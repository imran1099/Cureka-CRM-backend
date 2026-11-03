import { pool, db } from "./src/db/connection.js";
import { signToken } from "./src/middleware/auth.js";
import assert from "assert";

const BASE_URL = "http://localhost:4000/api";

async function runTests() {
  console.log("=== STARTING BULK CUSTOMER ASSIGNMENT & ROLE-BASED ACCESS TEST SUITE ===");

  // 1. Get or create test admin and two agents
  let admin = await db.get("SELECT * FROM agents WHERE role = 'admin' AND active = 1 LIMIT 1");
  if (!admin) {
    admin = await db.get("SELECT * FROM agents WHERE role = 'super_admin' AND active = 1 LIMIT 1");
  }
  assert(admin, "An active admin or super_admin must exist");

  const agents = await db.all(
    "SELECT * FROM agents WHERE role IN ('agent', 'customer_support_executive') AND active = 1 LIMIT 2"
  );
  assert(agents.length >= 2, "At least 2 active agents must exist for testing");
  const agentA = agents[0];
  const agentB = agents[1];

  console.log(`Test Admin: ${admin.name} (${admin.id})`);
  console.log(`Test Agent A: ${agentA.name} (${agentA.id})`);
  console.log(`Test Agent B: ${agentB.name} (${agentB.id})`);

  agentA.brands = (await db.all("SELECT brand_id FROM agent_brands WHERE agent_id = ?", agentA.id)).map(b => b.brand_id);
  agentB.brands = (await db.all("SELECT brand_id FROM agent_brands WHERE agent_id = ?", agentB.id)).map(b => b.brand_id);

  const adminToken = signToken(admin);
  const agentAToken = signToken(agentA);
  const agentBToken = signToken(agentB);

  // Pick 10 sample customers for deterministic testing
  const sampleCustomers = await db.all("SELECT id, phone, assigned_agent_id FROM customers LIMIT 10");
  assert(sampleCustomers.length >= 10, "At least 10 customers required");
  const custIdsA = sampleCustomers.slice(0, 5).map(c => c.id);
  const custIdsB = sampleCustomers.slice(5, 10).map(c => c.id);

  // TEST 1: Assignment Stats Endpoint
  console.log("\n[TEST 1] Testing GET /api/customers/assignment-stats...");
  const statsRes = await fetch(`${BASE_URL}/customers/assignment-stats`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(statsRes.status, 200);
  const statsData = await statsRes.json();
  assert(typeof statsData.totalCustomers === "number", "totalCustomers must be a number");
  assert(typeof statsData.unassignedCount === "number", "unassignedCount must be a number");
  assert(Array.isArray(statsData.agentStats), "agentStats must be an array");
  console.log(`✓ Assignment stats passed. Total: ${statsData.totalCustomers}, Unassigned: ${statsData.unassignedCount}`);

  // TEST 2: Bulk Assign 5 Customers to Agent A
  console.log("\n[TEST 2] Testing POST /api/customers/bulk-assign to Agent A...");
  const assignARes = await fetch(`${BASE_URL}/customers/bulk-assign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      customer_ids: custIdsA,
      agent_id: agentA.id,
      notes: "Assigned in Automated Test to Agent A"
    })
  });
  assert.strictEqual(assignARes.status, 200);
  const assignAData = await assignARes.json();
  assert.strictEqual(assignAData.success, true);
  assert.strictEqual(assignAData.targetAgentId, agentA.id);
  console.log(`✓ Bulk assigned ${assignAData.totalSelected} customers to Agent A`);

  // Verify in DB and history
  const dbCustsA = await db.all(
    `SELECT id, assigned_agent_id FROM customers WHERE id IN (${custIdsA.map(() => "?").join(",")})`,
    ...custIdsA
  );
  dbCustsA.forEach(c => assert.strictEqual(c.assigned_agent_id, agentA.id));
  const historyA = await db.all(
    `SELECT * FROM customer_assignment_history WHERE customer_id IN (${custIdsA.map(() => "?").join(",")}) AND new_agent_id = ?`,
    ...custIdsA, agentA.id
  );
  assert(historyA.length > 0, "Audit records must exist in customer_assignment_history");
  console.log(`✓ DB verification and customer_assignment_history audit check passed for Agent A`);

  // TEST 3: Bulk Assign 5 Customers to Agent B
  console.log("\n[TEST 3] Testing POST /api/customers/bulk-assign to Agent B...");
  const assignBRes = await fetch(`${BASE_URL}/customers/bulk-assign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      customer_ids: custIdsB,
      agent_id: agentB.id,
      notes: "Assigned in Automated Test to Agent B"
    })
  });
  assert.strictEqual(assignBRes.status, 200);
  const assignBData = await assignBRes.json();
  assert.strictEqual(assignBData.success, true);
  console.log(`✓ Bulk assigned ${assignBData.totalSelected} customers to Agent B`);

  // TEST 4: Non-Manager Agent Permissions Block
  console.log("\n[TEST 4] Testing Agent A trying to bulk assign (should return 403)...");
  const forbiddenAssignRes = await fetch(`${BASE_URL}/customers/bulk-assign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentAToken}`
    },
    body: JSON.stringify({
      customer_ids: custIdsA,
      agent_id: agentA.id
    })
  });
  assert.strictEqual(forbiddenAssignRes.status, 403);
  console.log("✓ Agent bulk assign attempt blocked with 403 Forbidden");

  // TEST 5: Agent-Level Data Scoping on GET /api/customers
  console.log("\n[TEST 5] Testing GET /api/customers for Agent A...");
  const agentACustsRes = await fetch(`${BASE_URL}/customers?limit=100`, {
    headers: { Authorization: `Bearer ${agentAToken}` }
  });
  assert.strictEqual(agentACustsRes.status, 200);
  const agentACustsData = await agentACustsRes.json();
  assert(agentACustsData.customers.length > 0, "Agent A must see their assigned customers");
  // CRITICAL: EVERY customer returned MUST be assigned to Agent A
  for (const c of agentACustsData.customers) {
    assert.strictEqual(
      c.assigned_agent_id,
      agentA.id,
      `Agent A received customer ${c.id} assigned to ${c.assigned_agent_id}!`
    );
  }
  // None of Agent B's customers can appear
  const foundBInA = agentACustsData.customers.some(c => custIdsB.includes(c.id));
  assert.strictEqual(foundBInA, false, "Agent B customer leaked into Agent A customer list!");
  console.log(`✓ Agent A customer list strictly scoped (${agentACustsData.customers.length} records verified)`);

  // TEST 6: Universal Autocomplete Search Scoping
  console.log("\n[TEST 6] Testing GET /api/customers/search scoping for Agent A...");
  const sampleCustB = await db.get("SELECT name FROM customers WHERE id = ?", custIdsB[0]);
  const searchLeakRes = await fetch(`${BASE_URL}/customers/search?q=${encodeURIComponent(sampleCustB.name)}`, {
    headers: { Authorization: `Bearer ${agentAToken}` }
  });
  assert.strictEqual(searchLeakRes.status, 200);
  const searchLeakData = await searchLeakRes.json();
  const leakedCust = searchLeakData.results.find(r => r.id === custIdsB[0]);
  assert(!leakedCust, "Agent A was able to find Agent B's customer via search!");
  console.log("✓ Search scoping verified: cross-agent customer not returned in autocomplete search");

  // TEST 7: Direct URL / API Protection (403 on other agent's customer)
  console.log("\n[TEST 7] Testing Direct URL 403 Protection...");
  const targetIdB = custIdsB[0];

  // 7a: GET /api/customers/:id
  const getDetailRes = await fetch(`${BASE_URL}/customers/${targetIdB}`, {
    headers: { Authorization: `Bearer ${agentAToken}` }
  });
  assert.strictEqual(getDetailRes.status, 403, "GET /api/customers/:id should return 403");

  // 7b: GET /api/customers/:id/360
  const get360Res = await fetch(`${BASE_URL}/customers/${targetIdB}/360`, {
    headers: { Authorization: `Bearer ${agentAToken}` }
  });
  assert.strictEqual(get360Res.status, 403, "GET /api/customers/:id/360 should return 403");

  // 7c: GET /api/customers/:id/timeline
  const getTimelineRes = await fetch(`${BASE_URL}/customers/${targetIdB}/timeline`, {
    headers: { Authorization: `Bearer ${agentAToken}` }
  });
  assert.strictEqual(getTimelineRes.status, 403, "GET /api/customers/:id/timeline should return 403");

  // 7d: POST /api/customers/:id/notes
  const postNoteRes = await fetch(`${BASE_URL}/customers/${targetIdB}/notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentAToken}`
    },
    body: JSON.stringify({ content: "Malicious note" })
  });
  assert.strictEqual(postNoteRes.status, 403, "POST /api/customers/:id/notes should return 403");

  // 7e: POST /api/customers/:id/calls
  const postCallRes = await fetch(`${BASE_URL}/customers/${targetIdB}/calls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentAToken}`
    },
    body: JSON.stringify({ outcome: "sold", brand_id: "brand_default" })
  });
  assert.strictEqual(postCallRes.status, 403, "POST /api/customers/:id/calls should return 403");

  // 7f: PATCH /api/customers/:id (trying to modify)
  const patchRes = await fetch(`${BASE_URL}/customers/${targetIdB}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentAToken}`
    },
    body: JSON.stringify({ name: "Hacked" })
  });
  assert.strictEqual(patchRes.status, 403, "PATCH /api/customers/:id should return 403");

  console.log("✓ All 6 direct access endpoints strictly return 403 Forbidden for non-assigned customer");

  // TEST 8: Agent attempting to reassign their own customer
  console.log("\n[TEST 8] Testing Agent A trying to reassign their own customer (should return 403)...");
  const agentReassignRes = await fetch(`${BASE_URL}/customers/${custIdsA[0]}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentAToken}`
    },
    body: JSON.stringify({ assigned_agent_id: agentB.id })
  });
  assert.strictEqual(agentReassignRes.status, 403);
  console.log("✓ Non-manager agent reassignment attempt blocked with 403");

  // TEST 9: CSV Bulk Assignment Endpoint
  console.log("\n[TEST 9] Testing POST /api/customers/bulk-assign-csv...");
  const targetCust = sampleCustomers[0];
  const csvContent = [
    "Customer ID,Customer Phone,Agent Email",
    `${targetCust.id},${targetCust.phone},${agentB.email}`,
    `INVALID_ID,9999999999,${agentA.email}`, // Invalid customer
    `${sampleCustomers[1].id},${sampleCustomers[1].phone},invalid-agent@notfound.com` // Invalid agent
  ].join("\n");

  const csvAssignRes = await fetch(`${BASE_URL}/customers/bulk-assign-csv`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ csvText: csvContent })
  });
  assert.strictEqual(csvAssignRes.status, 200);
  const csvAssignData = await csvAssignRes.json();
  assert.strictEqual(csvAssignData.totalRows, 3);
  assert.strictEqual(csvAssignData.assignedCount, 1);
  assert.strictEqual(csvAssignData.errorCount, 2);
  assert.strictEqual(csvAssignData.errors.length, 2);
  console.log(`✓ CSV bulk assignment processed correctly (1 assigned, 2 structured errors)`);

  // TEST 10: Assignment History Endpoint
  console.log("\n[TEST 10] Testing GET /api/customers/assignment-history...");
  const histRes = await fetch(`${BASE_URL}/customers/assignment-history?limit=10`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(histRes.status, 200);
  const histData = await histRes.json();
  assert(Array.isArray(histData.history) && histData.history.length > 0);
  assert(histData.history[0].customer_name, "History row must contain joined customer_name");
  console.log(`✓ Assignment history returned ${histData.history.length} records with full audit trail`);

  // TEST 11: Unassigned Customers Filter for Admin
  console.log("\n[TEST 11] Testing GET /api/customers?assigned_agent_id=unassigned...");
  const unassignedRes = await fetch(`${BASE_URL}/customers?assigned_agent_id=unassigned&limit=10`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(unassignedRes.status, 200);
  const unassignedData = await unassignedRes.json();
  for (const c of unassignedData.customers) {
    assert(!c.assigned_agent_id, `Expected unassigned customer but got ${c.assigned_agent_id}`);
  }
  console.log(`✓ Unassigned filter verified for admin (${unassignedData.customers.length} unassigned returned)`);

  console.log("\n=======================================================");
  console.log("🎉 ALL TESTS PASSED! BULK ASSIGNMENT & SCOPING FULLY VERIFIED!");
  console.log("=======================================================\n");
  process.exit(0);
}

runTests().catch(err => {
  console.error("\n❌ TEST SUITE FAILED:", err);
  process.exit(1);
});

