import "dotenv/config";
import { pool } from './src/db/connection.js';

async function verify() {
  const checks = [
    { name: "Brands", query: "SELECT COUNT(*) as c FROM brands" },
    { name: "Agents", query: "SELECT COUNT(*) as c FROM agents" },
    { name: "Customers", query: "SELECT COUNT(*) as c FROM customers" },
    { name: "Customer Brands", query: "SELECT COUNT(*) as c FROM customer_brands" },
    { name: "Purchase History", query: "SELECT COUNT(*) as c FROM purchase_history" },
    { name: "Tickets", query: "SELECT COUNT(*) as c FROM tickets" },
    { name: "Follow-ups", query: "SELECT COUNT(*) as c FROM customer_followups" },
    { name: "Calls", query: "SELECT COUNT(*) as c FROM call_logs" },
    { name: "Opportunities (Timeline events)", query: "SELECT COUNT(*) as c FROM customer_timeline" },
    { name: "Notifications (UNCC)", query: "SELECT COUNT(*) as c FROM uncc_notifications" },
    { name: "Shopify Stores", query: "SELECT COUNT(*) as c FROM shopify_stores" },
    { name: "Shopify Customers", query: "SELECT COUNT(*) as c FROM shopify_customers" },
    { name: "KPI Definitions", query: "SELECT COUNT(*) as c FROM pikf_kpi_definitions" },
    { name: "Workflow Rules", query: "SELECT COUNT(*) as c FROM bawoe_workflows" },
    { name: "Audit Logs", query: "SELECT COUNT(*) as c FROM escams_audit_logs" },
  ];

  for (const check of checks) {
    try {
      const [rows] = await pool.query(check.query);
      console.log(`${check.name.padEnd(35)}: ${rows[0].c}`);
    } catch (err) {
      console.log(`${check.name.padEnd(35)}: ERROR - ${err.message}`);
    }
  }

  process.exit(0);
}

verify();
