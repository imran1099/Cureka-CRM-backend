import { db } from "../db/connection.js";
import { nanoid } from "nanoid";
import { sendWhatsAppMessage } from "./businessOnBotService.js";
import { createTimelineEvent } from "./timelineService.js";
import { logEvent as logESCAMS } from "./escamsService.js";

/**
 * Send Agent Message in Conversation Thread
 */
export async function sendAgentMessage({ conversationId, agentId, text, mediaUrl = null, templateId = null }) {
  const conv = await db.get("SELECT * FROM bob_conversations WHERE id = ?", conversationId);
  if (!conv) throw new Error("Conversation not found");

  const customer = await db.get("SELECT * FROM customers WHERE id = ?", conv.customer_id);
  if (!customer) throw new Error("Customer not found");

  // Send message via REST API
  const sendRes = await sendWhatsAppMessage({
    toPhone: customer.phone,
    messageText: text,
    brandId: conv.brand_id
  });

  const msgId = "bob_msg_" + nanoid(10);
  await db.run(
    `INSERT INTO bob_messages (id, bob_message_id, conversation_id, customer_id, sender_type, agent_id, message_type, content, media_url, template_id, delivery_status)
     VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, 'sent')`,
    msgId, sendRes.message_id || `msg_${nanoid(8)}`, conv.id, customer.id, agentId, templateId ? 'template' : 'text', text, mediaUrl, templateId
  );

  // Update Conversation Status & Response Time
  const now = new Date();
  const lastMsgTime = new Date(conv.last_message_at);
  const responseTimeSec = Math.round((now.getTime() - lastMsgTime.getTime()) / 1000);

  await db.run(
    `UPDATE bob_conversations 
     SET status = 'active', unread_count = 0, assigned_agent_id = COALESCE(assigned_agent_id, ?), 
         last_message = ?, last_message_at = CURRENT_TIMESTAMP, last_response_at = CURRENT_TIMESTAMP, response_time_seconds = ?
     WHERE id = ?`,
    agentId, text, responseTimeSec, conv.id
  );

  // Timeline Event
  await createTimelineEvent({
    customerId: customer.id,
    brandId: conv.brand_id,
    eventType: "whatsapp_message_sent",
    eventTitle: "WhatsApp Message Sent by Agent",
    eventDescription: `Agent sent message: "${text.slice(0, 100)}"`,
    sourceSystem: "businessonbot"
  });

  return { id: msgId, status: "sent" };
}

/**
 * Assign Conversation to Agent (Round Robin / VIP)
 */
export async function assignConversation(conversationId, agentId, assignedBy = "system") {
  await db.run(
    "UPDATE bob_conversations SET assigned_agent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    agentId, conversationId
  );

  const conv = await db.get("SELECT * FROM bob_conversations WHERE id = ?", conversationId);
  if (conv) {
    await logESCAMS(
      { user: { id: assignedBy, role: "agent" }, ip: "127.0.0.1" },
      { action: "BOB_CONVERSATION_ASSIGNED", entity: "bob_conversations", entityId: conversationId, details: { agentId } }
    ).catch(() => {});
  }

  return { ok: true, assigned_agent_id: agentId };
}
