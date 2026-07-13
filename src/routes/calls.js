import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { getBrandCondition } from "../utils/dbHelpers.js";
import { createTimelineEvent } from "../services/timelineService.js";
import { createFollowup, processWorkflowRules } from "../services/followupService.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/calls/queue
// Intelligent Call Queue aggregating abandoned carts, follow-ups, and CTWA
router.get("/queue", requireBrandAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "c");
    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    // 1. Abandoned Carts (Priority: High)
    const cartsSql = `
      SELECT c.id as customer_id, c.name, c.phone, c.cart_value, c.cart_abandoned_at as trigger_date, 
             'Abandoned Cart' as queue_reason, 1 as priority_score
      FROM customers c
      ${brandFilter.join}
      WHERE c.cart_abandoned_at IS NOT NULL 
        AND c.cart_abandoned_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND ${brandFilter.condition}
    `;

    // 2. Pending Follow-ups (Priority: Medium)
    const followupsSql = `
      SELECT c.id as customer_id, c.name, c.phone, NULL as cart_value, f.due_date as trigger_date, 
             CONCAT('Follow-up: ', f.reason) as queue_reason, 3 as priority_score
      FROM customer_followups f
      JOIN customers c ON c.id = f.customer_id
      ${brandFilter.join}
      WHERE f.status = 'pending' AND f.due_date <= NOW()
        AND ${brandFilter.condition}
    `;

    // 3. Open Tickets pending call (Priority: Medium-High)
    const ticketsSql = `
      SELECT c.id as customer_id, c.name, c.phone, NULL as cart_value, t.updated_at as trigger_date, 
             CONCAT('Open Ticket: ', t.priority) as queue_reason, 2 as priority_score
      FROM tickets t
      JOIN customers c ON c.id = t.customer_id
      ${brandFilter.join}
      WHERE t.status = 'open' 
        AND ${brandFilter.condition}
    `;

    // Combine queries (union all)
    // We execute them sequentially for simplicity in parameter mapping, then merge and sort in JS
    const [carts, followups, tickets] = await Promise.all([
      db.all(cartsSql, ...params),
      db.all(followupsSql, ...params),
      db.all(ticketsSql, ...params)
    ]);

    let queue = [...carts, ...followups, ...tickets];

    // Dynamic sort: primary by priority_score (1 is highest), secondary by trigger_date
    queue.sort((a, b) => {
      if (a.priority_score !== b.priority_score) return a.priority_score - b.priority_score;
      return new Date(b.trigger_date) - new Date(a.trigger_date);
    });

    res.json({ queue: queue.slice(0, 100) }); // Return top 100
  } catch (err) {
    next(err);
  }
});

// GET /api/calls/scripts/:category
router.get("/scripts/:category", async (req, res, next) => {
  try {
    const script = await db.get("SELECT * FROM call_scripts WHERE category = ?", req.params.category);
    if (!script) return res.status(404).json({ error: "Script not found" });
    res.json(script);
  } catch (err) {
    next(err);
  }
});

