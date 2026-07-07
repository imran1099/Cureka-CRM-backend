import mysql from "mysql2/promise";
import { nanoid } from "nanoid";

const connectionUri = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/^mysql\+pymysql:\/\//, "mysql://")
  : "mysql://root:root@localhost:3306/cureka_crm_db";

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
  // ─── Existing Core Tables ──────────────────────────────────────────────────

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
    CREATE TABLE IF NOT EXISTS brands (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      short_code VARCHAR(50) UNIQUE NOT NULL,
      logo VARCHAR(255),
      theme_color VARCHAR(50),
      primary_domain VARCHAR(255),
      support_email VARCHAR(255),
      support_phone VARCHAR(255),
      default_currency VARCHAR(50) DEFAULT 'INR',
      timezone VARCHAR(100) DEFAULT 'Asia/Kolkata',
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(255)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_settings (
      id VARCHAR(255) PRIMARY KEY,
      brand_id VARCHAR(255) NOT NULL,
      setting_key VARCHAR(255) NOT NULL,
      setting_value TEXT,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      UNIQUE KEY unique_brand_setting (brand_id, setting_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_brands (
      agent_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255) NOT NULL,
      PRIMARY KEY (agent_id, brand_id),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
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
      product_name TEXT,
      sku VARCHAR(255),
      order_ids TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id),
      KEY idx_customers_segment (segment),
      KEY idx_customers_assigned (assigned_agent_id),
      KEY idx_customers_updated_at (updated_at),
      KEY idx_customers_name (name),
      KEY idx_customers_phone (phone)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_brands (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255) NOT NULL,
      shopify_store VARCHAR(255),
      website VARCHAR(255),
      source VARCHAR(50),
      customer_type VARCHAR(50),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      UNIQUE KEY unique_customer_brand (customer_id, brand_id)
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id VARCHAR(255) PRIMARY KEY,
      brand_id VARCHAR(255) NOT NULL,
      customer_id VARCHAR(255) NOT NULL,
      assigned_agent_id VARCHAR(255),
      department VARCHAR(100),
      priority VARCHAR(50) DEFAULT 'medium',
      sla VARCHAR(50),
      status VARCHAR(50) DEFAULT 'open',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(255) PRIMARY KEY,
      brand_id VARCHAR(255),
      user_id VARCHAR(255),
      action VARCHAR(255) NOT NULL,
      entity_type VARCHAR(100),
      entity_id VARCHAR(255),
      old_value TEXT,
      new_value TEXT,
      ip VARCHAR(255),
      device TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_user (user_id),
      KEY idx_audit_created (created_at),
      KEY idx_audit_entity (entity_type, entity_id)
    )
  `);

  // ─── IAM Tables ────────────────────────────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      id VARCHAR(255) PRIMARY KEY,
      module VARCHAR(100) NOT NULL,
      action VARCHAR(100) NOT NULL,
      description TEXT,
      UNIQUE KEY unique_perm (module, action)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id VARCHAR(255) NOT NULL,
      permission_id VARCHAR(255) NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_role_mapping (
      agent_id VARCHAR(255) NOT NULL,
      role_id VARCHAR(255) NOT NULL,
      assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_by VARCHAR(255),
      PRIMARY KEY (agent_id, role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(255) PRIMARY KEY,
      agent_id VARCHAR(255) NOT NULL,
      jti VARCHAR(255) UNIQUE NOT NULL,
      ip VARCHAR(100),
      device TEXT,
      browser VARCHAR(500),
      os VARCHAR(255),
      login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      KEY idx_sessions_agent (agent_id),
      KEY idx_sessions_jti (jti),
      KEY idx_sessions_active (is_active)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      jti VARCHAR(255) PRIMARY KEY,
      agent_id VARCHAR(255),
      revoked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      KEY idx_revoked_expires (expires_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_history (
      id VARCHAR(255) PRIMARY KEY,
      agent_id VARCHAR(255),
      event_type VARCHAR(50) NOT NULL,
      email_attempted VARCHAR(255),
      ip VARCHAR(100),
      browser VARCHAR(500),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_login_history_agent (agent_id),
      KEY idx_login_history_created (created_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(255) PRIMARY KEY,
      recipient_id VARCHAR(255) NOT NULL,
      type VARCHAR(100) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT,
      link VARCHAR(500),
      read_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_notifications_recipient (recipient_id),
      KEY idx_notifications_unread (recipient_id, read_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      type VARCHAR(50) DEFAULT 'shipping',
      full_address TEXT,
      landmark VARCHAR(255),
      city VARCHAR(255),
      state VARCHAR(255),
      country VARCHAR(255) DEFAULT 'India',
      pincode VARCHAR(50),
      is_default TINYINT(1) DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      KEY idx_cust_addresses (customer_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_notes (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255),
      content TEXT NOT NULL,
      attachments TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_cust_notes (customer_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_timeline_events (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      description TEXT,
      event_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      agent_id VARCHAR(255),
      metadata TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      KEY idx_cust_timeline (customer_id, event_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_followups (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      assigned_agent_id VARCHAR(255),
      due_date DATETIME NOT NULL,
      reason VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_cust_followups_date (due_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_categories (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      department_id VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_category_name (name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_rules (
      id VARCHAR(255) PRIMARY KEY,
      category_id VARCHAR(255),
      priority VARCHAR(50) NOT NULL,
      first_response_minutes INT NOT NULL,
      resolution_minutes INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id VARCHAR(255) PRIMARY KEY,
      ticket_id VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255),
      is_internal TINYINT(1) DEFAULT 1,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_ticket_comments (ticket_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_timeline (
      id VARCHAR(255) PRIMARY KEY,
      ticket_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      description TEXT,
      agent_id VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      KEY idx_ticket_timeline (ticket_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_escalations (
      id VARCHAR(255) PRIMARY KEY,
      ticket_id VARCHAR(255) NOT NULL,
      escalated_by VARCHAR(255),
      escalated_to VARCHAR(255),
      reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (escalated_by) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (escalated_to) REFERENCES roles(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_scripts (
      id VARCHAR(255) PRIMARY KEY,
      category VARCHAR(100) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_script_category (category)
    )
  `);

  // ─── Customer Success Command Center Tables ─────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_queues (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL,
      sla_minutes INT NOT NULL DEFAULT 60,
      priority_base INT NOT NULL DEFAULT 5,
      icon VARCHAR(50),
      color VARCHAR(50),
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_tasks (
      id VARCHAR(255) PRIMARY KEY,
      queue_id VARCHAR(255) NOT NULL,
      customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      assigned_agent_id VARCHAR(255),
      ticket_id VARCHAR(255),
      status VARCHAR(50) NOT NULL DEFAULT 'assigned',
      priority_score INT NOT NULL DEFAULT 5,
      reason TEXT,
      recommended_action TEXT,
      sla_deadline DATETIME,
      contacted_at DATETIME,
      resolved_at DATETIME,
      outcome VARCHAR(100),
      revenue_generated DOUBLE DEFAULT 0,
      order_id VARCHAR(255),
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (queue_id) REFERENCES cs_queues(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_cs_tasks_agent (assigned_agent_id),
      KEY idx_cs_tasks_status (status),
      KEY idx_cs_tasks_brand (brand_id),
      KEY idx_cs_tasks_sla (sla_deadline)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_campaigns (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      queue_id VARCHAR(255),
      description TEXT,
      start_date DATE,
      end_date DATE,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_by VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cs_task_audit (
      id VARCHAR(255) PRIMARY KEY,
      task_id VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255),
      from_status VARCHAR(50),
      to_status VARCHAR(50) NOT NULL,
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES cs_tasks(id) ON DELETE CASCADE,
      KEY idx_cs_task_audit (task_id)
    )
  `);

  // ─── Sales CRM & Revenue Engine Tables ────────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS opportunity_stages (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      color VARCHAR(50) DEFAULT '#6B7280',
      is_won TINYINT(1) NOT NULL DEFAULT 0,
      is_lost TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      stage_id VARCHAR(255) NOT NULL,
      type VARCHAR(100) NOT NULL DEFAULT 'general',
      source VARCHAR(100),
      assigned_agent_id VARCHAR(255),
      expected_revenue DOUBLE DEFAULT 0,
      probability INT DEFAULT 20,
      priority VARCHAR(50) DEFAULT 'medium',
      outcome VARCHAR(50) DEFAULT 'open',
      lost_reason TEXT,
      order_id VARCHAR(255),
      campaign_id VARCHAR(255),
      close_date DATE,
      last_activity_at DATETIME,
      next_followup_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (stage_id) REFERENCES opportunity_stages(id),
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_opp_customer (customer_id),
      KEY idx_opp_agent (assigned_agent_id),
      KEY idx_opp_stage (stage_id),
      KEY idx_opp_outcome (outcome),
      KEY idx_opp_brand (brand_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS opportunity_activities (
      id VARCHAR(255) PRIMARY KEY,
      opportunity_id VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255),
      activity_type VARCHAR(50) NOT NULL,
      description TEXT,
      from_stage VARCHAR(255),
      to_stage VARCHAR(255),
      metadata TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
      KEY idx_opp_activities (opportunity_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS opportunity_followups (
      id VARCHAR(255) PRIMARY KEY,
      opportunity_id VARCHAR(255) NOT NULL,
      assigned_agent_id VARCHAR(255),
      due_date DATETIME NOT NULL,
      follow_up_type VARCHAR(50) DEFAULT 'call',
      notes TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_opp_followups (opportunity_id),
      KEY idx_opp_followups_date (due_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cre_campaigns (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      type VARCHAR(100),
      description TEXT,
      start_date DATE,
      end_date DATE,
      revenue_target DOUBLE DEFAULT 0,
      revenue_achieved DOUBLE DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_by VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue_attribution (
      id VARCHAR(255) PRIMARY KEY,
      opportunity_id VARCHAR(255),
      order_id VARCHAR(255),
      agent_id VARCHAR(255),
      brand_id VARCHAR(255),
      campaign_id VARCHAR(255),
      source VARCHAR(100),
      type VARCHAR(100),
      amount DOUBLE NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_rev_attr_agent (agent_id),
      KEY idx_rev_attr_brand (brand_id),
      KEY idx_rev_attr_campaign (campaign_id)
    )
  `);

  await migrateExistingColumns();
  await seedDefaults();
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
    ["cart_value", "DOUBLE DEFAULT 0"],
    ["cart_items", "TEXT"],
    ["cart_abandoned_at", "DATETIME"],
    ["household_notes", "TEXT"],
    ["price_sensitivity", "VARCHAR(50)"],
    ["product_name", "TEXT"],
    ["sku", "VARCHAR(255)"],
    ["order_ids", "TEXT"],
    ["shopify_customer_id", "VARCHAR(255)"],
    ["customer_since", "DATETIME"],
    ["health_score", "INT DEFAULT 100"],
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
    ["brand_id", "VARCHAR(255)"],
    ["call_type", "VARCHAR(50) DEFAULT 'outbound'"],
    ["call_category", "VARCHAR(50)"],
    ["recording_url", "TEXT"],
    ["order_id", "VARCHAR(255)"],
    ["attempt_number", "INT DEFAULT 1"]
  ];

  for (const [col, type] of newCallCols) {
    if (!existingCallCols.includes(col)) {
      await pool.query(`ALTER TABLE call_logs ADD COLUMN ${col} ${type}`);
    }
  }

  const [agentCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents'"
  );
  const existingAgentCols = agentCols.map((c) => c.COLUMN_NAME);

  // Original cols + new IAM cols
  const newAgentCols = [
    ["employee_id", "VARCHAR(100)"],
    ["mobile", "VARCHAR(50)"],
    ["alternate_mobile", "VARCHAR(50)"],
    ["profile_photo", "MEDIUMTEXT"],
    ["department", "VARCHAR(100)"],
    ["department_id", "VARCHAR(255)"],
    ["designation", "VARCHAR(100)"],
    ["reporting_manager", "VARCHAR(255)"],
    ["reporting_manager_id", "VARCHAR(255)"],
    ["office_location", "VARCHAR(255)"],
    ["joining_date", "DATE"],
    ["employment_status", "VARCHAR(50) DEFAULT 'active'"],
    ["shift_timing", "VARCHAR(100)"],
    ["timezone", "VARCHAR(100) DEFAULT 'Asia/Kolkata'"],
    ["last_working_day", "DATE"],
    ["login_status", "VARCHAR(50) DEFAULT 'offline'"],
    ["failed_login_attempts", "INT NOT NULL DEFAULT 0"],
    ["locked_until", "DATETIME"],
    ["last_login_at", "DATETIME"],
    ["last_login_ip", "VARCHAR(100)"],
    ["last_login_device", "TEXT"],
  ];
  for (const [col, type] of newAgentCols) {
    if (!existingAgentCols.includes(col)) {
      await pool.query(`ALTER TABLE agents ADD COLUMN ${col} ${type}`);
    }
  }

  const [purchaseCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_history'"
  );
  const existingPurchaseCols = purchaseCols.map((c) => c.COLUMN_NAME);
  const newPurchaseCols = [
    ["brand_id", "VARCHAR(255)"],
    ["store", "VARCHAR(255)"],
    ["sales_channel", "VARCHAR(100)"],
    ["marketplace", "VARCHAR(100)"],
    ["website", "VARCHAR(255)"],
    ["order_source", "VARCHAR(100)"],
    ["order_type", "VARCHAR(100)"],
  ];
  for (const [col, type] of newPurchaseCols) {
    if (!existingPurchaseCols.includes(col)) {
      await pool.query(`ALTER TABLE purchase_history ADD COLUMN ${col} ${type}`);
    }
  }

  const [tagCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_tags'"
  );
  const existingTagCols = tagCols.map((c) => c.COLUMN_NAME);
  if (!existingTagCols.includes("brand_id")) {
    await pool.query(`ALTER TABLE customer_tags ADD COLUMN brand_id VARCHAR(255)`);
  }

  // Audit logs extended columns
  const [auditCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'"
  );
  const existingAuditCols = auditCols.map((c) => c.COLUMN_NAME);
  const newAuditCols = [
    ["entity_type", "VARCHAR(100)"],
    ["entity_id", "VARCHAR(255)"],
    ["device", "TEXT"],
  ];
  for (const [col, type] of newAuditCols) {
    if (!existingAuditCols.includes(col)) {
      await pool.query(`ALTER TABLE audit_logs ADD COLUMN ${col} ${type}`);
    }
  }

  // Add indexes to customers table for pagination
  const [indexCols] = await pool.query(
    "SHOW INDEX FROM customers WHERE Key_name IN ('idx_customers_updated_at', 'idx_customers_name', 'idx_customers_phone')"
  );
  const existingIndexes = indexCols.map((i) => i.Key_name);

  if (!existingIndexes.includes("idx_customers_updated_at")) {
    await pool.query("ALTER TABLE customers ADD INDEX idx_customers_updated_at (updated_at)");
  }
  if (!existingIndexes.includes("idx_customers_name")) {
    await pool.query("ALTER TABLE customers ADD INDEX idx_customers_name (name)");
  }
  if (!existingIndexes.includes("idx_customers_phone")) {
    await pool.query("ALTER TABLE customers ADD INDEX idx_customers_phone (phone)");
  }

  const [ticketCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets'"
  );
  const existingTicketCols = ticketCols.map((c) => c.COLUMN_NAME);
  const newTicketCols = [
    ["source", "VARCHAR(100)"],
    ["category_id", "VARCHAR(255)"],
    ["sub_category_id", "VARCHAR(255)"],
    ["first_response_at", "DATETIME"],
    ["resolved_at", "DATETIME"],
    ["sla_status", "VARCHAR(50) DEFAULT 'within_sla'"],
    ["sla_due_date", "DATETIME"],
    ["resolution_due_date", "DATETIME"]
  ];
  for (const [col, type] of newTicketCols) {
    if (!existingTicketCols.includes(col)) {
      await pool.query(`ALTER TABLE tickets ADD COLUMN ${col} ${type}`);
    }
  }
}

