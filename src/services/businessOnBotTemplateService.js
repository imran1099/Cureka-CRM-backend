import { db } from "../db/connection.js";
import { sendAgentMessage } from "./businessOnBotConversationService.js";

/**
 * Get Available WhatsApp Templates
 */
export async function getApprovedTemplates(category = null) {
  let sql = "SELECT * FROM bob_templates WHERE status = 'APPROVED'";
  const params = [];
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  sql += " ORDER BY name ASC";
  const templates = await db.all(sql, ...params);
  
  // Return pre-seeded defaults if table is empty
  if (templates.length === 0) {
    return [
      { id: "tmpl_1", name: "order_confirmation", category: "UTILITY", body_text: "Hi {{1}}, your order #{{2}} has been confirmed! Total: ₹{{3}}." },
      { id: "tmpl_2", name: "shipping_update", category: "UTILITY", body_text: "Hi {{1}}, your order #{{2}} is out for delivery via {{3}} (AWB: {{4}})." },
      { id: "tmpl_3", name: "cart_recovery", category: "MARKETING", body_text: "Hi {{1}}, you left items in your cart! Complete your purchase now for 10% off using code VIP10." },
      { id: "tmpl_4", name: "ticket_resolution", category: "UTILITY", body_text: "Hi {{1}}, your ticket #{{2}} has been resolved. Please rate your experience!" }
    ];
  }
  return templates;
}

/**
 * Substitute Template Variables
 */
export function substituteTemplateVariables(templateBody, variables = []) {
  let result = templateBody;
  variables.forEach((val, idx) => {
    const placeholder = new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g");
    result = result.replace(placeholder, val);
  });
  return result;
}

/**
 * Send WhatsApp Template to Customer
 */
export async function sendTemplateMessage({ conversationId, templateId, variables = [], agentId }) {
  const templates = await getApprovedTemplates();
  const template = templates.find(t => t.id === templateId || t.name === templateId) || templates[0];
  
  const text = substituteTemplateVariables(template.body_text, variables);
  
  const res = await sendAgentMessage({
    conversationId,
    agentId,
    text,
    templateId: template.id
  });

  return { ok: true, messageId: res.id, textSent: text };
}
