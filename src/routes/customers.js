import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { scoreCustomer, todayStr } from "../utils/ranking.js";

const router = express.Router();
router.use(requireAuth);

// Helper: attach latest call info to a customer row for scoring
async function withLatestCall(customer) {
  const latest = await db.get(
    "SELECT outcome, called_at FROM call_logs WHERE customer_id = ? ORDER BY called_at DESC LIMIT 1",
    customer.id
  );
  return {
    ...customer,
    last_call_date: latest ? latest.called_at.slice(0, 10) : null,
    last_outcome: latest ? latest.outcome : null,
  };
}

// Helper: parse JSON-array text fields safely (health_conditions, product_preferences)
function parseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function withParsedFields(customer) {
  return {
    ...customer,
    health_conditions: parseJsonArray(customer.health_conditions),
    product_preferences: parseJsonArray(customer.product_preferences),
  };
}

async function getTags(customerId) {
  return await db.all("SELECT id, tag, tag_type FROM customer_tags WHERE customer_id = ? ORDER BY created_at ASC", customerId);
}

// GET /api/queue — today's ranked call queue for the logged-in agent (or all, for admin)
router.get("/queue", async (req, res, next) => {
  try {
    const { segment, agentId } = req.query;
    const isAdmin = req.user.role === "admin";

    let sql = "SELECT * FROM customers WHERE do_not_call = 0";
    const params = [];

    if (segment && segment !== "all") {
      sql += " AND segment = ?";
      params.push(segment);
    }

    // Agents see their own assigned + unassigned, unless admin requests a specific agentId or 'all'
    if (!isAdmin) {
      sql += " AND (assigned_agent_id = ? OR assigned_agent_id IS NULL)";
      params.push(req.user.id);
    } else if (agentId && agentId !== "all") {
      sql += " AND (assigned_agent_id = ? OR assigned_agent_id IS NULL)";
      params.push(agentId);
    }

    const rows = await db.all(sql, ...params);
    const today = todayStr();
    const nowIso = new Date().toISOString();

    const rowsWithCall = await Promise.all(rows.map(withLatestCall));
    const ranked = rowsWithCall
      .map((c) => {
        const { score, reason } = scoreCustomer({ ...c, _now: nowIso }, today);
        return { ...c, score, reason };
      })
      .filter((c) => c.score > -1000)
      .sort((a, b) => b.score - a.score);

    res.json({ queue: ranked, count: ranked.length, generatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/callbacks/due — fetch callbacks due around now for the logged-in agent
router.get("/callbacks/due", async (req, res, next) => {
  try {
    const rows = await db.all(
      "SELECT id, name, callback_date FROM customers WHERE assigned_agent_id = ? AND callback_date IS NOT NULL AND do_not_call = 0",
      req.user.id
    );

    const now = new Date();
    const past = new Date(now.getTime() - 15 * 60 * 1000);
    const future = new Date(now.getTime() + 15 * 60 * 1000);

    const due = rows.filter(r => {
      const d = new Date(r.callback_date);
      if (isNaN(d.getTime())) return false;
      return d >= past && d <= future;
    });

    res.json({ due });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers — search / list (admin: all, agent: assigned scope optional)
router.get("/", async (req, res, next) => {
  try {
    const { q, segment, source, page = 1, limit = 50, sortBy = "updated_at", sortOrder = "desc" } = req.query;
    
    // Validate pagination params
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 50)); // Max 100 rows per page
    const offset = (pageNum - 1) * limitNum;

    // Validate sorting
    const allowedSortFields = ["updated_at", "name", "ltv", "created_at"];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : "updated_at";
    const sortDir = String(sortOrder).toLowerCase() === "asc" ? "ASC" : "DESC";

    let conditionSql = "WHERE 1=1";
    const params = [];

    if (q) {
      conditionSql += " AND (name LIKE ? OR phone LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    if (segment && segment !== "all") {
      conditionSql += " AND segment = ?";
      params.push(segment);
    }
    if (source && source !== "all") {
      conditionSql += " AND source = ?";
      params.push(source);
    }

    // 1. Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM customers ${conditionSql}`;
    const { total } = await db.get(countQuery, ...params);

    // 2. Fetch paginated records
    const sql = `SELECT * FROM customers ${conditionSql} ORDER BY ${sortField} ${sortDir} LIMIT ${limitNum} OFFSET ${offset}`;

    const rows = await db.all(sql, ...params);
    const rowsWithCall = await Promise.all(rows.map(withLatestCall));
    const processedRows = rowsWithCall.map(withParsedFields);
    
    res.json({ 
      customers: processedRows,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id — full profile: customer + purchase history + call log timeline
router.get("/:id", async (req, res, next) => {
  try {
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const purchases = await db.all("SELECT * FROM purchase_history WHERE customer_id = ? ORDER BY order_date DESC", req.params.id);

    const calls = await db.all(
      `SELECT call_logs.*, agents.name as agent_name
       FROM call_logs JOIN agents ON agents.id = call_logs.agent_id
       WHERE call_logs.customer_id = ? ORDER BY called_at DESC`,
      req.params.id
    );

    const latestCustomerInfo = await withLatestCall(customer);
    const { score, reason } = scoreCustomer({ ...latestCustomerInfo, _now: new Date().toISOString() }, todayStr());
    const tags = await getTags(req.params.id);

    res.json({ customer: { ...withParsedFields(customer), score, reason }, purchases, calls, tags });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers — create a new customer (manual add / import row)
router.post("/", async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !b.phone || !b.segment) {
      return res.status(400).json({ error: "name, phone, and segment are required" });
    }

    const id = "cust_" + nanoid(10);
    await db.run(
      `INSERT INTO customers
        (id, name, phone, email, age, gender, city, segment, source, ltv, last_order_date, replenish_due_date,
         cart_value, cart_items, cart_abandoned_at, assigned_agent_id,
         health_conditions, product_preferences, allergies_restrictions, preferred_contact_time, preferred_language, household_notes, price_sensitivity, product_name, sku, order_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      b.name,
      b.phone,
      b.email || null,
      b.age || null,
      b.gender || null,
      b.city || null,
      b.segment,
      b.source || "manual_upload",
      b.ltv || 0,
      b.last_order_date || null,
      b.replenish_due_date || null,
      b.cart_value || null,
      b.cart_items || null,
      b.cart_abandoned_at || null,
      b.assigned_agent_id || null,
      Array.isArray(b.health_conditions) ? JSON.stringify(b.health_conditions) : null,
      Array.isArray(b.product_preferences) ? JSON.stringify(b.product_preferences) : null,
      b.allergies_restrictions || null,
      b.preferred_contact_time || null,
      b.preferred_language || null,
      b.household_notes || null,
      b.price_sensitivity || null,
      b.product_name || null,
      b.sku || null,
      b.order_ids || null
    );

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/bulk — bulk import (CSV-parsed array from frontend)
router.post("/bulk", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array required" });
    }

    const insertSql = `INSERT INTO customers
      (id, name, phone, email, age, gender, city, segment, source, ltv, last_order_date, replenish_due_date,
       cart_value, cart_items, cart_abandoned_at, assigned_agent_id,
       health_conditions, product_preferences, allergies_restrictions, preferred_contact_time, preferred_language, household_notes, price_sensitivity, product_name, sku, order_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const toJsonArray = (val) => {
      if (!val) return null;
      const items = String(val).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      return items.length ? JSON.stringify(items) : null;
    };

    const inserted = await db.transaction(async (conn) => {
      let count = 0;
      for (const r of rows) {
        if (!r.name || !r.phone) continue;
        await conn.execute(insertSql, [
          "cust_" + nanoid(10),
          r.name,
          r.phone,
          r.email || null,
          r.age ? Number(r.age) : null,
          r.gender || null,
          r.city || null,
          r.segment || "new_lead",
          r.source || "manual_upload",
          Number(r.ltv) || 0,
          r.last_order_date || null,
          r.replenish_due_date || null,
          r.cart_value ? Number(r.cart_value) : null,
          r.cart_items || null,
          r.cart_abandoned_at || null,
          r.assigned_agent_id || null,
          toJsonArray(r.health_conditions),
          toJsonArray(r.product_preferences),
          r.allergies_restrictions || null,
          r.preferred_contact_time || null,
          r.preferred_language || null,
          r.household_notes || null,
          r.price_sensitivity || null,
          r.product_name || null,
          r.sku || null,
          r.order_ids || null,
        ]);
        count++;
      }
      return count;
    });

    res.status(201).json({ inserted });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/customers/:id — update customer fields (admin reassign, segment override, DNC, etc.)
router.patch("/:id", async (req, res, next) => {
  try {
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const allowed = [
      "name", "phone", "email", "age", "gender", "city", "segment", "source", "ltv", "last_order_date",
      "replenish_due_date", "cart_value", "cart_items", "cart_abandoned_at",
      "assigned_agent_id", "callback_date", "do_not_call",
      "allergies_restrictions", "preferred_contact_time", "preferred_language", "household_notes", "price_sensitivity",
      "product_name", "sku", "order_ids",
    ];
    const arrayFields = ["health_conditions", "product_preferences"];

    const updates = [];
    const params = [];
    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }
    for (const key of arrayFields) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        params.push(Array.isArray(req.body[key]) ? JSON.stringify(req.body[key]) : null);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });

    updates.push("updated_at = NOW()");
    await db.run(`UPDATE customers SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.id);

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id — admin only
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await db.run("DELETE FROM customers WHERE id = ?", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/calls — log a call outcome + remarks + structured signals
router.post("/:id/calls", async (req, res, next) => {
  try {
    const { outcome, remarks, sale_amount, callback_date, objection_type, sentiment, decision_style, interest_level, call_duration_seconds, price_sensitivity } = req.body;
    const validOutcomes = ["sold", "callback", "noanswer", "notinterested", "wrongnumber", "disconnected"];
    if (!validOutcomes.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${validOutcomes.join(", ")}` });
    }

    const customer = await db.get("SELECT * FROM customers WHERE id = ?", req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const id = "call_" + nanoid(10);
    await db.run(
      `INSERT INTO call_logs
        (id, customer_id, agent_id, outcome, remarks, sale_amount, callback_date, objection_type, sentiment, decision_style, interest_level, call_duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      req.params.id,
      req.user.id,
      outcome,
      remarks || null,
      sale_amount || null,
      outcome === "callback" ? callback_date : null,
      objection_type || null,
      sentiment || null,
      decision_style || null,
      interest_level || null,
      call_duration_seconds || null
    );

    // Update customer record: callback date, and bump LTV/last_order_date if sold
    if (outcome === "callback" && callback_date) {
      await db.run("UPDATE customers SET callback_date = ?, updated_at = NOW() WHERE id = ?", callback_date, req.params.id);
    } else {
      await db.run("UPDATE customers SET callback_date = NULL, updated_at = NOW() WHERE id = ?", req.params.id);
    }

    // Price sensitivity is a "latest read" on the customer, refreshed by whichever agent last assessed it
    if (price_sensitivity) {
      await db.run("UPDATE customers SET price_sensitivity = ?, updated_at = NOW() WHERE id = ?", price_sensitivity, req.params.id);
    }

    if (outcome === "sold" && sale_amount) {
      await db.run(
        "UPDATE customers SET ltv = ltv + ?, last_order_date = CURDATE(), updated_at = NOW() WHERE id = ?",
        sale_amount,
        req.params.id
      );

      await db.run(
        `INSERT INTO purchase_history (id, customer_id, order_date, product_name, quantity, amount, order_ref)
         VALUES (?, ?, CURDATE(), ?, 1, ?, ?)`,
        "ph_" + nanoid(10),
        req.params.id,
        remarks ? `Sold via call: ${remarks.slice(0, 60)}` : "Sold via call",
        sale_amount,
        "CALL-" + id
      );
    }

    res.status(201).json({ id, logged: true });
  } catch (err) {
    next(err);
  }
});

// --- Tag management (health / preference / behavioral) ---

// POST /api/customers/:id/tags — add a tag
router.post("/:id/tags", async (req, res, next) => {
  try {
    const { tag, tag_type } = req.body;
    if (!tag || !["health", "preference", "behavioral"].includes(tag_type)) {
      return res.status(400).json({ error: "tag and a valid tag_type (health/preference/behavioral) are required" });
    }
    const id = "tag_" + nanoid(10);
    try {
      await db.run(
        "INSERT INTO customer_tags (id, customer_id, tag, tag_type, added_by_agent_id) VALUES (?, ?, ?, ?, ?)",
        id,
        req.params.id,
        tag.trim(),
        tag_type,
        req.user.id
      );
      res.status(201).json({ id });
    } catch (e) {
      if (String(e.message).includes("Duplicate entry") || String(e.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "This tag is already on this customer" });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id/tags/:tagId
router.delete("/:id/tags/:tagId", async (req, res, next) => {
  try {
    await db.run("DELETE FROM customer_tags WHERE id = ? AND customer_id = ?", req.params.tagId, req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/tags
router.get("/:id/tags", async (req, res, next) => {
  try {
    const tags = await getTags(req.params.id);
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

export default router;
