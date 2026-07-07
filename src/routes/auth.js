import express from "express";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db, pool, writeAuditLog, createNotification } from "../db/connection.js";
import { signToken, requireAuth, getRequestMeta } from "../middleware/auth.js";

const router = express.Router();

// POST /api/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const trimmedEmail = email.toLowerCase().trim();
    const { ip, device } = getRequestMeta(req);

    const agent = await db.get("SELECT * FROM agents WHERE email = ?", trimmedEmail);

    // Log helper
    const logEvent = async (agentId, eventType) => {
      await db.run(
        "INSERT INTO login_history (id, agent_id, event_type, email_attempted, ip, browser) VALUES (?, ?, ?, ?, ?, ?)",
        "lh_" + nanoid(12), agentId || null, eventType, trimmedEmail, ip, device.substring(0, 500)
      );
    };

    if (!agent) {
      await logEvent(null, "failed");
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Check if account is suspended/resigned/inactive
    const blockedStatuses = ["suspended", "resigned", "inactive"];
    if (blockedStatuses.includes(agent.employment_status)) {
      await logEvent(agent.id, "blocked");
      return res.status(403).json({ error: "Account is not active. Please contact your administrator." });
    }

    // Check active flag
    if (!agent.active) {
      await logEvent(agent.id, "blocked");
      return res.status(401).json({ error: "Account is disabled" });
    }

    // Check brute-force lock
    if (agent.locked_until && new Date(agent.locked_until) > new Date()) {
      const remaining = Math.ceil((new Date(agent.locked_until) - new Date()) / 60000);
      await logEvent(agent.id, "locked_attempt");
      return res.status(429).json({
        error: `Account is locked due to multiple failed attempts. Try again in ${remaining} minute(s).`,
      });
    }

    const valid = bcrypt.compareSync(password, agent.password_hash);

    if (!valid) {
      const attempts = (agent.failed_login_attempts || 0) + 1;
      const shouldLock = attempts >= 5;
      const lockUntil = shouldLock ? new Date(Date.now() + 30 * 60 * 1000) : null;

      await db.run(
        "UPDATE agents SET failed_login_attempts = ?, locked_until = ? WHERE id = ?",
        attempts, lockUntil, agent.id
      );
      await logEvent(agent.id, shouldLock ? "locked" : "failed");

      if (shouldLock) {
        await createNotification({
          recipientId: agent.id,
          type: "security",
          title: "Account Locked",
          body: "Your account has been locked after 5 failed login attempts. It will unlock in 30 minutes.",
        }).catch(() => {});

        return res.status(429).json({
          error: "Account locked after 5 failed attempts. Try again in 30 minutes.",
        });
      }

      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Successful login: reset lockout fields
    await db.run(
      "UPDATE agents SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ?, last_login_device = ? WHERE id = ?",
      ip, device.substring(0, 500), agent.id
    );

    // Fetch brands
    const agentBrands = await db.all("SELECT brand_id FROM agent_brands WHERE agent_id = ?", agent.id);
    agent.brands = agentBrands.map((b) => b.brand_id);

    // Fetch role from mapping (prefer mapped role over legacy column)
    const roleRow = await db.get(
      `SELECT r.slug FROM user_role_mapping urm JOIN roles r ON r.id = urm.role_id WHERE urm.agent_id = ? LIMIT 1`,
      agent.id
    );
    if (roleRow) agent.role = roleRow.slug;

    // Fetch permissions
    const permRows = await db.all(
      `SELECT DISTINCT CONCAT(p.module, ':', p.action) as perm
       FROM user_role_mapping urm
       JOIN role_permissions rp ON rp.role_id = urm.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE urm.agent_id = ?`,
      agent.id
    );
    agent.permissions = permRows.map((r) => r.perm);

    // Generate JTI for session tracking
    const jti = nanoid(32);

    // Record active session
    await db.run(
      "INSERT INTO sessions (id, agent_id, jti, ip, browser, is_active) VALUES (?, ?, ?, ?, ?, 1)",
      "sess_" + nanoid(12), agent.id, jti, ip, device.substring(0, 500)
    );

    await logEvent(agent.id, "login");

    await writeAuditLog({
      userId: agent.id,
      action: "LOGIN",
      entityType: "user",
      entityId: agent.id,
      ip,
      device,
    });

    const token = signToken({ ...agent, jti });

    res.json({
      token,
      user: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        role: agent.role,
        brands: agent.brands,
        permissions: agent.permissions,
        department_id: agent.department_id,
        employment_status: agent.employment_status || "active",
        profile_photo: agent.profile_photo || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const { ip, device } = getRequestMeta(req);
    const jti = req.user.jti;

    if (jti) {
      // Revoke session
      await db.run(
        "UPDATE sessions SET is_active = 0 WHERE jti = ?",
        jti
      );
      // Add to blocklist with expiry matching the JWT expiry
      const exp = req.user.exp ? new Date(req.user.exp * 1000) : new Date(Date.now() + 12 * 60 * 60 * 1000);
      await db.run(
        "INSERT IGNORE INTO revoked_tokens (jti, agent_id, expires_at) VALUES (?, ?, ?)",
        jti, req.user.id, exp
      );
    }

    // Log history
    await db.run(
      "INSERT INTO login_history (id, agent_id, event_type, email_attempted, ip, browser) VALUES (?, ?, ?, ?, ?, ?)",
      "lh_" + nanoid(12), req.user.id, "logout", req.user.email, ip, device.substring(0, 500)
    );

    await writeAuditLog({ userId: req.user.id, action: "LOGOUT", entityType: "user", entityId: req.user.id, ip, device });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const agent = await db.get(
      `SELECT a.id, a.name, a.email, a.role, a.active, a.profile_photo, a.department_id, a.designation,
              a.employment_status, a.mobile, a.last_login_at, a.last_login_ip, a.employee_id, a.joining_date,
              d.name as department_name
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       WHERE a.id = ?`,
      req.user.id
    );
    if (!agent) return res.status(404).json({ error: "User not found" });

    const brands = await db.all("SELECT brand_id FROM agent_brands WHERE agent_id = ?", agent.id);
    const permRows = await db.all(
      `SELECT DISTINCT CONCAT(p.module, ':', p.action) as perm
       FROM user_role_mapping urm
       JOIN role_permissions rp ON rp.role_id = urm.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE urm.agent_id = ?`,
      agent.id
    );

    res.json({
      user: {
        ...agent,
        brands: brands.map((b) => b.brand_id),
        permissions: permRows.map((r) => r.perm),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password (self-service)
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password required" });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const agent = await db.get("SELECT * FROM agents WHERE id = ?", req.user.id);
    if (!bcrypt.compareSync(current_password, agent.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hash = bcrypt.hashSync(new_password, 12);
    await db.run("UPDATE agents SET password_hash = ? WHERE id = ?", hash, agent.id);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "PASSWORD_CHANGED", entityType: "user",
      entityId: req.user.id, ip, device,
    });

    await createNotification({
      recipientId: req.user.id, type: "security", title: "Password Changed",
      body: "Your password was changed successfully. If this was not you, contact your administrator immediately.",
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
