import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { connectStore } from "../services/shopifyAuthService.js";
import { validateShopifyWebhook, enqueueWebhook } from "../services/shopifyWebhookService.js";
import { startBulkImport, checkBulkImportStatus } from "../services/shopifyBulkImportService.js";

const router = express.Router();

// ─── PUBLIC WEBHOOK ENDPOINT ──────────────────────────────────────────────────
// This must be unauthenticated to accept requests from Shopify.
// We use raw body parser to get the exact string for HMAC validation.
router.post("/webhooks/:storeId", express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const { storeId } = req.params;
    const hmacHeader = req.get("x-shopify-hmac-sha256");
    const topic = req.get("x-shopify-topic");
    const rawBody = req.body.toString("utf8");

    if (!hmacHeader || !topic) {
      return res.status(400).send("Missing Shopify headers");
    }

    const store = await db.get("SELECT webhook_secret FROM shopify_stores WHERE id = ? AND is_active = 1", storeId);
    if (!store) {
      return res.status(404).send("Store not found or inactive");
    }

    if (!validateShopifyWebhook(rawBody, hmacHeader, store.webhook_secret)) {
      console.warn(`Invalid webhook signature for store ${storeId}, topic ${topic}`);
      return res.status(401).send("Unauthorized: Invalid signature");
    }

    const payload = JSON.parse(rawBody);

    // Enqueue for background processing
    await enqueueWebhook(storeId, topic, payload);

    // Always return 200 OK immediately so Shopify knows we received it
    res.status(200).send("Webhook received");
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).send("Internal Server Error");
  }
});

// ─── AUTHENTICATED ROUTES (REQUIRE LOGIN) ─────────────────────────────────────
router.use(requireAuth);

// GET /api/shopify/stores
router.get("/stores", requireBrandAccess, async (req, res, next) => {
  try {
    let sql = `
      SELECT s.id, s.brand_id, s.store_url, s.is_active, s.last_sync_at, s.created_at, b.name as brand_name
      FROM shopify_stores s
      JOIN brands b ON s.brand_id = b.id
    `;
    const params = [];
    
    if (req.query.brand_id) {
      sql += " WHERE s.brand_id = ?";
      params.push(req.query.brand_id);
    }
    
    const stores = await db.all(sql, ...params);
    res.json({ stores });
  } catch (err) {
    next(err);
  }
});

// POST /api/shopify/stores
router.post("/stores", requireBrandAccess, async (req, res, next) => {
  try {
    const { brand_id, store_url, access_token, webhook_secret } = req.body;
    if (!brand_id || !store_url || !access_token) {
      return res.status(400).json({ error: "brand_id, store_url, and access_token are required." });
    }

    const storeId = await connectStore({
      brandId: brand_id,
      storeUrl: store_url,
      accessToken: access_token,
      webhookSecret: webhook_secret
    });

    res.status(201).json({ id: storeId, message: "Store connected successfully" });
  } catch (err) {
    // Return 400 for token validation failures
    res.status(400).json({ error: err.message });
  }
});

// POST /api/shopify/sync/bulk
// Initiates a bulk import via GraphQL Bulk Operations
router.post("/sync/bulk", requireBrandAccess, async (req, res, next) => {
  try {
    const { store_id, entity_type } = req.body;
    if (!store_id || !entity_type) return res.status(400).json({ error: "store_id and entity_type required" });

    const result = await startBulkImport(store_id, entity_type);
    res.json({ message: "Bulk import started", ...result });
  } catch (err) {
    next(err);
  }
});

// GET /api/shopify/sync/status/:logId
router.get("/sync/status/:storeId/:logId", requireBrandAccess, async (req, res, next) => {
  try {
    const { storeId, logId } = req.params;
    const status = await checkBulkImportStatus(storeId, logId);
    res.json({ status });
  } catch (err) {
    next(err);
  }
});

// GET /api/shopify/logs/:storeId
router.get("/logs/:storeId", requireBrandAccess, async (req, res, next) => {
  try {
    const { storeId } = req.params;
    const logs = await db.all("SELECT * FROM shopify_sync_logs WHERE store_id = ? ORDER BY started_at DESC LIMIT 20", storeId);
    
    // Also fetch queue stats
    const [queueStats] = await db.all(`
      SELECT status, COUNT(*) as count 
      FROM shopify_event_queue 
      WHERE store_id = ? 
      GROUP BY status
    `, storeId);
    
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const row of queueStats) {
      stats[row.status] = row.count;
    }

    res.json({ logs, queueStats: stats });
  } catch (err) {
    next(err);
  }
});

export default router;
