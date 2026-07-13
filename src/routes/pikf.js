import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { calculatePerformanceScore, evaluateBadges, awardManualBadge, generateLeaderboards } from "../services/pikfService.js";

const router = express.Router();
router.use(requireAuth);

// 1. Get My Scorecard (Agent View)
router.get("/my-score", async (req, res, next) => {
  try {
    const { score, breakdown } = await calculatePerformanceScore(req.user.id);
    const badges = await db.all("SELECT badge_name, badge_type, reason, awarded_at FROM pikf_badges WHERE agent_id = ? ORDER BY awarded_at DESC", req.user.id);
    const coaching = await db.all("SELECT reason, status, created_at FROM pikf_coaching_plans WHERE agent_id = ? AND status = 'active'", req.user.id);
    
    // Auto-evaluate badges while we're fetching their score
    const newBadges = await evaluateBadges(req.user.id);

    res.json({ score, breakdown, badges: [...newBadges, ...badges], coaching });
  } catch (err) {
    next(err);
  }
});

// 2. Get Leaderboards
router.get("/leaderboards", async (req, res, next) => {
  try {
    const brandId = req.query.brandId || null;
    const leaders = await generateLeaderboards(brandId);
    res.json({ leaders });
  } catch (err) {
    next(err);
  }
});

// 3. Get Definitions & Global Targets
router.get("/definitions", async (req, res, next) => {
  try {
    const kpis = await db.all("SELECT * FROM pikf_kpi_definitions");
    res.json({ kpis });
  } catch (err) {
    next(err);
  }
});

// 4. (Manager) Get Team Performance
router.get("/team-performance", async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    // For MVP, just return all agents if admin, or logic for specific team
    const teamAgents = await db.all("SELECT id, name, email FROM agents WHERE role = 'agent'");
    const teamScores = [];
    
    for (const agent of teamAgents) {
      const { score, breakdown } = await calculatePerformanceScore(agent.id);
      teamScores.push({ ...agent, score, breakdown });
    }
    
    res.json({ teamScores });
  } catch (err) {
    next(err);
  }
});

// 5. (Manager) Set Target
router.post("/targets", async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const { kpi_id, target_type, target_entity_id, period, target_value } = req.body;
    
    // Basic upsert pattern
    await db.run(
      "DELETE FROM pikf_targets WHERE kpi_id = ? AND target_entity_id = ? AND period = ?",
      [kpi_id, target_entity_id, period]
    );
    
    await db.run(
      "INSERT INTO pikf_targets (id, kpi_id, target_type, target_entity_id, period, target_value, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [`tgt_${Date.now()}`, kpi_id, target_type, target_entity_id, period, target_value, req.user.id]
    );
    
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 6. (Manager) Award Manual Badge
router.post("/badges/manual", async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const { agent_id, badge_name, reason } = req.body;
    const badgeId = await awardManualBadge(agent_id, req.user.id, badge_name, reason);
    res.json({ success: true, badgeId });
  } catch (err) {
    next(err);
  }
});

export default router;
