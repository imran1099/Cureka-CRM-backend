import { db } from "../db/connection.js";
import { nanoid } from "nanoid";
import { createTimelineEvent } from "./timelineService.js";
import { createFollowup } from "./followupService.js";
import { publishNotification } from "./unccService.js";
import { logEvent as logESCAMS } from "./escamsService.js";
import { triggerEvent as triggerBAWOE } from "./bawoeService.js";

/**
 * Handle Inbound Webhooks from BusinessOnBot
 */
export async function processBoBWebhook(payload, signature = null) {
  const eventId = "bob_wh_" + nanoid(12);
  const eventType = payload.event || payload.type || "message.received";

  // Log Webhook Ingestion
  await db.run(
    "INSERT INTO bob_webhooks (id, event_type, payload_json, signature, processed) VALUES (?, ?, ?, ?, 1)",
    eventId, eventType, JSON.stringify(payload), signature
  );

  const phone = payload.phone || payload.customer?.phone || payload.message?.from;
  const email = payload.email || payload.customer?.email;
  const name = payload.customer?.name || payload.name || `WhatsApp User ${phone?.slice(-4) || ""}`;
  const bobContactId = payload.customer?.id || payload.contact_id;
  const text = payload.message?.text || payload.text || "";
  const brandId = payload.brand_id || payload.account?.brand_id || "CU";

  if (!phone) {
    return { ok: true, processed: true, note: "No phone number in payload" };
  }

  // 1. Locate or Create Customer using Matching Priority: BoB ID -> Phone -> Email
  let customer;
  if (bobContactId) {
    customer = await db.get("SELECT * FROM customers WHERE id = ?", bobContactId);
  }
  if (!customer && phone) {
    customer = await db.get("SELECT * FROM customers WHERE phone = ? OR phone LIKE ?", phone, `%${phone.slice(-10)}`);
  }
  if (!customer && email) {
    customer = await db.get("SELECT * FROM customers WHERE email = ?", email);
  }

  // Auto-Create Customer if missing
  if (!customer) {
    const custId = "cust_" + nanoid(10);
    await db.run(
      `INSERT INTO customers (id, name, phone, email, brand_id, segment, is_vip, created_at)
       VALUES (?, ?, ?, ?, ?, 'new_lead', 0, CURRENT_TIMESTAMP)`,
      custId, name, phone, email || null, brandId
    );
    customer = await db.get("SELECT * FROM customers WHERE id = ?", custId);
  }

  // 2. Locate or Create Active Conversation Thread
  let conversation = await db.get(
    "SELECT * FROM bob_conversations WHERE customer_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1",
    customer.id
  );

  if (!conversation) {
    const convId = "bob_conv_" + nanoid(10);
    await db.run(
      `INSERT INTO bob_conversations (id, bob_conversation_id, customer_id, brand_id, status, priority, category, unread_count, last_message, last_message_at)
       VALUES (?, ?, ?, ?, 'open', 'medium', 'general', 1, ?, CURRENT_TIMESTAMP)`,
      convId, payload.conversation_id || `conv_${nanoid(8)}`, customer.id, brandId, text || "New WhatsApp Message"
    );
    conversation = await db.get("SELECT * FROM bob_conversations WHERE id = ?", convId);

    // Auto Timeline Event for Conversation Started
    await createTimelineEvent({
      customerId: customer.id,
      brandId,
      eventType: "whatsapp_conversation_started",
      eventTitle: "WhatsApp Conversation Started",
      eventDescription: `Customer started WhatsApp conversation via BusinessOnBot (${phone})`,
      sourceSystem: "businessonbot"
    });
  } else {
    await db.run(
      "UPDATE bob_conversations SET unread_count = unread_count + 1, last_message = ?, last_message_at = CURRENT_TIMESTAMP WHERE id = ?",
      text || "New WhatsApp Message", conversation.id
    );
  }

  // 3. Insert Inbound Message
  const msgId = "bob_msg_" + nanoid(10);
  await db.run(
    `INSERT INTO bob_messages (id, bob_message_id, conversation_id, customer_id, sender_type, message_type, content, media_url, delivery_status)
     VALUES (?, ?, ?, ?, 'customer', ?, ?, ?, 'delivered')`,
    msgId, payload.message_id || `msg_${nanoid(8)}`, conversation.id, customer.id, payload.message?.type || 'text', text, payload.message?.media_url || null
  );

  // 4. Automatic Ticket Creation for Complaints & Issues
  const lowerText = text.toLowerCase();
  let ticketCreated = false;
  if (lowerText.includes("refund") || lowerText.includes("damage") || lowerText.includes("wrong product") || lowerText.includes("complaint") || lowerText.includes("delivery issue")) {
    const tktId = "tkt_" + nanoid(10);
    const category = lowerText.includes("refund") ? "Billing" : "Shipping";
    await db.run(
      `INSERT INTO tickets (id, brand_id, customer_id, department, priority, status, created_at)
       VALUES (?, ?, ?, ?, 'high', 'open', CURRENT_TIMESTAMP)`,
      tktId, brandId, customer.id, category
    );
    ticketCreated = true;

    // Timeline update
    await createTimelineEvent({
      customerId: customer.id,
      brandId,
      eventType: "ticket_created_via_whatsapp",
      eventTitle: `Ticket #${tktId.slice(0, 8)} Auto-Created`,
      eventDescription: `WhatsApp complaint automatically converted into high-priority ticket: "${text.slice(0, 100)}"`,
      sourceSystem: "businessonbot"
    });

    // UNCC Notification for Complaint
    await publishNotification({
      assignedTo: customer.assigned_agent_id || "admin",
      category: "Support",
      priority: "High",
      message: `Urgent WhatsApp complaint from ${customer.name}: "${text.slice(0, 80)}"`,
      actionType: "VIEW_TICKET",
      contextData: { ticket_id: tktId, customer_id: customer.id }
    });
  }

  // 5. Automatic Follow-up Task Creation for Callback Requests
  if (lowerText.includes("call me") || lowerText.includes("callback") || lowerText.includes("quote") || lowerText.includes("recommendation")) {
    await createFollowup({
      customerId: customer.id,
      brandId,
      assignedAgentId: customer.assigned_agent_id || "admin",
      createdByAgentId: "system",
      title: `WhatsApp Callback Request from ${customer.name}`,
      dueAt: new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 19).replace("T", " "),
      source: "businessonbot"
    });
  }

  // 6. BAWOE Workflow Engine Trigger
  await triggerBAWOE("whatsapp_message_received", {
    customer_id: customer.id,
    phone,
    text,
    ticket_created: ticketCreated
  }).catch(() => {});

  // 7. ESCAMS Security Audit Log
  await logESCAMS(
    { user: { id: "system", role: "system" }, ip: "127.0.0.1" },
    { action: "BOB_WEBHOOK_PROCESSED", entity: "bob_conversations", entityId: conversation.id, details: { eventType, phone } }
  ).catch(() => {});

  return { ok: true, conversation_id: conversation.id, customer_id: customer.id };
}
