import express from "express";
import { db } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { scoreCustomer, todayStr, daysBetween } from "../utils/ranking.js";
import { getBrandCondition } from "../utils/dbHelpers.js";

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
    const bc = getBrandCondition(req, "c"); // bc.join, bc.condition, bc.params

    const cJoin = bc.join.replace("c.id", "id"); 
    const cbFilterCustomer = getBrandCondition(req, "customers");
    const clFilter = getBrandCondition(req, "call_logs");

    const paramsCustomer = cbFilterCustomer.params || (cbFilterCustomer.param ? [cbFilterCustomer.param] : []);
    const paramsCall = clFilter.params || (clFilter.param ? [clFilter.param] : []);

    const segmentRows = await db.all(
      `SELECT customers.segment, COUNT(DISTINCT customers.id) as count, SUM(customers.ltv) as total_ltv, AVG(customers.ltv) as avg_ltv
       FROM customers ${cbFilterCustomer.join} WHERE customers.do_not_call = 0 AND ${cbFilterCustomer.condition} GROUP BY customers.segment`,
      ...paramsCustomer
    );

    const dormantPilingRows = await db.all(
      `SELECT c.id, c.name, c.phone, c.ltv, c.last_order_date, c.assigned_agent_id, a.name as agent_name,
              (SELECT MAX(called_at) FROM call_logs WHERE customer_id = c.id) as last_call_at
       FROM customers c ${bc.join} LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.segment = 'dormant' AND c.do_not_call = 0 AND ${bc.condition}
       GROUP BY c.id ORDER BY c.ltv DESC LIMIT 10`,
       ...(bc.params || (bc.param ? [bc.param] : []))
    );

    const dormantPiling = dormantPilingRows.map((c) => ({
      ...c,
      silent_days: c.last_order_date ? daysBetween(c.last_order_date, today) : null,
      days_since_last_call: c.last_call_at ? daysBetween(c.last_call_at.slice(0, 10), today) : null,
    }));

    const overdueCallbacksRows = await db.all(
      `SELECT c.id, c.name, c.phone, c.ltv, c.callback_date, a.name as agent_name
       FROM customers c ${bc.join} LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.callback_date IS NOT NULL AND c.callback_date <= CURDATE() AND c.do_not_call = 0 AND ${bc.condition}
       GROUP BY c.id ORDER BY c.callback_date ASC`,
       ...(bc.params || (bc.param ? [bc.param] : []))
    );

    const overdueCallbacks = overdueCallbacksRows.map((c) => ({
      ...c,
      days_overdue: daysBetween(c.callback_date, today),
    }));

    const staleReplenishmentRows = await db.all(
      `SELECT c.id, c.name, c.phone, c.ltv, c.replenish_due_date, a.name as agent_name
       FROM customers c ${bc.join} LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.segment = 'replenishment' AND c.do_not_call = 0 AND c.replenish_due_date IS NOT NULL AND ${bc.condition}
       GROUP BY c.id ORDER BY c.replenish_due_date ASC LIMIT 10`,
       ...(bc.params || (bc.param ? [bc.param] : []))
    );

    const staleReplenishment = staleReplenishmentRows
      .map((c) => ({ ...c, days_overdue: daysBetween(c.replenish_due_date, today) }))
      .filter((c) => c.days_overdue >= 0);

    const unassignedCountResult = await db.get(
      `SELECT COUNT(DISTINCT customers.id) as count FROM customers ${cbFilterCustomer.join} WHERE customers.assigned_agent_id IS NULL AND customers.do_not_call = 0 AND ${cbFilterCustomer.condition}`,
      ...paramsCustomer
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

router.get("/agents", async (req, res, next) => {
  try {
    const range = req.query.range || "7d";
    const since = rangeClause(range);
    
    const clFilter = getBrandCondition(req, "call_logs");
    const paramsCall = clFilter.params || (clFilter.param ? [clFilter.param] : []);

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
      LEFT JOIN call_logs ON call_logs.agent_id = agents.id AND call_logs.called_at >= ${since} AND ${clFilter.condition}
      WHERE agents.role = 'agent' AND agents.active = 1
      GROUP BY agents.id
      ORDER BY revenue DESC`,
      ...paramsCall
    );

    const objectionsByAgent = await db.all(
      `SELECT call_logs.agent_id, call_logs.objection_type, COUNT(*) as count
       FROM call_logs
       WHERE call_logs.called_at >= ${since} AND call_logs.objection_type IS NOT NULL AND call_logs.objection_type != 'no_objection' AND ${clFilter.condition}
       GROUP BY call_logs.agent_id, call_logs.objection_type`,
       ...paramsCall
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

router.get("/conversion", async (req, res, next) => {
  try {
    const range = req.query.range || "7d";
    const since = rangeClause(range);
    
    const clFilter = getBrandCondition(req, "call_logs");
    const paramsCall = clFilter.params || (clFilter.param ? [clFilter.param] : []);

    const outcomeBreakdown = await db.all(
      `SELECT call_logs.outcome, COUNT(*) as count FROM call_logs WHERE call_logs.called_at >= ${since} AND ${clFilter.condition} GROUP BY call_logs.outcome ORDER BY count DESC`,
      ...paramsCall
    );

    const objectionBreakdown = await db.all(
      `SELECT call_logs.objection_type, COUNT(*) as count FROM call_logs
       WHERE call_logs.called_at >= ${since} AND call_logs.objection_type IS NOT NULL AND ${clFilter.condition}
       GROUP BY call_logs.objection_type ORDER BY count DESC`,
      ...paramsCall
    );

    const sentimentBreakdown = await db.all(
      `SELECT call_logs.sentiment, COUNT(*) as count FROM call_logs
       WHERE call_logs.called_at >= ${since} AND call_logs.sentiment IS NOT NULL AND ${clFilter.condition}
       GROUP BY call_logs.sentiment ORDER BY count DESC`,
      ...paramsCall
    );

    const conversionBySegmentRows = await db.all(
      `SELECT c.segment,
              COUNT(cl.id) as calls,
              SUM(CASE WHEN cl.outcome = 'sold' THEN 1 ELSE 0 END) as sales,
              SUM(CASE WHEN cl.outcome = 'sold' THEN cl.sale_amount ELSE 0 END) as revenue
       FROM call_logs cl JOIN customers c ON c.id = cl.customer_id
       WHERE cl.called_at >= ${since} AND ${clFilter.condition.replace('call_logs.brand_id', 'cl.brand_id')}
       GROUP BY c.segment`,
      ...paramsCall
    );

    const conversionBySegment = conversionBySegmentRows.map((s) => ({
      ...s,
      conversion: s.calls > 0 ? Math.round((s.sales / s.calls) * 1000) / 10 : 0,
      revenue: s.revenue || 0,
    }));

    const conversionByPriceSensitivityRows = await db.all(
      `SELECT c.price_sensitivity,
              COUNT(cl.id) as calls,
              SUM(CASE WHEN cl.outcome = 'sold' THEN 1 ELSE 0 END) as sales
       FROM call_logs cl JOIN customers c ON c.id = cl.customer_id
       WHERE cl.called_at >= ${since} AND c.price_sensitivity IS NOT NULL AND ${clFilter.condition.replace('call_logs.brand_id', 'cl.brand_id')}
       GROUP BY c.price_sensitivity`,
      ...paramsCall
    );

    const conversionByPriceSensitivity = conversionByPriceSensitivityRows.map((s) => ({
      ...s,
      conversion: s.calls > 0 ? Math.round((s.sales / s.calls) * 1000) / 10 : 0,
    }));

    const tagsFilter = getBrandCondition(req, "customer_tags");
    const paramsTags = tagsFilter.params || (tagsFilter.param ? [tagsFilter.param] : []);

    const trendingTags = await db.all(
      `SELECT customer_tags.tag, customer_tags.tag_type, COUNT(*) as count FROM customer_tags WHERE ${tagsFilter.condition} GROUP BY customer_tags.tag, customer_tags.tag_type ORDER BY count DESC LIMIT 15`,
      ...paramsTags
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
