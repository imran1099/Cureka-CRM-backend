import 'dotenv/config';
import { db } from './src/db/connection.js';

async function testSchema() {
  const storeId = "test_store_123";
  const brandId = "test_brand_456";
  const logId = "test_log_789";
  const syncType = "orders";

  try {
    // Cleanup any previous test run
    await db.run("DELETE FROM shopify_sync_logs WHERE id = ?", logId);
    await db.run("DELETE FROM shopify_stores WHERE id = ?", storeId);
    await db.run("DELETE FROM brands WHERE id = ?", brandId);

    // 1. Setup mock store & brand
    await db.run("INSERT IGNORE INTO brands (id, name, short_code) VALUES (?, ?, ?)", brandId, "Test Brand", "TST");
    await db.run("INSERT IGNORE INTO shopify_stores (id, brand_id, store_url) VALUES (?, ?, ?)", storeId, brandId, "test.myshopify.com");

    console.log("Mock data inserted.");

    // 2. Test INSERT (like shopifyBulkImportService.js)
    await db.run(
      "INSERT INTO shopify_sync_logs (id, brand_id, sync_type, status) VALUES (?, ?, ?, 'running')",
      logId, brandId, syncType
    );
    console.log("INSERT successful (brand_id, sync_type, status)");

    // 3. Test UPDATE (like shopifyBulkImportService.js checkBulkImportStatus)
    const processed = 50;
    const failed = 2; // Testing the new records_failed column
    await db.run(
      "UPDATE shopify_sync_logs SET status = 'completed', records_processed = ?, records_failed = ?, completed_at = NOW() WHERE id = ?",
      processed, failed, logId
    );
    console.log("UPDATE successful (records_processed, records_failed)");

    // 4. Test SELECT (like shopify.js GET /logs/:storeId)
    const store = await db.get("SELECT brand_id FROM shopify_stores WHERE id = ?", storeId);
    if (!store) throw new Error("Store not found");
    
    const logs = await db.all("SELECT * FROM shopify_sync_logs WHERE brand_id = ? ORDER BY started_at DESC LIMIT 20", store.brand_id);
    console.log("SELECT successful. Found logs:", logs.length);
    console.log("First log:", logs[0]);
    
    process.exit(0);
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

testSchema();
