import express from "express";
import { nanoid } from "nanoid";
import { db, pool } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { createTimelineEvent } from "../services/timelineService.js";

const router = express.Router();
router.use(requireAuth);

// ─── GET /api/timeline/:customerId ───────────────────────────────────────────
// Query params: page, limit, event_type, category, brand_id, agent_id, include_internal, q, date_from, date_to
router.get("/:customerId", async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const {
      page = 1, limit = 30,
      event_type, category, brand_id, agent_id,
      include_internal = "false",
      q, date_from, date_to,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    let sql = `
      SELECT ct.*,
             tet.label as event_label, tet.icon as event_icon, tet.color as event_color, tet.category as event_category,
             a.name as agent_name,
             b.name as brand_name
      FROM customer_timeline ct
      LEFT JOIN timeline_event_types tet ON tet.id = ct.event_type
      LEFT JOIN agents a ON a.id = ct.agent_id
      LEFT JOIN brands b ON b.id = ct.brand_id
      WHERE ct.customer_id = ?`;
    const params = [customerId];

    // Internal note filtering (API-level, not just UI)
    if (include_internal !== "true") {
      sql += " AND ct.is_internal = 0";
    }
    if (event_type)  { sql += " AND ct.event_type = ?";      params.push(event_type); }
    if (category)    { sql += " AND tet.category = ?";       params.push(category); }
    if (brand_id)    { sql += " AND ct.brand_id = ?";        params.push(brand_id); }
    if (agent_id)    { sql += " AND ct.agent_id = ?";        params.push(agent_id); }
    if (date_from)   { sql += " AND ct.created_at >= ?";     params.push(date_from); }
    if (date_to)     { sql += " AND ct.created_at <= ?";     params.push(date_to + " 23:59:59"); }
    if (q)           { sql += " AND (ct.event_title LIKE ? OR ct.event_description LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }

    const countSql = sql.replace(
      /SELECT ct\.\*,[\s\S]*?FROM customer_timeline ct/,
      "SELECT COUNT(*) as total FROM customer_timeline ct"
    );
    const [[{ total }]] = await pool.query(countSql, params);

    sql += ` ORDER BY ct.created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
    const [events] = await pool.query(sql, params);

    res.json({ events, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) { next(err); }
});

// ─── POST /api/timeline/:customerId/note ─────────────────────────────────────
router.post("/:customerId/note", async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const { content, is_internal = true } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Note content is required" });

    await createTimelineEvent({
      customerId,
      eventType: is_internal ? "internal_note" : "profile_updated",
      eventTitle: is_internal ? "Internal Note" : "Agent Note",
      eventDescription: content.trim(),
      agentId: req.user.id,
      sourceSystem: "manual",
      isInternal: is_internal,
    });

    res.status(201).json({ success: true });
  } catch (err) { next(err); }
});

// ─── GET /api/timeline/:customerId/milestones ─────────────────────────────────
router.get("/:customerId/milestones", async (req, res, next) => {
  try {
    const milestones = await db.all(
      "SELECT * FROM timeline_milestones WHERE customer_id = ? ORDER BY achieved_at ASC",
      req.params.customerId
    );
    res.json({ milestones });
  } catch (err) { next(err); }
});

// ─── GET /api/timeline/:customerId/insights ───────────────────────────────────
router.get("/:customerId/insights", async (req, res, next) => {
  try {
    const insights = await db.all(
      "SELECT * FROM timeline_insights WHERE customer_id = ? ORDER BY generated_at DESC",
      req.params.customerId
    );
    res.json({ insights });
  } catch (err) { next(err); }
});

// ─── GET /api/timeline/:customerId/analytics ──────────────────────────────────
router.get("/:customerId/analytics", async (req, res, next) => {
  try {
    const { customerId } = req.params;

    const [totalEvents] = await pool.query("SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND is_internal = 0", [customerId]);
    const [supportInteractions] = await pool.query(
      "SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND event_type IN ('ticket_created','complaint_registered','refund_requested')",
      [customerId]
    );
    const [callCount] = await pool.query(
      "SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND event_type IN ('call_completed','call_outgoing','call_incoming')",
      [customerId]
    );
    const [purchases] = await pool.query(
      "SELECT COUNT(*) as cnt, MIN(created_at) as first_at, MAX(created_at) as last_at FROM customer_timeline WHERE customer_id = ? AND event_type IN ('deal_won','order_created')",
      [customerId]
    );
    const [registration] = await pool.query(
      "SELECT MIN(created_at) as registered_at FROM customer_timeline WHERE customer_id = ?",
      [customerId]
    );

    const purchaseData = purchases[0][0];
    const regData = registration[0][0];
    const totalDays = regData?.registered_at
      ? Math.floor((Date.now() - new Date(regData.registered_at)) / 86400000)
      : null;
    const purchaseCnt = purchaseData?.cnt || 0;
    const avgDaysBetweenPurchases = purchaseCnt >= 2 && purchaseData.first_at && purchaseData.last_at
      ? Math.floor((new Date(purchaseData.last_at) - new Date(purchaseData.first_at)) / 86400000 / (purchaseCnt - 1))
      : null;

    res.json({
      total_events: totalEvents[0][0]?.cnt || 0,
      support_interactions: supportInteractions[0][0]?.cnt || 0,
      total_calls: callCount[0][0]?.cnt || 0,
      total_purchases: purchaseCnt,
      lifecycle_days: totalDays,
      avg_days_between_purchases: avgDaysBetweenPurchases,
      first_purchase_at: purchaseData?.first_at || null,
      last_purchase_at: purchaseData?.last_at || null,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/timeline/event-types ────────────────────────────────────────────
router.get("/event-types/all", async (req, res, next) => {
  try {
    const types = await db.all("SELECT * FROM timeline_event_types WHERE is_active = 1 ORDER BY category, label");
    res.json({ types });
  } catch (err) { next(err); }
});

export default router;

