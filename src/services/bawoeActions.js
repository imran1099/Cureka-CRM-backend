import { db } from "../db/connection.js";
import { nanoid } from "nanoid";

export const BAWOE_ACTIONS = {
  CREATE_FOLLOWUP: async (payload, context) => {
    // context contains trigger data (e.g. customer_id, order_id)
    const { reason, priority, days } = payload;
    const customerId = context.customer_id;
    const brandId = context.brand_id;
    
    if (!customerId) throw new Error("Missing customer_id in context for CREATE_FOLLOWUP");
    
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (parseInt(days) || 1));
    
    const id = `flw_${Date.now()}`;
    await db.run(
      "INSERT INTO customer_followups (id, customer_id, brand_id, type, reason, status, due_date, priority) VALUES (?, ?, ?, 'Call', ?, 'pending', ?, ?)",
      [id, customerId, brandId, reason, dueDate.toISOString().split('T')[0], priority]
    );
    return { success: true, followup_id: id };
  },
  
  CREATE_TICKET: async (payload, context) => {
    const { category, reason, priority } = payload;
    const customerId = context.customer_id;
    const brandId = context.brand_id;
    
    if (!customerId) throw new Error("Missing customer_id in context for CREATE_TICKET");
    
    const id = `tkt_${Date.now()}`;
    await db.run(
      "INSERT INTO tickets (id, customer_id, brand_id, channel, category, reason, status, priority) VALUES (?, ?, ?, 'System', ?, ?, 'open', ?)",
      [id, customerId, brandId, category, reason, priority]
    );
    return { success: true, ticket_id: id };
  },

  REQUIRE_APPROVAL: async (payload, context) => {
    // Creates a specialized task for a manager
    const { approval_type, message, manager_role } = payload;
    const customerId = context.customer_id;
    const brandId = context.brand_id;
    
    // Find an appropriate manager
    const manager = await db.get("SELECT id FROM agents WHERE role = ? AND (brands LIKE ? OR role = 'admin') LIMIT 1", [manager_role || 'operations_manager', `%${brandId}%`]);
    const assigneeId = manager ? manager.id : 'unassigned';
    
    const id = `appr_${Date.now()}`;
    // We leverage the tickets table as a unified task inbox for simplicity in V1
    await db.run(
      "INSERT INTO tickets (id, customer_id, brand_id, channel, category, reason, status, priority, assigned_to, description) VALUES (?, ?, ?, 'System', 'Approval', ?, 'open', 'high', ?, ?)",
      [id, customerId, brandId, approval_type, assigneeId, message]
    );
    return { success: true, approval_task_id: id, assigned_to: assigneeId };
  }
};
