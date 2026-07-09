import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { createTimelineEvent } from "../services/timelineService.js";
import { processWorkflowRules } from "../services/followupService.js";

const router = express.Router();
router.use(requireAuth);

// ─── Brand Filter Helper ──────────────────────────────────────────────────────
function buildBrandFilter(req, alias = "o") {
  const ids = req.user.brands || [];
  if (!ids.length) return { where: "1=1", params: [] };
  const placeholders = ids.map(() => "?").join(",");
  return { where: `${alias}.brand_id IN (${placeholders})`, params: [...ids] };
}

// ─── GET /api/cre/stages ──────────────────────────────────────────────────────
router.get("/stages", async (req, res, next) => {
  try {
    const stages = await db.all(
      "SELECT * FROM opportunity_stages WHERE is_active = 1 ORDER BY sort_order ASC"
    );
    res.json({ stages });
  } catch (err) { next(err); }
});

// ─── POST /api/cre/stages ────────────────────────────────────────────────────
router.post("/stages", async (req, res, next) => {
  try {
    const { name, sort_order, color, is_won, is_lost } = req.body;
    const id = "stage_" + nanoid(10);
    await db.run(
      "INSERT INTO opportunity_stages (id, name, sort_order, color, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?)",
      id, name, sort_order || 10, color || "#6B7280", is_won ? 1 : 0, is_lost ? 1 : 0
    );
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── GET /api/cre/pipeline ─────────────────────────────────────────────────
// Kanban grouped by stage
router.get("/pipeline", requireBrandAccess, async (req, res, next) => {
  try {
    const bf = buildBrandFilter(req);
    const stages = await db.all(
      "SELECT * FROM opportunity_stages WHERE is_active = 1 ORDER BY sort_order ASC"
    );
    const opps = await db.all(
      `SELECT o.*, c.name as customer_name, c.phone, c.segment, c.ltv, c.health_score,
              a.name as agent_name, s.name as stage_name, s.color as stage_color
       FROM opportunities o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN agents a ON a.id = o.assigned_agent_id
       JOIN opportunity_stages s ON s.id = o.stage_id
       WHERE o.outcome = 'open' AND ${bf.where}
       ORDER BY o.updated_at DESC`,
      ...bf.params
    );

    const grouped = stages.map(s => ({
      ...s,
      opportunities: opps.filter(o => o.stage_id === s.id),
    }));

    res.json({ pipeline: grouped });
  } catch (err) { next(err); }
});

// ─── GET /api/cre/opportunities ──────────────────────────────────────────────
router.get("/opportunities", requireBrandAccess, async (req, res, next) => {
  try {
    const bf = buildBrandFilter(req);
    const { stage_id, type, outcome = "open", search } = req.query;

    let conditions = [bf.where, "o.outcome = ?"];
    let params = [...bf.params, outcome];

    if (stage_id) { conditions.push("o.stage_id = ?"); params.push(stage_id); }
    if (type)     { conditions.push("o.type = ?");     params.push(type); }
    if (search)   { conditions.push("c.name LIKE ?");  params.push(`%${search}%`); }

    const opps = await db.all(
      `SELECT o.*, c.name as customer_name, c.phone, c.segment, c.ltv,
              a.name as agent_name, s.name as stage_name, s.color as stage_color, s.sort_order
       FROM opportunities o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN agents a ON a.id = o.assigned_agent_id
       JOIN opportunity_stages s ON s.id = o.stage_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.sort_order ASC, o.updated_at DESC
       LIMIT 200`,
      ...params
    );
    res.json({ opportunities: opps });
  } catch (err) { next(err); }
});

// ─── POST /api/cre/opportunities ─────────────────────────────────────────────
router.post("/opportunities", requireBrandAccess, async (req, res, next) => {
  try {
    const { customer_id, brand_id, type, source, expected_revenue, priority, close_date, campaign_id } = req.body;
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });

    // Duplicate detection: open opp of same type for same customer
    const dupe = await db.get(
      "SELECT id FROM opportunities WHERE customer_id = ? AND type = ? AND outcome = 'open' LIMIT 1",
      customer_id, type || "general"
    );
    if (dupe) return res.status(409).json({ error: "An open opportunity of this type already exists for this customer", existing_id: dupe.id });

    const id = "opp_" + nanoid(12);
    const agentId = req.user.id;
    await db.run(
      `INSERT INTO opportunities
        (id, customer_id, brand_id, stage_id, type, source, assigned_agent_id, expected_revenue, priority, close_date, campaign_id)
       VALUES (?, ?, ?, 'stage_new_lead', ?, ?, ?, ?, ?, ?, ?)`,
      id, customer_id, brand_id || null, type || "general", source || "manual",
      agentId, expected_revenue || 0, priority || "medium", close_date || null, campaign_id || null
    );

    // Activity log: created
    await db.run(
      "INSERT INTO opportunity_activities (id, opportunity_id, agent_id, activity_type, description, to_stage) VALUES (?, ?, ?, ?, ?, ?)",
      "oa_" + nanoid(10), id, agentId, "created", "Opportunity created", "stage_new_lead"
    );

    // Timeline event (replaces old broken insert)
    createTimelineEvent({
      customerId: customer_id, brandId: brand_id || null,
      eventType: "opportunity_created",
      eventTitle: `New ${type || "general"} opportunity opened`,
      eventDescription: `Source: ${source || "manual"}. Expected revenue: ₹${expected_revenue || 0}.`,
      agentId, sourceSystem: "cre", refId: id, refType: "opportunity",
    }).catch(() => {});

    // Workflow automation
    processWorkflowRules("opportunity_created", {
      customerId: customer_id, brandId: brand_id || null,
      assignedAgentId: agentId, relatedOpportunityId: id,
    }).catch(() => {});

    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── GET /api/cre/opportunities/:id ──────────────────────────────────────────
router.get("/opportunities/:id", async (req, res, next) => {
  try {
    const opp = await db.get(
      `SELECT o.*, c.name as customer_name, c.phone, c.segment, c.ltv, c.health_score,
              c.last_order_date, c.product_preferences,
              a.name as agent_name, s.name as stage_name, s.color as stage_color, s.is_won, s.is_lost
       FROM opportunities o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN agents a ON a.id = o.assigned_agent_id
       JOIN opportunity_stages s ON s.id = o.stage_id
       WHERE o.id = ?`,
      req.params.id
    );
    if (!opp) return res.status(404).json({ error: "Opportunity not found" });

    const [activities, followups, purchaseHistory] = await Promise.all([
      db.all(
        `SELECT oa.*, a.name as agent_name FROM opportunity_activities oa
         LEFT JOIN agents a ON a.id = oa.agent_id
         WHERE oa.opportunity_id = ? ORDER BY oa.created_at DESC`,
        req.params.id
      ),
      db.all(
        "SELECT * FROM opportunity_followups WHERE opportunity_id = ? ORDER BY due_date ASC",
        req.params.id
      ),
      db.all(
        "SELECT * FROM purchase_history WHERE customer_id = ? ORDER BY order_date DESC LIMIT 5",
        opp.customer_id
      ),
    ]);

    // Simple product recommendations based on last product
    const recommendations = [];
    if (purchaseHistory.length > 0) {
      recommendations.push({ label: "Repeat Purchase", product: purchaseHistory[0].product_name });
      if (purchaseHistory[0].amount > 500) {
        recommendations.push({ label: "Bundle Upsell", product: `${purchaseHistory[0].product_name} Bundle` });
      }
    }

    res.json({ opportunity: opp, activities, followups, purchaseHistory, recommendations });
  } catch (err) { next(err); }
});

// ─── PATCH /api/cre/opportunities/:id ────────────────────────────────────────
router.patch("/opportunities/:id", async (req, res, next) => {
  try {
    const { stage_id, outcome, lost_reason, order_id, expected_revenue, probability, priority, close_date } = req.body;
    const agentId = req.user.id;

    const opp = await db.get("SELECT * FROM opportunities WHERE id = ?", req.params.id);
    if (!opp) return res.status(404).json({ error: "Opportunity not found" });

    // Validation: Lost requires reason
    if (outcome === "lost" && !lost_reason) {
      return res.status(400).json({ error: "lost_reason is required when marking as lost" });
    }
    // Validation: Won requires a valid order_id
    const finalOrderId = order_id || opp.order_id;
    let isWon = outcome === "won";
    let toStage = null;
    let fromStage = null;
    if (stage_id && stage_id !== opp.stage_id) {
      toStage = await db.get("SELECT name, is_won, is_lost FROM opportunity_stages WHERE id = ?", stage_id);
      fromStage = await db.get("SELECT name FROM opportunity_stages WHERE id = ?", opp.stage_id);
      if (toStage?.is_won) isWon = true;
    } else {
      const currStage = await db.get("SELECT is_won FROM opportunity_stages WHERE id = ?", opp.stage_id);
      if (currStage?.is_won) isWon = true;
    }

    if (isWon) {
      if (!finalOrderId) return res.status(400).json({ error: "order_id is required when marking as won" });
      const orderExists = await db.get("SELECT id FROM orders WHERE id = ?", finalOrderId);
      if (!orderExists) return res.status(400).json({ error: "Invalid order_id. Order not found in database." });
    }

    const newStageId = stage_id || opp.stage_id;
    const stageChanged = newStageId !== opp.stage_id;

    await db.run(
      `UPDATE opportunities SET
        stage_id = ?, outcome = COALESCE(?, outcome), lost_reason = COALESCE(?, lost_reason),
        order_id = COALESCE(?, order_id), expected_revenue = COALESCE(?, expected_revenue),
        probability = COALESCE(?, probability), priority = COALESCE(?, priority),
        close_date = COALESCE(?, close_date), last_activity_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      newStageId, outcome || null, lost_reason || null, order_id || null,
      expected_revenue || null, probability || null, priority || null,
      close_date || null, req.params.id
    );

    // Activity log
    if (stageChanged) {
      // toStage and fromStage already fetched in validation block
      if (!toStage) {
        toStage = await db.get("SELECT name, is_won, is_lost FROM opportunity_stages WHERE id = ?", newStageId);
        fromStage = await db.get("SELECT name FROM opportunity_stages WHERE id = ?", opp.stage_id);
      }
      await db.run(
        "INSERT INTO opportunity_activities (id, opportunity_id, agent_id, activity_type, description, from_stage, to_stage) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "oa_" + nanoid(10), req.params.id, agentId, "stage_change",
        `Stage changed: ${fromStage?.name} → ${toStage?.name}`, opp.stage_id, newStageId
      );

      // Timeline: stage change event
      if (toStage?.is_won) {
        createTimelineEvent({
          customerId: opp.customer_id, brandId: opp.brand_id,
          eventType: "deal_won",
          eventTitle: `Deal won 🏆 — Order ${order_id || opp.order_id}`,
          eventDescription: `Opportunity converted at ₹${expected_revenue || opp.expected_revenue || 0}. Order ID: ${order_id || opp.order_id}.`,
          agentId, sourceSystem: "cre", refId: req.params.id, refType: "opportunity",
          outcome: "won",
        }).catch(() => {});
      } else if (toStage?.is_lost) {
        createTimelineEvent({
          customerId: opp.customer_id, brandId: opp.brand_id,
          eventType: "deal_lost",
          eventTitle: `Deal lost — ${lost_reason || "No reason given"}`,
          eventDescription: lost_reason,
          agentId, sourceSystem: "cre", refId: req.params.id, refType: "opportunity",
          outcome: "lost",
        }).catch(() => {});
      } else {
        createTimelineEvent({
          customerId: opp.customer_id, brandId: opp.brand_id,
          eventType: "stage_change",
          eventTitle: `Pipeline stage: ${fromStage?.name} → ${toStage?.name}`,
          agentId, sourceSystem: "cre", refId: req.params.id, refType: "opportunity",
        }).catch(() => {});
      }

      // Revenue attribution on Won
      if (toStage?.is_won && (order_id || opp.order_id)) {
        const attrId = "ra_" + nanoid(10);
        await db.run(
          "INSERT INTO revenue_attribution (id, opportunity_id, order_id, agent_id, brand_id, campaign_id, source, type, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          attrId, req.params.id, order_id || opp.order_id, agentId,
          opp.brand_id, opp.campaign_id, opp.source, opp.type, expected_revenue || opp.expected_revenue || 0
        );
        // Update campaign revenue if linked
        if (opp.campaign_id) {
          await db.run(
            "UPDATE cre_campaigns SET revenue_achieved = revenue_achieved + ? WHERE id = ?",
            expected_revenue || opp.expected_revenue || 0, opp.campaign_id
          );
        }
      }
    } else if (outcome) {
      await db.run(
        "INSERT INTO opportunity_activities (id, opportunity_id, agent_id, activity_type, description) VALUES (?, ?, ?, ?, ?)",
        "oa_" + nanoid(10), req.params.id, agentId, "outcome_update",
        `Outcome set to: ${outcome}${lost_reason ? ` — ${lost_reason}` : ""}`
      );
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── POST /api/cre/opportunities/:id/activities ───────────────────────────────
router.post("/opportunities/:id/activities", async (req, res, next) => {
  try {
    const { activity_type, description, metadata } = req.body;
    const id = "oa_" + nanoid(10);
    await db.run(
      "INSERT INTO opportunity_activities (id, opportunity_id, agent_id, activity_type, description, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      id, req.params.id, req.user.id, activity_type || "note", description, metadata ? JSON.stringify(metadata) : null
    );
    await db.run("UPDATE opportunities SET last_activity_at = NOW(), updated_at = NOW() WHERE id = ?", req.params.id);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── POST /api/cre/opportunities/:id/followups ───────────────────────────────
router.post("/opportunities/:id/followups", async (req, res, next) => {
  try {
    const { due_date, follow_up_type, notes } = req.body;
    if (!due_date) return res.status(400).json({ error: "due_date is required" });
    if (new Date(due_date) <= new Date()) return res.status(400).json({ error: "Follow-up date must be in the future" });

    const id = "of_" + nanoid(10);
    await db.run(
      "INSERT INTO opportunity_followups (id, opportunity_id, assigned_agent_id, due_date, follow_up_type, notes) VALUES (?, ?, ?, ?, ?, ?)",
      id, req.params.id, req.user.id, due_date, follow_up_type || "call", notes || null
    );
    await db.run(
      "UPDATE opportunities SET next_followup_at = ?, last_activity_at = NOW(), updated_at = NOW() WHERE id = ?",
      due_date, req.params.id
    );
    await db.run(
      "INSERT INTO opportunity_activities (id, opportunity_id, agent_id, activity_type, description) VALUES (?, ?, ?, ?, ?)",
      "oa_" + nanoid(10), req.params.id, req.user.id, "followup_scheduled",
      `Follow-up scheduled for ${new Date(due_date).toLocaleString()}`
    );
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// ─── GET /api/cre/analytics ───────────────────────────────────────────────────
router.get("/analytics", requireBrandAccess, async (req, res, next) => {
  try {
    const bf = buildBrandFilter(req, "r");

    const revByAgent = await db.all(
      `SELECT a.name as agent_name, SUM(r.amount) as total_revenue, COUNT(r.id) as conversions
       FROM revenue_attribution r
       JOIN agents a ON a.id = r.agent_id
       WHERE ${bf.where}
       GROUP BY r.agent_id ORDER BY total_revenue DESC`,
      ...bf.params
    );

    const revByBrand = await db.all(
      `SELECT b.name as brand_name, SUM(r.amount) as total_revenue
       FROM revenue_attribution r
       JOIN brands b ON b.id = r.brand_id
       WHERE ${bf.where}
       GROUP BY r.brand_id ORDER BY total_revenue DESC`,
      ...bf.params
    );

    const bfO = buildBrandFilter(req, "o");
    const pipelineStats = await db.all(
      `SELECT s.name as stage_name, s.color, COUNT(o.id) as count,
              SUM(o.expected_revenue) as pipeline_value,
              AVG(o.probability) as avg_probability
       FROM opportunities o
       JOIN opportunity_stages s ON s.id = o.stage_id
       WHERE o.outcome = 'open' AND ${bfO.where}
       GROUP BY o.stage_id ORDER BY s.sort_order ASC`,
      ...bfO.params
    );

    const totals = await db.get(
      `SELECT COUNT(id) as total, SUM(CASE WHEN outcome='won' THEN 1 ELSE 0 END) as won,
              SUM(CASE WHEN outcome='lost' THEN 1 ELSE 0 END) as lost,
              SUM(expected_revenue) as total_pipeline_value
       FROM opportunities o WHERE ${bfO.where}`,
      ...bfO.params
    );

    const campaigns = await db.all(
      "SELECT * FROM cre_campaigns ORDER BY created_at DESC LIMIT 10"
    );

    res.json({ revByAgent, revByBrand, pipelineStats, totals, campaigns });
  } catch (err) { next(err); }
});

// ─── Campaign CRUD ────────────────────────────────────────────────────────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const campaigns = await db.all(`
      SELECT c.*, b.name as brand_name,
             (SELECT COUNT(id) FROM opportunities WHERE campaign_id = c.id) as total_opps,
             (SELECT COUNT(id) FROM opportunities WHERE campaign_id = c.id AND outcome = 'won') as won_opps
      FROM cre_campaigns c LEFT JOIN brands b ON b.id = c.brand_id
      ORDER BY c.created_at DESC
    `);
    res.json({ campaigns });
  } catch (err) { next(err); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const { name, brand_id, type, description, start_date, end_date, revenue_target } = req.body;
    const id = "camp_" + nanoid(10);
    await db.run(
      "INSERT INTO cre_campaigns (id, name, brand_id, type, description, start_date, end_date, revenue_target, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, name, brand_id || null, type || null, description || null,
      start_date || null, end_date || null, revenue_target || 0, req.user.id
    );
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.patch("/campaigns/:id", async (req, res, next) => {
  try {
    const { name, brand_id, type, description, start_date, end_date, revenue_target, is_active } = req.body;
    await db.run(
      `UPDATE cre_campaigns SET
       name = COALESCE(?, name), brand_id = COALESCE(?, brand_id), type = COALESCE(?, type),
       description = COALESCE(?, description), start_date = COALESCE(?, start_date),
       end_date = COALESCE(?, end_date), revenue_target = COALESCE(?, revenue_target),
       is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      name, brand_id, type, description, start_date, end_date, revenue_target, is_active, req.params.id
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete("/campaigns/:id", async (req, res, next) => {
  try {
    await db.run("DELETE FROM cre_campaigns WHERE id = ?", req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── Product Recommendations ──────────────────────────────────────────────────
router.get("/recommendations/:customerId", async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 5;
    
    const recs = await db.all(
      `SELECT r.*, p.name, p.price, p.image_url, p.category 
       FROM product_recommendations r
       JOIN products p ON p.id = r.product_id
       WHERE r.customer_id = ? 
       ORDER BY r.score DESC LIMIT ?`,
      customerId, limit
    );

    if (recs.length > 0) {
      return res.json({ recommendations: recs });
    }

    const fallback = await db.all(
      `SELECT p.id as product_id, p.name, p.price, p.image_url, p.category, 'fallback' as recommendation_type, 1.0 as score
       FROM products p
       WHERE p.is_active = 1
       ORDER BY RAND() LIMIT ?`,
      limit
    );
    res.json({ recommendations: fallback });
  } catch (err) { next(err); }
});

// ─── AI Analytics (Stub) ────────────────────────────────────────────────────
router.get("/ai-forecast", async (req, res, next) => {
  try {
    res.json({
      forecast: {
        expected_monthly_revenue: 150000,
        confidence_interval: "85%",
        top_growth_segment: "Sleep Care (Repeat Purchasers)",
        churn_risk_accounts: 12
      }
    });
  } catch (err) { next(err); }
});

export default router;