// ─── IAM Seed Defaults ─────────────────────────────────────────────────────

async function seedDefaults() {
  // Seed departments
  const departments = [
    { id: "dept_customer_support", name: "Customer Support", description: "Handles inbound customer queries and complaints" },
    { id: "dept_customer_success", name: "Customer Success", description: "Proactive retention and upselling team" },
    { id: "dept_operations", name: "Operations", description: "Day-to-day operational management" },
    { id: "dept_warehouse", name: "Warehouse", description: "Inventory and fulfilment management" },
    { id: "dept_marketplace", name: "Marketplace", description: "Online marketplace management" },
    { id: "dept_ecommerce", name: "E-commerce", description: "Direct e-commerce and digital channels" },
    { id: "dept_finance", name: "Finance", description: "Financial management and reporting" },
    { id: "dept_marketing", name: "Marketing", description: "Brand and growth marketing" },
    { id: "dept_hr", name: "Human Resources", description: "People operations and talent management" },
    { id: "dept_it", name: "Information Technology", description: "Systems, infrastructure and technical support" },
  ];

  for (const dept of departments) {
    await pool.query(
      `INSERT IGNORE INTO departments (id, name, description) VALUES (?, ?, ?)`,
      [dept.id, dept.name, dept.description]
    );
  }

  // Seed system roles
  const roles = [
    { id: "role_super_admin", name: "Super Admin", slug: "super_admin", description: "Full unrestricted system access", is_system: 1 },
    { id: "role_admin", name: "Admin", slug: "admin", description: "Full administrative access", is_system: 1 },
    { id: "role_general_manager", name: "General Manager", slug: "general_manager", description: "Cross-department management oversight", is_system: 1 },
    { id: "role_operations_manager", name: "Operations Manager", slug: "operations_manager", description: "Operations team management", is_system: 1 },
    { id: "role_team_leader", name: "Team Leader", slug: "team_leader", description: "Team-level supervision and reporting", is_system: 1 },
    { id: "role_cs_executive", name: "Customer Support Executive", slug: "customer_support_executive", description: "Front-line customer support agent", is_system: 1 },
    { id: "role_cx_executive", name: "Customer Success Executive", slug: "customer_success_executive", description: "Proactive retention and success agent", is_system: 1 },
    { id: "role_read_only", name: "Read Only", slug: "read_only", description: "View-only access across all modules", is_system: 1 },
  ];

  for (const role of roles) {
    await pool.query(
      `INSERT IGNORE INTO roles (id, name, slug, description, is_system) VALUES (?, ?, ?, ?, ?)`,
      [role.id, role.name, role.slug, role.description, role.is_system]
    );
  }

  // Seed permissions matrix
  const permDefs = [
    ["customers", "view", "View customer records"],
    ["customers", "create", "Create new customer records"],
    ["customers", "edit", "Edit existing customer records"],
    ["customers", "delete", "Delete customer records"],
    ["customers", "export", "Export customer data to CSV/Excel"],
    ["orders", "view", "View order records"],
    ["orders", "edit", "Edit order details"],
    ["orders", "cancel", "Cancel orders"],
    ["orders", "refund", "Process order refunds"],
    ["orders", "export", "Export order data"],
    ["tickets", "view", "View support tickets"],
    ["tickets", "assign", "Assign tickets to agents"],
    ["tickets", "escalate", "Escalate tickets to higher tiers"],
    ["tickets", "resolve", "Mark tickets as resolved"],
    ["tickets", "close", "Close tickets permanently"],
    ["calls", "view", "View call logs and history"],
    ["calls", "make", "Make outbound calls"],
    ["calls", "listen_recording", "Listen to call recordings"],
    ["calls", "download_recording", "Download call recordings"],
    ["reports", "view", "View reports and dashboards"],
    ["reports", "export", "Export report data"],
    ["reports", "schedule", "Schedule automated reports"],
    ["settings", "view", "View system settings"],
    ["settings", "modify", "Modify system settings"],
    ["settings", "delete", "Delete system configurations"],
    ["users", "view", "View user profiles and list"],
    ["users", "create", "Create new user accounts"],
    ["users", "edit", "Edit user profiles and access"],
    ["users", "delete", "Deactivate/delete user accounts"],
    ["users", "export", "Export user data"],
    ["roles", "view", "View roles and permissions"],
    ["roles", "create", "Create new roles"],
    ["roles", "edit", "Edit roles and permission matrix"],
    ["roles", "delete", "Delete roles"],
  ];

  for (const [module, action, description] of permDefs) {
    const id = `perm_${module}_${action}`;
    await pool.query(
      `INSERT IGNORE INTO permissions (id, module, action, description) VALUES (?, ?, ?, ?)`,
      [id, module, action, description]
    );
  }

  // Seed role-permission mappings
  const allPerms = permDefs.map(([m, a]) => `${m}:${a}`);
  const viewOnlyPerms = permDefs.filter(([, a]) => a === "view").map(([m, a]) => `${m}:${a}`);

  const rolePermMap = {
    role_super_admin: allPerms,
    role_admin: allPerms.filter((p) => p !== "roles:delete"),
    role_general_manager: [
      "customers:view", "customers:edit", "customers:export",
      "orders:view", "orders:export",
      "tickets:view", "tickets:assign", "tickets:escalate", "tickets:resolve", "tickets:close",
      "calls:view", "calls:listen_recording",
      "reports:view", "reports:export", "reports:schedule",
      "users:view",
      "roles:view",
      "settings:view",
    ],
    role_operations_manager: [
      "customers:view", "customers:edit",
      "orders:view",
      "tickets:view", "tickets:assign", "tickets:escalate", "tickets:resolve",
      "calls:view", "calls:listen_recording",
      "reports:view", "reports:export",
      "users:view",
    ],
    role_team_leader: [
      "customers:view", "customers:edit",
      "orders:view",
      "tickets:view", "tickets:assign", "tickets:resolve",
      "calls:view", "calls:make",
      "reports:view",
    ],
    role_cs_executive: [
      "customers:view", "customers:edit",
      "orders:view",
      "tickets:view", "tickets:assign", "tickets:resolve",
      "calls:view", "calls:make",
    ],
    role_cx_executive: [
      "customers:view", "customers:create", "customers:edit",
      "orders:view",
      "tickets:view",
      "calls:view", "calls:make",
      "reports:view",
    ],
    role_read_only: viewOnlyPerms,
  };

  for (const [roleId, perms] of Object.entries(rolePermMap)) {
    for (const perm of perms) {
      const [module, action] = perm.split(":");
      const permId = `perm_${module}_${action}`;
      await pool.query(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
        [roleId, permId]
      );
    }
  }

  // Migrate existing agents into user_role_mapping
  const roleSlugToId = {
    admin: "role_admin",
    super_admin: "role_super_admin",
    general_manager: "role_general_manager",
    operations_manager: "role_operations_manager",
    team_leader: "role_team_leader",
    agent: "role_cs_executive",
    customer_support_executive: "role_cs_executive",
    customer_success_executive: "role_cx_executive",
    read_only: "role_read_only",
  };

  const [existingAgents] = await pool.query("SELECT id, role FROM agents");
  for (const agent of existingAgents) {
    const roleId = roleSlugToId[agent.role] || "role_cs_executive";
    await pool.query(
      `INSERT IGNORE INTO user_role_mapping (agent_id, role_id) VALUES (?, ?)`,
      [agent.id, roleId]
    );
  }

  // Clean up expired revoked tokens (housekeeping)
  await pool.query(`DELETE FROM revoked_tokens WHERE expires_at < NOW()`).catch(() => {});

  // Seed CS Queue categories
  const csQueues = [
    { id: "csq_ctwa",          name: "CTWA Leads",                category: "sales",    sla_minutes: 15,  priority_base: 1, icon: "MessageSquare", color: "#EF4444" },
    { id: "csq_abandoned_cart",name: "Abandoned Cart",            category: "sales",    sla_minutes: 30,  priority_base: 1, icon: "ShoppingCart",  color: "#EF4444" },
    { id: "csq_checkout_assist",name:"Checkout Assistance",       category: "sales",    sla_minutes: 60,  priority_base: 2, icon: "CreditCard",    color: "#F97316" },
    { id: "csq_upsell",        name: "High Value Prospects",      category: "sales",    sla_minutes: 120, priority_base: 2, icon: "TrendingUp",    color: "#F97316" },
    { id: "csq_delivered_fu",  name: "Delivered Order Follow-up", category: "success",  sla_minutes: 480, priority_base: 3, icon: "PackageCheck",  color: "#EAB308" },
    { id: "csq_repeat_purchase",name:"Repeat Purchase Campaign",  category: "success",  sla_minutes: 1440,priority_base: 3, icon: "RefreshCw",     color: "#EAB308" },
    { id: "csq_wellness",      name: "Wellness Follow-up",        category: "success",  sla_minutes: 1440,priority_base: 4, icon: "Heart",         color: "#22C55E" },
    { id: "csq_complaints",    name: "Open Complaints",           category: "support",  sla_minutes: 60,  priority_base: 1, icon: "AlertTriangle", color: "#EF4444" },
    { id: "csq_delivery_issue",name: "Delivery Issues",           category: "support",  sla_minutes: 120, priority_base: 2, icon: "Truck",         color: "#F97316" },
    { id: "csq_refund",        name: "Refund Requests",           category: "support",  sla_minutes: 1440,priority_base: 2, icon: "RotateCcw",     color: "#F97316" },
    { id: "csq_rto_recovery",  name: "RTO Recovery",              category: "operations",sla_minutes: 720, priority_base: 2, icon: "PackageX",      color: "#F97316" },
    { id: "csq_address_verify",name: "Address Verification",      category: "operations",sla_minutes: 240, priority_base: 3, icon: "MapPin",        color: "#EAB308" },
    { id: "csq_dormant",       name: "Dormant Customers",         category: "retention",sla_minutes: 4320,priority_base: 4, icon: "Users",         color: "#8B5CF6" },
    { id: "csq_vip",           name: "VIP Customers",             category: "retention",sla_minutes: 60,  priority_base: 1, icon: "Star",          color: "#EF4444" },
  ];
  for (const q of csQueues) {
    await pool.query(
      `INSERT IGNORE INTO cs_queues (id, name, category, sla_minutes, priority_base, icon, color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [q.id, q.name, q.category, q.sla_minutes, q.priority_base, q.icon, q.color]
    );
  }

  // Seed default opportunity pipeline stages
  const oppStages = [
    { id: "stage_new_lead",       name: "New Lead",               sort_order: 1,  color: "#6B7280", is_won: 0, is_lost: 0 },
    { id: "stage_contact_attempt",name: "Contact Attempted",      sort_order: 2,  color: "#3B82F6", is_won: 0, is_lost: 0 },
    { id: "stage_connected",      name: "Connected",              sort_order: 3,  color: "#8B5CF6", is_won: 0, is_lost: 0 },
    { id: "stage_interested",     name: "Interested",             sort_order: 4,  color: "#F59E0B", is_won: 0, is_lost: 0 },
    { id: "stage_consultation",   name: "Product Consultation",   sort_order: 5,  color: "#F97316", is_won: 0, is_lost: 0 },
    { id: "stage_payment_link",   name: "Payment Link Shared",    sort_order: 6,  color: "#EC4899", is_won: 0, is_lost: 0 },
    { id: "stage_order_placed",   name: "Order Placed",           sort_order: 7,  color: "#10B981", is_won: 0, is_lost: 0 },
    { id: "stage_won",            name: "Won",                    sort_order: 8,  color: "#16A34A", is_won: 1, is_lost: 0 },
    { id: "stage_lost",           name: "Lost",                   sort_order: 9,  color: "#DC2626", is_won: 0, is_lost: 1 },
  ];
  for (const s of oppStages) {
    await pool.query(
      `INSERT IGNORE INTO opportunity_stages (id, name, sort_order, color, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?)`,
      [s.id, s.name, s.sort_order, s.color, s.is_won, s.is_lost]
    );
  }
}


// Helper: write an audit log entry
export async function writeAuditLog({ userId, action, entityType, entityId, oldValue, newValue, ip, device, brandId } = {}) {
  const id = "al_" + nanoid(14);
  await pool.query(
    `INSERT INTO audit_logs (id, brand_id, user_id, action, entity_type, entity_id, old_value, new_value, ip, device)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      brandId || null,
      userId || null,
      action,
      entityType || null,
      entityId || null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ip || null,
      device || null,
    ]
  );
}

// Helper: create an in-app notification
export async function createNotification({ recipientId, type, title, body, link } = {}) {
  const id = "notif_" + nanoid(12);
  await pool.query(
    `INSERT INTO notifications (id, recipient_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, recipientId, type, title, body || null, link || null]
  );
}
