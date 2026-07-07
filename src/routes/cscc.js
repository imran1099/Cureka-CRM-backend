import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";

const router = express.Router();
router.use(requireAuth);

// ─── Priority Engine ─────────────────────────────────────────────────────────
// Calculates a composite priority score for a cs_task.
// Lower score = higher priority. Range: 1 (critical) to 100 (low)
function computePriorityScore(task, customer) {
  let score = (task.priority_base || 5) * 10; // base from queue type (10-50)

  // SLA urgency: penalise if nearing/breached deadline
  if (task.sla_deadline) {
    const minsLeft = (new Date(task.sla_deadline) - Date.now()) / 60000;
    if (minsLeft < 0)    score -= 30; // breached
    else if (minsLeft < 15)  score -= 20;
    else if (minsLeft < 60)  score -= 10;
  }

  // Customer LTV boost
  const ltv = parseFloat(customer?.ltv || 0);
  if (ltv > 50000) score -= 15;
  else if (ltv > 10000) score -= 8;

  // Health score: lower is worse (more urgent)
  const hs = parseInt(customer?.health_score || 100);
  if (hs < 40) score -= 12;
  else if (hs < 70) score -= 6;

  return Math.max(1, Math.min(100, score));
}

// ─── GET /api/cscc/queues ─────────────────────────────────────────────────────
// Returns all active queue definitions
router.get("/queues", async (req, res, next) => {
  try {
    const queues = await db.all("SELECT * FROM cs_queues WHERE is_active = 1 ORDER BY priority_base ASC");
    res.json({ queues });
  } catch (err) { next(err); }
});

// ─── GET /api/cscc/my-workspace ──────────────────────────────────────────────
// Aggregated dashboard for the logged-in agent
router.get("/my-workspace", requireBrandAccess, async (req, res, next) => {
  try {
    const agentId = req.user.id;

    // Brand filter
    const brandIds = req.user.brands || [];
    let brandCondition = "1=1";
    const brandParams = [];
    if (brandIds.length > 0) {
      brandCondition = `t.brand_id IN (${brandIds.map(() => "?").join(",")})`;
      brandParams.push(...brandIds);
    }

    const taskRows = await db.all(
      `SELECT t.*, q.name as queue_name, q.category, q.color, q.icon, q.priority_base, q.sla_minutes,
              c.name as customer_name, c.phone, c.ltv, c.health_score, c.segment
       FROM cs_tasks t
       JOIN cs_queues q ON q.id = t.queue_id
       JOIN customers c ON c.id = t.customer_id
       WHERE t.assigned_agent_id = ? AND t.status NOT IN ('completed', 'resolved') AND ${brandCondition}
       ORDER BY t.sla_deadline ASC, t.priority_score ASC
       LIMIT 150`,
      agentId, ...brandParams
    );

    // Split into sections
    const now = new Date();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const urgent    = taskRows.filter(t => t.sla_deadline && new Date(t.sla_deadline) < new Date(Date.now() + 60 * 60 * 1000));
    const followups = taskRows.filter(t => t.queue_id?.startsWith("csq_") && t.sla_deadline && new Date(t.sla_deadline) >= new Date(Date.now() + 60 * 60 * 1000));
    const sales     = taskRows.filter(t => t.category === "sales");
    const support   = taskRows.filter(t => t.category === "support");

    // Agent stats for today
    const stats = await db.get(
      `SELECT COUNT(id) as total_assigned,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
              SUM(revenue_generated) as total_revenue
       FROM cs_tasks WHERE assigned_agent_id = ? AND DATE(created_at) = CURDATE()`,
      agentId
    );

    res.json({ urgent, followups, sales, support, all: taskRows, stats });
  } catch (err) { next(err); }
});

// ─── GET /api/cscc/tasks ──────────────────────────────────────────────────────
// List tasks with optional filters
router.get("/tasks", requireBrandAccess, async (req, res, next) => {
  try {
    const agentId = req.user.id;
    const { status, queue_id, category } = req.query;
    const brandIds = req.user.brands || [];

    let conditions = ["t.assigned_agent_id = ?"];
    let params = [agentId];

    if (brandIds.length > 0) {
      conditions.push(`t.brand_id IN (${brandIds.map(() => "?").join(",")})`);
      params.push(...brandIds);
    }
    if (status) { conditions.push("t.status = ?"); params.push(status); }
    if (queue_id) { conditions.push("t.queue_id = ?"); params.push(queue_id); }
    if (category) { conditions.push("q.category = ?"); params.push(category); }

    const tasks = await db.all(
      `SELECT t.*, q.name as queue_name, q.category, q.color, q.icon, q.priority_base,
              c.name as customer_name, c.phone, c.segment, c.ltv, c.health_score,
              c.last_order_date, c.cart_value
       FROM cs_tasks t
       JOIN cs_queues q ON q.id = t.queue_id
       JOIN customers c ON c.id = t.customer_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.priority_score ASC, t.sla_deadline ASC
       LIMIT 200`,
      ...params
    );

    res.json({ tasks });
  } catch (err) { next(err); }
});

