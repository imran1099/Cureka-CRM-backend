import { pool } from "../connection.js";
import { nanoid } from "nanoid";

/**
 * Migration 02: Sync existing customer order_ids to purchase_history.
 * 
 * Background:
 * In early versions of customer CSV import, order references (e.g. 'ORD-9821, ORD-10244')
 * were stored only as text in `customers.order_ids`. To allow each order to be tracked
 * and updated independently with its own status, this migration ensures every existing
 * customer's order references have a corresponding row in `purchase_history`.
 * 
 * Safety:
 * - Read-only on customers table.
 * - Idempotent: checks if (customer_id, order_ref) already exists before inserting.
 * - Does not overwrite any existing purchase_history rows.
 */
export async function runMigration02() {
  try {
    const [customers] = await pool.query(
      "SELECT id, phone, ltv, product_name, last_order_date, order_ids, created_at FROM customers WHERE order_ids IS NOT NULL AND order_ids != ''"
    );

    let syncedCount = 0;
    for (const cust of customers) {
      const orderRefs = cust.order_ids
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const orderRef of orderRefs) {
        const [existing] = await pool.query(
          "SELECT id FROM purchase_history WHERE customer_id = ? AND order_ref = ?",
          [cust.id, orderRef]
        );

        if (existing.length === 0) {
          const phId = "ph_" + nanoid(10);
          let orderDate = new Date().toISOString().split("T")[0];
          if (cust.last_order_date) {
            orderDate = String(cust.last_order_date).trim();
          } else if (cust.created_at) {
            try {
              const parsed = new Date(cust.created_at);
              if (!isNaN(parsed.getTime())) {
                orderDate = parsed.toISOString().split("T")[0];
              }
            } catch (e) {}
          }
          const prodName = cust.product_name || "Imported Product";
          const amount = (cust.ltv && cust.ltv > 0) ? cust.ltv : 0;

          await pool.query(
            `INSERT INTO purchase_history 
              (id, customer_id, order_date, product_name, quantity, amount, order_ref, status)
             VALUES (?, ?, ?, ?, 1, ?, ?, 'Pending')`,
            [phId, cust.id, orderDate, prodName, amount, orderRef]
          );
          syncedCount++;
        }
      }
    }

    if (syncedCount > 0) {
      console.log(`[Migration 02] Synced ${syncedCount} order references from customers to purchase_history.`);
    }
  } catch (err) {
    console.error("[Migration 02] Error syncing customer orders:", err.message);
  }
}
