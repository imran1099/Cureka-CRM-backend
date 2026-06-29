import "dotenv/config";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db, initSchema, pool } from "./connection.js";

async function runSeed() {
  await initSchema();

  console.log("Seeding database...");

  const agents = [
    { name: "Admin", email: "admin@cureka.com", password: "admin123", role: "admin" },
    { name: "Agent 1 - Priya", email: "agent1@cureka.com", password: "agent123", role: "agent" },
    { name: "Agent 2 - Karthik", email: "agent2@cureka.com", password: "agent123", role: "agent" },
    { name: "Agent 3 - Sneha", email: "agent3@cureka.com", password: "agent123", role: "agent" },
  ];

  const agentIds = {};
  for (const a of agents) {
    const existing = await db.get("SELECT id FROM agents WHERE email = ?", a.email);
    if (existing) {
      agentIds[a.email] = existing.id;
      continue;
    }
    const id = "agent_" + nanoid(10);
    await db.run(
      "INSERT IGNORE INTO agents (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      id,
      a.name,
      a.email,
      bcrypt.hashSync(a.password, 10),
      a.role
    );
    agentIds[a.email] = id;
  }

  const today = new Date();
  const isoOffset = (days) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const customers = [
    { name: "Anita Rao", phone: "9810000234", segment: "replenishment", source: "purchase", ltv: 8200, replenish_due_date: isoOffset(-3), last_order_date: isoOffset(-33), assigned_agent_id: agentIds["agent1@cureka.com"], age: 42, gender: "Female", city: "Bengaluru", health_conditions: ["thyroid", "low immunity"], product_preferences: ["ayurvedic preferred"], preferred_contact_time: "evening", price_sensitivity: "low" },
    { name: "Vikram Shah", phone: "9855500012", segment: "dormant", source: "purchase", ltv: 24500, last_order_date: isoOffset(-48), assigned_agent_id: agentIds["agent2@cureka.com"], age: 55, gender: "Male", city: "Mumbai", health_conditions: ["hypertension", "diabetes"], preferred_contact_time: "morning", price_sensitivity: "low" },
    { name: "Priya Menon", phone: "9877700821", segment: "abandoner", source: "abandoned_cart", ltv: 3400, cart_value: 3400, cart_items: "Vitamin D3 Drops x2, Omega-3 Capsules x1", cart_abandoned_at: new Date(Date.now() - 6 * 3600000).toISOString(), assigned_agent_id: null, age: 31, gender: "Female", city: "Kochi", price_sensitivity: "medium" },
    { name: "Suresh Kumar", phone: "9899900432", segment: "churnrisk", source: "purchase", ltv: 950, last_order_date: isoOffset(-25), assigned_agent_id: agentIds["agent3@cureka.com"], age: 38, gender: "Male", city: "Chennai", price_sensitivity: "high", household_notes: "Decisions made jointly with spouse" },
    { name: "Deepa Iyer", phone: "9844400210", segment: "replenishment", source: "purchase", ltv: 5600, replenish_due_date: isoOffset(-1), last_order_date: isoOffset(-31), assigned_agent_id: agentIds["agent1@cureka.com"], age: 47, gender: "Female", city: "Pune", health_conditions: ["joint pain"], preferred_contact_time: "afternoon", price_sensitivity: "medium" },
    { name: "Rohan Gupta", phone: "9866600789", segment: "dormant", source: "purchase", ltv: 41000, last_order_date: isoOffset(-68), assigned_agent_id: agentIds["agent2@cureka.com"], age: 60, gender: "Male", city: "Delhi", health_conditions: ["hypertension"], price_sensitivity: "low" },
    { name: "Meera Pillai", phone: "9888812345", segment: "new_lead", source: "website_lead", ltv: 0, assigned_agent_id: null, age: 29, gender: "Female", city: "Hyderabad" },
    { name: "Arjun Nair", phone: "9822233445", segment: "abandoner", source: "abandoned_cart", ltv: 1200, cart_value: 1850, cart_items: "Multivitamin Tablets x1", cart_abandoned_at: new Date(Date.now() - 20 * 3600000).toISOString(), assigned_agent_id: agentIds["agent3@cureka.com"], age: 34, gender: "Male", city: "Bengaluru", price_sensitivity: "high" },
  ];

  const customerIds = [];
  for (const c of customers) {
    const exists = await db.get("SELECT id FROM customers WHERE phone = ?", c.phone);
    if (exists) {
      customerIds.push(exists.id);
      continue;
    }
    const id = "cust_" + nanoid(10);
    await db.run(
      `INSERT INTO customers
        (id, name, phone, segment, source, ltv, last_order_date, replenish_due_date, cart_value, cart_items, cart_abandoned_at, assigned_agent_id,
         age, gender, city, health_conditions, product_preferences, allergies_restrictions, preferred_contact_time, preferred_language, household_notes, price_sensitivity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      c.name,
      c.phone,
      c.segment,
      c.source,
      c.ltv,
      c.last_order_date || null,
      c.replenish_due_date || null,
      c.cart_value || null,
      c.cart_items || null,
      c.cart_abandoned_at || null,
      c.assigned_agent_id || null,
      c.age || null,
      c.gender || null,
      c.city || null,
      c.health_conditions ? JSON.stringify(c.health_conditions) : null,
      c.product_preferences ? JSON.stringify(c.product_preferences) : null,
      c.allergies_restrictions || null,
      c.preferred_contact_time || null,
      c.preferred_language || null,
      c.household_notes || null,
      c.price_sensitivity || null
    );
    customerIds.push(id);
  }

  // A bit of purchase history for the two "purchase" sourced high-LTV customers
  const samplePurchases = [
    { idx: 0, date: isoOffset(-33), product: "Vitamin D3 Drops", qty: 2, amount: 1200 },
    { idx: 0, date: isoOffset(-90), product: "Multivitamin Tablets", qty: 1, amount: 850 },
    { idx: 1, date: isoOffset(-48), product: "Premium Health Checkup Package", qty: 1, amount: 14500 },
    { idx: 1, date: isoOffset(-150), product: "Cardiac Screening Package", qty: 1, amount: 10000 },
    { idx: 5, date: isoOffset(-68), product: "Comprehensive Wellness Package", qty: 1, amount: 28000 },
  ];

  for (const p of samplePurchases) {
    const custId = customerIds[p.idx];
    if (!custId) continue;
    const exists = await db.get("SELECT id FROM purchase_history WHERE customer_id = ? AND product_name = ?", custId, p.product);
    if (exists) continue;
    await db.run(
      `INSERT INTO purchase_history (id, customer_id, order_date, product_name, quantity, amount, order_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "ph_" + nanoid(10),
      custId,
      p.date,
      p.product,
      p.qty,
      p.amount,
      "ORD-" + nanoid(6).toUpperCase()
    );
  }

  // Sample tags (behavioral)
  const sampleTags = [
    { idx: 1, tag: "brand loyal", tag_type: "behavioral", agentEmail: "agent2@cureka.com" },
    { idx: 3, tag: "price sensitive", tag_type: "behavioral", agentEmail: "agent3@cureka.com" },
    { idx: 3, tag: "needs reassurance", tag_type: "behavioral", agentEmail: "agent3@cureka.com" },
    { idx: 5, tag: "research-heavy", tag_type: "behavioral", agentEmail: "agent2@cureka.com" },
    { idx: 7, tag: "quick decision maker", tag_type: "behavioral", agentEmail: "agent3@cureka.com" },
  ];
  for (const t of sampleTags) {
    const custId = customerIds[t.idx];
    if (!custId) continue;
    await db.run(
      "INSERT IGNORE INTO customer_tags (id, customer_id, tag, tag_type, added_by_agent_id) VALUES (?, ?, ?, ?, ?)",
      "tag_" + nanoid(10),
      custId,
      t.tag,
      t.tag_type,
      agentIds[t.agentEmail]
    );
  }

  // Sample call logs with structured signals
  const hoursAgoMySQL = (h) => new Date(Date.now() - h * 3600000).toISOString().slice(0, 19).replace("T", " ");

  const sampleCalls = [
    { idx: 0, agentEmail: "agent1@cureka.com", hoursAgo: 26, outcome: "sold", remarks: "Reordered Vitamin D3, happy with results", sale_amount: 1200, objection_type: "no_objection", sentiment: "positive", decision_style: "decisive", interest_level: 5 },
    { idx: 1, agentEmail: "agent2@cureka.com", hoursAgo: 50, outcome: "callback", remarks: "Interested in wellness package but wants to check with spouse first", objection_type: "spouse_approval", sentiment: "neutral", decision_style: "gatekeeper_involved", interest_level: 4 },
    { idx: 2, agentEmail: "agent1@cureka.com", hoursAgo: 4, outcome: "noanswer" },
    { idx: 3, agentEmail: "agent3@cureka.com", hoursAgo: 30, outcome: "notinterested", remarks: "Said the price was too high compared to local pharmacy", objection_type: "price", sentiment: "negative", decision_style: "needs_convincing", interest_level: 2 },
    { idx: 4, agentEmail: "agent1@cureka.com", hoursAgo: 10, outcome: "sold", remarks: "Renewed joint-pain supplement subscription", sale_amount: 950, objection_type: "no_objection", sentiment: "positive", decision_style: "decisive", interest_level: 5 },
    { idx: 5, agentEmail: "agent2@cureka.com", hoursAgo: 70, outcome: "callback", remarks: "Wants to research the wellness package more before committing", objection_type: "trust", sentiment: "neutral", decision_style: "needs_convincing", interest_level: 3 },
    { idx: 6, agentEmail: "agent3@cureka.com", hoursAgo: 18, outcome: "callback", remarks: "First-time lead, requested a callback next week", sentiment: "positive", decision_style: "decisive", interest_level: 4 },
    { idx: 7, agentEmail: "agent3@cureka.com", hoursAgo: 22, outcome: "notinterested", remarks: "Found a cheaper alternative online", objection_type: "price", sentiment: "negative", decision_style: "decisive", interest_level: 1 },
    { idx: 3, agentEmail: "agent3@cureka.com", hoursAgo: 100, outcome: "noanswer" },
    { idx: 2, agentEmail: "agent1@cureka.com", hoursAgo: 96, outcome: "callback", remarks: "Cart still pending, asked to call back this week", sentiment: "neutral", decision_style: "needs_convincing", interest_level: 3 },
  ];

  for (const c of sampleCalls) {
    const custId = customerIds[c.idx];
    if (!custId) continue;
    await db.run(
      `INSERT INTO call_logs (id, customer_id, agent_id, called_at, outcome, remarks, sale_amount, objection_type, sentiment, decision_style, interest_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "call_" + nanoid(10),
      custId,
      agentIds[c.agentEmail],
      hoursAgoMySQL(c.hoursAgo),
      c.outcome,
      c.remarks || null,
      c.sale_amount || null,
      c.objection_type || null,
      c.sentiment || null,
      c.decision_style || null,
      c.interest_level || null
    );
  }

  console.log("Seed complete.");
  console.log("\nLogin credentials:");
  for (const a of agents) console.log(`  ${a.role.padEnd(6)} ${a.email}  /  ${a.password}`);

  await pool.end();
}

runSeed().catch(async (err) => {
  console.error("Seeding failed:", err);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
