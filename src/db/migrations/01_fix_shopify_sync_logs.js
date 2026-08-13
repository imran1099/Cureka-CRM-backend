import 'dotenv/config';
import { db } from "../connection.js";

async function up() {
  console.log("Running migration: 01_fix_shopify_sync_logs...");
  try {
    const columns = await db.all("SHOW COLUMNS FROM shopify_sync_logs");
    const hasRecordsFailed = columns.some(col => col.Field === 'records_failed');
    
    if (!hasRecordsFailed) {
      console.log("Adding records_failed column to shopify_sync_logs...");
      await db.run("ALTER TABLE shopify_sync_logs ADD COLUMN records_failed INT NOT NULL DEFAULT 0");
      console.log("Added records_failed successfully.");
    } else {
      console.log("records_failed column already exists. Skipping.");
    }
  } catch (err) {
    console.error("Migration failed:", err);
    throw err;
  }
}

up().then(() => {
  console.log("Migration complete.");
  process.exit(0);
}).catch(() => {
  process.exit(1);
});
