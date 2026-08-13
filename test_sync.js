import 'dotenv/config';
import { db } from './src/db/connection.js';
import { syncOrder } from './src/services/shopifySyncService.js';

async function runTest() {
  const storeId = "store_test"; // Not strictly used if we pass brandId directly, wait, syncCustomer uses storeId
  const brandId = "brand_test";

  // Dummy Store setup
  await db.run("INSERT IGNORE INTO brands (id, name, short_code) VALUES (?, ?, ?)", brandId, "Test Brand", "TB");

  const mockShopifyOrder = {
    id: "1001",
    name: "#1001",
    created_at: new Date().toISOString(),
    customer: {
      id: "999",
      email: "test@example.com",
      first_name: "Test",
      last_name: "User",
      phone: "1234567890"
    },
    line_items: [
      { id: "li_1", title: "Hygiene Kit", quantity: 2, price: "500" },
      { id: "li_2", title: "Vitamin C", quantity: 1, price: "300" },
      { id: "li_3", title: "Immunity Booster", quantity: 3, price: "900" }
    ]
  };

  console.log("Syncing mock order 1001...");
  const shopifyId = await syncOrder(storeId, mockShopifyOrder, brandId);
  console.log("Order synced. shopifyId:", shopifyId);

  const purchaseHistory = await db.all("SELECT * FROM purchase_history WHERE order_ref = ?", "1001");
  console.log("Purchase History Rows:", purchaseHistory.length);
  console.log(purchaseHistory.map(row => `${row.product_name} x${row.quantity} = ${row.amount}`));

  const customers = await db.all("SELECT * FROM customers WHERE shopify_customer_id = ?", "999");
  console.log("Customers matched:", customers.length);
  
  if (customers.length > 0) {
    const custId = customers[0].id;
    // Test the 360 endpoint logic locally
    const purchaseOrders = await db.all(
      `SELECT id, order_date, product_name, quantity, amount, order_ref
       FROM purchase_history WHERE customer_id = ? ORDER BY order_date DESC`,
      custId
    );
    const distinctOrders = new Set(purchaseOrders.map(o => o.order_ref || o.id)).size;
    const totalSpend = purchaseOrders.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    const aov = distinctOrders ? Math.round(totalSpend / distinctOrders) : 0;
    
    console.log("Customer 360 Analytics:");
    console.log("- Total Orders:", distinctOrders);
    console.log("- Total Spend:", totalSpend);
    console.log("- AOV:", aov);
  }

  console.log("\nRe-syncing exact same order to test idempotency...");
  await syncOrder(storeId, mockShopifyOrder, brandId);
  const reSyncPH = await db.all("SELECT * FROM purchase_history WHERE order_ref = ?", "1001");
  console.log("Purchase History Rows after re-sync:", reSyncPH.length);

  process.exit(0);
}

runTest().catch(console.error);
