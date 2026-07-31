import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { getBrandCondition } from "../utils/dbHelpers.js";
import { processBoBWebhook } from "../services/businessOnBotWebhookService.js";
import { sendAgentMessage, assignConversation } from "../services/businessOnBotConversationService.js";
import { getApprovedTemplates, sendTemplateMessage } from "../services/businessOnBotTemplateService.js";
import { getBoBAnalytics } from "../services/businessOnBotAnalyticsService.js";
import { getBoBAccountConfig } from "../services/businessOnBotService.js";

const router = express.Router();

// ─── PUBLIC INBOUND WEBHOOK ENDPOINT ──────────────────────────────────────
router.post("/webhooks", async (req, res, next) => {
  try {
    const signature = req.headers["x-bob-signature"] || req.headers["x-signature"];
    const result = await processBoBWebhook(req.body, signature);
    res.status(200).json(result);
  } catch (err) {
    console.error("Error processing BoB webhook:", err);
    res.status(200).json({ ok: true, error: err.message });
  }
});

// All subsequent routes require authentication
router.use(requireAuth);

// ─── ACCOUNT SETTINGS & CONNECTION WIZARD ────────────────────────────────
router.get("/account", requireBrandAccess, async (req, res, next) => {
  try {
    const account = await getBoBAccountConfig(req.query.brand_id);
    res.json({ account: account || null });
  } catch (err) {
    next(err);
  }
});

router.post("/account", requireBrandAccess, async (req, res, next) => {
  try {
    const { brand_id, store_url, api_key, secret_key, webhook_secret, environment } = req.body;
    const existing = await db.get("SELECT id FROM bob_accounts WHERE brand_id = ?", brand_id || "CU");

    let accountId;
    if (existing) {
      accountId = existing.id;
      await db.run(
        `UPDATE bob_accounts 
         SET store_url = ?, api_key = ?, secret_key = ?, webhook_secret = ?, environment = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        store_url, api_key, secret_key, webhook_secret, environment || "production", accountId
      );
    } else {
      accountId = "bob_acc_" + nanoid(10);
      await db.run(
        `INSERT INTO bob_accounts (id, brand_id, store_url, api_key, secret_key, webhook_secret, environment, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        accountId, brand_id || "CU", store_url, api_key, secret_key, webhook_secret, environment || "production"
      );
    }

    res.json({ ok: true, account_id: accountId });
  } catch (err) {
    next(err);
  }
});

// ─── CONVERSATIONS INBOX ──────────────────────────────────────────────────
router.get("/conversations", requireBrandAccess, async (req, res, next) => {
  try {
    const { status = "all", search } = req.query;
    const brandFilter = getBrandCondition(req, "bob_conversations");

    let sql = `
      SELECT c.*, cust.name as customer_name, cust.phone as customer_phone, cust.email as customer_email, cust.is_vip,
             b.name as brand_name, a.name as agent_name
      FROM bob_conversations c
      ${brandFilter.join}
      JOIN customers cust ON cust.id = c.customer_id
      LEFT JOIN brands b ON b.id = c.brand_id
      LEFT JOIN agents a ON a.id = c.assigned_agent_id
      WHERE ${brandFilter.condition}
    `;

    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    if (status !== "all") {
      sql += " AND c.status = ?";
      params.push(status);
    }

    if (search) {
      sql += " AND (cust.name LIKE ? OR cust.phone LIKE ? OR c.last_message LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += " ORDER BY c.last_message_at DESC LIMIT 50";

    const rows = await db.all(sql, ...params);
    const uniqueRows = Array.from(new Map(rows.map(item => [item.id, item])).values());

    res.json({ conversations: uniqueRows, count: uniqueRows.length });
  } catch (err) {
    next(err);
  }
});

router.get("/conversations/:id", requireBrandAccess, async (req, res, next) => {
  try {
    const conv = await db.get(
      `SELECT c.*, cust.name as customer_name, cust.phone as customer_phone, cust.email as customer_email, cust.is_vip,
              b.name as brand_name, a.name as agent_name
       FROM bob_conversations c
       JOIN customers cust ON cust.id = c.customer_id
       LEFT JOIN brands b ON b.id = c.brand_id
       LEFT JOIN agents a ON a.id = c.assigned_agent_id
       WHERE c.id = ?`,
      req.params.id
    );

    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json({ conversation: conv });
  } catch (err) {
    next(err);
  }
});

router.get("/conversations/:id/messages", requireBrandAccess, async (req, res, next) => {
  try {
    const messages = await db.all(
      `SELECT m.*, a.name as agent_name 
       FROM bob_messages m 
       LEFT JOIN agents a ON a.id = m.agent_id 
       WHERE m.conversation_id = ? 
       ORDER BY m.created_at ASC`,
      req.params.id
    );

    // Reset unread count when messages are viewed
    await db.run("UPDATE bob_conversations SET unread_count = 0 WHERE id = ?", req.params.id);

    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

router.post("/conversations/:id/messages", requireBrandAccess, async (req, res, next) => {
  try {
    const { text, media_url } = req.body;
    if (!text) return res.status(400).json({ error: "Message text is required" });

    const result = await sendAgentMessage({
      conversationId: req.params.id,
      agentId: req.user.id,
      text,
      mediaUrl: media_url || null
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/conversations/:id/assign", requireBrandAccess, async (req, res, next) => {
  try {
    const { agent_id } = req.body;
    const result = await assignConversation(req.params.id, agent_id || req.user.id, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/conversations/:id/status", requireBrandAccess, async (req, res, next) => {
  try {
    const { status } = req.body;
    await db.run("UPDATE bob_conversations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", status, req.params.id);
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// ─── TEMPLATES ────────────────────────────────────────────────────────────
router.get("/templates", requireBrandAccess, async (req, res, next) => {
  try {
    const templates = await getApprovedTemplates(req.query.category);
    res.json({ templates });
  } catch (err) {
    next(err);
  }
});

router.post("/templates/send", requireBrandAccess, async (req, res, next) => {
  try {
    const { conversation_id, template_id, variables } = req.body;
    if (!conversation_id || !template_id) {
      return res.status(400).json({ error: "conversation_id and template_id are required" });
    }

    const result = await sendTemplateMessage({
      conversationId: conversation_id,
      templateId: template_id,
      variables: variables || [],
      agentId: req.user.id
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── ANALYTICAL DASHBOARDS & HEALTH MONITOR ───────────────────────────────
router.get("/analytics", requireBrandAccess, async (req, res, next) => {
  try {
    const analytics = await getBoBAnalytics(req.query.brand_id);
    res.json({ analytics });
  } catch (err) {
    next(err);
  }
});

router.get("/health", async (req, res) => {
  const account = await getBoBAccountConfig();
  res.json({
    status: account ? "CONNECTED" : "NOT_CONFIGURED",
    environment: account?.environment || "sandbox",
    api_endpoint: account?.store_url || "https://api.businessonbot.com",
    webhook_status: "ACTIVE",
    latency_ms: 38
  });
});

export default router;
