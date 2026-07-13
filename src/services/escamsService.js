import { nanoid } from "nanoid";
import { db } from "../db/connection.js";

/**
 * Universal logging function to record audit trails
 */
export async function logEvent(context, actionData) {
  const { user, req } = context;
  const { module, action, entity, entity_id, old_value, new_value, status = 'SUCCESS' } = actionData;

  const logId = `adt_${nanoid(12)}`;
  
  // Try to safely stringify values
  const safeOldValue = old_value ? JSON.stringify(old_value) : null;
  const safeNewValue = new_value ? JSON.stringify(new_value) : null;

  try {
    await db.run(
      `INSERT INTO escams_audit_logs 
        (id, user_id, user_name, role, brand_id, module, action, entity, entity_id, old_value, new_value, ip_address, device, browser, session_id, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      logId,
      user?.id || null,
      user?.name || 'System',
      user?.role || 'system',
      user?.brand_id || null, // Assuming brand_id is set in user context if applicable
      module,
      action,
      entity || null,
      entity_id || null,
      safeOldValue,
      safeNewValue,
      req?.ip || null,
      req?.headers?.['user-agent'] || null, // Device/Browser roughly from UA
      req?.headers?.['sec-ch-ua'] || null, 
      req?.headers?.['x-session-id'] || null,
      status
    );
  } catch (err) {
    console.error("Failed to write to ESCAMS audit log:", err);
  }
}

/**
 * Initiate a session record upon login
 */
export async function trackSession(user, req) {
  const sessionId = `sess_${nanoid(12)}`;
  try {
    await db.run(
      `INSERT INTO escams_sessions (id, user_id, ip_address, device, browser) VALUES (?, ?, ?, ?, ?)`,
      sessionId,
      user.id,
      req.ip || null,
      req.headers['user-agent'] || null,
      req.headers['sec-ch-ua'] || null
    );
    return sessionId;
  } catch (err) {
    console.error("Failed to track session:", err);
    return null;
  }
}

/**
 * Terminate a session
 */
export async function terminateSession(sessionId) {
  try {
    await db.run(`UPDATE escams_sessions SET status = 'TERMINATED', terminated_at = CURRENT_TIMESTAMP WHERE id = ?`, sessionId);
  } catch (err) {
    console.error("Failed to terminate session:", err);
  }
}

/**
 * Revoke a token
 */
export async function revokeToken(token, reason, userId) {
  try {
    await db.run(
      `INSERT INTO escams_revoked_tokens (token, reason, user_id) VALUES (?, ?, ?)`,
      token, reason, userId
    );
  } catch (err) {
    console.error("Failed to revoke token:", err);
  }
}

/**
 * Generate high-priority security alert
 */
export async function triggerSecurityAlert(type, severity, message) {
  const alertId = `alt_${nanoid(12)}`;
  try {
    await db.run(
      `INSERT INTO escams_alerts (id, type, severity, message) VALUES (?, ?, ?, ?)`,
      alertId, type, severity, message
    );
    console.warn(`[SECURITY ALERT] ${severity}: ${message}`);
  } catch (err) {
    console.error("Failed to trigger security alert:", err);
  }
}
