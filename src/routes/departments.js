import express from "express";
import { nanoid } from "nanoid";
import { db, writeAuditLog } from "../db/connection.js";
import { requireAuth, getRequestMeta } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/departments — list all departments with user counts
router.get("/", async (req, res, next) => {
  try {
    const departments = await db.all(
      `SELECT d.*, COUNT(DISTINCT a.id) as user_count
       FROM departments d
       LEFT JOIN agents a ON a.department_id = d.id AND a.active = 1
       WHERE d.is_active = 1
       GROUP BY d.id
       ORDER BY d.name ASC`
    );
    res.json({ departments });
  } catch (err) {
    next(err);
  }
});

// GET /api/departments/:id — single department with member list
router.get("/:id", async (req, res, next) => {
  try {
    const dept = await db.get("SELECT * FROM departments WHERE id = ?", req.params.id);
    if (!dept) return res.status(404).json({ error: "Department not found" });

    const members = await db.all(
      `SELECT a.id, a.name, a.email, a.designation, a.employment_status, a.profile_photo,
              r.name as role_name
       FROM agents a
       LEFT JOIN user_role_mapping urm ON urm.agent_id = a.id
       LEFT JOIN roles r ON r.id = urm.role_id
       WHERE a.department_id = ? AND a.active = 1
       ORDER BY a.name`,
      req.params.id
    );

    res.json({ department: { ...dept, members } });
  } catch (err) {
    next(err);
  }
});

// POST /api/departments — create department (admin+)
router.post("/", requirePermission("settings", "modify"), async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const existing = await db.get("SELECT id FROM departments WHERE name = ?", name);
    if (existing) return res.status(409).json({ error: "Department with this name already exists" });

    const id = "dept_" + nanoid(10);
    await db.run(
      "INSERT INTO departments (id, name, description) VALUES (?, ?, ?)",
      id, name, description || null
    );

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "DEPARTMENT_CREATED", entityType: "department", entityId: id,
      newValue: { name, description }, ip, device,
    });

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/departments/:id — update department
router.patch("/:id", requirePermission("settings", "modify"), async (req, res, next) => {
  try {
    const dept = await db.get("SELECT * FROM departments WHERE id = ?", req.params.id);
    if (!dept) return res.status(404).json({ error: "Department not found" });

    const { name, description } = req.body;
    const updates = [];
    const params = [];
    if (name) { updates.push("name = ?"); params.push(name); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (!updates.length) return res.status(400).json({ error: "No valid fields to update" });

    await db.run(`UPDATE departments SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.id);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "DEPARTMENT_UPDATED", entityType: "department", entityId: req.params.id,
      oldValue: dept, newValue: req.body, ip, device,
    });

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/departments/:id — deactivate (soft delete)
router.delete("/:id", requirePermission("settings", "delete"), async (req, res, next) => {
  try {
    const dept = await db.get("SELECT * FROM departments WHERE id = ?", req.params.id);
    if (!dept) return res.status(404).json({ error: "Department not found" });

    const activeUsers = await db.get(
      "SELECT COUNT(*) as cnt FROM agents WHERE department_id = ? AND active = 1", req.params.id
    );
    if (activeUsers.cnt > 0) {
      return res.status(400).json({
        error: `Cannot delete department: ${activeUsers.cnt} active user(s) are assigned to it.`,
      });
    }

    await db.run("UPDATE departments SET is_active = 0 WHERE id = ?", req.params.id);

    const { ip, device } = getRequestMeta(req);
    await writeAuditLog({
      userId: req.user.id, action: "DEPARTMENT_DELETED", entityType: "department", entityId: req.params.id, ip, device,
    });

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
