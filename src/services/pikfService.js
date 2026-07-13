import { db } from "../db/connection.js";

// Helper to get actual performance metrics for an agent (Mocked actual logic for brevity)
async function getAgentMetrics(agentId) {
  // In a real system, these would be SUM() and COUNT() queries on tickets/orders/calls
  return {
    kpi_revenue: 15000, 
    kpi_conversion: 85,
    kpi_csat: 92,
    kpi_followup: 95,
    kpi_sla: 98,
    kpi_productivity: 120,
    kpi_quality: 90,
    kpi_attendance: 100
  };
}

export async function calculatePerformanceScore(agentId) {
  const definitions = await db.all("SELECT * FROM pikf_kpi_definitions");
  const metrics = await getAgentMetrics(agentId);
  const targets = await db.all("SELECT * FROM pikf_targets WHERE target_entity_id = ? AND period = 'monthly'", agentId);
  
  let totalScore = 0;
  let breakdown = {};
  
  for (const def of definitions) {
    const weight = parseFloat(def.default_weight);
    const actual = metrics[def.id] || 0;
    const targetRow = targets.find(t => t.kpi_id === def.id);
    const targetValue = targetRow ? parseFloat(targetRow.target_value) : null;
    
    let kpiScore = 0;
    
    if (targetValue) {
      // Calculate achievement percentage capping at 100%
      const achievement = Math.min(100, (actual / targetValue) * 100);
      kpiScore = (achievement / 100) * weight;
    } else {
      // If no target, assume full weight if they have *any* metric, else 0 (simplified)
      kpiScore = actual > 0 ? weight : 0;
    }
    
    totalScore += kpiScore;
    breakdown[def.id] = { weight, actual, target: targetValue, score_contribution: kpiScore };
  }
  
  // Save daily snapshot
  await db.run(
    "INSERT INTO pikf_performance_scores (id, agent_id, date, score, breakdown) VALUES (?, ?, CURDATE(), ?, ?)",
    [`score_${Date.now()}`, agentId, totalScore, JSON.stringify(breakdown)]
  );
  
  // Check Coaching Triggers
  await checkCoachingAlerts(agentId, totalScore, breakdown);
  
  return { score: totalScore, breakdown };
}

async function checkCoachingAlerts(agentId, totalScore, breakdown) {
  // Trigger if score < 60
  if (totalScore < 60) {
    await db.run(
      "INSERT INTO pikf_coaching_plans (id, agent_id, manager_id, reason) VALUES (?, ?, ?, ?)",
      [`coach_${Date.now()}`, agentId, 'mgr_system', `Performance Score dropped to ${totalScore.toFixed(1)} (Critical)`]
    );
  }
  
  // Trigger if any metric is >20% below target
  for (const [kpiId, data] of Object.entries(breakdown)) {
    if (data.target) {
      const achievement = (data.actual / data.target) * 100;
      if (achievement < 80) {
        await db.run(
          "INSERT INTO pikf_coaching_plans (id, agent_id, manager_id, reason) VALUES (?, ?, ?, ?)",
          [`coach_${Date.now()}_${kpiId}`, agentId, 'mgr_system', `Missed ${kpiId} target by more than 20% (Achieved: ${achievement.toFixed(1)}%)`]
        );
      }
    }
  }
}

export async function evaluateBadges(agentId) {
  const metrics = await getAgentMetrics(agentId);
  const existingBadges = await db.all("SELECT badge_name FROM pikf_badges WHERE agent_id = ?", agentId);
  const hasBadge = (name) => existingBadges.some(b => b.badge_name === name);
  
  const awards = [];
  
  // Auto-award: Top Seller (Revenue > 10000)
  if (metrics.kpi_revenue > 10000 && !hasBadge('Top Seller')) {
    awards.push({ name: 'Top Seller', reason: 'Generated over $10,000 in revenue.' });
  }
  
  // Auto-award: Customer Champion (CSAT > 90)
  if (metrics.kpi_csat > 90 && !hasBadge('Customer Champion')) {
    awards.push({ name: 'Customer Champion', reason: 'Achieved >90% CSAT.' });
  }
  
  // Auto-award: Perfect SLA (SLA > 95)
  if (metrics.kpi_sla > 95 && !hasBadge('Perfect SLA')) {
    awards.push({ name: 'Perfect SLA', reason: 'Maintained >95% SLA compliance.' });
  }
  
  for (const a of awards) {
    await db.run(
      "INSERT INTO pikf_badges (id, agent_id, badge_name, badge_type, reason) VALUES (?, ?, ?, 'auto', ?)",
      [`bdg_${Date.now()}_${Math.random()}`, agentId, a.name, a.reason]
    );
  }
  
  return awards;
}

export async function awardManualBadge(agentId, managerId, badgeName, reason) {
  const id = `bdg_${Date.now()}`;
  await db.run(
    "INSERT INTO pikf_badges (id, agent_id, badge_name, badge_type, awarded_by, reason) VALUES (?, ?, ?, 'manual', ?, ?)",
    [id, agentId, badgeName, managerId, reason]
  );
  return id;
}

export async function generateLeaderboards(brandId = null) {
  // In a real scenario, this would aggregate `pikf_performance_scores` across all agents for the current period.
  // For V1, we mock returning a sorted list of agents.
  let sql = `
    SELECT a.id, a.name, a.role, a.brand_id, COALESCE(s.score, 0) as score
    FROM agents a
    LEFT JOIN pikf_performance_scores s ON a.id = s.agent_id AND s.date = CURDATE()
    WHERE a.role = 'agent'
  `;
  const params = [];
  
  if (brandId) {
    sql += ` AND a.brand_id = ?`;
    params.push(brandId);
  }
  
  sql += ` ORDER BY score DESC`;
  return await db.all(sql, ...params);
}
