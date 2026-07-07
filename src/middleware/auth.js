import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { pool, db } from "../db/connection.js";

const JWT_SECRET_ENV = process.env.JWT_SECRET;
if (!JWT_SECRET_ENV) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("FATAL: JWT_SECRET environment variable is required in production!");
  }
  console.warn("WARNING: JWT_SECRET environment variable is missing. Falling back to default development secret.");
}
const JWT_SECRET = JWT_SECRET_ENV || "dev-secret-change-me";

export function signToken(agent) {
  return jwt.sign(
    {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      brands: agent.brands || [],
      permissions: agent.permissions || [],
      department_id: agent.department_id || null,
      employment_status: agent.employment_status || "active",
      jti: agent.jti || nanoid(32),
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;

    // Async: check blocklist + update session activity (non-blocking)
    checkBlocklistAndSession(payload, req).catch(() => {});

    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAuthStrict(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  jwt.verify(token, JWT_SECRET, async (err, payload) => {
    if (err) return res.status(401).json({ error: "Invalid or expired token" });

    // Strict: check blocklist synchronously
    try {
      if (payload.jti) {
        const revoked = await db.get("SELECT jti FROM revoked_tokens WHERE jti = ?", payload.jti);
        if (revoked) return res.status(401).json({ error: "Session has been terminated" });
      }
      req.user = payload;
      // Update session activity
      if (payload.jti) {
        await pool.query(
          "UPDATE sessions SET last_activity_at = NOW() WHERE jti = ? AND is_active = 1",
          [payload.jti]
        ).catch(() => {});
      }
      next();
    } catch (e) {
      next(e);
    }
  });
}

async function checkBlocklistAndSession(payload, req) {
  if (!payload.jti) return;
  // Update last activity on active sessions
  await pool.query(
    "UPDATE sessions SET last_activity_at = NOW() WHERE jti = ? AND is_active = 1",
    [payload.jti]
  ).catch(() => {});
}

export function requireAdmin(req, res, next) {
  if (!req.user || !["admin", "super_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin access required" });
  }
  next();
}

export function requireManagement(req, res, next) {
  const mgmtRoles = ["super_admin", "admin", "general_manager", "operations_manager"];
  if (!req.user || !mgmtRoles.includes(req.user.role)) {
    return res.status(403).json({ error: "Management access required" });
  }
  next();
}

export function getRequestMeta(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    device: req.headers["user-agent"] || "",
  };
}
