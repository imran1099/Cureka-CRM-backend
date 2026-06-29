import express from "express";
import bcrypt from "bcryptjs";
import { db } from "../db/connection.js";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const agent = await db.get("SELECT * FROM agents WHERE email = ? AND active = 1", email.toLowerCase().trim());
    if (!agent) return res.status(401).json({ error: "Invalid email or password" });

    const valid = bcrypt.compareSync(password, agent.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const token = signToken(agent);
    res.json({
      token,
      user: { id: agent.id, name: agent.name, email: agent.email, role: agent.role },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
