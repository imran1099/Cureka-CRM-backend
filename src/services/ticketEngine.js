import { db } from "../db/connection.js";
import { nanoid } from "nanoid";

/**
 * Log a ticket timeline event
 */
export async function logTicketEvent(ticketId, eventType, description, agentId = null) {
  const id = "tt_" + nanoid(10);
  await db.run(
    "INSERT INTO ticket_timeline (id, ticket_id, event_type, description, agent_id) VALUES (?, ?, ?, ?, ?)",
    id, ticketId, eventType, description, agentId
  );
}

/**
 * Calculates SLA due dates based on rules and sets them on the ticket.
 */
export async function applySlaRules(ticketId, categoryId, priority) {
  // Find matching SLA rule
  const rule = await db.get(
    "SELECT * FROM sla_rules WHERE category_id = ? AND priority = ?",
    categoryId, priority
  );
  
  if (!rule) return; // No specific SLA defined

  const now = new Date();
  
  const firstResponseDue = new Date(now.getTime() + rule.first_response_minutes * 60000);
  const resolutionDue = new Date(now.getTime() + rule.resolution_minutes * 60000);
  
  await db.run(
    "UPDATE tickets SET sla_due_date = ?, resolution_due_date = ? WHERE id = ?",
    firstResponseDue.toISOString().slice(0, 19).replace('T', ' '), 
    resolutionDue.toISOString().slice(0, 19).replace('T', ' '), 
    ticketId
  );
  
  await logTicketEvent(ticketId, "SLA_APPLIED", `SLA rule applied (Priority: ${priority}). First response due: ${firstResponseDue.toLocaleString()}.`);
}

/**
 * Auto-assigns a ticket to the best agent using a simple Round-Robin load balancer logic
 * based on brand access.
 */
export async function autoAssignTicket(ticketId, brandId) {
  // Get all active agents who have access to this brand
  const eligibleAgents = await db.all(`
    SELECT a.id, a.name 
    FROM agents a
    JOIN agent_brands ab ON ab.agent_id = a.id
    WHERE ab.brand_id = ? AND a.active = 1 AND a.login_status = 'online'
  `, brandId);

  if (eligibleAgents.length === 0) {
    await logTicketEvent(ticketId, "ASSIGNMENT_FAILED", "No online agents available for this brand.");
    return null;
  }

  // Find the agent with the fewest open tickets
  const agentLoads = await Promise.all(eligibleAgents.map(async (agent) => {
    const row = await db.get(
      "SELECT COUNT(*) as count FROM tickets WHERE assigned_agent_id = ? AND status NOT IN ('closed', 'resolved')",
      agent.id
    );
    return { ...agent, load: row.count };
  }));

  // Sort by lowest load
  agentLoads.sort((a, b) => a.load - b.load);
  const bestAgent = agentLoads[0];

  await db.run("UPDATE tickets SET assigned_agent_id = ?, updated_at = NOW() WHERE id = ?", bestAgent.id, ticketId);
  await logTicketEvent(ticketId, "ASSIGNED", `Auto-assigned to ${bestAgent.name} (Current load: ${bestAgent.load})`, bestAgent.id);
  
  return bestAgent.id;
}
