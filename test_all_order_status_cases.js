import { db, pool } from "./src/db/connection.js";
import { parseCsvText, extractRowFields, normalizeStatus, ALLOWED_STATUSES } from "./src/routes/orders.js";
import axios from "axios";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "cureka-secret-key-production-2026";
const API_BASE = "http://localhost:4000/api";

function generateToken(role = "admin", permissions = ["orders:edit"]) {
  return jwt.sign(
    { id: "test_admin", role, permissions, brands: ["brand_HyPkZp2jyp", "brand_aSnj0oGaW1", "brand_jwyBi_zo60"] },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function runTests() {
  console.log("==========================================================");
  console.log("STARTING TEST SUITE: BULK ORDER STATUS UPDATE VIA CSV");
  console.log("==========================================================\n");

  const adminToken = generateToken("admin", ["orders:edit"]);
  const agentToken = jwt.sign(
    { id: "test_agent_no_orders", role: "agent", permissions: ["calls:make"], brands: ["brand_HyPkZp2jyp"] },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  const authHeaders = {
    headers: { Authorization: `Bearer ${adminToken}` }
  };

  // Record initial customer count
  const initialCustomerCount = (await db.get("SELECT COUNT(*) as c FROM customers")).c;
  const initialCustomerAarav = await db.get("SELECT * FROM customers WHERE phone = '+919876543210'");

  console.log(`[Baseline] Total Customers: ${initialCustomerCount}`);
  console.log(`[Baseline] Aarav Sharma Phone: ${initialCustomerAarav.phone}, Name: ${initialCustomerAarav.name}`);

  // Test 1: One customer with one order
  console.log("\n--- TEST 1: One customer with one order (ORD-11502 -> 'Delivered') ---");
  const test1Payload = {
    rows: [
      { "Customer Phone": "+919988776655", "Order ID": "ORD-11502", "Order Status": "Delivered" }
    ]
  };
  const res1 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test1Payload, authHeaders);
  console.log("Result Summary:", res1.data.summary);
  const ord11502 = await db.get("SELECT order_ref, status FROM purchase_history WHERE order_ref = 'ORD-11502'");
  console.log("DB status for ORD-11502:", ord11502.status);
  if (res1.data.summary.updatedCount === 1 && ord11502.status === "Delivered") {
    console.log("✅ TEST 1 PASSED");
  } else {
    console.error("❌ TEST 1 FAILED");
  }

  // Test 2: One customer with multiple orders and different statuses
  console.log("\n--- TEST 2: One customer with multiple orders and different statuses (ORD-9821 -> 'Delivered', ORD-10244 -> 'Shipped') ---");
  const test2Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Delivered" },
      { "Customer Phone": "+919876543210", "Order ID": "ORD-10244", "Order Status": "Shipped" }
    ]
  };
  const res2 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test2Payload, authHeaders);
  console.log("Result Summary:", res2.data.summary);
  const ord9821 = await db.get("SELECT order_ref, status FROM purchase_history WHERE order_ref = 'ORD-9821'");
  const ord10244 = await db.get("SELECT order_ref, status FROM purchase_history WHERE order_ref = 'ORD-10244'");
  console.log(`DB statuses: ORD-9821 = ${ord9821.status}, ORD-10244 = ${ord10244.status}`);
  if (res2.data.summary.updatedCount === 2 && ord9821.status === "Delivered" && ord10244.status === "Shipped") {
    console.log("✅ TEST 2 PASSED");
  } else {
    console.error("❌ TEST 2 FAILED");
  }

  // Test 3: Multiple customers with multiple orders
  console.log("\n--- TEST 3: Multiple customers with multiple orders ---");
  const test3Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Confirmed" },
      { "Customer Phone": "+919876543210", "Order ID": "ORD-10244", "Order Status": "Processing" },
      { "Customer Phone": "+919988776655", "Order ID": "ORD-11502", "Order Status": "Out for Delivery" }
    ]
  };
  const res3 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test3Payload, authHeaders);
  console.log("Result Summary:", res3.data.summary);
  if (res3.data.summary.updatedCount === 3) {
    console.log("✅ TEST 3 PASSED");
  } else {
    console.error("❌ TEST 3 FAILED");
  }

  // Test 4: Order ID not found
  console.log("\n--- TEST 4: Order ID not found (ORD-NON-EXISTENT-999) ---");
  const test4Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "ORD-NON-EXISTENT-999", "Order Status": "Delivered" }
    ]
  };
  const res4 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test4Payload, authHeaders);
  console.log("Result Summary:", res4.data.summary);
  console.log("Skipped reason:", res4.data.results[0]?.reason);
  if (res4.data.summary.skippedCount === 1 && res4.data.results[0].result === "skipped") {
    console.log("✅ TEST 4 PASSED (Correctly skipped non-existent order)");
  } else {
    console.error("❌ TEST 4 FAILED");
  }

  // Test 5: Duplicate Order ID in CSV
  console.log("\n--- TEST 5: Duplicate Order ID in CSV with conflicting statuses ---");
  const test5Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Delivered" },
      { "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Cancelled" }
    ]
  };
  const res5 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test5Payload, authHeaders);
  console.log("Result Summary:", res5.data.summary);
  console.log("Conflict reason:", res5.data.results[0]?.reason);
  if (res5.data.summary.failedCount >= 1 && res5.data.results[0].result === "failed") {
    console.log("✅ TEST 5 PASSED (Flagged conflicting duplicates without ambiguous update)");
  } else {
    console.error("❌ TEST 5 FAILED");
  }

  // Test 6: Invalid order status
  console.log("\n--- TEST 6: Invalid order status ('SomeUnknownRandomStatus') ---");
  const test6Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "SomeUnknownRandomStatus" }
    ]
  };
  const res6 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test6Payload, authHeaders);
  console.log("Result Summary:", res6.data.summary);
  console.log("Invalid status reason:", res6.data.results[0]?.reason);
  if (res6.data.summary.invalidStatusCount === 1 && res6.data.results[0].result === "failed") {
    console.log("✅ TEST 6 PASSED (Rejected invalid status value)");
  } else {
    console.error("❌ TEST 6 FAILED");
  }

  // Test 7: Empty Order ID
  console.log("\n--- TEST 7: Empty Order ID ---");
  const test7Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "", "Order Status": "Delivered" }
    ]
  };
  const res7 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test7Payload, authHeaders);
  console.log("Result Summary:", res7.data.summary);
  console.log("Empty Order ID reason:", res7.data.results[0]?.reason);
  if (res7.data.summary.failedCount === 1 && res7.data.results[0].reason.includes("Empty Order ID")) {
    console.log("✅ TEST 7 PASSED (Handled empty Order ID)");
  } else {
    console.error("❌ TEST 7 FAILED");
  }

  // Test 8: Empty status
  console.log("\n--- TEST 8: Empty status ---");
  const test8Payload = {
    rows: [
      { "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "" }
    ]
  };
  const res8 = await axios.post(`${API_BASE}/orders/bulk-status-update`, test8Payload, authHeaders);
  console.log("Result Summary:", res8.data.summary);
  console.log("Empty status reason:", res8.data.results[0]?.reason);
  if (res8.data.summary.failedCount === 1 && res8.data.results[0].reason.includes("Empty Order Status")) {
    console.log("✅ TEST 8 PASSED (Handled empty status)");
  } else {
    console.error("❌ TEST 8 FAILED");
  }

  // Test 9: Order already having the requested status
  console.log("\n--- TEST 9: Order already having the requested status ---");
  // First update ORD-9821 to 'Delivered'
  await axios.post(`${API_BASE}/orders/bulk-status-update`, {
    rows: [{ "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Delivered" }]
  }, authHeaders);
  // Send same status again
  const res9 = await axios.post(`${API_BASE}/orders/bulk-status-update`, {
    rows: [{ "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Delivered" }]
  }, authHeaders);
  console.log("Result Summary:", res9.data.summary);
  console.log("Unchanged reason:", res9.data.results[0]?.reason);
  if (res9.data.summary.unchangedCount === 1 && res9.data.results[0].result === "unchanged") {
    console.log("✅ TEST 9 PASSED (Correctly reported as unchanged)");
  } else {
    console.error("❌ TEST 9 FAILED");
  }

  // Test 10: Invalid CSV format
  console.log("\n--- TEST 10: Invalid CSV format (empty rows / corrupted input) ---");
  try {
    await axios.post(`${API_BASE}/orders/bulk-status-update`, { rows: [] }, authHeaders);
    console.error("❌ TEST 10 FAILED: Should have rejected empty rows array");
  } catch (err10) {
    if (err10.response && err10.response.status === 400) {
      console.log("Rejected empty array with 400 Bad Request:", err10.response.data.error);
      console.log("✅ TEST 10 PASSED (Rejected invalid CSV format)");
    } else {
      console.error("❌ TEST 10 FAILED:", err10.message);
    }
  }

  // Test 11: Unauthorized user attempting the update
  console.log("\n--- TEST 11: Unauthorized user attempting the update ---");
  try {
    await axios.post(
      `${API_BASE}/orders/bulk-status-update`,
      { rows: [{ "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Shipped" }] },
      { headers: { Authorization: `Bearer ${agentToken}` } }
    );
    console.error("❌ TEST 11 FAILED: Unauthorized user was not blocked");
  } catch (err11) {
    if (err11.response && (err11.response.status === 403 || err11.response.status === 401)) {
      console.log("Blocked unauthorized agent with status:", err11.response.status);
      console.log("✅ TEST 11 PASSED (Blocked unauthorized user)");
    } else {
      console.error("❌ TEST 11 FAILED:", err11.message);
    }
  }

  // Test 12: Large CSV upload (100 rows batch)
  console.log("\n--- TEST 12: Large CSV upload (Batch simulation) ---");
  const largeBatch = [];
  for (let k = 1; k <= 50; k++) {
    largeBatch.push({
      "Customer Phone": "+919876543210",
      "Order ID": `ORD-TEST-BATCH-${k}`,
      "Order Status": k % 2 === 0 ? "Delivered" : "Shipped"
    });
  }
  // Add our known orders to verify they update cleanly inside a large file
  largeBatch.push({ "Customer Phone": "+919876543210", "Order ID": "ORD-9821", "Order Status": "Returned" });
  largeBatch.push({ "Customer Phone": "+919876543210", "Order ID": "ORD-10244", "Order Status": "Refunded" });

  const res12 = await axios.post(`${API_BASE}/orders/bulk-status-update`, { rows: largeBatch }, authHeaders);
  console.log("Large Batch Summary:", res12.data.summary);
  if (res12.data.summary.totalRows === 52 && res12.data.summary.updatedCount === 2 && res12.data.summary.skippedCount === 50) {
    console.log("✅ TEST 12 PASSED (Large CSV handled efficiently, correctly updated known orders and skipped unknowns)");
  } else {
    console.error("❌ TEST 12 FAILED");
  }

  // Verify Data Integrity:
  console.log("\n--- FINAL DATA INTEGRITY VERIFICATION ---");
  const finalCustomerCount = (await db.get("SELECT COUNT(*) as c FROM customers")).c;
  const finalCustomerAarav = await db.get("SELECT * FROM customers WHERE phone = '+919876543210'");

  console.log(`Initial Customer Count: ${initialCustomerCount} | Final Customer Count: ${finalCustomerCount}`);
  if (initialCustomerCount === finalCustomerCount) {
    console.log("✅ Zero customer records created or deleted.");
  } else {
    console.error("❌ Data Integrity Failure: Customer count changed!");
  }

  const profileIntact = (
    finalCustomerAarav.name === initialCustomerAarav.name &&
    finalCustomerAarav.email === initialCustomerAarav.email &&
    finalCustomerAarav.ltv === initialCustomerAarav.ltv &&
    finalCustomerAarav.phone === initialCustomerAarav.phone &&
    finalCustomerAarav.segment === initialCustomerAarav.segment
  );

  if (profileIntact) {
    console.log("✅ Customer profile information strictly preserved (name, email, ltv, phone unchanged).");
  } else {
    console.error("❌ Data Integrity Failure: Customer profile modified!");
  }

  console.log("\n==========================================================");
  console.log("ALL 12 TEST CASES AND INTEGRITY VERIFICATIONS COMPLETED");
  console.log("==========================================================");
}

runTests().catch(err => {
  console.error("Test Suite Uncaught Error:", err);
  process.exit(1);
}).finally(() => process.exit(0));

