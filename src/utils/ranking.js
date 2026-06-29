// Ranking engine: decides who an agent should call next, and why.
// Higher score = call sooner. A negative score means "exclude from today's queue".

function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.round(ms / 86400000);
}

function hoursBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.round(ms / 3600000);
}

const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * Computes a priority score + a human-readable reason for a single customer.
 * @param {object} customer - row from the customers table (plus latest call_log info if available)
 * @param {string} today - ISO date string, defaults to now
 */
export function scoreCustomer(customer, today = todayStr()) {
  let score = 0;
  let reason = "";

  switch (customer.segment) {
    case "replenishment": {
      const overdue = customer.replenish_due_date ? daysBetween(customer.replenish_due_date, today) : 0;
      score = 100 + overdue * 4 + Math.min(customer.ltv / 500, 20);
      reason =
        overdue > 0
          ? `Due for refill — ${overdue} day${overdue === 1 ? "" : "s"} overdue`
          : overdue === 0
          ? "Due for refill — today"
          : `Refill due in ${-overdue} day${-overdue === 1 ? "" : "s"}`;
      break;
    }
    case "abandoner": {
      const now = customer._now || new Date().toISOString();
      const hrs = customer.cart_abandoned_at ? Math.max(1, hoursBetween(customer.cart_abandoned_at, now)) : 24;
      score = 90 - Math.min(hrs / 2, 40) + Math.min((customer.cart_value || 0) / 300, 15);
      reason = `Cart abandoned ~${hrs}h ago — ₹${(customer.cart_value || 0).toLocaleString("en-IN")} in cart`;
      break;
    }
    case "dormant": {
      const silent = customer.last_order_date ? daysBetween(customer.last_order_date, today) : 0;
      score = 70 + Math.min(customer.ltv / 300, 30) + Math.min(silent / 10, 10);
      reason = `₹${customer.ltv.toLocaleString("en-IN")} LTV — silent ${silent} days`;
      break;
    }
    case "churnrisk": {
      const since = customer.last_order_date ? daysBetween(customer.last_order_date, today) : 0;
      score = 40 + Math.min(since / 15, 15);
      reason = `Single purchase, ${since} days ago — no repeat yet`;
      break;
    }
    case "new_lead": {
      score = 80;
      reason = "New lead — not yet contacted";
      break;
    }
    default: {
      score = 10;
      reason = "General follow-up";
    }
  }

  // Scheduled callback overrides everything
  if (customer.callback_date) {
    const delta = daysBetween(customer.callback_date, today);
    if (delta < 0) {
      score = -1000;
      reason = `Callback scheduled for ${customer.callback_date}`;
    } else {
      score = 200 + delta * 10;
      reason = delta === 0 ? "Callback scheduled — today" : `Callback overdue by ${delta} day${delta === 1 ? "" : "s"}`;
    }
  }

  // Already resolved today with a terminal outcome -> drop from queue
  if (customer.last_call_date === today && ["sold", "notinterested", "wrongnumber"].includes(customer.last_outcome)) {
    score = -2000;
  }

  // Do-not-call always excluded
  if (customer.do_not_call) {
    score = -3000;
    reason = "Marked do-not-call";
  }

  return { score: Math.round(score * 100) / 100, reason };
}

export { todayStr, daysBetween, hoursBetween };
