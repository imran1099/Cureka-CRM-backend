import express from "express";
import { db } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { scoreCustomer, todayStr, daysBetween } from "../utils/ranking.js";

const router = express.Router();
router.use(requireAuth, requireAdmin);

const RANGE_SQL = {
  today: "CURDATE()",
  "7d": "(NOW() - INTERVAL 7 DAY)",
  "30d": "(NOW() - INTERVAL 30 DAY)",
};

function rangeClause(range) {
  return RANGE_SQL[range] || RANGE_SQL.today;
}

// GET /api/insights/attention — segment + customer-level "who needs attention" view
router.get("/attention", async (req, res, next) => {
  try {
    const today = todayStr();

    // Segment-level rollup: count, combined LTV, and how many are overdue/stale within each segment
    const segmentRows = await db.all(
      `SELECT segment, COUNT(*) as count, SUM(ltv) as total_ltv, AVG(ltv) as avg_ltv
       FROM customers WHERE do_not_call = 0 GROUP BY segment`
    );

    // Dormant high-LTV customers piling up without contact — the highest-value "leaking" group
    const dormantPilingRows = await db.all(
      `SELECT c.id, c.name, c.phone, c.ltv, c.last_order_date, c.assigned_agent_id, a.name as agent_name,
              (SELECT MAX(called_at) FROM call_logs WHERE customer_id = c.id) as last_call_at
       FROM customers c LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.segment = 'dormant' AND c.do_not_call = 0
       ORDER BY c.ltv DESC LIMIT 10`
    );

    const dormantPiling = dormantPilingRows.map((c) => ({
      ...c,
      silent_days: c.last_order_date ? daysBetween(c.last_order_date, today) : null,
      days_since_last_call: c.last_call_at ? daysBetween(c.last_call_at.slice(0, 10), today) : null,
    }));

    // Overdue callbacks — promises made to customers that are now late
    const overdueCallbacksRows = await db.all(
      `SELECT c.id, c.name, c.phone, c.ltv, c.callback_date, a.name as agent_name
       FROM customers c LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.callback_date IS NOT NULL AND c.callback_date <= CURDATE() AND c.do_not_call = 0
       ORDER BY c.callback_date ASC`
    );

    const overdueCallbacks = overdueCallbacksRows.map((c) => ({
      ...c,
      days_overdue: daysBetween(c.callback_date, today),
    }));

    // Stale replenishment customers — overdue by more than a few days, revenue actively being missed
    const staleReplenishmentRows = await db.all(
      `SELECT c.id, c.name, c.phone, c.ltv, c.replenish_due_date, a.name as agent_name
       FROM customers c LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.segment = 'replenishment' AND c.do_not_call = 0 AND c.replenish_due_date IS NOT NULL
       ORDER BY c.replenish_due_date ASC LIMIT 10`
    );

    const staleReplenishment = staleReplenishmentRows
      .map((c) => ({ ...c, days_overdue: daysBetween(c.replenish_due_date, today) }))
      .filter((c) => c.days_overdue >= 0);

    // Unassigned customers (nobody's queue picks them up by default unless segment filter is "all")
    const unassignedCountResult = await db.get(
      "SELECT COUNT(*) as count FROM customers WHERE assigned_agent_id IS NULL AND do_not_call = 0"
    );
    const unassignedCount = unassignedCountResult ? unassignedCountResult.count : 0;

    res.json({
      segmentRollup: segmentRows,
      dormantPiling,
      overdueCallbacks,
      staleReplenishment,
      unassignedCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/insights/agents?range=today|7d|30d — coaching signals per agent
router.get("/agents", async (req, res, next) => {
  try {
    const range = req.query.range || "7d";
    const since = rangeClause(range);

    const agentStats = await db.all(
      `SELECT
        agents.id, agents.name,
        COUNT(call_logs.id) as calls_made,
        SUM(CASE WHEN call_logs.outcome = 'sold' THEN 1 ELSE 0 END) as sales,
        SUM(CASE WHEN call_logs.outcome = 'sold' THEN call_logs.sale_amount ELSE 0 END) as revenue,
        SUM(CASE WHEN call_logs.outcome = 'noanswer' THEN 1 ELSE 0 END) as no_answers,
        SUM(CASE WHEN call_logs.outcome = 'notinterested' THEN 1 ELSE 0 END) as not_interested,
        SUM(CASE WHEN call_logs.sentiment = 'negative' THEN 1 ELSE 0 END) as negative_calls,
        AVG(call_logs.interest_level) as avg_interest_level
      FROM agents
      LEFT JOIN call_logs ON call_logs.agent_id = agents.id AND call_logs.called_at >= ${since}
      WHERE agents.role = 'agent' AND agents.active = 1
      GROUP BY agents.id
      ORDER BY revenue DESC`
    );

    // Top objection per agent — helps distinguish "needs pricing talk-track" vs "needs trust-building help"
    const objectionsByAgent = await db.all(
      `SELECT agent_id, objection_type, COUNT(*) as count
       FROM call_logs
       WHERE called_at >= ${since} AND objection_type IS NOT NULL AND objection_type != 'no_objection'
       GROUP BY agent_id, objection_type`
    );

    const topObjectionByAgent = {};
    for (const row of objectionsByAgent) {
      if (!topObjectionByAgent[row.agent_id] || row.count > topObjectionByAgent[row.agent_id].count) {
        topObjectionByAgent[row.agent_id] = { type: row.objection_type, count: row.count };
      }
    }

    const enriched = agentStats.map((a) => ({
      ...a,
      revenue: a.revenue || 0,
      conversion: a.calls_made > 0 ? Math.round((a.sales / a.calls_made) * 1000) / 10 : 0,
      avg_interest_level: a.avg_interest_level ? Math.round(a.avg_interest_level * 10) / 10 : null,
      top_objection: topObjectionByAgent[a.id] || null,
    }));

    res.json({ range, agents: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /api/insights/conversion?range=today|7d|30d — why sales are/aren't converting
router.get("/conversion", async (req, res, next) => {
  try {
    const range = req.query.range || "7d";
    const since = rangeClause(range);

    const outcomeBreakdown = await db.all(
      `SELECT outcome, COUNT(*) as count FROM call_logs WHERE called_at >= ${since} GROUP BY outcome ORDER BY count DESC`
    );

    const objectionBreakdown = await db.all(
      `SELECT objection_type, COUNT(*) as count FROM call_logs
       WHERE called_at >= ${since} AND objection_type IS NOT NULL
       GROUP BY objection_type ORDER BY count DESC`
    );

    const sentimentBreakdown = await db.all(
      `SELECT sentiment, COUNT(*) as count FROM call_logs
       WHERE called_at >= ${since} AND sentiment IS NOT NULL
       GROUP BY sentiment ORDER BY count DESC`
    );

    // Conversion rate by segment — which customer types convert best/worst right now
    const conversionBySegmentRows = await db.all(
      `SELECT c.segment,
              COUNT(cl.id) as calls,
              SUM(CASE WHEN cl.outcome = 'sold' THEN 1 ELSE 0 END) as sales,
              SUM(CASE WHEN cl.outcome = 'sold' THEN cl.sale_amount ELSE 0 END) as revenue
       FROM call_logs cl JOIN customers c ON c.id = cl.customer_id
       WHERE cl.called_at >= ${since}
       GROUP BY c.segment`
    );

    const conversionBySegment = conversionBySegmentRows.map((s) => ({
      ...s,
      conversion: s.calls > 0 ? Math.round((s.sales / s.calls) * 1000) / 10 : 0,
      revenue: s.revenue || 0,
    }));

    // Price sensitivity vs conversion — directly answers "is price the issue, or something else?"
    const conversionByPriceSensitivityRows = await db.all(
      `SELECT c.price_sensitivity,
              COUNT(cl.id) as calls,
              SUM(CASE WHEN cl.outcome = 'sold' THEN 1 ELSE 0 END) as sales
       FROM call_logs cl JOIN customers c ON c.id = cl.customer_id
       WHERE cl.called_at >= ${since} AND c.price_sensitivity IS NOT NULL
       GROUP BY c.price_sensitivity`
    );

    const conversionByPriceSensitivity = conversionByPriceSensitivityRows.map((s) => ({
      ...s,
      conversion: s.calls > 0 ? Math.round((s.sales / s.calls) * 1000) / 10 : 0,
    }));

    // Trending behavioral/health tags — what's showing up most across the customer base right now
    const trendingTags = await db.all(
      `SELECT tag, tag_type, COUNT(*) as count FROM customer_tags GROUP BY tag, tag_type ORDER BY count DESC LIMIT 15`
    );

    res.json({
      range,
      outcomeBreakdown,
      objectionBreakdown,
      sentimentBreakdown,
      conversionBySegment,
      conversionByPriceSensitivity,
      trendingTags,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
