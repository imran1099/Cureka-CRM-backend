import express from "express";
import { pool, db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { nanoid } from "nanoid";

const router = express.Router();

/**
 * Standard allowed order statuses in Cureka CRM.
 * Normalized to standard Title Case for consistency across DB tables.
 */
export const ALLOWED_STATUSES = [
  "Delivered",
  "Shipped",
  "Processing",
  "Pending",
  "Cancelled",
  "Refunded",
  "Returned",
  "Out for Delivery",
  "Confirmed",
  "Failed",
  "Unfulfilled",
  "Fulfilled"
];

const STATUS_MAP = new Map(
  ALLOWED_STATUSES.map(s => [s.toLowerCase().replace(/[\s_-]+/g, ""), s])
);

/**
 * Normalizes input status to official CRM status, or returns null if invalid.
 */
export function normalizeStatus(raw) {
  if (!raw || typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return STATUS_MAP.get(key) || null;
}

/**
 * Clean and normalize phone numbers for robust matching
 * (e.g. "+91 98765 43210" -> "9876543210" and "+919876543210")
 */
export function normalizePhone(raw) {
  if (!raw) return "";
  const cleaned = String(raw).trim().replace(/[^\d+]/g, "");
  return cleaned;
}

/**
 * Authorization guard: User must be admin or have 'orders:edit' permission.
 */
function requireOrderEditPermission(req, res, next) {
  const role = req.user?.role;
  const permissions = req.user?.permissions || [];
  
  if (role === "admin" || role === "super_admin" || permissions.includes("orders:edit") || permissions.includes("orders:manage")) {
    return next();
  }
  return res.status(403).json({ error: "Forbidden: You do not have permission to edit orders" });
}

/**
 * Robust CSV Line Parser (RFC-4180 compliant)
 */
function splitCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

export function parseCsvText(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  
  return lines.slice(1).filter(l => l.trim().length > 0).map((line, idx) => {
    const values = splitCsvLine(line);
    const row = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => {
      row[h] = values[i] !== undefined ? values[i].trim() : "";
    });
    return row;
  });
}

/**
 * Normalize row object to extract phone, orderId, orderStatus
 */
export function extractRowFields(row) {
  let phone = "";
  let orderId = "";
  let status = "";

  for (const [key, val] of Object.entries(row)) {
    if (key.startsWith("_")) continue;
    const cleanKey = key.toLowerCase().replace(/[\s_-]+/g, "");
    if (cleanKey === "customerphone" || cleanKey === "phone") {
      phone = String(val || "").trim();
    } else if (cleanKey === "orderid" || cleanKey === "orderref" || cleanKey === "ordernumber") {
      orderId = String(val || "").trim();
    } else if (cleanKey === "orderstatus" || cleanKey === "status") {
      status = String(val || "").trim();
    }
  }

  return { phone, orderId, status };
}

// ─── GET /api/orders/sample-csv ──────────────────────────────────────────────
router.get("/sample-csv", requireAuth, (req, res) => {
  const csvHeaders = "Customer Phone,Order ID,Order Status";
  const sample1 = '"+919876543210","ORD-9821","Delivered"';
  const sample2 = '"+919876543210","ORD-10244","Shipped"';
  const sample3 = '"+919988776655","ORD-11502","Processing"';

  const csvContent = [csvHeaders, sample1, sample2, sample3].join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="bulk_order_status_update_sample.csv"');
  res.status(200).send(csvContent);
});

// ─── POST /api/orders/preview — Validate and Preview without committing ────────
router.post("/preview", requireAuth, requireOrderEditPermission, async (req, res, next) => {
  try {
    let rows = req.body.rows;
    if (!rows && req.body.csvText) {
      rows = parseCsvText(req.body.csvText);
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No records found in CSV to preview" });
    }

    const previewResults = await analyzeOrderRows(rows);
    res.json(previewResults);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/orders/bulk-status-update ─────────────────────────────────────
router.post("/bulk-status-update", requireAuth, requireOrderEditPermission, async (req, res, next) => {
  let connection;
  try {
    let rows = req.body.rows;
    if (!rows && req.body.csvText) {
      rows = parseCsvText(req.body.csvText);
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array or csvText is required and must not be empty" });
    }

    // 1. Analyze and validate all rows first
    const analysis = await analyzeOrderRows(rows);

    // 2. Perform updates inside a database transaction
    connection = await pool.getConnection();
    await connection.beginTransaction();

    let successfullyUpdated = 0;
    const finalResults = [];

    for (const item of analysis.items) {
      if (item.result !== "valid_for_update") {
        finalResults.push({
          rowNumber: item.rowNumber,
          customerPhone: item.customerPhone,
          orderId: item.orderId,
          requestedStatus: item.requestedStatus,
          previousStatus: item.currentStatus || "N/A",
          result: item.result, // "unchanged", "skipped", "failed", "duplicate"
          reason: item.reason
        });
        continue;
      }

      // Execute update on the identified order records
      const targetStatus = item.normalizedStatus;
      let orderUpdated = false;

      // A) Update purchase_history records
      if (item.matches.purchaseHistory && item.matches.purchaseHistory.length > 0) {
        for (const ph of item.matches.purchaseHistory) {
          await connection.query(
            "UPDATE purchase_history SET status = ? WHERE id = ?",
            [targetStatus, ph.id]
          );
          orderUpdated = true;
        }
      }

      // B) Update shopify_orders records
      if (item.matches.shopifyOrders && item.matches.shopifyOrders.length > 0) {
        for (const so of item.matches.shopifyOrders) {
          await connection.query(
            "UPDATE shopify_orders SET fulfillment_status = ?, updated_at = NOW() WHERE id = ?",
            [targetStatus, so.id]
          );
          orderUpdated = true;
        }
      }

      // C) Update orders table records
      if (item.matches.orders && item.matches.orders.length > 0) {
        for (const o of item.matches.orders) {
          await connection.query(
            "UPDATE orders SET status = ? WHERE id = ?",
            [targetStatus, o.id]
          );
          orderUpdated = true;
        }
      }

      if (orderUpdated) {
        successfullyUpdated++;
        finalResults.push({
          rowNumber: item.rowNumber,
          customerPhone: item.customerPhone,
          orderId: item.orderId,
          requestedStatus: targetStatus,
          previousStatus: item.currentStatus,
          result: "updated",
          reason: `Successfully updated status from '${item.currentStatus}' to '${targetStatus}'`
        });
      } else {
        finalResults.push({
          rowNumber: item.rowNumber,
          customerPhone: item.customerPhone,
          orderId: item.orderId,
          requestedStatus: targetStatus,
          previousStatus: item.currentStatus,
          result: "failed",
          reason: "Database update affected 0 rows"
        });
      }
    }

    // 3. Commit transaction
    await connection.commit();

    // 4. Audit Log Entry
    try {
      const summaryStats = {
        totalRows: rows.length,
        updated: successfullyUpdated,
        unchanged: analysis.unchangedCount,
        skipped: analysis.skippedCount,
        failed: analysis.failedCount,
        duplicate: analysis.duplicateCount,
      };

      await db.run(
        `INSERT INTO audit_logs (id, agent_id, action, entity, entity_id, brand_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "al_" + nanoid(10),
        req.user.id,
        "BULK_ORDER_STATUS_UPDATE",
        "orders",
        "bulk_csv",
        req.user?.brands?.[0] || null,
        JSON.stringify(summaryStats)
      );
    } catch (auditErr) {
      console.warn("Audit log creation non-fatal error:", auditErr.message);
    }

    // 5. Build summary response
    const skippedRecords = finalResults.filter(r => r.result === "skipped");
    const failedRecords = finalResults.filter(r => r.result === "failed" || r.result === "duplicate");
    const unchangedRecords = finalResults.filter(r => r.result === "unchanged");
    const errorRows = finalResults.filter(r => r.result !== "updated");

    res.json({
      success: true,
      summary: {
        totalRows: rows.length,
        updatedCount: successfullyUpdated,
        unchangedCount: unchangedRecords.length,
        skippedCount: skippedRecords.length,
        failedCount: failedRecords.length,
        duplicateCount: analysis.duplicateCount,
        invalidStatusCount: analysis.invalidStatusCount,
      },
      results: finalResults,
      errorRows
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rbErr) {
        console.error("Rollback error:", rbErr);
      }
    }
    next(err);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * Core validation and matching engine for CSV order rows.
 * Validates syntax, duplicates, order existence, customer matching, and status change necessity.
 */
async function analyzeOrderRows(rows) {
  const items = [];
  const orderIdMap = new Map(); // orderId -> array of rows with that orderId

  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  let unchangedCount = 0;
  let invalidStatusCount = 0;

  // Pass 1: Parse fields and detect CSV-level duplicates
  for (let i = 0; i < rows.length; i++) {
    const rawRow = rows[i];
    const rowNumber = rawRow._rowNumber || i + 1;
    const { phone, orderId, status } = extractRowFields(rawRow);

    const item = {
      rowNumber,
      customerPhone: phone,
      orderId,
      requestedStatus: status,
      normalizedStatus: null,
      currentStatus: null,
      result: null,
      reason: null,
      matches: {
        purchaseHistory: [],
        shopifyOrders: [],
        orders: []
      }
    };

    if (!orderId) {
      item.result = "failed";
      item.reason = "Empty Order ID";
      invalidCount++;
      items.push(item);
      continue;
    }

    if (!status) {
      item.result = "failed";
      item.reason = "Empty Order Status";
      invalidCount++;
      items.push(item);
      continue;
    }

    const normStatus = normalizeStatus(status);
    if (!normStatus) {
      item.result = "failed";
      item.reason = `Invalid order status '${status}'. Must be one of: ${ALLOWED_STATUSES.join(", ")}`;
      invalidCount++;
      invalidStatusCount++;
      items.push(item);
      continue;
    }
    item.normalizedStatus = normStatus;

    // Track for duplicate detection
    if (!orderIdMap.has(orderId)) {
      orderIdMap.set(orderId, []);
    }
    orderIdMap.get(orderId).push(item);
    items.push(item);
  }

  // Pass 2: Check for ambiguous duplicate Order IDs in CSV
  for (const [orderId, group] of orderIdMap.entries()) {
    if (group.length > 1) {
      const distinctStatuses = new Set(group.map(g => g.normalizedStatus));
      if (distinctStatuses.size > 1) {
        // Conflicting statuses for the same order in the same CSV!
        for (const itm of group) {
          itm.result = "failed";
          itm.reason = `Duplicate Order ID '${orderId}' in CSV with conflicting statuses: ${Array.from(distinctStatuses).join(", ")}`;
          duplicateCount++;
          invalidCount++;
        }
      } else {
        // Same status repeated: keep first as candidate, mark subsequent as duplicate
        for (let idx = 1; idx < group.length; idx++) {
          group[idx].result = "duplicate";
          group[idx].reason = `Duplicate Order ID '${orderId}' repeated in CSV (ignored subsequent occurrence)`;
          duplicateCount++;
        }
      }
    }
  }

  // Pass 3: Match against Database (existing orders only)
  for (const item of items) {
    if (item.result) continue; // Already failed or marked duplicate

    const { orderId, customerPhone, normalizedStatus } = item;

    // A) Search purchase_history
    const phRows = await db.all(
      `SELECT ph.id, ph.customer_id, ph.order_ref, ph.status, c.phone, c.name
       FROM purchase_history ph
       LEFT JOIN customers c ON c.id = ph.customer_id
       WHERE ph.order_ref = ?`,
      orderId
    );

    // B) Search shopify_orders
    const soRows = await db.all(
      `SELECT so.id, so.crm_customer_id as customer_id, so.order_number, so.fulfillment_status, so.status, c.phone, c.name
       FROM shopify_orders so
       LEFT JOIN customers c ON c.id = so.crm_customer_id
       WHERE so.order_number = ? OR so.id = ?`,
      orderId, orderId
    );

    // C) Search orders table
    const oRows = await db.all(
      `SELECT o.id, o.customer_id, o.status, c.phone, c.name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ?`,
      orderId
    );

    item.matches.purchaseHistory = phRows;
    item.matches.shopifyOrders = soRows;
    item.matches.orders = oRows;

    const totalMatches = phRows.length + soRows.length + oRows.length;

    // If order not found in any order table:
    if (totalMatches === 0) {
      item.result = "skipped";
      item.reason = `Order ID '${orderId}' not found in CRM orders`;
      skippedCount++;
      continue;
    }

    // Check for ambiguity across different customers
    const matchedCustomerIds = new Set([
      ...phRows.map(r => r.customer_id).filter(Boolean),
      ...soRows.map(r => r.customer_id).filter(Boolean),
      ...oRows.map(r => r.customer_id).filter(Boolean),
    ]);

    if (matchedCustomerIds.size > 1) {
      item.result = "failed";
      item.reason = `Order ID '${orderId}' matches multiple different customer accounts in CRM`;
      invalidCount++;
      continue;
    }

    // If phone is provided in CSV, verify it matches the order's customer
    if (customerPhone) {
      const cleanInputPhone = normalizePhone(customerPhone);
      const matchedPhones = [
        ...phRows.map(r => r.phone),
        ...soRows.map(r => r.phone),
        ...oRows.map(r => r.phone),
      ].filter(Boolean).map(normalizePhone);

      const phoneMatches = matchedPhones.some(p => 
        p === cleanInputPhone || 
        p.endsWith(cleanInputPhone.slice(-10)) || 
        cleanInputPhone.endsWith(p.slice(-10))
      );

      if (matchedPhones.length > 0 && !phoneMatches) {
        item.result = "failed";
        item.reason = `Customer Phone '${customerPhone}' does not match order customer phone '${matchedPhones[0]}'`;
        invalidCount++;
        continue;
      }
    }

    // Determine current order status from matched records
    let currentStatus = null;
    if (phRows.length > 0) {
      currentStatus = phRows[0].status;
    } else if (soRows.length > 0) {
      currentStatus = soRows[0].fulfillment_status || soRows[0].status;
    } else if (oRows.length > 0) {
      currentStatus = oRows[0].status;
    }
    item.currentStatus = currentStatus || "Pending";

    // Check if status is already the requested status
    if (normalizeStatus(item.currentStatus) === normalizedStatus) {
      item.result = "unchanged";
      item.reason = `Order status is already '${item.currentStatus}'`;
      unchangedCount++;
      continue;
    }

    // Valid for update!
    item.result = "valid_for_update";
    validCount++;
  }

  return {
    totalRows: rows.length,
    validCount,
    invalidCount,
    duplicateCount,
    skippedCount,
    unchangedCount,
    invalidStatusCount,
    items
  };
}

export default router;

