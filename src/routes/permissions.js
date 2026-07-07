import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/permissions — list all permissions grouped by module
router.get("/", async (req, res, next) => {
  try {
    const permissions = await db.all(
      "SELECT id, module, action, description FROM permissions ORDER BY module, action"
    );

    const grouped = permissions.reduce((acc, p) => {
      if (!acc[p.module]) acc[p.module] = [];
      acc[p.module].push(p);
      return acc;
    }, {});

    // Consistent module order
    const moduleOrder = ["customers", "orders", "tickets", "calls", "reports", "settings", "users", "roles"];
    const orderedGrouped = {};
    for (const mod of moduleOrder) {
      if (grouped[mod]) orderedGrouped[mod] = grouped[mod];
    }
    // Any remaining modules not in the order list
    for (const [mod, perms] of Object.entries(grouped)) {
      if (!orderedGrouped[mod]) orderedGrouped[mod] = perms;
    }

    res.json({ permissions, grouped: orderedGrouped });
  } catch (err) {
    next(err);
  }
});

export default router;