// POST /api/calls
// Log a call and run follow-up/timeline automation
router.post("/", requireBrandAccess, async (req, res, next) => {
  try {
    const { 
      customer_id, brand_id, call_type = 'outbound', call_category, 
      outcome, remarks, sale_amount, objection_type, call_duration_seconds, order_id, 
      follow_up_date, follow_up_reason 
    } = req.body;

    if (!customer_id || !outcome) {
      return res.status(400).json({ error: "customer_id and outcome are required" });
    }

    const id = "call_" + nanoid(10);
    const agent_id = req.user.id;

    // Insert call log
    await db.run(`
      INSERT INTO call_logs (
        id, customer_id, agent_id, brand_id, call_type, call_category, outcome, remarks, sale_amount, objection_type, call_duration_seconds, order_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, customer_id, agent_id, brand_id || null, call_type, call_category || 'general', outcome, remarks || null, sale_amount || 0, objection_type || null, call_duration_seconds || 0, order_id || null);

    // Automation: Create follow-up if requested
    if (follow_up_date) {
      await createFollowup({
        customerId: customer_id, brandId: brand_id || null,
        categoryId: "fcat_ctwa_lead",
        assignedAgentId: agent_id,
        createdByAgentId: agent_id,
        title: follow_up_reason || "Scheduled Follow-up",
        dueAt: follow_up_date,
        source: "call_log",
      }).catch(() => {});
      createTimelineEvent({
        customerId: customer_id, brandId: brand_id || null,
        eventType: "followup_scheduled",
        eventTitle: `Follow-up scheduled for ${new Date(follow_up_date).toLocaleDateString()}`,
        eventDescription: follow_up_reason || "Scheduled after call.",
        agentId: agent_id, sourceSystem: "calls",
        refId: id, refType: "call",
      }).catch(() => {});
    }

    // Workflow automation: no-answer triggers retry rule
    if (outcome === "no_answer" || outcome === "missed") {
      processWorkflowRules("call_no_answer", {
        customerId: customer_id, brandId: brand_id || null,
        assignedAgentId: agent_id,
        relatedOrderId: order_id,
      }).catch(() => {});
    }

    // Timeline event via new service (replaces old broken insert)
    const callEventType = outcome === "no_answer" || outcome === "missed" ? "call_missed"
      : call_type === "inbound" ? "call_incoming" : "call_outgoing";
    createTimelineEvent({
      customerId: customer_id, brandId: brand_id || null,
      eventType: callEventType,
      eventTitle: `${call_type === "inbound" ? "Incoming" : "Outgoing"} call — ${outcome}`,
      eventDescription: remarks || null,
      outcome, agentId: agent_id,
      sourceSystem: "calls", refId: id, refType: "call",
      metadata: { call_duration_seconds, sale_amount, call_category },
    }).catch(() => {});

    // Automation: Clear any pending follow-ups for this customer if a call was made
    await db.run("UPDATE customer_followups SET status = 'completed', updated_at = NOW() WHERE customer_id = ? AND status = 'pending' AND due_date <= NOW()", customer_id);

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/calls/analytics
// Dashboards
router.get("/analytics", requireBrandAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "cl");
    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    // Agent Stats
    const agentStats = await db.all(`
      SELECT a.name as agent_name, COUNT(cl.id) as total_calls, 
             SUM(CASE WHEN cl.sale_amount > 0 THEN 1 ELSE 0 END) as orders_generated,
             SUM(cl.sale_amount) as revenue_generated,
             AVG(cl.call_duration_seconds) as avg_duration
      FROM call_logs cl
      JOIN agents a ON a.id = cl.agent_id
      ${brandFilter.join.replace('c.id', 'cl.customer_id')}
      WHERE ${brandFilter.condition}
      GROUP BY cl.agent_id
    `, ...params);

    // Top Objections
    const objections = await db.all(`
      SELECT objection_type, COUNT(id) as count
      FROM call_logs cl
      ${brandFilter.join.replace('c.id', 'cl.customer_id')}
      WHERE objection_type IS NOT NULL AND ${brandFilter.condition}
      GROUP BY objection_type
      ORDER BY count DESC
      LIMIT 5
    `, ...params);

    // Outcomes
    const outcomes = await db.all(`
      SELECT outcome, COUNT(id) as count
      FROM call_logs cl
      ${brandFilter.join.replace('c.id', 'cl.customer_id')}
      WHERE ${brandFilter.condition}
      GROUP BY outcome
      ORDER BY count DESC
    `, ...params);

    // Total metrics
    const totals = await db.get(`
      SELECT COUNT(id) as total_calls, SUM(sale_amount) as total_revenue
      FROM call_logs cl
      ${brandFilter.join.replace('c.id', 'cl.customer_id')}
      WHERE ${brandFilter.condition}
    `, ...params);

    res.json({ agentStats, objections, outcomes, totals });
  } catch (err) {
    next(err);
  }
});

// Admin: Scripts config
router.post("/scripts", requireAuth, async (req, res, next) => {
  try {
    const { category, title, content } = req.body;
    const id = "script_" + nanoid(10);
    // Upsert logic for simplicity
    await db.run(
      "REPLACE INTO call_scripts (id, category, title, content) VALUES (?, ?, ?, ?)",
      id, category, title, content
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
