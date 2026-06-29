import mysql from "mysql2/promise";

const connectionUri = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/^mysql\+pymysql:\/\//, "mysql://")
  : "mysql://root:xnAKNPLYcINfjJVejJrqGZmbKKJRFCmv@reseau.proxy.rlwy.net:36200/cureka_crm_db";

export const pool = mysql.createPool({
  uri: connectionUri,
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

export const db = {
  async all(sql, ...params) {
    const [rows] = await pool.execute(sql, params);
    return rows;
  },
  async get(sql, ...params) {
    const [rows] = await pool.execute(sql, params);
    return rows[0];
  },
  async run(sql, ...params) {
    const [result] = await pool.execute(sql, params);
    return result;
  },
  async exec(sql) {
    await pool.query(sql);
  },
  async transaction(fn) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }
};

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'agent',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      age INT,
      gender VARCHAR(50),
      city VARCHAR(255),
      segment VARCHAR(50) NOT NULL,
      source VARCHAR(50) NOT NULL DEFAULT 'manual_upload',
      ltv DOUBLE NOT NULL DEFAULT 0,
      last_order_date VARCHAR(50),
      replenish_due_date VARCHAR(50),
      cart_value DOUBLE,
      cart_items TEXT,
      cart_abandoned_at VARCHAR(50),
      assigned_agent_id VARCHAR(255),
      callback_date VARCHAR(50),
      do_not_call TINYINT(1) NOT NULL DEFAULT 0,
      health_conditions TEXT,
      product_preferences TEXT,
      allergies_restrictions TEXT,
      preferred_contact_time VARCHAR(50),
      preferred_language VARCHAR(100),
      household_notes TEXT,
      price_sensitivity VARCHAR(50),
      product_name VARCHAR(255),
      sku VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id),
      KEY idx_customers_segment (segment),
      KEY idx_customers_assigned (assigned_agent_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_history (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      order_date VARCHAR(50) NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      amount DOUBLE NOT NULL DEFAULT 0,
      order_ref VARCHAR(255),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      KEY idx_purchase_history_customer (customer_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255) NOT NULL,
      called_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      outcome VARCHAR(50) NOT NULL,
      remarks TEXT,
      sale_amount DOUBLE,
      callback_date VARCHAR(50),
      objection_type VARCHAR(100),
      sentiment VARCHAR(50),
      decision_style VARCHAR(100),
      interest_level INT,
      call_duration_seconds INT,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      KEY idx_call_logs_customer (customer_id),
      KEY idx_call_logs_agent (agent_id),
      KEY idx_call_logs_objection (objection_type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_tags (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      tag VARCHAR(255) NOT NULL,
      tag_type VARCHAR(50) NOT NULL,
      added_by_agent_id VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_customer_tag (customer_id, tag, tag_type),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (added_by_agent_id) REFERENCES agents(id),
      KEY idx_customer_tags_customer (customer_id),
      KEY idx_customer_tags_tag (tag, tag_type)
    )
  `);

  await migrateExistingColumns();
}

async function migrateExistingColumns() {
  const [customerCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'"
  );
  const existingCustCols = customerCols.map((c) => c.COLUMN_NAME);

  const newCustomerCols = [
    ["age", "INT"],
    ["gender", "VARCHAR(50)"],
    ["city", "VARCHAR(255)"],
    ["health_conditions", "TEXT"],
    ["product_preferences", "TEXT"],
    ["allergies_restrictions", "TEXT"],
    ["preferred_contact_time", "VARCHAR(50)"],
    ["preferred_language", "VARCHAR(100)"],
    ["household_notes", "TEXT"],
    ["price_sensitivity", "VARCHAR(50)"],
    ["product_name", "VARCHAR(255)"],
    ["sku", "VARCHAR(255)"],
  ];

  for (const [col, type] of newCustomerCols) {
    if (!existingCustCols.includes(col)) {
      await pool.query(`ALTER TABLE customers ADD COLUMN ${col} ${type}`);
    }
  }

  const [callCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_logs'"
  );
  const existingCallCols = callCols.map((c) => c.COLUMN_NAME);

  const newCallCols = [
    ["objection_type", "VARCHAR(100)"],
    ["sentiment", "VARCHAR(50)"],
    ["decision_style", "VARCHAR(100)"],
    ["interest_level", "INT"],
    ["call_duration_seconds", "INT"],
  ];

  for (const [col, type] of newCallCols) {
    if (!existingCallCols.includes(col)) {
      await pool.query(`ALTER TABLE call_logs ADD COLUMN ${col} ${type}`);
    }
  }
}
