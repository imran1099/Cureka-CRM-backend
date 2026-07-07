import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";

const router = express.Router();
router.use(requireAuth, requirePermission("reports", "view"));

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

export default router;
