import { isManagerOrAdmin } from "../utils/dbHelpers.js";
import { db } from "../db/connection.js";

/**
 * requireRole(roles[]) — legacy role-based guard (backward-compatible)
 */
export function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role permissions" });
    }
    next();
  };
}

/**
 * requireCustomerAccess — strictly enforces that agents can only access
 * customer records assigned directly to them. Managers and Admins bypass this.
 * Direct URL access or manual API attempts for non-assigned customers return 403.
 */
export async function requireCustomerAccess(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    // Admins and Managers have global customer visibility
    if (isManagerOrAdmin(req.user)) return next();

    const customerId = req.params.id || req.params.customerId || req.body?.customer_id || req.query?.customer_id;
    if (!customerId) return next();

    const customer = await db.get("SELECT id, assigned_agent_id FROM customers WHERE id = ?", customerId);
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (customer.assigned_agent_id !== req.user.id) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this customer" });
    }

    next();
  } catch (err) {
    next(err);
  }
}


/**
 * requirePermission(module, action) — permission-matrix-based guard.
 * super_admin and admin bypass all permission checks.
 * All other roles are checked against req.user.permissions[].
 */
export function requirePermission(module, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    // Admins bypass the permission check
    if (["super_admin", "admin"].includes(req.user.role)) return next();

    const key = `${module}:${action}`;
    if (!req.user.permissions || !req.user.permissions.includes(key)) {
      return res.status(403).json({
        error: `Forbidden: you do not have the '${key}' permission`,
      });
    }
    next();
  };
}

/**
 * requireBrandAccess — ensures the requesting user has access to the
 * brand_id in query/body/params. Admins and management may pass 'all'.
 */
export function requireBrandAccess(req, res, next) {
  const managementRoles = ["admin", "super_admin", "general_manager", "operations_manager"];

  if (req.user && managementRoles.includes(req.user.role)) {
    if (["admin", "super_admin"].includes(req.user.role)) return next();
    const requestedBrandId = req.query.brand_id || req.body.brand_id || req.params.brand_id;
    if (requestedBrandId === "all") return next();
  }

  const requestedBrandId = req.query.brand_id || req.body.brand_id || req.params.brand_id;

  if (!requestedBrandId) return next();

  if (!req.user || !req.user.brands || !req.user.brands.includes(requestedBrandId)) {
    return res.status(403).json({ error: "Forbidden: you do not have access to this brand" });
  }

  next();
}

/**
 * requireSelfOrAdmin — allows action only if the requesting user is the
 * target user, or if the requester is admin/super_admin.
 * Expects req.params.id or req.params.userId to be the target user id.
 */
export function requireSelfOrAdmin(req, res, next) {
  const targetId = req.params.id || req.params.userId;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.id === targetId || ["admin", "super_admin"].includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({ error: "Forbidden: you can only access your own profile" });
}
