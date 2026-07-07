import express from "express";
import { nanoid } from "nanoid";
import { db, writeAuditLog } from "../db/connection.js";
import { requireAuth, requireAdmin, getRequestMeta } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/roles — list all roles with user count
router.get("/", requirePermission("roles", "view"), async (req, res, next) => {
  try {
    const roles = await db.all(
      `SELECT r.*,
              COUNT(DISTINCT urm.agent_id) as user_count,
              COUNT(DISTINCT rp.permission_id) as permission_count
       FROM roles r
       LEFT JOIN user_role_mapping urm ON urm.role_id = r.id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.is_active = 1
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.created_at ASC`
    );
    res.json({ roles });
  } catch (err) {
    next(err);
  }
});

// GET /api/roles/:id — single role with full permission detail
router.get("/:id", requirePermission("roles", "view"), async (req, res, next) => {
  try {
    const role = await db.get("SELECT * FROM roles WHERE id = ?", req.params.id);
    if (!role) return res.status(404).json({ error: "Role not found" });

    const permissions = await db.all(
      `SELECT p.id, p.module, p.action, p.description
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?
       ORDER BY p.module, p.action`,
      req.params.id
    );
    const users = await db.all(
      `SELECT a.id, a.name, a.email, a.employment_status FROM agents a
       JOIN user_role_mapping urm ON urm.agent_id = a.id WHERE urm.role_id = ?`,
      req.params.id
    );

    res.json({ role: { ...role, permissions, users } });
  } catch (err) {
    next(err);
  }
});

// GET /api/roles/:id/permissions — get permission matrix for a role
router.get("/:id/permissions", requirePermission("roles", "view"), async (req, res, next) => {
  try {
    // Return all permissions with a flag indicating if this role has them
    const allPerms = await db.all("SELECT id, module, action, description FROM permissions ORDER BY module, action");
    const rolePerms = await db.all(
      "SELECT permission_id FROM role_permissions WHERE role_id = ?", req.params.id
    );
    const rolePermSet = new Set(rolePerms.map((r) => r.permission_id));

    const matrix = allPerms.map((p) => ({ ...p, granted: rolePermSet.has(p.id) }));

    // Group by module
    const grouped = matrix.reduce((acc, p) => {
      if (!acc[p.module]) acc[p.module] = [];
      acc[p.module].push(p);
      return acc;
    }, {});

    res.json({ permissions: matrix, grouped });
  } catch (err) {
    next(err);
  }
});

// PUT /api/roles/:id/permissions — replace full permission set for a role
router.put("/:id/permissions", requirePermission("roles", "edit"), async (req, res, next) => {
  try {
    const role = await db.get("SELECT * FROM roles WHERE id = ?", req.params.id);
    if (!role) return res.status(404).json({ error: "Role not found" });

    const { permission_ids } = req.body;
    if (!Array.isArray(permission_ids)) {
      return res.status(400).json({ error: "permission_ids must be an array" });
    }

    // Get old permissions for audit
    const oldPerms = await db.all("SELECT permission_id FROM role_permissions WHERE role_id = ?", req.params.id);

    await db.run("DELETE FROM role_permissions WHERE role_id = ?", req.params.id);
    for (const permId of permission_ids) {
      await db.run(
        "INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
        req.params.id, permId
      );
    }

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "ROLE_PERMISSIONS_UPDATED", entityType: "role", entityId: req.params.id,
      oldValue: { permission_ids: oldPerms.map((r) => r.permission_id) },
      newValue: { permission_ids }, ip, device,
    });

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/roles — create custom role
router.post("/", requirePermission("roles", "create"), async (req, res, next) => {
  try {
    const { name, description, permission_ids } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const slug = name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const existing = await db.get("SELECT id FROM roles WHERE slug = ?", slug);
    if (existing) return res.status(409).json({ error: "A role with this name already exists" });

    const id = "role_" + nanoid(10);
    await db.run(
      "INSERT INTO roles (id, name, slug, description, is_system, is_active) VALUES (?, ?, ?, ?, 0, 1)",
      id, name, slug, description || null
    );

    if (Array.isArray(permission_ids)) {
      for (const permId of permission_ids) {
        await db.run("INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)", id, permId);
      }
    }

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "ROLE_CREATED", entityType: "role", entityId: id,
      newValue: { name, slug, description }, ip, device,
    });

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/roles/:id — update role name/description
router.patch("/:id", requirePermission("roles", "edit"), async (req, res, next) => {
  try {
    const role = await db.get("SELECT * FROM roles WHERE id = ?", req.params.id);
    if (!role) return res.status(404).json({ error: "Role not found" });
    if (role.is_system) {
      return res.status(400).json({ error: "System roles cannot be renamed. You can edit their permissions." });
    }

    const { name, description } = req.body;
    const updates = [];
    const params = [];
    if (name) { updates.push("name = ?"); params.push(name); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (!updates.length) return res.status(400).json({ error: "No valid fields to update" });

    await db.run(`UPDATE roles SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.id);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "ROLE_UPDATED", entityType: "role", entityId: req.params.id,
      oldValue: role, newValue: req.body, ip, device,
    });

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/roles/:id — deactivate role
router.delete("/:id", requirePermission("roles", "delete"), async (req, res, next) => {
  try {
    const role = await db.get("SELECT * FROM roles WHERE id = ?", req.params.id);
    if (!role) return res.status(404).json({ error: "Role not found" });
    if (role.is_system) return res.status(400).json({ error: "System roles cannot be deleted" });

    const usersOnRole = await db.get(
      "SELECT COUNT(*) as cnt FROM user_role_mapping WHERE role_id = ?", req.params.id
    );
    if (usersOnRole.cnt > 0) {
      return res.status(400).json({ error: `This role is assigned to ${usersOnRole.cnt} user(s). Reassign them first.` });
    }

    await db.run("UPDATE roles SET is_active = 0 WHERE id = ?", req.params.id);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "ROLE_DELETED", entityType: "role", entityId: req.params.id, ip, device,
    });

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
