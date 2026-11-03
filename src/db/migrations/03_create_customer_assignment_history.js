import { pool } from "../connection.js";

/**
 * Migration 03: Create customer assignment history table and indexes.
 *
 * Tracks every assignment and reassignment of a customer to an agent:
 * - customer_id: Customer being assigned
 * - previous_agent_id: Previous agent (null if newly assigned from unassigned)
 * - new_agent_id: New assigned agent
 * - assigned_by: Agent/Admin who performed the assignment
 * - assignment_type: 'manual', 'bulk', 'csv'
 * - notes: Optional remarks for the assignment
 */
export async function runMigration03() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_assignment_history (
        id VARCHAR(255) PRIMARY KEY,
        customer_id VARCHAR(255) NOT NULL,
        previous_agent_id VARCHAR(255),
        new_agent_id VARCHAR(255) NOT NULL,
        assigned_by VARCHAR(255) NOT NULL,
        assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        assignment_type VARCHAR(50) NOT NULL DEFAULT 'manual',
        notes TEXT,
        KEY idx_cah_customer (customer_id),
        KEY idx_cah_new_agent (new_agent_id),
        KEY idx_cah_prev_agent (previous_agent_id),
        KEY idx_cah_assigned_at (assigned_at)
      )
    `);

    // Ensure index on customers.assigned_agent_id exists
    const [indexes] = await pool.query(
      "SHOW INDEX FROM customers WHERE Key_name = 'idx_customers_assigned_agent'"
    );
    if (indexes.length === 0) {
      await pool.query("ALTER TABLE customers ADD INDEX idx_customers_assigned_agent (assigned_agent_id)");
    }

    console.log("[Migration 03] Customer assignment history table and indexes initialized.");
  } catch (err) {
    console.error("[Migration 03] Error creating assignment history table:", err.message);
  }
}

