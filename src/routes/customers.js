import express from "express";
import { nanoid } from "nanoid";
import { db, pool } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { requireBrandAccess, requireCustomerAccess } from "../middleware/rbac.js";
import { createTimelineEvent } from "../services/timelineService.js";
import { processWorkflowRules } from "../services/followupService.js";
import { scoreCustomer, todayStr } from "../utils/ranking.js";
import { getBrandCondition, isManagerOrAdmin, getCustomerScopeCondition } from "../utils/dbHelpers.js";
import { parseCsvText } from "./orders.js";

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
    const { segment, agentId, page, limit } = req.query;
    const isManagement = isManagerOrAdmin(req.user);

    const brandFilter = getBrandCondition(req, "customers");
    let sql = `SELECT customers.* FROM customers ${brandFilter.join} WHERE do_not_call = 0 AND ${brandFilter.condition}`;
    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    if (segment && segment !== "all") {
      sql += " AND customers.segment = ?";
      params.push(segment);
    }

    if (!isManagement) {
      // Agents strictly only see their assigned customers
      sql += " AND customers.assigned_agent_id = ?";
      params.push(req.user.id);
    } else if (agentId && agentId !== "all") {
      if (agentId === "unassigned") {
        sql += " AND (customers.assigned_agent_id IS NULL OR customers.assigned_agent_id = '')";
      } else {
        sql += " AND customers.assigned_agent_id = ?";
        params.push(agentId);
      }
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

    const total = ranked.length;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const isAll = limit === "all";
    const limitNum = isAll ? (total || 1) : Math.max(1, parseInt(limit, 10) || 50);
    const offset = (pageNum - 1) * limitNum;
    const paginatedQueue = isAll ? ranked : ranked.slice(offset, offset + limitNum);
    const totalPages = isAll ? 1 : Math.max(1, Math.ceil(total / limitNum));

    res.json({
      queue: paginatedQueue,
      total,
      count: paginatedQueue.length,
      page: pageNum,
      limit: isAll ? total : limitNum,
      totalPages,
      generatedAt: new Date().toISOString()
    });
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
    const brandFilter = getBrandCondition(req, "c");

    let sql = `
      SELECT DISTINCT 
        c.id, c.name, c.phone, c.email, c.segment, (c.segment = 'vip') as is_vip,
        (SELECT COUNT(*) FROM purchase_history p WHERE p.customer_id = c.id) as order_count,
        (SELECT COALESCE(SUM(p.amount), 0) FROM purchase_history p WHERE p.customer_id = c.id) as total_spend,
        (SELECT p.order_date FROM purchase_history p WHERE p.customer_id = c.id ORDER BY p.order_date DESC LIMIT 1) as latest_order_date,
        (SELECT 'Delivered' FROM purchase_history p WHERE p.customer_id = c.id ORDER BY p.order_date DESC LIMIT 1) as latest_order_status
      FROM customers c
      ${brandFilter.join}
      LEFT JOIN purchase_history ph ON ph.customer_id = c.id
      LEFT JOIN tickets t ON t.customer_id = c.id
      WHERE (
        c.name LIKE ? OR
        c.phone LIKE ? OR
        c.email LIKE ? OR
        c.id LIKE ? OR
        ph.order_ref LIKE ? OR
        ph.id LIKE ? OR
        t.id LIKE ?
      ) AND ${brandFilter.condition}
      LIMIT 15
    `;

    const params = [
      searchPattern, searchPattern, searchPattern, searchPattern,
      searchPattern, searchPattern, searchPattern
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
    const { q, segment, source, assigned_agent_id, page = 1, limit = 50, sortBy = "updated_at", sortOrder = "desc" } = req.query;
    
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

    if (!isManagerOrAdmin(req.user)) {
      // Non-managers strictly see only their assigned customers
      conditionSql += " AND customers.assigned_agent_id = ?";
      params.push(req.user.id);
    } else if (assigned_agent_id && assigned_agent_id !== "all") {
      if (assigned_agent_id === "unassigned") {
        conditionSql += " AND (customers.assigned_agent_id IS NULL OR customers.assigned_agent_id = '')";
      } else {
        conditionSql += " AND customers.assigned_agent_id = ?";
        params.push(assigned_agent_id);
      }
    }

    const countQuery = `SELECT COUNT(DISTINCT customers.id) as total FROM customers ${brandFilter.join} ${conditionSql}`;
    const { total } = await db.get(countQuery, ...params);

    const sql = `
      SELECT 
        customers.*,
        (SELECT GROUP_CONCAT(DISTINCT order_ref SEPARATOR ', ') FROM purchase_history WHERE customer_id = customers.id AND status = 'active') as order_ids,
        (SELECT COUNT(*) FROM abandoned_checkouts WHERE crm_customer_id = customers.id AND status = 'abandoned') as abandoned_cart_count
      FROM customers 
      ${brandFilter.join} 
      ${conditionSql} 
      GROUP BY customers.id 
      ORDER BY customers.${sortField} ${sortDir} 
      LIMIT ${limitNum} OFFSET ${offset}
    `;

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

// Helper to escape CSV field values safely
function escapeCsv(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r") || str.includes(";")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// GET /api/customers/export — Export customer data to CSV with customer ID and all details
async function handleCustomerExport(req, res, next) {
  try {
    const q = req.query.q || req.body?.q;
    const segment = req.query.segment || req.body?.segment;
    const source = req.query.source || req.body?.source;
    const assigned_agent_id = req.query.assigned_agent_id || req.body?.assigned_agent_id;
    let customer_ids = req.query.customer_ids || req.body?.customer_ids;

    if (typeof customer_ids === "string") {
      customer_ids = customer_ids.split(",").map(id => id.trim()).filter(Boolean);
    }

    const brandFilter = getBrandCondition(req, "customers");
    let conditionSql = `WHERE ${brandFilter.condition}`;
    const params = brandFilter.params ? [...brandFilter.params] : (brandFilter.param ? [brandFilter.param] : []);

    if (Array.isArray(customer_ids) && customer_ids.length > 0) {
      const placeholders = customer_ids.map(() => "?").join(",");
      conditionSql += ` AND customers.id IN (${placeholders})`;
      params.push(...customer_ids);
    }

    if (q) {
      conditionSql += " AND (customers.name LIKE ? OR customers.phone LIKE ? OR customers.id LIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (segment && segment !== "all") {
      conditionSql += " AND customers.segment = ?";
      params.push(segment);
    }
    if (source && source !== "all") {
      conditionSql += " AND customers.source = ?";
      params.push(source);
    }

    // Role-based scoping: non-managers can strictly ONLY export their assigned customers!
    if (!isManagerOrAdmin(req.user)) {
      conditionSql += " AND customers.assigned_agent_id = ?";
      params.push(req.user.id);
    } else if (assigned_agent_id && assigned_agent_id !== "all") {
      if (assigned_agent_id === "unassigned") {
        conditionSql += " AND (customers.assigned_agent_id IS NULL OR customers.assigned_agent_id = '')";
      } else {
        conditionSql += " AND customers.assigned_agent_id = ?";
        params.push(assigned_agent_id);
      }
    }

    const sql = `
      SELECT 
        customers.*,
        a.name as agent_name,
        a.email as agent_email,
        (SELECT COUNT(*) FROM purchase_history WHERE customer_id = customers.id) as order_count,
        (SELECT GROUP_CONCAT(DISTINCT order_ref SEPARATOR ', ') FROM purchase_history WHERE customer_id = customers.id) as ph_order_ids
      FROM customers
      LEFT JOIN agents a ON a.id = customers.assigned_agent_id
      ${brandFilter.join}
      ${conditionSql}
      GROUP BY customers.id
      ORDER BY customers.created_at DESC
    `;

    const rows = await db.all(sql, ...params);

    const exportHeaders = [
      "Customer ID",
      "Customer Name",
      "Phone",
      "Email",
      "Age",
      "Gender",
      "City",
      "Segment",
      "Source",
      "Lifetime Value (LTV)",
      "Total Orders",
      "Order IDs",
      "Product Name",
      "SKU",
      "Order Status",
      "Last Order Date",
      "Replenish Due Date",
      "Assigned Agent ID",
      "Assigned Agent Name",
      "Assigned Agent Email",
      "Cart Value",
      "Cart Items",
      "Cart Abandoned At",
      "Callback Date",
      "Do Not Call",
      "Health Conditions",
      "Product Preferences",
      "Allergies & Restrictions",
      "Preferred Contact Time",
      "Preferred Language",
      "Household Notes",
      "Price Sensitivity",
      "Shopify Customer ID",
      "Customer Since",
      "Health Score",
      "Created At",
      "Updated At"
    ];

    const csvLines = [
      exportHeaders.join(","),
      ...rows.map((c) => {
        let healthConditions = c.health_conditions;
        try {
          const parsed = JSON.parse(healthConditions);
          if (Array.isArray(parsed)) healthConditions = parsed.join("; ");
        } catch (e) {}

        let productPreferences = c.product_preferences;
        try {
          const parsed = JSON.parse(productPreferences);
          if (Array.isArray(parsed)) productPreferences = parsed.join("; ");
        } catch (e) {}

        let cartItems = c.cart_items;
        try {
          const parsed = JSON.parse(cartItems);
          if (Array.isArray(parsed)) {
            cartItems = parsed.map(item => typeof item === "string" ? item : (item.name || item.title || JSON.stringify(item))).join("; ");
          }
        } catch (e) {}

        const combinedOrderIds = c.ph_order_ids || c.order_ids || "";
        const orderCount = c.order_count > 0 
          ? c.order_count 
          : (combinedOrderIds ? combinedOrderIds.split(/[,;]/).map(s => s.trim()).filter(Boolean).length : (c.product_name ? 1 : 0));

        return [
          escapeCsv(c.id),
          escapeCsv(c.name),
          escapeCsv(c.phone),
          escapeCsv(c.email),
          escapeCsv(c.age),
          escapeCsv(c.gender),
          escapeCsv(c.city),
          escapeCsv(c.segment),
          escapeCsv(c.source),
          escapeCsv(c.ltv || 0),
          escapeCsv(orderCount),
          escapeCsv(combinedOrderIds),
          escapeCsv(c.product_name || ""),
          escapeCsv(c.sku || ""),
          escapeCsv(c.order_status || "Delivered"),
          escapeCsv(c.last_order_date || ""),
          escapeCsv(c.replenish_due_date || ""),
          escapeCsv(c.assigned_agent_id || ""),
          escapeCsv(c.agent_name || (c.assigned_agent_id ? "" : "Unassigned")),
          escapeCsv(c.agent_email || ""),
          escapeCsv(c.cart_value || ""),
          escapeCsv(cartItems || ""),
          escapeCsv(c.cart_abandoned_at || ""),
          escapeCsv(c.callback_date || ""),
          escapeCsv(c.do_not_call ? "Yes" : "No"),
          escapeCsv(healthConditions || ""),
          escapeCsv(productPreferences || ""),
          escapeCsv(c.allergies_restrictions || ""),
          escapeCsv(c.preferred_contact_time || ""),
          escapeCsv(c.preferred_language || ""),
          escapeCsv(c.household_notes || ""),
          escapeCsv(c.price_sensitivity || ""),
          escapeCsv(c.shopify_customer_id || ""),
          escapeCsv(c.customer_since || ""),
          escapeCsv(c.health_score || ""),
          escapeCsv(c.created_at || ""),
          escapeCsv(c.updated_at || "")
        ].join(",");
      })
    ];

    const csvContent = "\uFEFF" + csvLines.join("\r\n");
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="customers_export_${dateStr}_${timeStr}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    next(err);
  }
}

router.get("/export", requireBrandAccess, handleCustomerExport);
router.post("/export", requireBrandAccess, handleCustomerExport);

// GET /api/customers/sample-csv — download sample CSV template for bulk import
router.get("/sample-csv", (req, res) => {
  const csvHeaders = "name,phone,email,age,gender,city,segment,source,ltv,last_order_date,replenish_due_date,cart_value,cart_items,cart_abandoned_at,health_conditions,product_preferences,allergies_restrictions,preferred_contact_time,preferred_language,household_notes,price_sensitivity,product_name,sku,order_ids";
  const sampleRow1 = '"Aarav Sharma","+919876543210","aarav.sharma@example.com",34,"male","Mumbai","vip","meta_ads",12500,"2026-09-15","2026-11-15","","","","diabetes; hypertension","Ayurvedic supplements; Omega-3","None","evening","English","Prefers doorstep delivery","moderate","Daily Multivitamin 60s","DMV-60","ORD-9821, ORD-10244"';
  const sampleRow2 = '"Priya Patel","+919812345678","priya.p@example.com",29,"female","Ahmedabad","abandoned_cart","google_ads",0,"","","2499","Skin Glow Serum 30ml","2026-10-20 14:30:00","acne; dry skin","Organic skincare; Sunscreen","Gluten allergy","morning","Hindi","Family of 3","budget","Skin Glow Serum","SGS-30",""';
  const sampleRow3 = '"Rohan Verma","+919988776655","rohan.v@example.com",42,"male","Delhi","repeat_customer","referral",4500,"2026-10-05","2026-11-05","","","","joint pain","Joint Care Balm; Calcium Tablets","Dust allergy","afternoon","English","","high_value","Joint Care Balm 100g","JCB-100","ORD-11502"';

  const csvContent = [csvHeaders, sampleRow1, sampleRow2, sampleRow3].join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="customer_bulk_import_sample.csv"');
  res.status(200).send(csvContent);
});

// POST /api/customers/bulk — bulk import customer records
router.post("/bulk", requireBrandAccess, async (req, res, next) => {
  try {
    const { rows, brand_id: bodyBrandId } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required and must not be empty" });
    }

    const brandId = bodyBrandId || req.query.brand_id || req.user?.brands?.[0] || null;
    let importedCount = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = (row.name || "").trim();
      const phone = (row.phone || "").trim();

      if (!name || !phone) {
        errors.push({ row: i + 1, error: "name and phone are required" });
        continue;
      }

      try {
        let id;
        const exists = await db.get("SELECT id FROM customers WHERE phone = ?", phone);
        const segment = (row.segment || "new_lead").trim();
        const source = (row.source || "bulk_import").trim();
        const ltv = parseFloat(row.ltv) || 0;
        const age = row.age ? parseInt(row.age, 10) || null : null;
        const gender = (row.gender || "").trim() || null;
        const email = (row.email || "").trim() || null;
        const city = (row.city || "").trim() || null;
        const lastOrderDate = (row.last_order_date || "").trim() || null;
        const replenishDueDate = (row.replenish_due_date || "").trim() || null;
        const cartValue = row.cart_value ? parseFloat(row.cart_value) || null : null;
        const cartItems = (row.cart_items || "").trim() || null;
        const cartAbandonedAt = (row.cart_abandoned_at || "").trim() || null;
        const allergies = (row.allergies_restrictions || "").trim() || null;
        const preferredContactTime = (row.preferred_contact_time || "").trim() || null;
        const preferredLanguage = (row.preferred_language || "").trim() || null;
        const householdNotes = (row.household_notes || "").trim() || null;
        const priceSensitivity = (row.price_sensitivity || "").trim() || null;
        const productName = (row.product_name || "").trim() || null;
        const sku = (row.sku || "").trim() || null;
        const orderIds = (row.order_ids || "").trim() || null;

        // Parse health conditions
        let healthConditions = null;
        if (row.health_conditions) {
          const list = Array.isArray(row.health_conditions)
            ? row.health_conditions
            : String(row.health_conditions).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
          healthConditions = JSON.stringify(list);
        }

        // Parse product preferences
        let productPreferences = null;
        if (row.product_preferences) {
          const list = Array.isArray(row.product_preferences)
            ? row.product_preferences
            : String(row.product_preferences).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
          productPreferences = JSON.stringify(list);
        }

        if (exists) {
          id = exists.id;
          await db.run(
            `UPDATE customers SET
              name = ?, email = COALESCE(?, email), age = COALESCE(?, age), gender = COALESCE(?, gender),
              city = COALESCE(?, city), segment = COALESCE(?, segment), source = COALESCE(?, source),
              ltv = CASE WHEN ? > 0 THEN ? ELSE ltv END,
              last_order_date = COALESCE(?, last_order_date), replenish_due_date = COALESCE(?, replenish_due_date),
              cart_value = COALESCE(?, cart_value), cart_items = COALESCE(?, cart_items),
              cart_abandoned_at = COALESCE(?, cart_abandoned_at),
              health_conditions = COALESCE(?, health_conditions),
              product_preferences = COALESCE(?, product_preferences),
              allergies_restrictions = COALESCE(?, allergies_restrictions),
              preferred_contact_time = COALESCE(?, preferred_contact_time),
              preferred_language = COALESCE(?, preferred_language),
              household_notes = COALESCE(?, household_notes),
              price_sensitivity = COALESCE(?, price_sensitivity),
              product_name = IF(? IS NOT NULL, ?, product_name),
              sku = IF(? IS NOT NULL, ?, sku),
              order_ids = IF(? IS NOT NULL, ?, order_ids),
              updated_at = NOW()
             WHERE id = ?`,
            name, email, age, gender, city, segment, source,
            ltv, ltv,
            lastOrderDate, replenishDueDate,
            cartValue, cartItems, cartAbandonedAt,
            healthConditions, productPreferences, allergies,
            preferredContactTime, preferredLanguage, householdNotes, priceSensitivity,
            productName, productName, sku, sku, orderIds, orderIds,
            id
          );
        } else {
          id = "cust_" + nanoid(10);
          await db.run(
            `INSERT INTO customers
              (id, name, phone, email, age, gender, city, segment, source, ltv, last_order_date, replenish_due_date,
               cart_value, cart_items, cart_abandoned_at,
               health_conditions, product_preferences, allergies_restrictions, preferred_contact_time,
               preferred_language, household_notes, price_sensitivity, product_name, sku, order_ids)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, name, phone, email, age, gender, city, segment, source, ltv, lastOrderDate, replenishDueDate,
            cartValue, cartItems, cartAbandonedAt,
            healthConditions, productPreferences, allergies, preferredContactTime,
            preferredLanguage, householdNotes, priceSensitivity, productName, sku, orderIds
          );

          createTimelineEvent({
            customerId: id,
            brandId: brandId,
            eventType: "customer_registered",
            eventTitle: `Customer imported via ${source}`,
            eventDescription: `Segment: ${segment}. Source: ${source}.`,
            sourceSystem: "customers",
          }).catch(() => {});
        }

        if (brandId) {
          const cbExists = await db.get("SELECT id FROM customer_brands WHERE customer_id = ? AND brand_id = ?", id, brandId);
          if (!cbExists) {
            await db.run(
              "INSERT INTO customer_brands (id, customer_id, brand_id, source) VALUES (?, ?, ?, ?)",
              "cb_" + nanoid(10), id, brandId, source
            );
          }
        }

        // ── Create purchase_history rows from CSV order fields ──────────
        // If product_name or order_ids provided, insert into purchase_history
        // so the Orders tab shows history. Split order_ids by comma/semicolon
        // to support multiple order references in one CSV cell.
        if (productName || orderIds) {
          const orderRefs = orderIds
            ? orderIds.split(/[,;]/).map(s => s.trim()).filter(Boolean)
            : [null];

          for (const orderRef of orderRefs) {
            // Avoid duplicate rows for the same customer + order_ref
            const phKey = orderRef
              ? await db.get(
                  "SELECT id FROM purchase_history WHERE customer_id = ? AND order_ref = ?",
                  id, orderRef
                )
              : null;

            if (!phKey) {
              await db.run(
                `INSERT INTO purchase_history (id, customer_id, order_date, product_name, quantity, amount, order_ref, brand_id)
                 VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
                "ph_" + nanoid(10),
                id,
                lastOrderDate || new Date().toISOString().split("T")[0],
                productName || "Imported Product",
                ltv > 0 ? ltv : 0,
                orderRef || ("CSV-" + nanoid(6)),
                brandId || null
              );
            }
          }
        }

        importedCount++;
      } catch (rowErr) {
        errors.push({ row: i + 1, error: rowErr.message });
      }
    }

    res.json({
      success: true,
      imported: importedCount,
      total: rows.length,
      errors
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/assignment-stats — Customer count per agent and unassigned total
router.get("/assignment-stats", requireBrandAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "customers");
    const whereSql = brandFilter.condition === "1=1" ? "" : `WHERE ${brandFilter.condition}`;
    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    // Total customers
    const totalRow = await db.get(
      `SELECT COUNT(DISTINCT customers.id) as count FROM customers ${brandFilter.join} ${whereSql}`,
      ...params
    );

    // Unassigned customers
    const unassignedRow = await db.get(
      `SELECT COUNT(DISTINCT customers.id) as count FROM customers ${brandFilter.join} 
       ${whereSql ? `${whereSql} AND` : "WHERE"} (customers.assigned_agent_id IS NULL OR customers.assigned_agent_id = '')`,
      ...params
    );

    // Active agents customer counts
    const agentStats = await db.all(`
      SELECT 
        a.id, a.id as agent_id, a.name, a.email, a.role,
        (SELECT COUNT(*) FROM customers WHERE customers.assigned_agent_id = a.id) as assigned_count
      FROM agents a
      WHERE a.active = 1
      ORDER BY assigned_count DESC, a.name ASC
    `);

    res.json({
      totalCustomers: totalRow?.count || 0,
      unassignedCount: unassignedRow?.count || 0,
      agentStats
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/assignment-history — Global assignment audit log
router.get("/assignment-history", async (req, res, next) => {
  try {
    const { customer_id, limit = 100 } = req.query;
    const limitNum = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));

    let sql = `
      SELECT 
        h.id, h.customer_id, h.assigned_at, h.assignment_type, h.notes,
        c.name as customer_name, c.phone as customer_phone,
        a_prev.name as prev_agent_name, a_prev.email as prev_agent_email,
        a_new.name as new_agent_name, a_new.email as new_agent_email,
        a_by.name as assigned_by_name
      FROM customer_assignment_history h
      JOIN customers c ON c.id = h.customer_id
      LEFT JOIN agents a_prev ON a_prev.id = h.previous_agent_id
      LEFT JOIN agents a_new ON a_new.id = h.new_agent_id
      LEFT JOIN agents a_by ON a_by.id = h.assigned_by
    `;
    const params = [];
    if (customer_id) {
      sql += " WHERE h.customer_id = ?";
      params.push(customer_id);
    }
    sql += ` ORDER BY h.assigned_at DESC LIMIT ${limitNum}`;

    const history = await db.all(sql, ...params);
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/bulk-assign — Bulk assign customers to an agent
router.post("/bulk-assign", async (req, res, next) => {
  let connection;
  try {
    if (!isManagerOrAdmin(req.user)) {
      return res.status(403).json({ error: "Forbidden: only managers and administrators can bulk assign customers" });
    }

    const { customer_ids, select_all_filtered, filters = {}, agent_id, notes } = req.body;
    const rawAgentId = agent_id && agent_id !== "unassigned" && agent_id !== "undefined" ? String(agent_id).trim() : null;

    let targetAgentName = "Unassigned";
    let targetAgentId = null;
    if (rawAgentId) {
      const agent = await db.get(
        "SELECT id, name, active FROM agents WHERE (id = ? OR email = ?) AND active = 1",
        rawAgentId, rawAgentId
      );
      if (!agent) {
        return res.status(400).json({ error: "Target agent does not exist or is inactive" });
      }
      targetAgentId = agent.id;
      targetAgentName = agent.name;
    }

    let targetCustomerIds = [];
    if (select_all_filtered) {
      // Build filtered set across entire database
      const brandFilter = getBrandCondition(req, "customers");
      let conditionSql = `WHERE ${brandFilter.condition}`;
      const params = brandFilter.params ? [...brandFilter.params] : (brandFilter.param ? [brandFilter.param] : []);

      if (filters.q) {
        conditionSql += " AND (customers.name LIKE ? OR customers.phone LIKE ?)";
        params.push(`%${filters.q}%`, `%${filters.q}%`);
      }
      if (filters.segment && filters.segment !== "all") {
        conditionSql += " AND customers.segment = ?";
        params.push(filters.segment);
      }
      if (filters.source && filters.source !== "all") {
        conditionSql += " AND customers.source = ?";
        params.push(filters.source);
      }
      if (filters.assigned_agent_id && filters.assigned_agent_id !== "all") {
        if (filters.assigned_agent_id === "unassigned") {
          conditionSql += " AND (customers.assigned_agent_id IS NULL OR customers.assigned_agent_id = '')";
        } else {
          conditionSql += " AND customers.assigned_agent_id = ?";
          params.push(filters.assigned_agent_id);
        }
      }

      const matchingRows = await db.all(`SELECT customers.id FROM customers ${brandFilter.join} ${conditionSql}`, ...params);
      targetCustomerIds = matchingRows.map(r => r.id);
    } else if (Array.isArray(customer_ids) && customer_ids.length > 0) {
      targetCustomerIds = customer_ids.filter(Boolean);
    }

    if (targetCustomerIds.length === 0) {
      return res.status(400).json({ error: "No customers selected for assignment" });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    let assignedCount = 0;
    let unchangedCount = 0;

    // Process in batches of 500 for high performance
    const batchSize = 500;
    for (let i = 0; i < targetCustomerIds.length; i += batchSize) {
      const batchIds = targetCustomerIds.slice(i, i + batchSize);
      const placeholders = batchIds.map(() => "?").join(",");
      const [existingCusts] = await connection.query(
        `SELECT id, assigned_agent_id FROM customers WHERE id IN (${placeholders})`,
        batchIds
      );

      for (const cust of existingCusts) {
        const prevAgentId = cust.assigned_agent_id || null;
        if (prevAgentId === targetAgentId) {
          unchangedCount++;
          continue;
        }

        const historyId = "cah_" + nanoid(10);
        await connection.query(
          `INSERT INTO customer_assignment_history 
           (id, customer_id, previous_agent_id, new_agent_id, assigned_by, assignment_type, notes)
           VALUES (?, ?, ?, ?, ?, 'bulk', ?)`,
          [
            historyId,
            cust.id,
            prevAgentId,
            targetAgentId,
            req.user.id,
            notes || `Bulk assigned to ${targetAgentName} by ${req.user.name || req.user.email}`
          ]
        );
        assignedCount++;
      }

      await connection.query(
        `UPDATE customers SET assigned_agent_id = ?, updated_at = NOW() WHERE id IN (${placeholders})`,
        [targetAgentId, ...batchIds]
      );
    }

    await connection.commit();

    res.json({
      success: true,
      totalSelected: targetCustomerIds.length,
      assignedCount,
      unchangedCount,
      targetAgentId,
      targetAgentName
    });
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/customers/bulk-assign-csv — Bulk assign customers to agents via CSV file
router.post("/bulk-assign-csv", async (req, res, next) => {
  let connection;
  try {
    if (!isManagerOrAdmin(req.user)) {
      return res.status(403).json({ error: "Forbidden: only managers and administrators can bulk assign via CSV" });
    }

    let rows = req.body.rows;
    if (!rows && req.body.csvText) {
      rows = parseCsvText(req.body.csvText);
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No CSV rows found to process" });
    }

    // Preload active agents map (by email and id)
    const activeAgents = await db.all("SELECT id, name, email FROM agents WHERE active = 1");
    const agentByEmail = new Map();
    const agentById = new Map();
    activeAgents.forEach(a => {
      agentByEmail.set(a.email.toLowerCase().trim(), a);
      agentById.set(a.id, a);
    });

    connection = await pool.getConnection();
    await connection.beginTransaction();

    let assignedCount = 0;
    let unchangedCount = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = r._rowNumber || (i + 2);
      
      // Extract Customer Identifier
      const custId = (r["Customer ID"] || r["customer_id"] || r["CustomerId"] || r["ID"] || r["id"] || "").trim();
      let phone = (r["Customer Phone"] || r["customer_phone"] || r["Phone"] || r["phone"] || r["Mobile"] || "").trim();
      
      // Extract Agent Identifier
      const agentEmail = (r["Agent Email"] || r["agent_email"] || r["Email"] || r["email"] || "").trim().toLowerCase();
      const agentId = (r["Agent ID"] || r["agent_id"] || "").trim();

      if (!custId && !phone) {
        errors.push({
          row: rowNum,
          customer_ref: "Empty",
          agent_ref: agentEmail || agentId || "Unassigned",
          reason: "Row is missing both Customer ID and Customer Phone"
        });
        continue;
      }

      // Resolve Agent
      let targetAgent = null;
      let isExplicitUnassign = agentEmail === "unassigned" || agentId === "unassigned" || (!agentEmail && !agentId);
      
      if (agentEmail && agentByEmail.has(agentEmail)) {
        targetAgent = agentByEmail.get(agentEmail);
      } else if (agentId && agentById.has(agentId)) {
        targetAgent = agentById.get(agentId);
      } else if (isExplicitUnassign) {
        targetAgent = null;
      } else {
        errors.push({
          row: rowNum,
          customer_ref: custId || phone,
          agent_ref: agentEmail || agentId,
          reason: `Agent not found or inactive: '${agentEmail || agentId}'`
        });
        continue;
      }

      // Resolve Customer
      let customer = null;
      if (custId) {
        const [cMatches] = await connection.query("SELECT id, name, phone, assigned_agent_id FROM customers WHERE id = ?", [custId]);
        if (cMatches.length > 0) customer = cMatches[0];
      }
      if (!customer && phone) {
        const cleanPhone = phone.replace(/[^0-9]/g, "");
        const [pMatches] = await connection.query(
          "SELECT id, name, phone, assigned_agent_id FROM customers WHERE phone = ? OR phone LIKE ?",
          [phone, `%${cleanPhone.slice(-10)}`]
        );
        if (pMatches.length > 0) customer = pMatches[0];
      }

      if (!customer) {
        errors.push({
          row: rowNum,
          customer_ref: custId || phone,
          agent_ref: targetAgent?.name || "Unassigned",
          reason: `Customer record not found for identifier '${custId || phone}'`
        });
        continue;
      }

      const prevAgentId = customer.assigned_agent_id || null;
      const newAgentId = targetAgent?.id || null;

      if (prevAgentId === newAgentId) {
        unchangedCount++;
        continue;
      }

      const historyId = "cah_" + nanoid(10);
      await connection.query(
        `INSERT INTO customer_assignment_history 
         (id, customer_id, previous_agent_id, new_agent_id, assigned_by, assignment_type, notes)
         VALUES (?, ?, ?, ?, ?, 'csv', ?)`,
        [
          historyId,
          customer.id,
          prevAgentId,
          newAgentId,
          req.user.id,
          `CSV Bulk Assignment to ${targetAgent?.name || "Unassigned"}`
        ]
      );

      await connection.query(
        "UPDATE customers SET assigned_agent_id = ?, updated_at = NOW() WHERE id = ?",
        [newAgentId, customer.id]
      );
      assignedCount++;
    }

    await connection.commit();

    res.json({
      success: true,
      totalRows: rows.length,
      assignedCount,
      unchangedCount,
      errorCount: errors.length,
      errors
    });
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/customers/:id
router.get("/:id", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
router.post("/:id/calls", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
router.post("/:id/tags", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
router.delete("/:id/tags/:tagId", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
  try {
    await db.run("DELETE FROM customer_tags WHERE id = ? AND customer_id = ?", req.params.tagId, req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/tags
router.get("/:id/tags", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
  try {
    const tags = await getTags(req.params.id);
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/customers/:id
router.patch("/:id", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
  try {
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // Enforce role permission if reassigning agent
    if ("assigned_agent_id" in req.body) {
      if (!isManagerOrAdmin(req.user)) {
        return res.status(403).json({ error: "Forbidden: only managers and administrators can reassign customers" });
      }
      const newAgentId = req.body.assigned_agent_id ? String(req.body.assigned_agent_id).trim() : null;
      if (newAgentId !== (customer.assigned_agent_id || null)) {
        await db.run(
          `INSERT INTO customer_assignment_history 
           (id, customer_id, previous_agent_id, new_agent_id, assigned_by, assignment_type, notes)
           VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
          "cah_" + nanoid(10),
          customer.id,
          customer.assigned_agent_id || null,
          newAgentId,
          req.user.id,
          req.body.notes || `Reassigned by ${req.user.name || req.user.email}`
        );
      }
    }

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
router.get("/:id/360", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "customers");
    const checkSql = `SELECT customers.* FROM customers ${brandFilter.join} WHERE customers.id = ? AND ${brandFilter.condition} GROUP BY customers.id`;
    const params = [req.params.id];
    if (brandFilter.params) params.push(...brandFilter.params);
    else if (brandFilter.param) params.push(brandFilter.param);

    const customer = await db.get(checkSql, ...params);
    if (!customer) return res.status(404).json({ error: "Customer not found or access denied" });

    // 1. Orders & Purchases
    const manualOrders = await db.all(
      `SELECT id, order_date, product_name, quantity, amount, order_ref, status
       FROM purchase_history WHERE customer_id = ? AND shopify_line_item_id IS NULL ORDER BY order_date DESC`,
      req.params.id
    );
    
    const shopifyOrdersRaw = await db.all(
      `SELECT o.id, o.order_number, o.total_price, o.currency, o.financial_status, o.fulfillment_status, o.status, o.cancelled_at, o.cancel_reason, o.created_at, o.tags,
              i.id as item_id, i.name as product_name, i.quantity, i.price as amount, i.sku
       FROM shopify_orders o 
       LEFT JOIN shopify_order_items i ON o.id = i.order_id 
       WHERE o.crm_customer_id = ? ORDER BY o.created_at DESC`,
      req.params.id
    );

    const abandonedCheckouts = await db.all(
      `SELECT id, checkout_token, total_price, currency, line_items, abandoned_checkout_url, status, created_at, recovered_at 
       FROM abandoned_checkouts WHERE crm_customer_id = ? ORDER BY created_at DESC`,
      req.params.id
    );

    // Group Shopify orders
    const shopifyOrdersMap = new Map();
    shopifyOrdersRaw.forEach(row => {
      if (!shopifyOrdersMap.has(row.id)) {
        shopifyOrdersMap.set(row.id, {
          id: row.id,
          order_number: row.order_number,
          order_date: row.created_at,
          source: "Shopify",
          financial_status: row.financial_status,
          fulfillment_status: row.fulfillment_status,
          status: row.status,
          cancelled_at: row.cancelled_at,
          cancel_reason: row.cancel_reason,
          total_price: row.total_price,
          currency: row.currency,
          tags: row.tags,
          line_items: []
        });
      }
      if (row.item_id) {
        shopifyOrdersMap.get(row.id).line_items.push({
          product_name: row.product_name,
          sku: row.sku,
          quantity: row.quantity,
          unit_price: row.amount,
          total_price: (row.amount || 0) * (row.quantity || 1)
        });
      }
    });

    const unifiedOrders = [];
    for (const o of Array.from(shopifyOrdersMap.values())) {
      unifiedOrders.push({
        ...o,
        tracking_number: "N/A" // Tracking will be merged from timeline if exists
      });
    }
    for (const m of manualOrders) {
      unifiedOrders.push({
        id: m.id,
        order_number: m.order_ref || m.id,
        order_date: m.order_date,
        source: "CRM",
        financial_status: "Paid", // Default for manual
        fulfillment_status: m.status || "Delivered",
        status: m.status || "active",
        total_price: m.amount * (m.quantity || 1),
        currency: "INR",
        line_items: [{
          product_name: m.product_name,
          quantity: m.quantity,
          unit_price: m.amount,
          total_price: m.amount * (m.quantity || 1)
        }],
        tracking_number: "N/A"
      });
    }
    
    // Sort combined orders by date desc
    unifiedOrders.sort((a, b) => new Date(b.order_date) - new Date(a.order_date));

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
    let effectiveTotalOrders = unifiedOrders.length;
    if (effectiveTotalOrders === 0 && (customer.order_ids || customer.product_name || customer.last_order_date)) {
      effectiveTotalOrders = customer.order_ids 
        ? customer.order_ids.split(/[,;]/).map(s => s.trim()).filter(Boolean).length 
        : 1;
    }
    const totalOrders = effectiveTotalOrders;
    const totalSpend = customer.ltv || 0;
    const aov = totalOrders > 0 ? Math.round(totalSpend / totalOrders) : 0;
    const repeatPurchasePct = totalOrders > 1 ? Math.round(((totalOrders - 1) / totalOrders) * 100) : 0;
    
    // Dynamic RFM
    let rfmScore = "N/A";
    if (totalOrders > 0) {
      const daysSinceLastOrder = Math.floor((new Date() - new Date(unifiedOrders[0].order_date)) / (1000 * 60 * 60 * 24));
      let segment = "Active";
      if (daysSinceLastOrder > 90) segment = "At Risk";
      if (daysSinceLastOrder > 180) segment = "Churned";
      if (totalOrders >= 3 && daysSinceLastOrder <= 30) segment = "Champions";
      rfmScore = `${totalOrders >= 3 ? 'High' : 'Med'}-${segment}`;
    }

    // Dynamic Risk Score
    let riskScore = "N/A";
    if (totalOrders > 0) {
      const daysSinceLastOrder = Math.floor((new Date() - new Date(unifiedOrders[0].order_date)) / (1000 * 60 * 60 * 24));
      riskScore = `${Math.min(100, Math.floor(daysSinceLastOrder / 3))} / 100 (${daysSinceLastOrder > 60 ? 'High' : 'Low'})`;
    }

    // Dynamic Predicted Next Order
    let predictedNextOrder = "Insufficient data";
    if (totalOrders >= 2) {
      const firstDate = new Date(unifiedOrders[unifiedOrders.length - 1].order_date);
      const lastDate = new Date(unifiedOrders[0].order_date);
      const avgIntervalDays = Math.floor(((lastDate - firstDate) / (1000 * 60 * 60 * 24)) / (totalOrders - 1));
      if (avgIntervalDays > 0) {
        const nextDate = new Date(lastDate.getTime() + (avgIntervalDays * 24 * 60 * 60 * 1000));
        predictedNextOrder = nextDate.toISOString().split('T')[0];
      }
    }

    // 7. Build Consolidated Chronological Timeline
    const timelineEvents = await db.all("SELECT id, event_date as date, event_type as title, description as remarks FROM customer_timeline_events WHERE customer_id = ?", req.params.id);

    const mergedTimeline = [
      ...unifiedOrders.map(o => ({ 
        id: o.id, 
        type: "order", 
        date: new Date(o.order_date).toISOString(), 
        title: o.source === "Shopify" ? `Shopify Order #${o.order_number}` : `Manual Order`,
        amount: o.total_price,
        remarks: `Items: ${o.line_items.map(i => i.product_name).join(', ')} • Status: ${o.fulfillment_status}` 
      })),
      ...calls.map(c => ({ id: c.id, type: "call", date: new Date(c.date).toISOString(), title: `Call (${c.outcome})`, remarks: c.remarks, agent: c.agent_name })),
      ...tickets.map(t => ({ id: t.id, type: "ticket", date: new Date(t.created_at).toISOString(), title: `Ticket #${t.id.slice(0, 8)} (${t.department})`, remarks: `Status: ${t.status} • Priority: ${t.priority}` })),
      ...notes.map(n => ({ id: n.id, type: "note", date: new Date(n.date).toISOString(), title: "Internal Agent Note", remarks: n.content, agent: n.agent_name })),
      ...timelineEvents.map(e => ({ id: e.id, type: "event", date: new Date(e.date).toISOString(), title: e.title, remarks: e.remarks }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Determine loyalty points (if DB has a column, use it, else return N/A)
    const loyaltyPoints = customer.loyalty_points !== undefined ? customer.loyalty_points : "Not available";

    const parsedCustomer = withParsedFields(customer);

    res.json({
      customer: {
        ...parsedCustomer,
        is_vip: customer.segment === "vip" ? 1 : 0,
        loyalty_points: loyaltyPoints,
        birthday: customer.birthday || "N/A",
        gender: customer.gender || "N/A",
        whatsapp_consent: customer.whatsapp_consent !== undefined ? customer.whatsapp_consent : "N/A",
        newsletter_consent: customer.newsletter_consent !== undefined ? customer.newsletter_consent : "N/A",
        membership_tier: customer.segment === "vip" ? "VIP" : "Standard",
        brandLinks
      },
      analytics: {
        total_orders: totalOrders,
        total_spend: totalSpend,
        aov,
        repeat_purchase_pct: repeatPurchasePct,
        rfm_score: rfmScore,
        risk_score: riskScore,
        predicted_next_purchase: predictedNextOrder,
        last_purchase_date: unifiedOrders.length > 0 ? unifiedOrders[0].order_date : null
      },
      orders: unifiedOrders,
      abandoned_checkouts: abandonedCheckouts,
      communication: {
        calls,
        notes,
        whatsapp: [],
        emails: []
      },
      support: {
        tickets,
        open_tickets: tickets.filter(t => t.status !== "closed").length,
        csat_score: "N/A",
        nps_score: "N/A"
      },
      marketing: {
        campaigns_received: "N/A",
        emails_opened: "N/A",
        whatsapp_clicks: "N/A",
        coupons_used: [],
        referral_source: "N/A",
        utm_source: "N/A"
      },
      subscriptions: {
        newsletter: customer.newsletter_consent === 1,
        whatsapp_consent: customer.whatsapp_consent === 1,
        membership_tier: customer.segment === "vip" ? "VIP" : "Standard",
        loyalty_points: loyaltyPoints
      },
      timeline: mergedTimeline,
      addresses,
      tags,
      followups,
      aiInsights: {
        summary: totalOrders > 0 
          ? `Customer has ₹${totalSpend.toLocaleString("en-IN")} lifetime spend across ${totalOrders} orders. Average order value is ₹${aov.toLocaleString("en-IN")}.` 
          : "Customer has no purchase history.",
        buying_behavior: totalOrders > 0 
          ? `Most frequently purchased category: ${unifiedOrders[0]?.line_items[0]?.product_name || "Unknown"}`
          : "Insufficient purchase history to determine buying behavior.",
        complaint_history: tickets.length > 0 ? `Customer has raised ${tickets.length} support tickets.` : "No support tickets raised.",
        sentiment: "Sentiment analysis unavailable",
        risk_level: riskScore,
        suggested_next_action: totalOrders > 0 ? "Review recent order history and re-engage if necessary." : "Send welcome sequence to encourage first purchase.",
        recommendations: [],
        smart_reply: "Smart reply suggestions unavailable."
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/timeline
router.get("/:id/timeline", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
router.post("/:id/notes", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
router.post("/:id/followups", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
router.post("/:id/addresses", requireBrandAccess, requireCustomerAccess, async (req, res, next) => {
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