// ─── POST /api/cscc/tasks ─────────────────────────────────────────────────────
// Create a new CS task (for manual or automation triggers)
router.post("/tasks", requireBrandAccess, async (req, res, next) => {
  try {
    const { customer_id, queue_id, brand_id, assigned_agent_id, reason, recommended_action, ticket_id } = req.body;
    if (!customer_id || !queue_id) return res.status(400).json({ error: "customer_id and queue_id are required" });

    const queue = await db.get("SELECT * FROM cs_queues WHERE id = ?", queue_id);
    if (!queue) return res.status(400).json({ error: "Invalid queue_id" });

    const customer = await db.get("SELECT * FROM customers WHERE id = ?", customer_id);
    if (!customer) return res.status(400).json({ error: "Customer not found" });

    const id = "cst_" + nanoid(12);
    const slaDeadline = new Date(Date.now() + queue.sla_minutes * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const tempTask = { priority_base: queue.priority_base, sla_deadline: slaDeadline };
    const priorityScore = computePriorityScore(tempTask, customer);

    await db.run(
      `INSERT INTO cs_tasks (id, queue_id, customer_id, brand_id, assigned_agent_id, ticket_id, reason, recommended_action, sla_deadline, priority_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, queue_id, customer_id, brand_id || null,
      assigned_agent_id || req.user.id,
      ticket_id || null, reason || queue.name, recommended_action || null,
      slaDeadline, priorityScore
    );

    // Audit
    await db.run(
      "INSERT INTO cs_task_audit (id, task_id, agent_id, from_status, to_status) VALUES (?, ?, ?, ?, ?)",
      "csta_" + nanoid(10), id, req.user.id, null, "assigned"
    );

    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── PATCH /api/cscc/tasks/:id ────────────────────────────────────────────────
// Update task status, outcome, revenue
router.patch("/tasks/:id", async (req, res, next) => {
  try {
    const { status, outcome, revenue_generated, notes, order_id } = req.body;
    const agentId = req.user.id;

    const task = await db.get("SELECT * FROM cs_tasks WHERE id = ?", req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const fromStatus = task.status;
    const contactedAt = status === "in_progress" && !task.contacted_at
      ? new Date().toISOString().slice(0, 19).replace("T", " ")
      : task.contacted_at;
    const resolvedAt = (status === "resolved" || status === "completed")
      ? new Date().toISOString().slice(0, 19).replace("T", " ")
      : task.resolved_at;

    await db.run(
      `UPDATE cs_tasks SET status = ?, outcome = COALESCE(?, outcome), revenue_generated = COALESCE(?, revenue_generated),
       notes = COALESCE(?, notes), order_id = COALESCE(?, order_id), contacted_at = ?, resolved_at = ?, updated_at = NOW()
       WHERE id = ?`,
      status || task.status, outcome || null, revenue_generated || null,
      notes || null, order_id || null, contactedAt, resolvedAt, req.params.id
    );

    // Audit log
    if (fromStatus !== status) {
      await db.run(
        "INSERT INTO cs_task_audit (id, task_id, agent_id, from_status, to_status, notes) VALUES (?, ?, ?, ?, ?, ?)",
        "csta_" + nanoid(10), req.params.id, agentId, fromStatus, status || task.status, notes || null
      );
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── POST /api/cscc/tasks/:id/followup ────────────────────────────────────────
// Auto-schedule follow-up for a task
router.post("/tasks/:id/followup", async (req, res, next) => {
  try {
    const { due_date, reason, priority } = req.body;
    const agentId = req.user.id;

    const task = await db.get("SELECT * FROM cs_tasks WHERE id = ?", req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (!due_date) return res.status(400).json({ error: "due_date is required for follow-up" });

    // Create a follow-up in customer_followups (for Call Queue)
    const fupId = "fup_" + nanoid(10);
    await db.run(
      "INSERT INTO customer_followups (id, customer_id, assigned_agent_id, due_date, reason) VALUES (?, ?, ?, ?, ?)",
      fupId, task.customer_id, agentId, due_date, reason || "Scheduled Follow-up"
    );

    // Create a new cs_task for the follow-up
    const newTaskId = "cst_" + nanoid(12);
    const queue = await db.get("SELECT * FROM cs_queues WHERE id = ?", task.queue_id);
    const newSla = new Date(new Date(due_date).getTime() + (queue?.sla_minutes || 60) * 60 * 1000)
      .toISOString().slice(0, 19).replace("T", " ");

    await db.run(
      `INSERT INTO cs_tasks (id, queue_id, customer_id, brand_id, assigned_agent_id, ticket_id, reason, sla_deadline, priority_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newTaskId, task.queue_id, task.customer_id, task.brand_id,
      agentId, task.ticket_id, reason || `Follow-up from task ${task.id}`,
      new Date(due_date).toISOString().slice(0, 19).replace("T", " "), priority || task.priority_score
    );

    // Mark original task as complete
    await db.run("UPDATE cs_tasks SET status = 'completed', updated_at = NOW() WHERE id = ?", task.id);
    await db.run(
      "INSERT INTO cs_task_audit (id, task_id, agent_id, from_status, to_status, notes) VALUES (?, ?, ?, ?, ?, ?)",
      "csta_" + nanoid(10), task.id, agentId, task.status, "completed", `Follow-up scheduled for ${due_date}`
    );

    res.json({ success: true, newTaskId, followupId: fupId });
  } catch (err) { next(err); }
});

// ─── GET /api/cscc/analytics ─────────────────────────────────────────────────
// Team Leader & Executive Dashboards
router.get("/analytics", requireBrandAccess, async (req, res, next) => {
  try {
    const brandIds = req.user.brands || [];
    let brandCondition = "1=1";
    const brandParams = [];
    if (brandIds.length > 0) {
      brandCondition = `t.brand_id IN (${brandIds.map(() => "?").join(",")})`;
      brandParams.push(...brandIds);
    }

    // Queue health
    const queueHealth = await db.all(
      `SELECT q.name, q.color, q.category,
              COUNT(t.id) as total,
              SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN t.sla_deadline < NOW() AND t.status NOT IN ('completed','resolved') THEN 1 ELSE 0 END) as sla_breached,
              SUM(t.revenue_generated) as revenue
       FROM cs_tasks t
       JOIN cs_queues q ON q.id = t.queue_id
       WHERE ${brandCondition}
       GROUP BY t.queue_id
       ORDER BY q.priority_base ASC`,
      ...brandParams
    );

    // Agent performance
    const agentPerf = await db.all(
      `SELECT a.name as agent_name,
              COUNT(t.id) as total_assigned,
              SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(t.revenue_generated) as revenue,
              SUM(CASE WHEN t.sla_deadline > NOW() OR t.status = 'completed' THEN 1 ELSE 0 END) as sla_compliant
       FROM cs_tasks t
       JOIN agents a ON a.id = t.assigned_agent_id
       WHERE ${brandCondition}
       GROUP BY t.assigned_agent_id
       ORDER BY revenue DESC`,
      ...brandParams
    );

    // Executive totals
    const totals = await db.get(
      `SELECT COUNT(id) as total_tasks,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
              SUM(revenue_generated) as total_revenue,
              SUM(CASE WHEN queue_id = 'csq_abandoned_cart' AND status = 'completed' THEN 1 ELSE 0 END) as cart_recovered,
              SUM(CASE WHEN queue_id = 'csq_ctwa' AND status = 'completed' THEN 1 ELSE 0 END) as ctwa_converted
       FROM cs_tasks t WHERE ${brandCondition}`,
      ...brandParams
    );

    res.json({ queueHealth, agentPerf, totals });
  } catch (err) { next(err); }
});

// ─── GET /api/cscc/campaigns ─────────────────────────────────────────────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const campaigns = await db.all("SELECT * FROM cs_campaigns ORDER BY created_at DESC");
    res.json({ campaigns });
  } catch (err) { next(err); }
});

// ─── POST /api/cscc/campaigns ────────────────────────────────────────────────
router.post("/campaigns", async (req, res, next) => {
  try {
    const { name, brand_id, queue_id, description, start_date, end_date } = req.body;
    const id = "camp_" + nanoid(10);
    await db.run(
      "INSERT INTO cs_campaigns (id, name, brand_id, queue_id, description, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, name, brand_id || null, queue_id || null, description || null, start_date || null, end_date || null, req.user.id
    );
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

export default router;
