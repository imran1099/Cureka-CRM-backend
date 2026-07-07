import express from "express";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db, writeAuditLog, createNotification } from "../db/connection.js";
import { requireAuth, requireAdmin, getRequestMeta } from "../middleware/auth.js";
import { requirePermission, requireSelfOrAdmin } from "../middleware/rbac.js";

const router = express.Router();
router.use(requireAuth);

// ─── GET /api/users — paginated list with search + filters ─────────────────
router.get("/", requirePermission("users", "view"), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 15);
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || "";
    const { department_id, role, brand_id, status } = req.query;

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push("(a.name LIKE ? OR a.email LIKE ? OR a.employee_id LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (department_id) {
      conditions.push("a.department_id = ?");
      params.push(department_id);
    }
    if (status) {
      conditions.push("a.employment_status = ?");
      params.push(status);
    }
    if (role) {
      conditions.push("r.slug = ?");
      params.push(role);
    }
    if (brand_id) {
      conditions.push("EXISTS (SELECT 1 FROM agent_brands ab WHERE ab.agent_id = a.id AND ab.brand_id = ?)");
      params.push(brand_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = await db.get(
      `SELECT COUNT(DISTINCT a.id) as total
       FROM agents a
       LEFT JOIN user_role_mapping urm ON urm.agent_id = a.id
       LEFT JOIN roles r ON r.id = urm.role_id
       ${where}`,
      ...params
    );

    const users = await db.all(
      `SELECT a.id, a.name, a.email, a.employee_id, a.mobile, a.designation,
              a.employment_status, a.active, a.profile_photo, a.department_id, a.joining_date,
              a.last_login_at, a.created_at,
              d.name as department_name,
              r.name as role_name, r.slug as role_slug,
              mgr.name as reporting_manager_name
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN user_role_mapping urm ON urm.agent_id = a.id
       LEFT JOIN roles r ON r.id = urm.role_id
       LEFT JOIN agents mgr ON mgr.id = a.reporting_manager_id
       ${where}
       ORDER BY a.name ASC
       LIMIT ${limit} OFFSET ${offset}`,
      ...params
    );

    // Attach brands for each user
    const userIds = users.map((u) => u.id);
    let brandsMap = {};
    if (userIds.length) {
      const brandRows = await db.all(
        `SELECT ab.agent_id, b.id, b.name, b.short_code FROM agent_brands ab JOIN brands b ON b.id = ab.brand_id WHERE ab.agent_id IN (${userIds.map(() => "?").join(",")})`,
        ...userIds
      );
      brandRows.forEach((br) => {
        if (!brandsMap[br.agent_id]) brandsMap[br.agent_id] = [];
        brandsMap[br.agent_id].push({ id: br.id, name: br.name, short_code: br.short_code });
      });
    }

    const enrichedUsers = users.map((u) => ({ ...u, brands: brandsMap[u.id] || [] }));

    // Stats
    const stats = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(employment_status = 'active') as active,
         SUM(employment_status = 'on_leave') as on_leave,
         SUM(employment_status = 'suspended') as suspended,
         SUM(employment_status = 'resigned') as resigned
       FROM agents`
    );

    res.json({ users: enrichedUsers, total: countRow.total, page, limit, stats });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/users/me — own profile ──────────────────────────────────────
router.get("/me", async (req, res, next) => {
  try {
    const agent = await db.get(
      `SELECT a.*, d.name as department_name, mgr.name as reporting_manager_name
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN agents mgr ON mgr.id = a.reporting_manager_id
       WHERE a.id = ?`,
      req.user.id
    );
    if (!agent) return res.status(404).json({ error: "User not found" });
    delete agent.password_hash;

    const brands = await db.all(
      "SELECT b.id, b.name, b.short_code FROM agent_brands ab JOIN brands b ON b.id = ab.brand_id WHERE ab.agent_id = ?",
      agent.id
    );
    const roleRow = await db.get(
      "SELECT r.* FROM user_role_mapping urm JOIN roles r ON r.id = urm.role_id WHERE urm.agent_id = ? LIMIT 1",
      agent.id
    );
    const permRows = await db.all(
      `SELECT CONCAT(p.module, ':', p.action) as perm FROM user_role_mapping urm
       JOIN role_permissions rp ON rp.role_id = urm.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE urm.agent_id = ?`,
      agent.id
    );

    res.json({ user: { ...agent, brands, role: roleRow || null, permissions: permRows.map((r) => r.perm) } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/users/:id — full profile ────────────────────────────────────
router.get("/:id", requirePermission("users", "view"), async (req, res, next) => {
  try {
    const agent = await db.get(
      `SELECT a.id, a.name, a.email, a.employee_id, a.mobile, a.alternate_mobile,
              a.designation, a.employment_status, a.active, a.profile_photo,
              a.department_id, a.joining_date, a.shift_timing, a.timezone,
              a.office_location, a.last_working_day, a.last_login_at,
              a.last_login_ip, a.last_login_device, a.created_at,
              a.reporting_manager_id, a.failed_login_attempts, a.locked_until,
              d.name as department_name,
              mgr.name as reporting_manager_name
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN agents mgr ON mgr.id = a.reporting_manager_id
       WHERE a.id = ?`,
      req.params.id
    );
    if (!agent) return res.status(404).json({ error: "User not found" });

    const brands = await db.all(
      "SELECT b.id, b.name, b.short_code, b.theme_color FROM agent_brands ab JOIN brands b ON b.id = ab.brand_id WHERE ab.agent_id = ?",
      agent.id
    );
    const role = await db.get(
      "SELECT r.* FROM user_role_mapping urm JOIN roles r ON r.id = urm.role_id WHERE urm.agent_id = ? LIMIT 1",
      agent.id
    );
    const permissions = await db.all(
      `SELECT CONCAT(p.module, ':', p.action) as perm FROM user_role_mapping urm
       JOIN role_permissions rp ON rp.role_id = urm.role_id
       JOIN permissions p ON p.id = rp.permission_id WHERE urm.agent_id = ?`,
      agent.id
    );
    const recentActivity = await db.all(
      "SELECT action, entity_type, created_at, ip FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
      agent.id
    );

    res.json({ user: { ...agent, brands, role, permissions: permissions.map((r) => r.perm), recentActivity } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/users — create user ────────────────────────────────────────
router.post("/", requirePermission("users", "create"), async (req, res, next) => {
  try {
    const {
      name, email, password, employee_id, mobile, alternate_mobile, designation,
      department_id, reporting_manager_id, office_location, joining_date,
      shift_timing, timezone, role_id, brand_ids,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = await db.get("SELECT id FROM agents WHERE email = ?", email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    if (employee_id) {
      const dupEmpId = await db.get("SELECT id FROM agents WHERE employee_id = ?", employee_id);
      if (dupEmpId) return res.status(409).json({ error: "Employee ID is already in use" });
    }

    const id = "agent_" + nanoid(14);
    const hash = bcrypt.hashSync(password, 12);

    // Determine role slug for backward-compat column
    let roleSlug = "customer_support_executive";
    if (role_id) {
      const roleRow = await db.get("SELECT slug FROM roles WHERE id = ?", role_id);
      if (roleRow) roleSlug = roleRow.slug;
    }

    await db.run(
      `INSERT INTO agents
       (id, name, email, password_hash, role, employee_id, mobile, alternate_mobile, designation,
        department_id, reporting_manager_id, office_location, joining_date, shift_timing, timezone,
        employment_status, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`,
      id, name, email.toLowerCase().trim(), hash, roleSlug,
      employee_id || null, mobile || null, alternate_mobile || null, designation || null,
      department_id || null, reporting_manager_id || null, office_location || null,
      joining_date || null, shift_timing || null, timezone || "Asia/Kolkata"
    );

    // Assign role
    if (role_id) {
      await db.run(
        "INSERT INTO user_role_mapping (agent_id, role_id, assigned_by) VALUES (?, ?, ?)",
        id, role_id, req.user.id
      );
    } else {
      // Default to CS Executive
      await db.run(
        "INSERT INTO user_role_mapping (agent_id, role_id, assigned_by) VALUES (?, 'role_cs_executive', ?)",
        id, req.user.id
      );
    }

    // Assign brands
    if (brand_ids?.length) {
      for (const bid of brand_ids) {
        await db.run("INSERT IGNORE INTO agent_brands (agent_id, brand_id) VALUES (?, ?)", id, bid);
      }
    }

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "USER_CREATED", entityType: "user", entityId: id,
      newValue: { name, email, role_id, department_id }, ip, device,
    });

    await createNotification({
      recipientId: id, type: "welcome", title: "Welcome to the CXP!",
      body: `Your account has been created. Please log in and update your profile.`,
    }).catch(() => {});

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/users/me — self-service update ────────────────────────────
router.patch("/me", async (req, res, next) => {
  try {
    const allowed = ["mobile", "alternate_mobile", "profile_photo"];
    const updates = [];
    const params = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }

    if (!updates.length) return res.status(400).json({ error: "No updatable fields provided" });

    await db.run(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`, ...params, req.user.id);
    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/users/:id — admin update user ─────────────────────────────
router.patch("/:id", requirePermission("users", "edit"), async (req, res, next) => {
  try {
    const {
      name, email, employee_id, mobile, alternate_mobile, designation,
      department_id, reporting_manager_id, office_location, joining_date,
      shift_timing, timezone, last_working_day, role_id, brand_ids, active,
    } = req.body;

    const existing = await db.get("SELECT * FROM agents WHERE id = ?", req.params.id);
    if (!existing) return res.status(404).json({ error: "User not found" });

    const updates = [];
    const params = [];
    const fields = {
      name, email, employee_id, mobile, alternate_mobile, designation,
      department_id, reporting_manager_id, office_location, joining_date,
      shift_timing, timezone, last_working_day,
    };

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        updates.push(`${key} = ?`);
        params.push(val === "" ? null : val);
      }
    }
    if (active !== undefined) { updates.push("active = ?"); params.push(active ? 1 : 0); }

    if (updates.length) {
      await db.run(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.id);
    }

    // Update role if provided
    if (role_id) {
      const roleRow = await db.get("SELECT slug FROM roles WHERE id = ?", role_id);
      await db.run("DELETE FROM user_role_mapping WHERE agent_id = ?", req.params.id);
      await db.run(
        "INSERT INTO user_role_mapping (agent_id, role_id, assigned_by) VALUES (?, ?, ?)",
        req.params.id, role_id, req.user.id
      );
      if (roleRow) {
        await db.run("UPDATE agents SET role = ? WHERE id = ?", roleRow.slug, req.params.id);
      }
    }

    // Update brands if provided
    if (Array.isArray(brand_ids)) {
      await db.run("DELETE FROM agent_brands WHERE agent_id = ?", req.params.id);
      for (const bid of brand_ids) {
        await db.run("INSERT IGNORE INTO agent_brands (agent_id, brand_id) VALUES (?, ?)", req.params.id, bid);
      }
    }

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "USER_UPDATED", entityType: "user", entityId: req.params.id,
      oldValue: existing, newValue: req.body, ip, device,
    });

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/users/:id/status — change employment status ───────────────
router.patch("/:id/status", requirePermission("users", "edit"), async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ["active", "on_leave", "suspended", "resigned", "inactive"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const agent = await db.get("SELECT * FROM agents WHERE id = ?", req.params.id);
    if (!agent) return res.status(404).json({ error: "User not found" });

    // Prevent deactivating the last super_admin
    if (["super_admin", "admin"].includes(agent.role) && status !== "active") {
      const adminCount = await db.get(
        "SELECT COUNT(*) as cnt FROM agents WHERE role IN ('admin', 'super_admin') AND employment_status = 'active' AND id != ?",
        req.params.id
      );
      if (adminCount.cnt === 0) {
        return res.status(400).json({ error: "Cannot deactivate the last active administrator" });
      }
    }

    const active = status === "active" ? 1 : 0;
    const lastWorkingDay = ["resigned", "inactive"].includes(status) ? new Date().toISOString().split("T")[0] : null;

    await db.run(
      "UPDATE agents SET employment_status = ?, active = ?, last_working_day = IFNULL(?, last_working_day) WHERE id = ?",
      status, active, lastWorkingDay, req.params.id
    );

    // Revoke all active sessions if deactivating
    if (status !== "active") {
      await db.run("UPDATE sessions SET is_active = 0 WHERE agent_id = ?", req.params.id);
    }

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "USER_STATUS_CHANGED", entityType: "user", entityId: req.params.id,
      oldValue: { employment_status: agent.employment_status },
      newValue: { employment_status: status }, ip, device,
    });

    await createNotification({
      recipientId: req.params.id, type: "account", title: "Account Status Updated",
      body: `Your account status has been changed to: ${status.replace("_", " ")}.`,
    }).catch(() => {});

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/users/:id/reset-password — admin reset ─────────────────────
router.post("/:id/reset-password", requirePermission("users", "edit"), async (req, res, next) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: "new_password must be at least 8 characters" });
    }

    const agent = await db.get("SELECT id, name FROM agents WHERE id = ?", req.params.id);
    if (!agent) return res.status(404).json({ error: "User not found" });

    const hash = bcrypt.hashSync(new_password, 12);
    await db.run("UPDATE agents SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?", hash, req.params.id);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "PASSWORD_RESET", entityType: "user", entityId: req.params.id, ip, device,
    });

    await createNotification({
      recipientId: req.params.id, type: "security", title: "Password Reset",
      body: `Your password was reset by an administrator. Please log in with your new password.`,
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/users/:id/team — direct reports ─────────────────────────────
router.get("/:id/team", requirePermission("users", "view"), async (req, res, next) => {
  try {
    const team = await db.all(
      `SELECT a.id, a.name, a.email, a.designation, a.employment_status, a.profile_photo,
              d.name as department_name, r.name as role_name
       FROM agents a
       LEFT JOIN departments d ON d.id = a.department_id
       LEFT JOIN user_role_mapping urm ON urm.agent_id = a.id
       LEFT JOIN roles r ON r.id = urm.role_id
       WHERE a.reporting_manager_id = ? AND a.active = 1
       ORDER BY a.name`,
      req.params.id
    );
    res.json({ team });
  } catch (err) {
    next(err);
  }
});

export default router;
