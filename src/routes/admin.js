import express from "express";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getBrandCondition } from "../utils/dbHelpers.js";

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/admin/leaderboard?range=today|7d|30d
router.get("/leaderboard", async (req, res, next) => {
  try {
    const range = req.query.range || "today";
    const sinceClause =
      range === "7d" ? "(NOW() - INTERVAL 7 DAY)" : range === "30d" ? "(NOW() - INTERVAL 30 DAY)" : "CURDATE()";

    const clFilter = getBrandCondition(req, "call_logs");
    const paramsCall = clFilter.params || (clFilter.param ? [clFilter.param] : []);

    const rows = await db.all(
      `SELECT
        agents.id, agents.name,
        COUNT(call_logs.id) as calls_made,
        SUM(CASE WHEN call_logs.outcome = 'sold' THEN 1 ELSE 0 END) as sales,
        SUM(CASE WHEN call_logs.outcome = 'sold' THEN call_logs.sale_amount ELSE 0 END) as revenue
      FROM agents
      LEFT JOIN call_logs ON call_logs.agent_id = agents.id AND call_logs.called_at >= ${sinceClause} AND ${clFilter.condition}
      WHERE agents.role NOT IN ('admin', 'super_admin', 'read_only') AND agents.active = 1
      GROUP BY agents.id
      ORDER BY revenue DESC`,
      ...paramsCall
    );

    const leaderboard = rows.map((r) => ({
      ...r,
      revenue: r.revenue || 0,
      conversion: r.calls_made > 0 ? Math.round((r.sales / r.calls_made) * 1000) / 10 : 0,
    }));

    res.json({ range, leaderboard });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/overview — top-line stats for the dashboard
router.get("/overview", async (req, res, next) => {
  try {
    const clFilter = getBrandCondition(req, "call_logs");
    const paramsCall = clFilter.params || (clFilter.param ? [clFilter.param] : []);

    const today = await db.get(
      `SELECT
        COUNT(*) as calls_today,
        SUM(CASE WHEN call_logs.outcome = 'sold' THEN 1 ELSE 0 END) as sales_today,
        SUM(CASE WHEN call_logs.outcome = 'sold' THEN call_logs.sale_amount ELSE 0 END) as revenue_today
      FROM call_logs WHERE call_logs.called_at >= CURDATE() AND ${clFilter.condition}`,
      ...paramsCall
    );

    const cbFilterCustomer = getBrandCondition(req, "customers");
    const paramsCustomer = cbFilterCustomer.params || (cbFilterCustomer.param ? [cbFilterCustomer.param] : []);

    const segmentHealth = await db.all(
      `SELECT customers.segment, COUNT(DISTINCT customers.id) as count, SUM(customers.ltv) as total_ltv
       FROM customers ${cbFilterCustomer.join} WHERE customers.do_not_call = 0 AND ${cbFilterCustomer.condition} GROUP BY customers.segment`,
       ...paramsCustomer
    );

    const overdueCallbacks = await db.get(
      `SELECT COUNT(DISTINCT customers.id) as count FROM customers ${cbFilterCustomer.join} WHERE customers.callback_date IS NOT NULL AND customers.callback_date <= CURDATE() AND ${cbFilterCustomer.condition}`,
      ...paramsCustomer
    );

    const unassigned = await db.get(
      `SELECT COUNT(DISTINCT customers.id) as count FROM customers ${cbFilterCustomer.join} WHERE customers.assigned_agent_id IS NULL AND customers.do_not_call = 0 AND ${cbFilterCustomer.condition}`,
      ...paramsCustomer
    );

    res.json({
      callsToday: today.calls_today || 0,
      salesToday: today.sales_today || 0,
      revenueToday: today.revenue_today || 0,
      segmentHealth,
      overdueCallbacks: overdueCallbacks ? overdueCallbacks.count : 0,
      unassignedCustomers: unassigned ? unassigned.count : 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/agents — list all agents
router.get("/agents", async (req, res, next) => {
  try {
    const agents = await db.all("SELECT id, name, email, role, active, created_at FROM agents ORDER BY created_at ASC");
    res.json({ agents });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/agents — create a new agent login
router.post("/agents", async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "name, email, password required" });

    const existing = await db.get("SELECT id FROM agents WHERE email = ?", email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: "An agent with this email already exists" });

    const id = "agent_" + nanoid(10);
    const hash = bcrypt.hashSync(password, 10);
    await db.run(
      "INSERT INTO agents (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      id,
      name,
      email.toLowerCase().trim(),
      hash,
      role || "agent"
    );

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/agents/:id — deactivate, change role, reset password
router.patch("/agents/:id", async (req, res, next) => {
  try {
    const { active, role, password } = req.body;
    const updates = [];
    const params = [];

    if (active !== undefined) {
      updates.push("active = ?");
      params.push(active ? 1 : 0);
    }
    if (role) {
      updates.push("role = ?");
      params.push(role);
    }
    if (password) {
      updates.push("password_hash = ?");
      params.push(bcrypt.hashSync(password, 10));
    }
    if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });

    await db.run(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.id);
    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

export default router;
