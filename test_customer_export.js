import { pool, db } from "./src/db/connection.js";
import { signToken } from "./src/middleware/auth.js";
import assert from "assert";

const BASE_URL = "http://localhost:4000/api";

async function parseCsv(text) {
  // Strip BOM if present
  let cleanText = text;
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
  }
  const lines = cleanText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current);
    return fields;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

async function runTests() {
  console.log("=== STARTING CUSTOMER EXPORT VERIFICATION TEST SUITE ===");

  let admin = await db.get("SELECT * FROM agents WHERE role = 'admin' AND active = 1 LIMIT 1");
  if (!admin) {
    admin = await db.get("SELECT * FROM agents WHERE role = 'super_admin' AND active = 1 LIMIT 1");
  }
  assert(admin, "Admin user must exist");

  const agents = await db.all("SELECT * FROM agents WHERE role IN ('agent', 'customer_support_executive') AND active = 1 LIMIT 2");
  assert(agents.length >= 1, "At least 1 active agent must exist");
  const agentA = agents[0];

  const adminToken = signToken(admin);
  const agentAToken = signToken(agentA);

  const totalInDb = (await db.get("SELECT COUNT(*) as count FROM customers")).count;
  console.log(`Total customers in database: ${totalInDb}`);

  // ── TEST 1: Admin Full Export ──────────────────────────────────────────────
  console.log("\n[TEST 1] Testing Admin GET /api/customers/export...");
  const exportRes = await fetch(`${BASE_URL}/customers/export`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  assert.strictEqual(exportRes.status, 200, "Export response status must be 200");
  const contentType = exportRes.headers.get("content-type");
  assert(contentType && contentType.includes("text/csv"), "Content-Type must be text/csv");
  const disposition = exportRes.headers.get("content-disposition");
  assert(disposition && disposition.includes("customers_export_"), "Content-Disposition must have filename");

  const arrayBuf = await exportRes.arrayBuffer();
  const rawBuf = Buffer.from(arrayBuf);
  assert.strictEqual(rawBuf[0], 0xef, "Byte 0 must be 0xEF (UTF-8 BOM)");
  assert.strictEqual(rawBuf[1], 0xbb, "Byte 1 must be 0xBB (UTF-8 BOM)");
  assert.strictEqual(rawBuf[2], 0xbf, "Byte 2 must be 0xBF (UTF-8 BOM)");
  console.log("✓ UTF-8 BOM (0xEF, 0xBB, 0xBF) verified for Excel compatibility.");

  const csvText = rawBuf.toString("utf-8");
  const { headers, rows } = await parseCsv(csvText);
  console.log(`✓ CSV received with ${headers.length} columns and ${rows.length} rows.`);

  // Verify headers
  assert.strictEqual(headers[0], "Customer ID", "First column must be 'Customer ID'");
  const requiredColumns = [
    "Customer ID",
    "Customer Name",
    "Phone",
    "Email",
    "Lifetime Value (LTV)",
    "Total Orders",
    "Order IDs",
    "Product Name",
    "SKU",
    "Order Status",
    "Last Order Date",
    "Assigned Agent ID",
    "Assigned Agent Name",
    "Assigned Agent Email"
  ];
  for (const col of requiredColumns) {
    assert(headers.includes(col), `CSV header must include '${col}'`);
  }
  console.log("✓ All required columns verified in CSV headers.");
  assert.strictEqual(rows.length, totalInDb, `Admin export row count (${rows.length}) must match DB count (${totalInDb})`);
  console.log(`✓ Admin export returned all ${rows.length} customers.`);

  // ── TEST 2: Filtered Export by Segment ─────────────────────────────────────
  console.log("\n[TEST 2] Testing Filtered Export (GET /api/customers/export?segment=vip)...");
  const vipDbCount = (await db.get("SELECT COUNT(*) as count FROM customers WHERE segment = 'vip'")).count;
  const vipRes = await fetch(`${BASE_URL}/customers/export?segment=vip`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.strictEqual(vipRes.status, 200);
  const vipCsv = await parseCsv(await vipRes.text());
  assert.strictEqual(vipCsv.rows.length, vipDbCount, `VIP filtered rows (${vipCsv.rows.length}) must match DB count (${vipDbCount})`);
  console.log(`✓ Filtered export by segment passed (${vipCsv.rows.length} VIP records).`);

  // ── TEST 3: POST Selected Export ───────────────────────────────────────────
  console.log("\n[TEST 3] Testing POST /api/customers/export with specific customer_ids...");
  const sample3 = await db.all("SELECT id FROM customers LIMIT 3");
  const targetIds = sample3.map(c => c.id);

  const postRes = await fetch(`${BASE_URL}/customers/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ customer_ids: targetIds })
  });
  assert.strictEqual(postRes.status, 200);
  const postCsv = await parseCsv(await postRes.text());
  assert.strictEqual(postCsv.rows.length, 3, "Selected export must return exactly 3 rows");
  const exportedIds = postCsv.rows.map(r => r[0]);
  for (const id of targetIds) {
    assert(exportedIds.includes(id), `Exported CSV must contain requested customer ID ${id}`);
  }
  console.log(`✓ Selected export correctly returned ${exportedIds.length} requested customer IDs.`);

  // ── TEST 4: Role-Based Scoping Security for Agents ────────────────────────
  console.log(`\n[TEST 4] Testing Agent-scoped Export Security for Agent ${agentA.name} (${agentA.id})...`);
  // Ensure Agent A has at least 2 assigned customers and someone else has customers
  const sampleForA = await db.all("SELECT id FROM customers LIMIT 2");
  for (const c of sampleForA) {
    await db.run("UPDATE customers SET assigned_agent_id = ? WHERE id = ?", agentA.id, c.id);
  }
  const agentACount = (await db.get("SELECT COUNT(*) as count FROM customers WHERE assigned_agent_id = ?", agentA.id)).count;
  assert(agentACount >= 2, "Agent A should have at least 2 assigned customers");

  const agentRes = await fetch(`${BASE_URL}/customers/export`, {
    headers: { Authorization: `Bearer ${agentAToken}` }
  });
  assert.strictEqual(agentRes.status, 200);
  const agentCsv = await parseCsv(await agentRes.text());
  assert.strictEqual(agentCsv.rows.length, agentACount, `Agent must ONLY receive their assigned customers (${agentACount}), got ${agentCsv.rows.length}`);

  const agentIdColIdx = agentCsv.headers.indexOf("Assigned Agent ID");
  for (const row of agentCsv.rows) {
    assert.strictEqual(row[agentIdColIdx], agentA.id, `Every row must belong to Agent ${agentA.id}`);
  }
  console.log(`✓ Agent export strictly scoped to assigned records (${agentCsv.rows.length} rows, all matching Agent ID ${agentA.id}).`);

  // Test agent trying to export unassigned or another agent's customer ID via POST
  const otherCustomer = await db.get("SELECT id FROM customers WHERE assigned_agent_id != ? OR assigned_agent_id IS NULL LIMIT 1", agentA.id);
  if (otherCustomer) {
    console.log(`\n[TEST 5] Testing Agent trying to export unauthorized customer ${otherCustomer.id}...`);
    const unauthorizedRes = await fetch(`${BASE_URL}/customers/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentAToken}`
      },
      body: JSON.stringify({ customer_ids: [otherCustomer.id] })
    });
    assert.strictEqual(unauthorizedRes.status, 200);
    const unauthCsv = await parseCsv(await unauthorizedRes.text());
    assert.strictEqual(unauthCsv.rows.length, 0, "Unauthorized customer must not be returned to non-manager agent");
    console.log("✓ Unauthorized customer correctly blocked by backend scoping!");
  }

  console.log("\n========================================================");
  console.log("🎉 ALL CUSTOMER EXPORT TESTS PASSED SUCCESSFULLY!");
  console.log("========================================================\n");
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
