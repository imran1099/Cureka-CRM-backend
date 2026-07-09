import { db } from "../db/connection.js";
import { nanoid } from "nanoid";
import { createTimelineEvent } from "./timelineService.js";

// ─── Priority Score Calculation ─────────────────────────────────────────────────
// Returns 0–100 (higher = more urgent)
export function calculatePriorityScore(followup, customer = {}) {
  let score = 50;

  // Health score penalty (low health = higher urgency)
  const health = parseInt(customer.health_score) || 50;
  if (health < 30) score += 20;
  else if (health < 50) score += 10;

  // LTV bonus
  const ltv = parseFloat(customer.ltv) || 0;
  if (ltv > 10000) score += 15;
  else if (ltv > 5000) score += 8;

  // Category default priority
  const cat = followup.category_id || "";
  if (cat === "fcat_ctwa_lead" || cat === "fcat_high_value_lead") score += 25;
  else if (cat === "fcat_abandoned_cart" || cat === "fcat_complaint" || cat === "fcat_payment_pending") score += 15;
  else if (cat === "fcat_refund" || cat === "fcat_delivery_issue" || cat === "fcat_rto_recovery") score += 10;

  // Overdue penalty
  if (followup.due_at && new Date(followup.due_at) < new Date()) {
    const overdueMins = (Date.now() - new Date(followup.due_at).getTime()) / 60000;
    score += Math.min(20, Math.floor(overdueMins / 30));
  }

  // Escalation level boost
  score += (followup.escalation_level || 0) * 10;

  return Math.min(100, Math.max(0, score));
}

export function scoreToLabel(score) {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "low";
}

// ─── Create Follow-up ────────────────────────────────────────────────────────────
export async function createFollowup({
  customerId, brandId, categoryId, assignedAgentId, createdByAgentId,
  title, description, dueAt, reminderAt, priority,
  relatedOrderId, relatedTicketId, relatedOpportunityId,
  source = "manual",
}) {
  if (!customerId) throw new Error("customerId is required");
  if (!dueAt) throw new Error("dueAt is required");

  const id = "fup_" + nanoid(12);
  const customer = await db.get("SELECT * FROM customers WHERE id = ?", customerId).catch(() => ({}));

  const tempFollowup = { category_id: categoryId, due_at: dueAt, escalation_level: 0 };
  const priorityScore = calculatePriorityScore(tempFollowup, customer);
  const resolvedPriority = priority || scoreToLabel(priorityScore);

  await db.run(
    `INSERT INTO customer_followups
      (id, customer_id, brand_id, category_id, assigned_agent_id, created_by_agent_id,
       related_order_id, related_ticket_id, related_opportunity_id,
       title, description, priority, priority_score, status, due_at, due_date, reminder_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    id, customerId, brandId || null, categoryId || null,
    assignedAgentId || null, createdByAgentId || null,
    relatedOrderId || null, relatedTicketId || null, relatedOpportunityId || null,
    title, description || null, resolvedPriority, priorityScore,
    dueAt, dueAt, reminderAt || null, source
  );

  // Schedule in-app reminder if reminder time provided
  if (reminderAt) {
    const rid = "fr_" + nanoid(10);
    await db.run(
      "INSERT INTO followup_reminders (id, followup_id, remind_at, channel) VALUES (?, ?, ?, 'in_app')",
      rid, id, reminderAt
    );
  }

  // Audit
  await db.run(
    "INSERT INTO workflow_audit_log (id, followup_id, agent_id, action, new_status) VALUES (?, ?, ?, 'created', 'scheduled')",
    "wal_" + nanoid(10), id, createdByAgentId || null
  );

  // Timeline event (non-fatal)
  createTimelineEvent({
    customerId, brandId,
    eventType: "followup_scheduled",
    eventTitle: title,
    eventDescription: `Category: ${categoryId || "general"}. Due: ${new Date(dueAt).toLocaleString("en-IN")}.`,
    agentId: createdByAgentId,
    sourceSystem: "followups",
    refId: id, refType: "followup",
  }).catch(() => {});

  return id;
}

// ─── Complete a Follow-up ────────────────────────────────────────────────────────
export async function completeFollowup(id, { outcome, notes, agentId } = {}) {
  const fup = await db.get("SELECT * FROM customer_followups WHERE id = ?", id);
  if (!fup) throw new Error("Follow-up not found");
  if (!outcome) throw new Error("Outcome is required to complete a follow-up");

  await db.run(
    `UPDATE customer_followups
     SET status = 'completed', outcome = ?, outcome_notes = ?, completed_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    outcome, notes || null, id
  );

  await db.run(
    "INSERT INTO workflow_audit_log (id, followup_id, agent_id, action, old_status, new_status, notes) VALUES (?, ?, ?, 'completed', ?, 'completed', ?)",
    "wal_" + nanoid(10), id, agentId || null, fup.status, notes || null
  );

  createTimelineEvent({
    customerId: fup.customer_id, brandId: fup.brand_id,
    eventType: "followup_scheduled",
    eventTitle: `Follow-up completed: ${fup.title}`,
    eventDescription: `Outcome: ${outcome}. ${notes || ""}`,
    agentId, sourceSystem: "followups",
    refId: id, refType: "followup",
    outcome,
  }).catch(() => {});
}

