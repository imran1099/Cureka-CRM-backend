import { db } from "../db/connection.js";

// Main entry point for any CRM module to dispatch a notification
export async function publishNotification(payload) {
  const { assigned_to, category, priority, message, action_type, context_data, brand_id, hours_until_due } = payload;
  
  const id = `notif_${Date.now()}_${Math.random().toString(36).substring(2,7)}`;
  
  let dueQuery = "NULL";
  if (hours_until_due) {
    dueQuery = `DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${hours_until_due} HOUR)`;
  }
  
  await db.run(`
    INSERT INTO uncc_notifications (
      id, assigned_to, category, priority, message, action_type, context_data, brand_id, due_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ${dueQuery}
    )
  `, [id, assigned_to, category, priority, message, action_type, JSON.stringify(context_data || {}), brand_id]);
  
  return id;
}

// Fetch notifications for a user
export async function getNotifications(userId) {
  // We fetch unread and recently read/completed ones
  const sql = `
    SELECT * FROM uncc_notifications 
    WHERE assigned_to = ? 
    ORDER BY 
      CASE status
        WHEN 'unread' THEN 1
        WHEN 'read' THEN 2
        WHEN 'completed' THEN 3
        ELSE 4
      END,
      CASE priority 
        WHEN 'Critical' THEN 1 
        WHEN 'High' THEN 2 
        WHEN 'Medium' THEN 3 
        WHEN 'Low' THEN 4 
      END,
      created_at DESC
    LIMIT 100
  `;
  return await db.all(sql, userId);
}

export async function markNotificationAsRead(id, userId) {
  await db.run(
    "UPDATE uncc_notifications SET status = 'read', read_at = CURRENT_TIMESTAMP WHERE id = ? AND assigned_to = ? AND status = 'unread'",
    [id, userId]
  );
}

// Orchestrator for Quick Actions
export async function executeQuickAction(id, userId, payload) {
  const notif = await db.get("SELECT * FROM uncc_notifications WHERE id = ?", id);
  if (!notif) throw new Error("Notification not found");
  
  // Verify ownership/RBAC (for V1, just basic assignment check)
  // In a real system, a GM might be executing an action on behalf of someone else
  if (notif.assigned_to !== userId) {
    // Check if user is admin/manager (simplified)
    const user = await db.get("SELECT role FROM agents WHERE id = ?", userId);
    if (!user || (user.role !== 'admin' && user.role !== 'general_manager' && user.role !== 'operations_manager')) {
      throw new Error("Unauthorized to execute this action");
    }
  }

  const contextData = notif.context_data ? JSON.parse(notif.context_data) : {};
  const actionType = notif.action_type;
  
  let actionResult = { success: false, message: "Action not recognized" };

  // ROUTER LOGIC
  if (actionType === 'APPROVE_REFUND') {
    // Route to Tickets/Shopify
    // Mock logic: Update ticket status and complete
    if (contextData.ticket_id) {
      await db.run("UPDATE tickets SET status = 'closed', reason = 'Refund Approved' WHERE id = ?", contextData.ticket_id);
    }
    actionResult = { success: true, message: "Refund Approved successfully" };
  } 
  else if (actionType === 'REJECT_REFUND') {
    if (contextData.ticket_id) {
      await db.run("UPDATE tickets SET status = 'closed', reason = 'Refund Rejected' WHERE id = ?", contextData.ticket_id);
    }
    actionResult = { success: true, message: "Refund Rejected" };
  }
  else if (actionType === 'VIEW_CARTS') {
    // No backend mutation needed, frontend navigates to C360 Segment
    actionResult = { success: true, message: "Opening Customer Segments..." };
  }
  else if (actionType === 'CALL_CUSTOMER') {
    // Creates a followup
    if (contextData.customer_id) {
      await db.run(
        "INSERT INTO customer_followups (id, customer_id, brand_id, type, reason, status, priority, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())",
        [`flw_${Date.now()}`, contextData.customer_id, contextData.brand_id, 'Call', 'Quick Action Request', 'pending', 'high']
      );
    }
    actionResult = { success: true, message: "Follow-up Call Scheduled" };
  }

  if (actionResult.success) {
    await db.run(
      "UPDATE uncc_notifications SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );
  }

  return actionResult;
}

// Background Daemon for Escalations
export async function checkEscalations() {
  // Find all Critical/High notifications that are past their due_at and still unread/read (not completed)
  const overdue = await db.all(`
    SELECT n.*, a.role as agent_role 
    FROM uncc_notifications n
    JOIN agents a ON n.assigned_to = a.id
    WHERE n.due_at IS NOT NULL 
      AND n.due_at < CURRENT_TIMESTAMP 
      AND n.status IN ('unread', 'read')
  `);
  
  for (const notif of overdue) {
    let newRole = null;
    if (notif.agent_role === 'agent') newRole = 'operations_manager';
    else if (notif.agent_role === 'operations_manager') newRole = 'general_manager';
    else if (notif.agent_role === 'general_manager') newRole = 'admin';
    
    if (newRole) {
      // Find a manager for this brand
      let manager = await db.get("SELECT id FROM agents WHERE role = ? AND brands LIKE ? LIMIT 1", [newRole, `%${notif.brand_id}%`]);
      // Fallback if no specific brand manager
      if (!manager) manager = await db.get("SELECT id FROM agents WHERE role = ? LIMIT 1", newRole);
      
      if (manager) {
        // Escalate!
        await db.run("UPDATE uncc_notifications SET assigned_to = ?, priority = 'Critical', message = ? WHERE id = ?", 
          [manager.id, `[ESCALATED] ${notif.message}`, notif.id]
        );
        
        // Optionally create an audit log timeline event here
      }
    }
  }
}
