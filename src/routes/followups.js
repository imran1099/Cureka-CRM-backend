import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { getBrandCondition } from "../utils/dbHelpers.js";
import {
  createFollowup, completeFollowup, rescheduleFollowup,
  processWorkflowRules, calculatePriorityScore, scoreToLabel,
} from "../services/followupService.js";

const router = express.Router();
router.use(requireAuth);

// ─── Brand-aware filter helper ────────────────────────────────────────────────
function buildFilter(req, alias = "f") {
  const ids = req.user.brands || [];
  if (!ids.length) return { where: "1=1", params: [] };
  const ph = ids.map(() => "?").join(",");
  return { where: `${alias}.brand_id IN (${ph})`, params: [...ids] };
}

// ─── GET /api/followups/categories ────────────────────────────────────────────
router.get("/categories", async (req, res, next) => {
  try {
    const cats = await db.all("SELECT * FROM followup_categories WHERE is_active = 1 ORDER BY group_name, name");
    res.json({ categories: cats });
  } catch (err) { next(err); }
});

// ─── GET /api/followups/dashboard/today ───────────────────────────────────────
// Agent daily work planner
router.get("/dashboard/today", async (req, res, next) => {
  try {
    const agentId = req.user.id;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const base = `
      SELECT f.*, fc.name as category_name, fc.icon as category_icon, fc.color as category_color, fc.group_name,
             c.name as customer_name, c.phone as customer_phone, c.health_score, c.ltv, c.segment
      FROM customer_followups f
      LEFT JOIN followup_categories fc ON fc.id = f.category_id
      JOIN customers c ON c.id = f.customer_id
    `;

    const [overdue, dueToday, upcoming, completedToday] = await Promise.all([
      db.all(`${base} WHERE f.assigned_agent_id = ? AND f.status = 'overdue' ORDER BY f.priority_score DESC LIMIT 50`, agentId),
      db.all(`${base} WHERE f.assigned_agent_id = ? AND f.status IN ('scheduled','pending','in_progress') AND f.due_at BETWEEN ? AND ? ORDER BY f.priority_score DESC LIMIT 50`,
        agentId, todayStart.toISOString().slice(0,19), todayEnd.toISOString().slice(0,19)),
      db.all(`${base} WHERE f.assigned_agent_id = ? AND f.status IN ('scheduled','pending') AND f.due_at > ? ORDER BY f.due_at ASC LIMIT 30`,
        agentId, todayEnd.toISOString().slice(0,19)),
      db.all(`${base} WHERE f.assigned_agent_id = ? AND f.status = 'completed' AND f.completed_at >= ? ORDER BY f.completed_at DESC LIMIT 20`,
        agentId, todayStart.toISOString().slice(0,19)),
    ]);

    // Group by category for summary
    const summary = dueToday.reduce((acc, f) => {
      const key = f.category_name || "General";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    res.json({
      overdue, due_today: dueToday, upcoming, completed_today: completedToday,
      summary, overdue_count: overdue.length, due_today_count: dueToday.length,
      completed_today_count: completedToday.length, upcoming_count: upcoming.length,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/followups/dashboard/stats ───────────────────────────────────────
// Team leader / exec analytics
router.get("/dashboard/stats", requireBrandAccess, async (req, res, next) => {
  try {
    const bf = buildFilter(req);
    const { date_from, date_to, agent_id } = req.query;
    let cond = [bf.where];
    let params = [...bf.params];

    if (date_from) { cond.push("f.created_at >= ?"); params.push(date_from); }
    if (date_to)   { cond.push("f.created_at <= ?"); params.push(date_to + " 23:59:59"); }
    if (agent_id)  { cond.push("f.assigned_agent_id = ?"); params.push(agent_id); }
    const where = cond.join(" AND ");

    const [totals, byStatus, byCategory, byAgent] = await Promise.all([
      db.get(`
        SELECT
          COUNT(*) as total,
          SUM(status = 'completed') as completed,
          SUM(status = 'overdue') as overdue,
          SUM(status IN ('scheduled','pending','in_progress')) as pending
        FROM customer_followups f WHERE ${where}
      `, ...params),
      db.all(`
        SELECT status, COUNT(*) as cnt
        FROM customer_followups f WHERE ${where}
        GROUP BY status
      `, ...params),
      db.all(`
        SELECT fc.name as category, fc.icon, fc.color, fc.group_name, COUNT(f.id) as cnt,
               SUM(f.status = 'completed') as completed
        FROM customer_followups f
        LEFT JOIN followup_categories fc ON fc.id = f.category_id
        WHERE ${where}
        GROUP BY f.category_id
        ORDER BY cnt DESC
      `, ...params),
      db.all(`
        SELECT a.name as agent_name, COUNT(f.id) as total,
               SUM(f.status = 'completed') as completed,
               SUM(f.status = 'overdue') as overdue,
               ROUND(SUM(f.status = 'completed') * 100.0 / COUNT(f.id), 1) as completion_rate
        FROM customer_followups f
        JOIN agents a ON a.id = f.assigned_agent_id
        WHERE ${where}
        GROUP BY f.assigned_agent_id
        ORDER BY total DESC
      `, ...params),
    ]);

    const completionRate = totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0;
    const overdueRate = totals.total > 0 ? Math.round((totals.overdue / totals.total) * 100) : 0;

    res.json({
      totals, completion_rate: completionRate, overdue_rate: overdueRate,
      by_status: byStatus, by_category: byCategory, by_agent: byAgent,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/followups ───────────────────────────────────────────────────────
router.get("/", requireBrandAccess, async (req, res, next) => {
  try {
    const bf = buildFilter(req);
    const { status, category_id, agent_id, priority, search, date_from, date_to, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let cond = [bf.where];
    let params = [...bf.params];

    if (status)      { cond.push("f.status = ?");               params.push(status); }
    if (category_id) { cond.push("f.category_id = ?");          params.push(category_id); }
    if (agent_id)    { cond.push("f.assigned_agent_id = ?");    params.push(agent_id); }
    if (priority)    { cond.push("f.priority = ?");             params.push(priority); }
    if (date_from)   { cond.push("f.due_at >= ?");              params.push(date_from); }
    if (date_to)     { cond.push("f.due_at <= ?");              params.push(date_to + " 23:59:59"); }
    if (search)      { cond.push("(c.name LIKE ? OR f.title LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }

    // Agent-level: only their own follow-ups
    if (!req.user.brands?.length) {
      cond.push("f.assigned_agent_id = ?");
      params.push(req.user.id);
    }

    const where = cond.join(" AND ");

    const [rows, countRow] = await Promise.all([
      db.all(`
        SELECT f.*, fc.name as category_name, fc.icon as category_icon, fc.color as category_color, fc.group_name,
               c.name as customer_name, c.phone as customer_phone, c.health_score, c.ltv, c.segment,
               a.name as agent_name
        FROM customer_followups f
        LEFT JOIN followup_categories fc ON fc.id = f.category_id
        JOIN customers c ON c.id = f.customer_id
        LEFT JOIN agents a ON a.id = f.assigned_agent_id
        WHERE ${where}
        ORDER BY f.priority_score DESC, f.due_at ASC
        LIMIT ? OFFSET ?
      `, ...params, parseInt(limit), offset),
      db.get(`SELECT COUNT(*) as total FROM customer_followups f JOIN customers c ON c.id = f.customer_id WHERE ${where}`, ...params),
    ]);

    res.json({
      followups: rows,
      total: countRow.total,
      page: parseInt(page),
      totalPages: Math.ceil(countRow.total / parseInt(limit)),
    });
  } catch (err) { next(err); }
});

// ─── POST /api/followups ──────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const {
      customer_id, brand_id, category_id, assigned_agent_id,
      title, description, due_at, reminder_at, priority,
      related_order_id, related_ticket_id, related_opportunity_id,
    } = req.body;

    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
    if (!title)       return res.status(400).json({ error: "title is required" });
    if (!due_at)      return res.status(400).json({ error: "due_at is required" });

    const id = await createFollowup({
      customerId: customer_id, brandId: brand_id, categoryId: category_id,
      assignedAgentId: assigned_agent_id || req.user.id,
      createdByAgentId: req.user.id,
      title, description, dueAt: due_at, reminderAt: reminder_at, priority,
      relatedOrderId: related_order_id, relatedTicketId: related_ticket_id,
      relatedOpportunityId: related_opportunity_id,
      source: "manual",
    });

    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── GET /api/followups/:id ───────────────────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const fup = await db.get(`
      SELECT f.*, fc.name as category_name, fc.icon as category_icon, fc.color as category_color, fc.group_name,
             c.name as customer_name, c.phone as customer_phone, c.health_score, c.ltv, c.segment,
             a.name as agent_name, b.name as brand_name
      FROM customer_followups f
      LEFT JOIN followup_categories fc ON fc.id = f.category_id
      JOIN customers c ON c.id = f.customer_id
      LEFT JOIN agents a ON a.id = f.assigned_agent_id
      LEFT JOIN brands b ON b.id = f.brand_id
      WHERE f.id = ?
    `, req.params.id);
    if (!fup) return res.status(404).json({ error: "Follow-up not found" });

    const [reminders, auditLog, escalations] = await Promise.all([
      db.all("SELECT * FROM followup_reminders WHERE followup_id = ? ORDER BY remind_at ASC", fup.id),
      db.all("SELECT wal.*, a.name as agent_name FROM workflow_audit_log wal LEFT JOIN agents a ON a.id = wal.agent_id WHERE wal.followup_id = ? ORDER BY wal.created_at DESC", fup.id),
      db.all("SELECT * FROM escalation_log WHERE followup_id = ? ORDER BY created_at ASC", fup.id),
    ]);

    res.json({ followup: fup, reminders, audit_log: auditLog, escalations });
  } catch (err) { next(err); }
});

// ─── PATCH /api/followups/:id ─────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { action, outcome, notes, due_at, reason, assigned_agent_id, status, priority } = req.body;
    const fup = await db.get("SELECT * FROM customer_followups WHERE id = ?", req.params.id);
    if (!fup) return res.status(404).json({ error: "Follow-up not found" });

    if (action === "complete") {
      if (!outcome) return res.status(400).json({ error: "outcome is required" });
      await completeFollowup(fup.id, { outcome, notes, agentId: req.user.id });

    } else if (action === "reschedule") {
      if (!due_at) return res.status(400).json({ error: "due_at is required for reschedule" });
      if (!reason) return res.status(400).json({ error: "reason is required for reschedule" });
      await rescheduleFollowup(fup.id, { dueAt: due_at, reason, agentId: req.user.id });

    } else if (action === "escalate") {
      const newLevel = (fup.escalation_level || 0) + 1;
      await db.run(
        "UPDATE customer_followups SET escalation_level = ?, status = 'overdue', updated_at = NOW() WHERE id = ?",
        newLevel, fup.id
      );
      await db.run(
        "INSERT INTO escalation_log (id, followup_id, from_agent_id, escalation_level, reason) VALUES (?, ?, ?, ?, ?)",
        "el_" + nanoid(10), fup.id, req.user.id, newLevel, reason || "Manual escalation"
      );
      await db.run(
        "INSERT INTO workflow_audit_log (id, followup_id, agent_id, action, old_status, new_status, notes) VALUES (?, ?, ?, 'escalated', ?, 'overdue', ?)",
        "wal_" + nanoid(10), fup.id, req.user.id, fup.status, reason || "Manual escalation"
      );

    } else {
      // General field update
      const updates = []; const params = [];
      if (assigned_agent_id !== undefined) { updates.push("assigned_agent_id = ?"); params.push(assigned_agent_id); }
      if (status && status !== fup.status) { updates.push("status = ?"); params.push(status); }
      if (priority && priority !== fup.priority) { updates.push("priority = ?"); params.push(priority); }
      if (updates.length) {
        updates.push("updated_at = NOW()");
        await db.run(`UPDATE customer_followups SET ${updates.join(", ")} WHERE id = ?`, ...params, fup.id);
        await db.run(
          "INSERT INTO workflow_audit_log (id, followup_id, agent_id, action, old_status, new_status) VALUES (?, ?, ?, 'updated', ?, ?)",
          "wal_" + nanoid(10), fup.id, req.user.id, fup.status, status || fup.status
        );
      }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── DELETE /api/followups/:id — Cancel ──────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const fup = await db.get("SELECT * FROM customer_followups WHERE id = ?", req.params.id);
    if (!fup) return res.status(404).json({ error: "Not found" });
    await db.run("UPDATE customer_followups SET status = 'cancelled', updated_at = NOW() WHERE id = ?", req.params.id);
    await db.run(
      "INSERT INTO workflow_audit_log (id, followup_id, agent_id, action, old_status, new_status) VALUES (?, ?, ?, 'cancelled', ?, 'cancelled')",
      "wal_" + nanoid(10), fup.id, req.user.id, fup.status
    );
    res.json({ cancelled: true });
  } catch (err) { next(err); }
});

// ─── Workflow Rules CRUD ──────────────────────────────────────────────────────

router.get("/rules/list", async (req, res, next) => {
  try {
    const rules = await db.all("SELECT * FROM workflow_rules ORDER BY trigger_event, priority_order ASC");
    res.json({ rules });
  } catch (err) { next(err); }
});

router.post("/rules/create", async (req, res, next) => {
  try {
    const { name, description, trigger_event, conditions, action_type, action_config, priority_order } = req.body;
    if (!name || !trigger_event || !action_config) return res.status(400).json({ error: "name, trigger_event, action_config are required" });
    const id = "wr_" + nanoid(10);
    await db.run(
      "INSERT INTO workflow_rules (id, name, description, trigger_event, conditions, action_type, action_config, priority_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, name, description || null, trigger_event,
      conditions ? JSON.stringify(conditions) : null,
      action_type || "create_followup",
      JSON.stringify(action_config),
      priority_order || 10,
      req.user.id
    );
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.patch("/rules/:id", async (req, res, next) => {
  try {
    const { name, description, trigger_event, conditions, action_config, is_active, priority_order } = req.body;
    const updates = []; const params = [];
    if (name !== undefined)          { updates.push("name = ?");           params.push(name); }
    if (description !== undefined)   { updates.push("description = ?");    params.push(description); }
    if (trigger_event !== undefined) { updates.push("trigger_event = ?");  params.push(trigger_event); }
    if (conditions !== undefined)    { updates.push("conditions = ?");     params.push(JSON.stringify(conditions)); }
    if (action_config !== undefined) { updates.push("action_config = ?");  params.push(JSON.stringify(action_config)); }
    if (is_active !== undefined)     { updates.push("is_active = ?");      params.push(is_active ? 1 : 0); }
    if (priority_order !== undefined){ updates.push("priority_order = ?"); params.push(priority_order); }
    if (!updates.length) return res.status(400).json({ error: "No fields to update" });
    updates.push("updated_at = NOW()");
    await db.run(`UPDATE workflow_rules SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.id);
    res.json({ updated: true });
  } catch (err) { next(err); }
});

router.delete("/rules/:id", async (req, res, next) => {
  try {
    const rule = await db.get("SELECT * FROM workflow_rules WHERE id = ?", req.params.id);
    if (!rule) return res.status(404).json({ error: "Not found" });
    if (rule.id.startsWith("wr_cart") || rule.id.startsWith("wr_call") || rule.id.startsWith("wr_ticket") || rule.id.startsWith("wr_order") || rule.id.startsWith("wr_payment") || rule.id.startsWith("wr_opp")) {
      // Soft-disable instead of delete for system rules
      await db.run("UPDATE workflow_rules SET is_active = 0 WHERE id = ?", req.params.id);
    } else {
      await db.run("DELETE FROM workflow_rules WHERE id = ?", req.params.id);
    }
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

export default router;
