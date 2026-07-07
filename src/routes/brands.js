import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/brands - list brands the user has access to
router.get("/", async (req, res, next) => {
  try {
    let brands;
    if (req.user.role === "admin") {
      brands = await db.all("SELECT * FROM brands ORDER BY created_at DESC");
    } else {
      brands = await db.all(
        `SELECT b.* FROM brands b
         JOIN agent_brands ab ON b.id = ab.brand_id
         WHERE ab.agent_id = ? ORDER BY b.created_at DESC`,
        req.user.id
      );
    }
    res.json({ brands });
  } catch (err) {
    next(err);
  }
});

// GET /api/brands/:brand_id - get specific brand details
router.get("/:brand_id", requireBrandAccess, async (req, res, next) => {
  try {
    const brand = await db.get("SELECT * FROM brands WHERE id = ?", req.params.brand_id);
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    res.json({ brand });
  } catch (err) {
    next(err);
  }
});

// Admin only routes below
router.use(requireAdmin);

// POST /api/brands - create a new brand
router.post("/", async (req, res, next) => {
  try {
    const { name, short_code, logo, theme_color, primary_domain, support_email, support_phone, default_currency, timezone } = req.body;
    if (!name || !short_code) return res.status(400).json({ error: "Name and short_code are required" });

    const existing = await db.get("SELECT id FROM brands WHERE short_code = ?", short_code);
    if (existing) return res.status(409).json({ error: "A brand with this short_code already exists" });

    const id = "brand_" + nanoid(10);
    await db.run(
      `INSERT INTO brands (id, name, short_code, logo, theme_color, primary_domain, support_email, support_phone, default_currency, timezone, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, short_code, logo || null, theme_color || null, primary_domain || null, support_email || null, support_phone || null, default_currency || 'INR', timezone || 'Asia/Kolkata', req.user.id
    );

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/brands/:brand_id - update brand
router.patch("/:brand_id", async (req, res, next) => {
  try {
    const { name, short_code, logo, theme_color, primary_domain, support_email, support_phone, default_currency, timezone, status } = req.body;
    const updates = [];
    const params = [];

    const fields = { name, short_code, logo, theme_color, primary_domain, support_email, support_phone, default_currency, timezone, status };
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        updates.push(`${key} = ?`);
        params.push(val);
      }
    }
    
    if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });
    
    updates.push("updated_at = CURRENT_TIMESTAMP");

    await db.run(`UPDATE brands SET ${updates.join(", ")} WHERE id = ?`, ...params, req.params.brand_id);
    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/brands/:brand_id - (Soft delete or hard delete)
router.delete("/:brand_id", async (req, res, next) => {
  try {
    const hasCustomers = await db.get("SELECT id FROM customer_brands WHERE brand_id = ? LIMIT 1", req.params.brand_id);
    if (hasCustomers) return res.status(400).json({ error: "Cannot delete brand with existing customers" });
    
    await db.run("DELETE FROM brands WHERE id = ?", req.params.brand_id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
