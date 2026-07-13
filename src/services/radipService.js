import { db } from "../db/connection.js";

// Helper to safely apply global filters (Date, Brand, etc.)
function applyFilters(sql, params, filters = {}) {
  let modifiedSql = sql;
  
  if (filters.brand_id) {
    modifiedSql += ` AND brand_id = ?`;
    params.push(filters.brand_id);
  }
  
  if (filters.date_range) {
    if (filters.date_range === 'today') {
      modifiedSql += ` AND DATE(created_at) = CURDATE()`;
    } else if (filters.date_range === '7d') {
      modifiedSql += ` AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`;
    } else if (filters.date_range === '30d') {
      modifiedSql += ` AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`;
    }
  }

  return { sql: modifiedSql, params };
}

// Executes pre-defined standard reports
export async function executeStandardReport(reportId, filters = {}) {
  let sql = "";
  let params = [];

  switch (reportId) {
    case 'std_01': // Revenue by Brand
      sql = `SELECT b.name as brand, SUM(o.total_price) as total_revenue, COUNT(o.id) as total_orders
             FROM shopify_orders o
             JOIN brands b ON o.brand_id = b.id
             WHERE 1=1`;
      const r1 = applyFilters(sql, params, filters);
      r1.sql += ` GROUP BY b.name ORDER BY total_revenue DESC`;
      return await db.all(r1.sql, ...r1.params);

    case 'std_02': // Agent Leaderboard
      sql = `SELECT a.name as agent, COUNT(c.id) as total_calls, SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) as completed_calls
             FROM agents a
             LEFT JOIN calls c ON a.id = c.agent_id
             WHERE 1=1`;
      const r2 = applyFilters(sql, params, filters);
      r2.sql += ` GROUP BY a.name ORDER BY total_calls DESC`;
      return await db.all(r2.sql, ...r2.params);

    case 'std_03': // Open vs Closed Cases
      sql = `SELECT status, COUNT(*) as count 
             FROM tickets 
             WHERE 1=1`;
      const r3 = applyFilters(sql, params, filters);
      r3.sql += ` GROUP BY status`;
      return await db.all(r3.sql, ...r3.params);
      
    case 'std_04': // Sales Pipeline Report
      sql = `SELECT stage, COUNT(*) as count, SUM(value) as total_value
             FROM sales_opportunities
             WHERE 1=1`;
      const r4 = applyFilters(sql, params, filters);
      r4.sql += ` GROUP BY stage`;
      return await db.all(r4.sql, ...r4.params);

    case 'std_05': // Customer Lifetime Value (Mocked for speed)
      sql = `SELECT c.name, SUM(o.total_price) as lifetime_value, COUNT(o.id) as total_orders
             FROM customers c
             JOIN shopify_orders o ON c.id = o.customer_id
             WHERE 1=1`;
      const r5 = applyFilters(sql, params, filters);
      r5.sql += ` GROUP BY c.id ORDER BY lifetime_value DESC LIMIT 100`;
      return await db.all(r5.sql, ...r5.params);

    case 'std_06': // Abandoned Cart Recovery (Mocked table structure)
      sql = `SELECT 'Recovered' as status, COUNT(*) as count FROM tickets WHERE reason = 'Abandoned Cart' AND status = 'closed'
             UNION
             SELECT 'Lost' as status, COUNT(*) as count FROM tickets WHERE reason = 'Abandoned Cart' AND status != 'closed'`;
      return await db.all(sql);

    default:
      throw new Error(`Standard report ${reportId} not implemented`);
  }
}

// Safe schema mapping for Guided Builder
const ALLOWED_SOURCES = {
  'orders': { table: 'shopify_orders', dateCol: 'created_at' },
  'tickets': { table: 'tickets', dateCol: 'created_at' },
  'calls': { table: 'calls', dateCol: 'created_at' }
};

const ALLOWED_METRICS = {
  'count': 'COUNT(*)',
  'sum_revenue': 'SUM(total_price)'
};

// Guided Report Query Builder
export async function executeCustomReport(config, filters = {}) {
  // config format: { source: 'orders', dimension: 'brand_id', metric: 'sum_revenue' }
  const source = ALLOWED_SOURCES[config.source];
  if (!source) throw new Error("Invalid source");

  const metricSql = ALLOWED_METRICS[config.metric] || 'COUNT(*)';
  const dimension = config.dimension || '1'; // Default grouping

  // Minimal SQL Injection protection via allowlists
  let sql = `SELECT ${dimension} as dimension, ${metricSql} as metric_value FROM ${source.table} WHERE 1=1`;
  let params = [];
  
  const q = applyFilters(sql, params, filters);
  q.sql += ` GROUP BY ${dimension} ORDER BY metric_value DESC LIMIT 100`;

  return await db.all(q.sql, ...q.params);
}

// Extensible Export Interface (CSV for V1)
export async function exportReport(data, format = 'csv') {
  if (format === 'csv') {
    if (!data || data.length === 0) return "";
    
    // Extract headers
    const headers = Object.keys(data[0]);
    const csvRows = [];
    csvRows.push(headers.join(','));
    
    for (const row of data) {
      const values = headers.map(header => {
        const val = row[header];
        // Escape quotes and wrap in quotes if there's a comma
        const escaped = ('' + val).replace(/"/g, '""');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(','));
    }
    
    return csvRows.join('\\n');
  } else if (format === 'excel') {
    throw new Error("Excel export requires additional dependencies. Planned for V2.");
  } else if (format === 'pdf') {
    throw new Error("PDF export requires additional dependencies. Planned for V2.");
  } else {
    throw new Error(`Unsupported export format: ${format}`);
  }
}
