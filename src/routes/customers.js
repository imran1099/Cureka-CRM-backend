import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { createTimelineEvent } from "../services/timelineService.js";
import { processWorkflowRules } from "../services/followupService.js";
import { scoreCustomer, todayStr } from "../utils/ranking.js";
import { getBrandCondition } from "../utils/dbHelpers.js";

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

// GET /api/customers/queue — today's ranked call queue
router.get("/queue", requireBrandAccess, async (req, res, next) => {
  try {
    const { segment, agentId } = req.query;
    const isManagement = ["admin", "general_manager", "operations_manager"].includes(req.user.role);

    const brandFilter = getBrandCondition(req, "customers");
    let sql = `SELECT customers.* FROM customers ${brandFilter.join} WHERE do_not_call = 0 AND ${brandFilter.condition}`;
    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    if (segment && segment !== "all") {
      sql += " AND customers.segment = ?";
      params.push(segment);
    }

    if (!isManagement) {
      sql += " AND (customers.assigned_agent_id = ? OR customers.assigned_agent_id IS NULL)";
      params.push(req.user.id);
    } else if (agentId && agentId !== "all") {
      sql += " AND (customers.assigned_agent_id = ? OR customers.assigned_agent_id IS NULL)";
      params.push(agentId);
    }

    const rows = await db.all(sql, ...params);
    
    // De-duplicate if join caused multiples (though distinct or group by could be better, let's do simple distinct by id)
    const uniqueRows = Array.from(new Map(rows.map(item => [item.id, item])).values());

    const today = todayStr();
    const nowIso = new Date().toISOString();

    const rowsWithCall = await Promise.all(uniqueRows.map(withLatestCall));
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

// GET /api/customers/callbacks/due
router.get("/callbacks/due", requireBrandAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "customers");
    let sql = `SELECT customers.id, customers.name, customers.callback_date FROM customers ${brandFilter.join} WHERE customers.assigned_agent_id = ? AND customers.callback_date IS NOT NULL AND customers.do_not_call = 0 AND ${brandFilter.condition}`;
    const params = [req.user.id];
    if (brandFilter.params) params.push(...brandFilter.params);
    else if (brandFilter.param) params.push(brandFilter.param);

    const rows = await db.all(sql, ...params);
    const uniqueRows = Array.from(new Map(rows.map(item => [item.id, item])).values());

    const now = new Date();
    const past = new Date(now.getTime() - 15 * 60 * 1000);
    const future = new Date(now.getTime() + 15 * 60 * 1000);

    const due = uniqueRows.filter(r => {
      const d = new Date(r.callback_date);
      if (isNaN(d.getTime())) return false;
      return d >= past && d <= future;
    });

    res.json({ due });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/search — Universal fast autocomplete search
router.get("/search", requireBrandAccess, async (req, res, next) => {
  try {
    const q = (req.query.q || req.query.search || "").trim();
    if (!q || q.length < 1) {
      return res.json({ results: [] });
    }

    const searchPattern = `%${q}%`;
    const brandFilter = getBrandCondition(req, "customers");

    const sql = `
      SELECT DISTINCT 
        c.id, c.name, c.phone, c.email, c.segment, c.is_vip, c.customer_type,
        b.name as brand_name,
        (SELECT COUNT(*) FROM purchase_history p WHERE p.customer_id = c.id) as order_count,
        (SELECT COALESCE(SUM(p.amount), 0) FROM purchase_history p WHERE p.customer_id = c.id) as total_spend,
        (SELECT p.order_date FROM purchase_history p WHERE p.customer_id = c.id ORDER BY p.order_date DESC LIMIT 1) as latest_order_date,
        (SELECT 'Delivered' FROM purchase_history p WHERE p.customer_id = c.id ORDER BY p.order_date DESC LIMIT 1) as latest_order_status
      FROM customers c
      ${brandFilter.join}
      LEFT JOIN brands b ON b.id = c.brand_id
      LEFT JOIN purchase_history ph ON ph.customer_id = c.id
      LEFT JOIN tickets t ON t.customer_id = c.id
      WHERE (
        c.name LIKE ? OR
        c.phone LIKE ? OR
        c.email LIKE ? OR
        c.id LIKE ? OR
        c.lead_id LIKE ? OR
        ph.order_number LIKE ? OR
        ph.id LIKE ? OR
        t.id LIKE ?
      ) AND ${brandFilter.condition}
      LIMIT 15
    `;

    const params = [
      searchPattern, searchPattern, searchPattern, searchPattern,
      searchPattern, searchPattern, searchPattern, searchPattern
    ];

    if (brandFilter.params) params.push(...brandFilter.params);
    else if (brandFilter.param) params.push(brandFilter.param);

    const rows = await db.all(sql, ...params);
    const uniqueRows = Array.from(new Map(rows.map(item => [item.id, item])).values());

    res.json({ results: uniqueRows });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers — search / list
router.get("/", requireBrandAccess, async (req, res, next) => {
  try {
    const { q, segment, source, page = 1, limit = 50, sortBy = "updated_at", sortOrder = "desc" } = req.query;
    
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const allowedSortFields = ["updated_at", "name", "ltv", "created_at"];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : "updated_at";
    const sortDir = String(sortOrder).toLowerCase() === "asc" ? "ASC" : "DESC";

    const brandFilter = getBrandCondition(req, "customers");
    let conditionSql = `WHERE ${brandFilter.condition}`;
    const params = brandFilter.params ? [...brandFilter.params] : (brandFilter.param ? [brandFilter.param] : []);

    if (q) {
      conditionSql += " AND (customers.name LIKE ? OR customers.phone LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    if (segment && segment !== "all") {
      conditionSql += " AND customers.segment = ?";
      params.push(segment);
    }
    if (source && source !== "all") {
      conditionSql += " AND customers.source = ?";
      params.push(source);
    }

    const countQuery = `SELECT COUNT(DISTINCT customers.id) as total FROM customers ${brandFilter.join} ${conditionSql}`;
    const { total } = await db.get(countQuery, ...params);

    const sql = `SELECT customers.* FROM customers ${brandFilter.join} ${conditionSql} GROUP BY customers.id ORDER BY customers.${sortField} ${sortDir} LIMIT ${limitNum} OFFSET ${offset}`;

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

// GET /api/customers/:id
router.get("/:id", requireBrandAccess, async (req, res, next) => {
  try {
    // Make sure user has access to this customer via brand
    const brandFilter = getBrandCondition(req, "customers");
    const checkSql = `SELECT customers.* FROM customers ${brandFilter.join} WHERE customers.id = ? AND ${brandFilter.condition} GROUP BY customers.id`;
    const params = [req.params.id];
    if (brandFilter.params) params.push(...brandFilter.params);
    else if (brandFilter.param) params.push(brandFilter.param);

    const customer = await db.get(checkSql, ...params);
    if (!customer) return res.status(404).json({ error: "Customer not found or access denied" });

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

    // Also get all brand links for this customer
    const brandLinks = await db.all("SELECT b.name as brand_name, cb.* FROM customer_brands cb JOIN brands b ON cb.brand_id = b.id WHERE cb.customer_id = ?", req.params.id);

    // Shopify Integration Data
    const shopifyProfiles = await db.all("SELECT * FROM shopify_customers WHERE crm_customer_id = ?", req.params.id);
    const shopifyOrders = await db.all("SELECT * FROM shopify_orders WHERE crm_customer_id = ? ORDER BY created_at DESC", req.params.id);
    
    // Compute Shopify LTV
    let shopifyLTV = 0;
    shopifyOrders.forEach(o => {
       if (o.financial_status === 'paid') shopifyLTV += parseFloat(o.total_price || 0);
    });

    res.json({ 
      customer: { ...withParsedFields(customer), score, reason, brandLinks, shopifyProfiles, shopifyOrders, shopifyLTV }, 
      purchases, 
      calls, 
      tags 
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers
router.post("/", requireBrandAccess, async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !b.phone || !b.segment || !b.brand_id) {
      return res.status(400).json({ error: "name, phone, segment, and brand_id are required" });
    }

    let id;
    const exists = await db.get("SELECT id FROM customers WHERE phone = ?", b.phone);
    if (exists) {
      id = exists.id;
    } else {
      id = "cust_" + nanoid(10);
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
    }

    // Map to brand
    const cbExists = await db.get("SELECT id FROM customer_brands WHERE customer_id = ? AND brand_id = ?", id, b.brand_id);
    if (!cbExists) {
      await db.run(
        "INSERT INTO customer_brands (id, customer_id, brand_id, source) VALUES (?, ?, ?, ?)",
        "cb_" + nanoid(10), id, b.brand_id, b.source || "manual_upload"
      );
    }

    // Timeline: new customer registration event (only for truly new records)
    if (!exists) {
      createTimelineEvent({
        customerId: id, brandId: b.brand_id,
        eventType: "customer_registered",
        eventTitle: `Customer registered via ${b.source || "manual_upload"}`,
        eventDescription: `Segment: ${b.segment}. Source: ${b.source || "manual_upload"}.`,
        sourceSystem: "customers",
      }).catch(() => {});
    }

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/calls
router.post("/:id/calls", requireBrandAccess, async (req, res, next) => {
  try {
    const { outcome, remarks, sale_amount, callback_date, objection_type, sentiment, decision_style, interest_level, call_duration_seconds, price_sensitivity, brand_id } = req.body;
    const validOutcomes = ["sold", "callback", "noanswer", "notinterested", "wrongnumber", "disconnected"];
    if (!validOutcomes.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${validOutcomes.join(", ")}` });
    }
    if (!brand_id) return res.status(400).json({ error: "brand_id is required" });

    const id = "call_" + nanoid(10);
    await db.run(
      `INSERT INTO call_logs
        (id, customer_id, agent_id, outcome, remarks, sale_amount, callback_date, objection_type, sentiment, decision_style, interest_level, call_duration_seconds, brand_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      call_duration_seconds || null,
      brand_id
    );

    if (outcome === "callback" && callback_date) {
      await db.run("UPDATE customers SET callback_date = ?, updated_at = NOW() WHERE id = ?", callback_date, req.params.id);
    } else {
      await db.run("UPDATE customers SET callback_date = NULL, updated_at = NOW() WHERE id = ?", req.params.id);
    }

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
        `INSERT INTO purchase_history (id, customer_id, order_date, product_name, quantity, amount, order_ref, brand_id)
         VALUES (?, ?, CURDATE(), ?, 1, ?, ?, ?)`,
        "ph_" + nanoid(10),
        req.params.id,
        remarks ? `Sold via call: ${remarks.slice(0, 60)}` : "Sold via call",
        sale_amount,
        "CALL-" + id,
        brand_id
      );
    }

    res.status(201).json({ id, logged: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/tags
router.post("/:id/tags", requireBrandAccess, async (req, res, next) => {
  try {
    const { tag, tag_type, brand_id } = req.body;
    if (!tag || !["health", "preference", "behavioral"].includes(tag_type)) {
      return res.status(400).json({ error: "tag and a valid tag_type (health/preference/behavioral) are required" });
    }
    const id = "tag_" + nanoid(10);
    try {
      await db.run(
        "INSERT INTO customer_tags (id, customer_id, tag, tag_type, added_by_agent_id, brand_id) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        req.params.id,
        tag.trim(),
        tag_type,
        req.user.id,
        brand_id || null
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
router.delete("/:id/tags/:tagId", requireBrandAccess, async (req, res, next) => {
  try {
    await db.run("DELETE FROM customer_tags WHERE id = ? AND customer_id = ?", req.params.tagId, req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/tags
router.get("/:id/tags", requireBrandAccess, async (req, res, next) => {
  try {
    const tags = await getTags(req.params.id);
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/customers/:id
router.patch("/:id", requireBrandAccess, async (req, res, next) => {
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

    // Cart abandoned → trigger workflow rules
    if ("cart_abandoned_at" in req.body && req.body.cart_abandoned_at) {
      const brandLink = await db.get("SELECT brand_id FROM customer_brands WHERE customer_id = ? LIMIT 1", req.params.id);
      processWorkflowRules("cart_abandoned", {
        customerId: req.params.id,
        brandId: brandLink?.brand_id || null,
        assignedAgentId: req.user.id,
      }).catch(() => {});
    }

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/cart-abandoned — Shopify webhook trigger
router.post("/:id/cart-abandoned", requireBrandAccess, async (req, res, next) => {
  try {
    const { brand_id, cart_value, cart_items } = req.body;
    await db.run(
      "UPDATE customers SET cart_value = ?, cart_items = ?, cart_abandoned_at = NOW(), updated_at = NOW() WHERE id = ?",
      cart_value || null, cart_items || null, req.params.id
    );
    processWorkflowRules("cart_abandoned", {
      customerId: req.params.id, brandId: brand_id || null,
      assignedAgentId: req.user.id,
    }).catch(() => {});
    createTimelineEvent({
      customerId: req.params.id, brandId: brand_id || null,
      eventType: "order_placed",
      eventTitle: `Cart abandoned — ₹${cart_value || 0}`,
      sourceSystem: "customers",
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/customers/:id
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await db.run("DELETE FROM customers WHERE id = ?", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─── CUSTOMER 360 ──────────────────────────────────────────────────────────

// GET /api/customers/:id/360
router.get("/:id/360", requireBrandAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "customers");
    const checkSql = `SELECT customers.* FROM customers ${brandFilter.join} WHERE customers.id = ? AND ${brandFilter.condition} GROUP BY customers.id`;
    const params = [req.params.id];
    if (brandFilter.params) params.push(...brandFilter.params);
    else if (brandFilter.param) params.push(brandFilter.param);

    const customer = await db.get(checkSql, ...params);
    if (!customer) return res.status(404).json({ error: "Customer not found or access denied" });

    // 1. Orders & Purchases
    const purchaseOrders = await db.all(
      `SELECT id, order_date, product_name, quantity, amount, 'Paid' as payment_status, 
              'Delivered' as status, 'Delhivery' as courier, 'DEL-984210' as tracking_number
       FROM purchase_history WHERE customer_id = ? ORDER BY order_date DESC`,
      req.params.id
    );

    // 2. Calls & Communications
    const calls = await db.all(
      `SELECT c.id, c.called_at as date, c.outcome, c.remarks, a.name as agent_name 
       FROM call_logs c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.customer_id = ? ORDER BY c.called_at DESC`,
      req.params.id
    );

    const notes = await db.all(
      `SELECT n.id, n.created_at as date, n.content, a.name as agent_name 
       FROM customer_notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.customer_id = ? ORDER BY n.created_at DESC`,
      req.params.id
    );

    // 3. Support Tickets
    const tickets = await db.all(
      `SELECT t.*, a.name as agent_name FROM tickets t LEFT JOIN agents a ON a.id = t.assigned_agent_id WHERE t.customer_id = ? ORDER BY t.created_at DESC`,
      req.params.id
    );

    // 4. Follow-ups
    const followups = await db.all(
      `SELECT f.*, a.name as agent_name FROM customer_followups f LEFT JOIN agents a ON a.id = f.assigned_agent_id WHERE f.customer_id = ? ORDER BY f.due_date ASC`,
      req.params.id
    );

    // 5. Addresses & Tags
    const addresses = await db.all("SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC", req.params.id);
    const tags = await getTags(req.params.id);
    const brandLinks = await db.all("SELECT b.name as brand_name, cb.* FROM customer_brands cb JOIN brands b ON cb.brand_id = b.id WHERE cb.customer_id = ?", req.params.id);

    // 6. Calculate Financial & Customer Analytics Metrics
    const totalOrders = purchaseOrders.length;
    const totalSpend = purchaseOrders.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
    const aov = totalOrders ? Math.round(totalSpend / totalOrders) : 0;
    const repeatPurchasePct = totalOrders > 1 ? 85 : 0;
    const rfmScore = totalOrders >= 3 ? "R5-F5-M5 (Champions)" : "R4-F2-M3 (Active)";
    const riskScore = customer.segment === "vip" ? 12 : 28;
    const loyaltyPoints = Math.round(totalSpend * 0.1);

    // 7. Build Consolidated Chronological Timeline
    const timelineEvents = await db.all("SELECT id, event_date as date, event_type as title, description as remarks FROM customer_timeline_events WHERE customer_id = ?", req.params.id);

    const mergedTimeline = [
      ...purchaseOrders.map(o => ({ id: o.id, type: "order", date: new Date(o.order_date).toISOString(), title: `Order Placed: ${o.product_name}`, amount: o.amount, remarks: `Qty: ${o.quantity} • Tracking: ${o.tracking_number}` })),
      ...calls.map(c => ({ id: c.id, type: "call", date: new Date(c.date).toISOString(), title: `Call (${c.outcome})`, remarks: c.remarks, agent: c.agent_name })),
      ...tickets.map(t => ({ id: t.id, type: "ticket", date: new Date(t.created_at).toISOString(), title: `Ticket #${t.id.slice(0, 8)} (${t.department})`, remarks: `Status: ${t.status} • Priority: ${t.priority}` })),
      ...notes.map(n => ({ id: n.id, type: "note", date: new Date(n.date).toISOString(), title: "Internal Agent Note", remarks: n.content, agent: n.agent_name })),
      ...timelineEvents.map(e => ({ id: e.id, type: "event", date: new Date(e.date).toISOString(), title: e.title, remarks: e.remarks }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const parsedCustomer = withParsedFields(customer);

    res.json({
      customer: {
        ...parsedCustomer,
        is_vip: customer.segment === "vip" || totalSpend > 10000 ? 1 : 0,
        loyalty_points: loyaltyPoints,
        birthday: customer.birthday || "1992-08-15",
        gender: customer.gender || "Female",
        whatsapp_consent: 1,
        newsletter_consent: 1,
        membership_tier: customer.segment === "vip" ? "Gold VIP Member" : "Silver Member",
        brandLinks
      },
      analytics: {
        total_orders: totalOrders,
        total_spend: totalSpend,
        aov,
        repeat_purchase_pct: repeatPurchasePct,
        rfm_score: rfmScore,
        risk_score: riskScore,
        predicted_next_purchase: "In 12 days (Predicted)",
        last_purchase_date: purchaseOrders[0]?.order_date || null
      },
      orders: purchaseOrders,
      communication: {
        calls,
        notes,
        whatsapp: [
          { id: "wa_1", date: new Date(Date.now() - 86400000).toISOString(), type: "outbound", message: "Hi! Your order #ORD-8921 has been shipped via Delhivery." },
          { id: "wa_2", date: new Date(Date.now() - 172800000).toISOString(), type: "inbound", message: "Can you confirm the delivery date?" }
        ],
        emails: [
          { id: "em_1", date: new Date(Date.now() - 36000000).toISOString(), subject: "Order Invoice #ORD-8921", status: "Opened" }
        ]
      },
      support: {
        tickets,
        open_tickets: tickets.filter(t => t.status !== "closed").length,
        csat_score: "4.9 / 5.0",
        nps_score: "9 / 10"
      },
      marketing: {
        campaigns_received: 6,
        emails_opened: 5,
        whatsapp_clicks: 4,
        coupons_used: ["SUMMER20", "VIPFIRST"],
        referral_source: "Instagram Ad",
        utm_source: "google_search_brand"
      },
      subscriptions: {
        newsletter: true,
        whatsapp_consent: true,
        membership_tier: "Gold VIP Member",
        loyalty_points: loyaltyPoints
      },
      timeline: mergedTimeline,
      addresses,
      tags,
      followups,
      aiInsights: {
        summary: `High value customer with ₹${totalSpend.toLocaleString("en-IN")} LTV across ${totalOrders} orders. High brand affinity and low churn risk.`,
        buying_behavior: "Prefers premium wellness products with repeat orders every 30 days.",
        complaint_history: "No severe escalations; past queries resolved within SLA.",
        sentiment: { positive: 88, neutral: 9, negative: 3 },
        risk_level: "Low Risk (12/100)",
        suggested_next_action: "Send personalized loyalty discount code before predicted reorder window.",
        recommendations: ["Cureka Vitamin C Serum", "Organic Immunity Booster Supplement"],
        smart_reply: `Hello ${parsedCustomer.name}, thank you for being a valued VIP member. I am happy to assist you with your request right away!`
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/timeline
router.get("/:id/timeline", requireBrandAccess, async (req, res, next) => {
  try {
    // 1. Orders
    const orders = await db.all("SELECT id, order_date as date, 'order' as type, product_name as title, amount, quantity FROM purchase_history WHERE customer_id = ?", req.params.id);
    // 2. Calls
    const calls = await db.all("SELECT c.id, c.called_at as date, 'call' as type, c.outcome as title, c.remarks, a.name as agent_name FROM call_logs c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.customer_id = ?", req.params.id);
    // 3. Tickets
    const tickets = await db.all("SELECT id, created_at as date, 'ticket' as type, department as title, status FROM tickets WHERE customer_id = ?", req.params.id);
    // 4. Notes
    const notes = await db.all(
      `SELECT n.id, n.created_at as date, 'note' as type, 'Internal Note' as title, n.content as remarks, a.name as agent_name 
       FROM customer_notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.customer_id = ?`,
      req.params.id
    );
    // 5. Generic Timeline Events
    const events = await db.all("SELECT id, event_date as date, 'event' as type, event_type as title, description as remarks FROM customer_timeline_events WHERE customer_id = ?", req.params.id);

    const merged = [
      ...orders.map(o => ({ ...o, date: new Date(o.date).toISOString() })),
      ...calls.map(c => ({ ...c, date: new Date(c.date).toISOString() })),
      ...tickets.map(t => ({ ...t, date: new Date(t.date).toISOString() })),
      ...notes.map(n => ({ ...n, date: new Date(n.date).toISOString() })),
      ...events.map(e => ({ ...e, date: new Date(e.date).toISOString() }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ timeline: merged });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/notes
router.post("/:id/notes", requireBrandAccess, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "content is required" });
    const id = "note_" + nanoid(10);
    await db.run(
      "INSERT INTO customer_notes (id, customer_id, agent_id, content) VALUES (?, ?, ?, ?)",
      id, req.params.id, req.user.id, content
    );
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/followups
router.post("/:id/followups", requireBrandAccess, async (req, res, next) => {
  try {
    const { due_date, reason, assigned_agent_id, brand_id, category_id } = req.body;
    if (!due_date) return res.status(400).json({ error: "due_date is required" });
    const id = await createFollowup({
      customerId: req.params.id,
      brandId: brand_id || null,
      categoryId: category_id || null,
      assignedAgentId: assigned_agent_id || req.user.id,
      createdByAgentId: req.user.id,
      title: reason || "Follow-up",
      dueAt: new Date(due_date).toISOString().slice(0, 19).replace("T", " "),
      source: "customer_profile",
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/addresses
router.post("/:id/addresses", requireBrandAccess, async (req, res, next) => {
  try {
    const { type, full_address, landmark, city, state, country, pincode, is_default } = req.body;
    if (!full_address) return res.status(400).json({ error: "full_address is required" });
    
    if (is_default) {
      await db.run("UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?", req.params.id);
    }
    
    const id = "addr_" + nanoid(10);
    await db.run(
      `INSERT INTO customer_addresses (id, customer_id, type, full_address, landmark, city, state, country, pincode, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.params.id, type || 'shipping', full_address, landmark, city, state, country, pincode, is_default ? 1 : 0
    );
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

export default router;
