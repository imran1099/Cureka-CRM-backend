import { db } from "../db/connection.js";

// Fetch Dashboard layout based on role
export async function getDashboardForRole(role) {
  // Try to find an exact role match, or default to Executive
  let dashboard = await db.get("SELECT * FROM bi_dashboards WHERE role_type = ? LIMIT 1", role);
  
  if (!dashboard) {
    dashboard = await db.get("SELECT * FROM bi_dashboards WHERE is_default = 1 ORDER BY id ASC LIMIT 1");
  }
  
  if (!dashboard) return null;

  const widgets = await db.all("SELECT * FROM bi_widgets WHERE dashboard_id = ? ORDER BY grid_y ASC, grid_x ASC", dashboard.id);
  
  return { ...dashboard, widgets };
}

// Global filter query builder
function applyFilters(sql, params, filters, alias = '') {
  let modifiedSql = sql;
  const prefix = alias ? `${alias}.` : '';
  
  if (filters.brand_id) {
    modifiedSql += ` AND ${prefix}brand_id = ?`;
    params.push(filters.brand_id);
  }
  if (filters.agent_id) {
    modifiedSql += ` AND ${prefix}agent_id = ?`;
    params.push(filters.agent_id);
  }
  
  // Date filters
  if (filters.date_range === 'today') {
    modifiedSql += ` AND DATE(${prefix}created_at) = CURDATE()`;
  } else if (filters.date_range === '7d') {
    modifiedSql += ` AND ${prefix}created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`;
  } else if (filters.date_range === '30d') {
    modifiedSql += ` AND ${prefix}created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`;
  } else if (filters.date_range === 'month') {
    modifiedSql += ` AND MONTH(${prefix}created_at) = MONTH(CURDATE()) AND YEAR(${prefix}created_at) = YEAR(CURDATE())`;
  }
  
  return { sql: modifiedSql, params };
}

// Master Aggregation Function
export async function calculateKPI(kpiId, filters = {}, userId = null) {
  try {
    switch (kpiId) {
      
      case 'revenue_today': {
        const query = applyFilters(`SELECT SUM(total_price) as val FROM shopify_orders WHERE DATE(created_at) = CURDATE()`, [], filters);
        const res = await db.get(query.sql, ...query.params);
        return { value: res?.val || 0, type: 'currency' };
      }

      case 'orders_today': {
        const query = applyFilters(`SELECT COUNT(*) as val FROM shopify_orders WHERE DATE(created_at) = CURDATE()`, [], filters);
        const res = await db.get(query.sql, ...query.params);
        return { value: res?.val || 0, type: 'number' };
      }

      case 'csat_score': {
        return { value: 94.2, type: 'percentage', suffix: '%' }; // Simulated CSAT
      }

      case 'open_cases': {
        const query = applyFilters(`SELECT COUNT(*) as val FROM tickets WHERE status != 'closed'`, [], filters);
        const res = await db.get(query.sql, ...query.params);
        return { value: res?.val || 0, type: 'number' };
      }

      case 'revenue_trend': {
        // Last 7 days grouped by date
        const sql = `
          SELECT DATE(created_at) as name, SUM(total_price) as Revenue 
          FROM shopify_orders 
          WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
          GROUP BY DATE(created_at)
          ORDER BY DATE(created_at) ASC
        `;
        const res = await db.all(sql);
        return { data: res };
      }

      case 'revenue_by_brand': {
        const sql = `
          SELECT b.name as name, SUM(o.total_price) as value 
          FROM shopify_orders o
          JOIN brands b ON o.brand_id = b.id
          GROUP BY b.name
        `;
        const res = await db.all(sql);
        return { data: res };
      }

      case 'agent_leaderboard': {
        const sql = `
          SELECT a.name, COUNT(c.id) as calls, 0 as revenue, '95%' as csat
          FROM agents a
          LEFT JOIN calls c ON a.id = c.agent_id
          GROUP BY a.id
          ORDER BY calls DESC
          LIMIT 5
        `;
        const res = await db.all(sql);
        return { data: res };
      }

      // ─── AGENT SPECIFIC KPIs ──────────────────────────────────────────────
      
      case 'my_calls_assigned': {
        const sql = `SELECT COUNT(*) as val FROM calls WHERE agent_id = ? AND DATE(created_at) = CURDATE()`;
        const res = await db.get(sql, userId);
        return { value: res?.val || 0, type: 'number' };
      }

      case 'my_calls_completed': {
        const sql = `SELECT COUNT(*) as val FROM calls WHERE agent_id = ? AND status = 'completed' AND DATE(created_at) = CURDATE()`;
        const res = await db.get(sql, userId);
        return { value: res?.val || 0, type: 'number' };
      }

      case 'my_revenue': {
        // Simulated: agents might generate revenue through specific tagged orders
        return { value: 0, type: 'currency' };
      }

      case 'my_open_cases': {
        const sql = `SELECT COUNT(*) as val FROM tickets WHERE assigned_to = ? AND status != 'closed'`;
        const res = await db.get(sql, userId);
        return { value: res?.val || 0, type: 'number' };
      }

      case 'my_quick_actions': {
        return { data: [] }; // The UI handles quick action routing, no DB query needed
      }

      default:
        return { value: 0, type: 'string' };
    }
  } catch (err) {
    console.error(`Error calculating KPI ${kpiId}:`, err);
    return { value: 0, type: 'error' };
  }
}

// Insights Generator
export async function generateInsights(filters = {}) {
  // A dynamic rule-based insights engine
  const insights = [];
  
  // Rule 1: Revenue vs Yesterday
  const todayQuery = applyFilters(`SELECT SUM(total_price) as val FROM shopify_orders WHERE DATE(created_at) = CURDATE()`, [], filters);
  const yestQuery = applyFilters(`SELECT SUM(total_price) as val FROM shopify_orders WHERE DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`, [], filters);
  
  const [todayRes, yestRes] = await Promise.all([
    db.get(todayQuery.sql, ...todayQuery.params),
    db.get(yestQuery.sql, ...yestQuery.params)
  ]);
  
  const todayRev = todayRes?.val || 0;
  const yestRev = yestRes?.val || 0;
  
  if (todayRev > yestRev && yestRev > 0) {
    const pct = (((todayRev - yestRev) / yestRev) * 100).toFixed(1);
    insights.push(`Revenue is trending up! 📈 ${pct}% higher than yesterday.`);
  } else if (todayRev < yestRev && yestRev > 0) {
    const pct = (((yestRev - todayRev) / yestRev) * 100).toFixed(1);
    insights.push(`Revenue dropped by ${pct}% compared to yesterday. Watch closely.`);
  } else {
    insights.push(`Revenue is stable compared to yesterday.`);
  }
  
  // Rule 2: Open Cases Warning
  const casesQuery = applyFilters(`SELECT COUNT(*) as val FROM tickets WHERE status = 'open'`, [], filters);
  const casesRes = await db.get(casesQuery.sql, ...casesQuery.params);
  if (casesRes?.val > 50) {
    insights.push(`High volume of open tickets (${casesRes.val}). Consider reallocating agents.`);
  }
  
  return insights;
}
