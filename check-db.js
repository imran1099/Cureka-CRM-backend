import { pool } from './src/db/connection.js';

async function check() {
  try {
    const [callCols] = await pool.query("SHOW COLUMNS FROM call_logs");
    console.log("call_logs:", callCols.map(c => c.Field).join(", "));
  } catch (err) {
    console.log("call_logs error:", err.message);
  }

  try {
    const [shopCols] = await pool.query("SHOW COLUMNS FROM shopify_stores");
    console.log("shopify_stores:", shopCols.map(c => c.Field).join(", "));
  } catch (err) {
    console.log("shopify_stores error:", err.message);
  }
  process.exit(0);
}

check();
