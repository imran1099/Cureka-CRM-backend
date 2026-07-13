import express from "express";
import { db } from "../db/connection.js";
import { requireAuth, requireManagement } from "../middleware/auth.js";
import { terminateSession, revokeToken, logEvent } from "../services/escamsService.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/audit — paginated audit log
router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const { user_id, action, entity_type, date_from, date_to } = req.query;

    const conditions = [];
    const params = [];

    if (user_id) { conditions.push("al.user_id = ?"); params.push(user_id); }
    if (action) { conditions.push("al.action LIKE ?"); params.push(`%${action}%`); }
    if (entity_type) { conditions.push("al.entity_type = ?"); params.push(entity_type); }
    if (date_from) { conditions.push("al.created_at >= ?"); params.push(date_from); }
    if (date_to) { conditions.push("al.created_at <= ?"); params.push(date_to + " 23:59:59"); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = await db.get(`SELECT COUNT(*) as total FROM audit_logs al ${where}`, ...params);

    const logs = await db.all(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.old_value, al.new_value,
              al.ip, al.device, al.created_at, al.brand_id,
              a.name as user_name, a.email as user_email, a.role as user_role
       FROM audit_logs al
       LEFT JOIN agents a ON a.id = al.user_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      ...params
    );

    const parsedLogs = logs.map((log) => ({
      ...log,
      old_value: log.old_value ? tryParse(log.old_value) : null,
      new_value: log.new_value ? tryParse(log.new_value) : null,
    }));

    res.json({ logs: parsedLogs, total: countRow.total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/audit/login-history — login events
router.get("/login-history", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const { user_id, event_type, date_from, date_to } = req.query;

    const conditions = [];
    const params = [];

    if (user_id) { conditions.push("lh.agent_id = ?"); params.push(user_id); }
    if (event_type) { conditions.push("lh.event_type = ?"); params.push(event_type); }
    if (date_from) { conditions.push("lh.created_at >= ?"); params.push(date_from); }
    if (date_to) { conditions.push("lh.created_at <= ?"); params.push(date_to + " 23:59:59"); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = await db.get(`SELECT COUNT(*) as total FROM login_history lh ${where}`, ...params);

    const history = await db.all(
      `SELECT lh.id, lh.event_type, lh.email_attempted, lh.ip, lh.browser, lh.created_at,
              a.id as user_id, a.name as user_name, a.email as user_email
       FROM login_history lh
       LEFT JOIN agents a ON a.id = lh.agent_id
       ${where}
       ORDER BY lh.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      ...params
    );

    res.json({ history, total: countRow.total, page, limit });
  } catch (err) {
    next(err);
  }
});

function tryParse(val) {
  try { return JSON.parse(val); } catch { return val; }
}

// GET /api/audit/security - ESCAMS Dashboard Data
router.get("/security", requireManagement, async (req, res, next) => {
  try {
    const logs = await db.all(`SELECT * FROM escams_audit_logs ORDER BY created_at DESC LIMIT 50`);
    const alerts = await db.all(`SELECT * FROM escams_alerts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 20`);
    const sessions = await db.all(`SELECT * FROM escams_sessions ORDER BY login_time DESC LIMIT 50`);
    
    res.json({ logs, alerts, sessions });
  } catch (err) {
    next(err);
  }
});

// POST /api/audit/sessions/:id/terminate - Terminate an active session
router.post("/sessions/:id/terminate", requireManagement, async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const session = await db.get("SELECT * FROM escams_sessions WHERE id = ?", sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Mark session terminated
    await terminateSession(sessionId);

    // If we have a mapped JTI or token mechanism, we'd revoke it here. 
    // For V1, the session blocklist checks `x-session-id` on requests, but we'll log it.
    await logEvent({ req, user: req.user }, {
      module: "Security",
      action: "TERMINATE_SESSION",
      entity: "Session",
      entity_id: sessionId
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
