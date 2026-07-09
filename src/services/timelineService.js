import { nanoid } from "nanoid";
import { pool } from "../db/connection.js";

/**
 * Creates a timeline event for a customer.
 * Called internally by tickets, calls, cre, customers routes.
 */
export async function createTimelineEvent({
  customerId,
  eventType,
  eventTitle,
  eventDescription,
  outcome,
  agentId,
  brandId,
  department,
  sourceSystem = "manual",
  refId,
  refType,
  metadata,
  isInternal = false,
}) {
  if (!customerId || !eventType || !eventTitle) return;

  try {
    const id = "cte_" + nanoid(14);
    await pool.query(
      `INSERT INTO customer_timeline
         (id, customer_id, brand_id, event_type, event_title, event_description, outcome,
          agent_id, department, source_system, ref_id, ref_type, metadata, is_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        brandId || null,
        eventType,
        eventTitle,
        eventDescription || null,
        outcome || null,
        agentId || null,
        department || null,
        sourceSystem,
        refId || null,
        refType || null,
        metadata ? JSON.stringify(metadata) : null,
        isInternal ? 1 : 0,
      ]
    );

    // Fire-and-forget background enrichments (non-fatal)
    refreshInsights(customerId).catch(() => {});
    checkMilestones(customerId).catch(() => {});
  } catch (err) {
    console.error("[timelineService] Failed to create event:", err.message);
  }
}

async function refreshInsights(customerId) {
  const [[supportRow]] = await pool.query(
    "SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND event_type IN ('ticket_created','complaint_registered')",
    [customerId]
  );
  const [[callRow]] = await pool.query(
    "SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND event_type IN ('call_completed','call_outgoing','call_incoming')",
    [customerId]
  );
  const [[wonRow]] = await pool.query(
    "SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND event_type = 'deal_won'",
    [customerId]
  );
  const [[lastPurchaseRow]] = await pool.query(
    "SELECT created_at FROM customer_timeline WHERE customer_id = ? AND event_type = 'order_created' ORDER BY created_at DESC LIMIT 1",
    [customerId]
  );

  const sc = supportRow?.cnt || 0;
  const cc = callRow?.cnt || 0;
  const wc = wonRow?.cnt || 0;
  const insights = [];

  if (sc >= 3) insights.push({ type: "support_heavy",    content: `Customer has contacted support ${sc} times. Consider proactive outreach to prevent churn.` });
  if (cc >= 5) insights.push({ type: "high_engagement",  content: `Customer has been contacted ${cc} times via call. High engagement level.` });
  if (wc >= 2) insights.push({ type: "repeat_buyer",     content: `Customer has converted ${wc} opportunities. Strong repeat purchase behaviour.` });

  if (lastPurchaseRow?.created_at) {
    const daysSince = Math.floor((Date.now() - new Date(lastPurchaseRow.created_at)) / 86400000);
    if (daysSince >= 25 && daysSince <= 40)
      insights.push({ type: "replenishment_due", content: `Last order was ${daysSince} days ago. Customer may be due for replenishment.` });
    if (daysSince > 60)
      insights.push({ type: "dormant_risk", content: `No purchase in ${daysSince} days. Customer may be at risk of churning.` });
  }

  const custKey = customerId.replace(/[^a-z0-9]/gi, "").slice(0, 20);
  for (const ins of insights) {
    await pool.query(
      `INSERT INTO timeline_insights (id, customer_id, insight_type, content)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), generated_at = NOW()`,
      [`ins_${custKey}_${ins.type}`, customerId, ins.type, ins.content]
    ).catch(() => {});
  }
}

async function checkMilestones(customerId) {
  const [[wonRow]] = await pool.query(
    "SELECT COUNT(*) as cnt FROM customer_timeline WHERE customer_id = ? AND event_type = 'deal_won'",
    [customerId]
  );
  const [[custRow]] = await pool.query("SELECT ltv FROM customers WHERE id = ?", [customerId]);

  const cnt = wonRow?.cnt || 0;
  const ltv = parseFloat(custRow?.ltv) || 0;
  const custKey = customerId.replace(/[^a-z0-9]/gi, "").slice(0, 20);

  const milestones = [];
  if (cnt >= 1)     milestones.push({ type: "first_purchase", label: "First Purchase! 🎉",            icon: "🛒" });
  if (cnt >= 5)     milestones.push({ type: "fifth_order",    label: "5th Order Milestone",            icon: "⭐" });
  if (ltv >= 10000) milestones.push({ type: "ltv_10k",        label: "₹10,000 Lifetime Spend",        icon: "💎" });
  if (ltv >= 50000) milestones.push({ type: "ltv_50k",        label: "₹50,000 Lifetime Spend – VIP!", icon: "👑" });

  for (const m of milestones) {
    await pool.query(
      `INSERT IGNORE INTO timeline_milestones (id, customer_id, milestone_type, label, icon) VALUES (?, ?, ?, ?, ?)`,
      [`ms_${custKey}_${m.type}`, customerId, m.type, m.label, m.icon]
    ).catch(() => {});
  }
}

