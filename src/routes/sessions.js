import express from "express";
import { nanoid } from "nanoid";
import { db, writeAuditLog } from "../db/connection.js";
import { requireAuth, requireAdmin, getRequestMeta } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/sessions — list sessions
// Admin: all active sessions across all users
// Non-admin: own sessions only
router.get("/", async (req, res, next) => {
  try {
    const isAdmin = ["admin", "super_admin"].includes(req.user.role);
    const userId = req.query.user_id;

    let sql, params;

    if (isAdmin) {
      const conditions = ["s.is_active = 1"];
      const bindParams = [];
      if (userId) {
        conditions.push("s.agent_id = ?");
        bindParams.push(userId);
      }
      sql = `
        SELECT s.id, s.agent_id, s.jti, s.ip, s.browser, s.os, s.device,
               s.login_at, s.last_activity_at, s.is_active,
               a.name as user_name, a.email as user_email, a.role as user_role
        FROM sessions s
        JOIN agents a ON a.id = s.agent_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.last_activity_at DESC
        LIMIT 200`;
      params = bindParams;
    } else {
      sql = `
        SELECT s.id, s.agent_id, s.jti, s.ip, s.browser, s.os, s.device,
               s.login_at, s.last_activity_at, s.is_active
        FROM sessions s
        WHERE s.agent_id = ? AND s.is_active = 1
        ORDER BY s.last_activity_at DESC`;
      params = [req.user.id];
    }

    const sessions = await db.all(sql, ...params);

    // Mask JTI in responses (only keep first 8 chars as identifier)
    const safeSessions = sessions.map((s) => ({
      ...s,
      jti: s.jti ? s.jti.substring(0, 8) + "…" : null,
      is_current: s.jti === req.user.jti,
    }));

    res.json({ sessions: safeSessions });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sessions/:id — terminate a specific session
router.delete("/:id", async (req, res, next) => {
  try {
    const session = await db.get("SELECT * FROM sessions WHERE id = ?", req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const isAdmin = ["admin", "super_admin"].includes(req.user.role);
    // Non-admin can only terminate their own sessions
    if (!isAdmin && session.agent_id !== req.user.id) {
      return res.status(403).json({ error: "You can only terminate your own sessions" });
    }

    await db.run("UPDATE sessions SET is_active = 0 WHERE id = ?", req.params.id);

    // Add JTI to revoked tokens blocklist
    await db.run(
      "INSERT IGNORE INTO revoked_tokens (jti, agent_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 12 HOUR))",
      session.jti, session.agent_id
    );

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "SESSION_TERMINATED", entityType: "session", entityId: req.params.id,
      newValue: { target_user: session.agent_id, terminated_by: req.user.id }, ip, device,
    });

    res.json({ terminated: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sessions/user/:userId — terminate all sessions for a user (admin only)
router.delete("/user/:userId", requireAdmin, async (req, res, next) => {
  try {
    const sessions = await db.all(
      "SELECT id, jti, agent_id FROM sessions WHERE agent_id = ? AND is_active = 1",
      req.params.userId
    );

    if (sessions.length === 0) {
      return res.json({ terminated: 0 });
    }

    // Revoke all JTIs
    for (const s of sessions) {
      await db.run(
        "INSERT IGNORE INTO revoked_tokens (jti, agent_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 12 HOUR))",
        s.jti, s.agent_id
      );
    }

    await db.run("UPDATE sessions SET is_active = 0 WHERE agent_id = ?", req.params.userId);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "ALL_SESSIONS_TERMINATED", entityType: "user", entityId: req.params.userId,
      newValue: { sessions_revoked: sessions.length }, ip, device,
    });

    res.json({ terminated: sessions.length });
  } catch (err) {
    next(err);
  }
});

export default router;
