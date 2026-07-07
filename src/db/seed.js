import "dotenv/config";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db, initSchema, pool } from "./connection.js";

async function runSeed() {
  await initSchema();

  console.log("Seeding database...");

  const brands = [
    { id: "brand_" + nanoid(10), name: "Healthetc", short_code: "HE", support_email: "support@healthetc.com" },
    { id: "brand_" + nanoid(10), name: "Cureka", short_code: "CU", support_email: "support@cureka.com" },
    { id: "brand_" + nanoid(10), name: "The Good Hygiene Company", short_code: "TGHC", support_email: "support@tghc.com" },
  ];

  const brandIds = {};
  for (const b of brands) {
    const existing = await db.get("SELECT id FROM brands WHERE short_code = ?", b.short_code);
    if (existing) {
      brandIds[b.short_code] = existing.id;
    } else {
      await db.run(
        "INSERT INTO brands (id, name, short_code, support_email) VALUES (?, ?, ?, ?)",
        b.id, b.name, b.short_code, b.support_email
      );
      brandIds[b.short_code] = b.id;
    }
  }

  const agents = [
    { name: "Super Admin", email: "admin@cureka.com", password: "admin123", role: "admin", brands: [brandIds["HE"], brandIds["CU"], brandIds["TGHC"]] },
    { name: "GM - Ravi", email: "gm@cureka.com", password: "gm123", role: "general_manager", brands: [brandIds["HE"], brandIds["CU"], brandIds["TGHC"]] },
    { name: "Ops Manager - Sarah", email: "ops@cureka.com", password: "ops123", role: "operations_manager", brands: [brandIds["HE"], brandIds["CU"], brandIds["TGHC"]] },
    { name: "Priyanka", email: "priyanka@healthetc.com", password: "agent123", role: "agent", brands: [brandIds["HE"]] },
    { name: "Sneha", email: "sneha@cureka.com", password: "agent123", role: "agent", brands: [brandIds["CU"]] },
    { name: "Syed", email: "syed@tghc.com", password: "agent123", role: "agent", brands: [brandIds["TGHC"]] },
  ];

  const agentIds = {};
  for (const a of agents) {
    const existing = await db.get("SELECT id FROM agents WHERE email = ?", a.email);
    let agentId;
    if (existing) {
      agentId = existing.id;
      agentIds[a.email] = existing.id;
      // Update role just in case
      await db.run("UPDATE agents SET role = ? WHERE id = ?", a.role, agentId);
    } else {
      agentId = "agent_" + nanoid(10);
      await db.run(
        "INSERT INTO agents (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        agentId,
        a.name,
        a.email,
        bcrypt.hashSync(a.password, 10),
        a.role
      );
      agentIds[a.email] = agentId;
    }

    // Map agent to brands
    for (const bId of a.brands) {
      await db.run("INSERT IGNORE INTO agent_brands (agent_id, brand_id) VALUES (?, ?)", agentId, bId);
    }
  }

  const today = new Date();
  const isoOffset = (days) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const customers = [
    { name: "Anita Rao", phone: "9810000234", email: "anita@example.com", segment: "replenishment", source: "purchase", ltv: 8200, replenish_due_date: isoOffset(-3), last_order_date: isoOffset(-33), assigned_agent_id: agentIds["priyanka@healthetc.com"], age: 42, gender: "Female", city: "Bengaluru", health_conditions: ["thyroid"], price_sensitivity: "low", brand_id: brandIds["HE"] },
    { name: "Vikram Shah", phone: "9855500012", email: "vikram@example.com", segment: "dormant", source: "purchase", ltv: 24500, last_order_date: isoOffset(-48), assigned_agent_id: agentIds["sneha@cureka.com"], age: 55, gender: "Male", city: "Mumbai", health_conditions: ["diabetes"], price_sensitivity: "low", brand_id: brandIds["CU"] },
    { name: "Priya Menon", phone: "9877700821", segment: "abandoner", source: "abandoned_cart", ltv: 3400, cart_value: 3400, cart_items: "Vitamin D3 Drops", assigned_agent_id: null, age: 31, gender: "Female", city: "Kochi", price_sensitivity: "medium", brand_id: brandIds["HE"] },
    { name: "Suresh Kumar", phone: "9899900432", segment: "churnrisk", source: "purchase", ltv: 950, last_order_date: isoOffset(-25), assigned_agent_id: agentIds["syed@tghc.com"], age: 38, gender: "Male", city: "Chennai", price_sensitivity: "high", brand_id: brandIds["TGHC"] },
    { name: "Deepa Iyer", phone: "9844400210", segment: "replenishment", source: "purchase", ltv: 5600, replenish_due_date: isoOffset(-1), last_order_date: isoOffset(-31), assigned_agent_id: agentIds["priyanka@healthetc.com"], age: 47, gender: "Female", city: "Pune", price_sensitivity: "medium", brand_id: brandIds["HE"] },
    { name: "Rohan Gupta", phone: "9866600789", segment: "dormant", source: "purchase", ltv: 41000, last_order_date: isoOffset(-68), assigned_agent_id: agentIds["sneha@cureka.com"], age: 60, gender: "Male", city: "Delhi", price_sensitivity: "low", brand_id: brandIds["CU"] },
  ];

  const customerIds = [];
  for (const c of customers) {
    let custId;
    const exists = await db.get("SELECT id FROM customers WHERE phone = ?", c.phone);
    if (exists) {
      custId = exists.id;
    } else {
      custId = "cust_" + nanoid(10);
      await db.run(
        `INSERT INTO customers
          (id, name, phone, email, segment, source, ltv, last_order_date, replenish_due_date, cart_value, cart_items, assigned_agent_id,
           age, gender, city, health_conditions, price_sensitivity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        custId, c.name, c.phone, c.email || null, c.segment, c.source, c.ltv,
        c.last_order_date || null, c.replenish_due_date || null, c.cart_value || null, c.cart_items || null, c.assigned_agent_id || null,
        c.age || null, c.gender || null, c.city || null,
        c.health_conditions ? JSON.stringify(c.health_conditions) : null,
        c.price_sensitivity || null
      );
    }
    customerIds.push(custId);

    // Link customer to brand
    const cbExists = await db.get("SELECT id FROM customer_brands WHERE customer_id = ? AND brand_id = ?", custId, c.brand_id);
    if (!cbExists) {
      await db.run(
        "INSERT INTO customer_brands (id, customer_id, brand_id, source) VALUES (?, ?, ?, ?)",
        "cb_" + nanoid(10), custId, c.brand_id, c.source
      );
    }
  }

  const samplePurchases = [
    { idx: 0, date: isoOffset(-33), product: "Vitamin D3 Drops", qty: 2, amount: 1200, brand_id: brandIds["HE"] },
    { idx: 1, date: isoOffset(-48), product: "Wellness Package", qty: 1, amount: 14500, brand_id: brandIds["CU"] },
    { idx: 3, date: isoOffset(-25), product: "Hygiene Kit", qty: 1, amount: 950, brand_id: brandIds["TGHC"] },
    { idx: 4, date: isoOffset(-31), product: "Joint Support", qty: 1, amount: 5600, brand_id: brandIds["HE"] },
    { idx: 5, date: isoOffset(-68), product: "Comprehensive Plan", qty: 1, amount: 28000, brand_id: brandIds["CU"] },
  ];

  for (const p of samplePurchases) {
    const custId = customerIds[p.idx];
    if (!custId) continue;
    const exists = await db.get("SELECT id FROM purchase_history WHERE customer_id = ? AND product_name = ?", custId, p.product);
    if (exists) continue;
    await db.run(
      `INSERT INTO purchase_history (id, customer_id, order_date, product_name, quantity, amount, order_ref, brand_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "ph_" + nanoid(10), custId, p.date, p.product, p.qty, p.amount, "ORD-" + nanoid(6).toUpperCase(), p.brand_id
    );
  }

  const hoursAgoMySQL = (h) => new Date(Date.now() - h * 3600000).toISOString().slice(0, 19).replace("T", " ");

  const sampleCalls = [
    { idx: 0, agentEmail: "priyanka@healthetc.com", hoursAgo: 26, outcome: "sold", remarks: "Reordered", sale_amount: 1200, brand_id: brandIds["HE"] },
    { idx: 1, agentEmail: "sneha@cureka.com", hoursAgo: 50, outcome: "callback", remarks: "Wants to check", brand_id: brandIds["CU"] },
    { idx: 3, agentEmail: "syed@tghc.com", hoursAgo: 30, outcome: "notinterested", remarks: "Too high", brand_id: brandIds["TGHC"] },
  ];

  for (const c of sampleCalls) {
    const custId = customerIds[c.idx];
    if (!custId) continue;
    await db.run(
      `INSERT INTO call_logs (id, customer_id, agent_id, called_at, outcome, remarks, sale_amount, brand_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "call_" + nanoid(10), custId, agentIds[c.agentEmail], hoursAgoMySQL(c.hoursAgo), c.outcome, c.remarks || null, c.sale_amount || null, c.brand_id
    );
  }

  // Create sample tickets
  const sampleTickets = [
    { idx: 0, agentEmail: "priyanka@healthetc.com", department: "Shipping", priority: "high", status: "open", brand_id: brandIds["HE"] },
    { idx: 1, agentEmail: "sneha@cureka.com", department: "Billing", priority: "medium", status: "resolved", brand_id: brandIds["CU"] },
  ];

  for (const t of sampleTickets) {
    const custId = customerIds[t.idx];
    if (!custId) continue;
    await db.run(
      `INSERT INTO tickets (id, brand_id, customer_id, assigned_agent_id, department, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "tkt_" + nanoid(10), t.brand_id, custId, agentIds[t.agentEmail], t.department, t.priority, t.status
    );
  }

  console.log("Seed complete.");
  console.log("\nLogin credentials:");
  for (const a of agents) console.log(`  ${a.role.padEnd(16)} ${a.email}  /  ${a.password}`);

  await pool.end();
}

runSeed().catch(async (err) => {
  console.error("Seeding failed:", err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