// ─── Reschedule a Follow-up ──────────────────────────────────────────────────────
export async function rescheduleFollowup(id, { dueAt, reason, agentId } = {}) {
  const fup = await db.get("SELECT * FROM customer_followups WHERE id = ?", id);
  if (!fup) throw new Error("Follow-up not found");
  if (!dueAt) throw new Error("dueAt is required to reschedule");
  if (!reason) throw new Error("reason is required to reschedule");

  await db.run(
    "UPDATE customer_followups SET due_at = ?, reschedule_reason = ?, status = 'scheduled', updated_at = NOW() WHERE id = ?",
    dueAt, reason, id
  );

  await db.run(
    "INSERT INTO workflow_audit_log (id, followup_id, agent_id, action, old_status, new_status, notes) VALUES (?, ?, ?, 'rescheduled', ?, 'scheduled', ?)",
    "wal_" + nanoid(10), id, agentId || null, fup.status, reason
  );
}

// ─── Process Workflow Rules ──────────────────────────────────────────────────────
// Called by any module after a business event
export async function processWorkflowRules(triggerEvent, payload = {}) {
  try {
    const rules = await db.all(
      "SELECT * FROM workflow_rules WHERE trigger_event = ? AND is_active = 1 ORDER BY priority_order ASC",
      triggerEvent
    );

    for (const rule of rules) {
      const config = typeof rule.action_config === "string" ? JSON.parse(rule.action_config) : rule.action_config;
      const conditions = rule.conditions ? (typeof rule.conditions === "string" ? JSON.parse(rule.conditions) : rule.conditions) : null;

      // Evaluate conditions
      if (conditions) {
        let match = true;
        for (const [key, val] of Object.entries(conditions)) {
          if (payload[key] !== val) { match = false; break; }
        }
        if (!match) continue;
      }

      // Calculate due date
      const delayHours = config.delay_hours || 0;
      const dueAt = new Date(Date.now() + delayHours * 3600000).toISOString().slice(0, 19).replace("T", " ");

      await createFollowup({
        customerId: payload.customerId,
        brandId: payload.brandId,
        categoryId: config.category_id,
        assignedAgentId: payload.assignedAgentId,
        createdByAgentId: null,
        title: config.title || "Follow-up",
        description: `Auto-created by rule: ${rule.name}`,
        dueAt,
        priority: config.priority,
        relatedOrderId: payload.relatedOrderId,
        relatedTicketId: payload.relatedTicketId,
        relatedOpportunityId: payload.relatedOpportunityId,
        source: "workflow_engine",
      });
    }
  } catch (e) {
    console.error("[WorkflowEngine] Error processing rules for", triggerEvent, e.message);
  }
}

// ─── Escalation Engine (runs on a 15-min cron) ──────────────────────────────────
export async function checkEscalations() {
  try {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");

    // Find overdue follow-ups that haven't been escalated yet
    const overdue = await db.all(`
      SELECT f.*, f.category_id as cat_id,
             ep.overdue_hours_l1, ep.overdue_hours_l2, ep.overdue_hours_l3
      FROM customer_followups f
      LEFT JOIN escalation_policies ep
        ON (ep.category_id = f.category_id OR ep.category_id IS NULL)
      WHERE f.status NOT IN ('completed', 'cancelled')
        AND f.due_at < ?
      ORDER BY ep.category_id DESC
      LIMIT 100
    `, now);

    for (const fup of overdue) {
      const overdueHours = (Date.now() - new Date(fup.due_at).getTime()) / 3600000;
      const l1Hours = fup.overdue_hours_l1 || 4;
      const l2Hours = fup.overdue_hours_l2 || 12;
      const l3Hours = fup.overdue_hours_l3 || 24;
      let targetLevel = 0;

      if (overdueHours >= l3Hours) targetLevel = 3;
      else if (overdueHours >= l2Hours) targetLevel = 2;
      else if (overdueHours >= l1Hours) targetLevel = 1;

      if (targetLevel > (fup.escalation_level || 0)) {
        await db.run(
          "UPDATE customer_followups SET escalation_level = ?, status = 'overdue', updated_at = NOW() WHERE id = ?",
          targetLevel, fup.id
        );
        const eid = "el_" + nanoid(10);
        await db.run(
          "INSERT INTO escalation_log (id, followup_id, escalation_level, reason) VALUES (?, ?, ?, ?)",
          eid, fup.id, targetLevel, `Auto-escalated after ${Math.floor(overdueHours)}h overdue`
        );
      } else if (fup.status !== "overdue") {
        await db.run(
          "UPDATE customer_followups SET status = 'overdue', updated_at = NOW() WHERE id = ?",
          fup.id
        );
      }
    }

    // Process pending reminders
    const pendingReminders = await db.all(`
      SELECT fr.*, f.assigned_agent_id, f.title, f.customer_id, f.id as followup_id
      FROM followup_reminders fr
      JOIN customer_followups f ON f.id = fr.followup_id
      WHERE fr.is_sent = 0 AND fr.remind_at <= ?
    `, now);

    for (const r of pendingReminders) {
      if (r.assigned_agent_id && r.channel === "in_app") {
        await db.run(
          `INSERT IGNORE INTO notifications (id, recipient_id, type, title, body, link)
           VALUES (?, ?, 'followup_reminder', ?, ?, ?)`,
          "notif_" + nanoid(12), r.assigned_agent_id,
          `⏰ Reminder: ${r.title}`,
          `You have a follow-up due soon.`,
          `/followups?id=${r.followup_id}`
        );
      }
      await db.run("UPDATE followup_reminders SET is_sent = 1, sent_at = NOW() WHERE id = ?", r.id);
    }
  } catch (e) {
    console.error("[EscalationEngine] Error:", e.message);
  }
}
