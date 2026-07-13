import mysql from "mysql2/promise";
import { nanoid } from "nanoid";

const connectionUri = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/^mysql\+pymysql:\/\//, "mysql://")
  : "mysql://root:root@localhost:3306/cureka_crms";
// : "mysql://root:root@localhost:3306/cureka_crm_db";
// : "mysql://root:ioYkajsDqbcsbxCwIKLyLSIRyeLguYvg@hayabusa.proxy.rlwy.net:25408/cureka_crm_db";

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
    CREATE TABLE IF NOT EXISTS products (
      id VARCHAR(255) PRIMARY KEY,
      sku VARCHAR(100) UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100),
      price DOUBLE NOT NULL DEFAULT 0,
      image_url TEXT,
      brand_id VARCHAR(255),
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(255) PRIMARY KEY,
      shopify_order_id VARCHAR(255),
      customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      total_amount DOUBLE NOT NULL DEFAULT 0,
      status VARCHAR(50) DEFAULT 'completed',
      ordered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id VARCHAR(255) PRIMARY KEY,
      order_id VARCHAR(255) NOT NULL,
      product_id VARCHAR(255),
      quantity INT NOT NULL DEFAULT 1,
      price DOUBLE NOT NULL DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_recommendations (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      product_id VARCHAR(255) NOT NULL,
      recommendation_type VARCHAR(50),
      score DOUBLE DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_sync_logs (
      id VARCHAR(255) PRIMARY KEY,
      brand_id VARCHAR(255),
      sync_type VARCHAR(50),
      status VARCHAR(50),
      records_processed INT DEFAULT 0,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      error_message TEXT
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
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
      FOREIGN KEY (campaign_id) REFERENCES cre_campaigns(id) ON DELETE SET NULL,
      KEY idx_rev_attr_agent (agent_id),
      KEY idx_rev_attr_brand (brand_id),
      KEY idx_rev_attr_campaign (campaign_id)
    )
  `);

  // ─── Customer Journey Intelligence Timeline ────────────────────────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeline_event_types (
      id VARCHAR(100) PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      label VARCHAR(255) NOT NULL,
      icon VARCHAR(10) NOT NULL DEFAULT '📌',
      color VARCHAR(20) NOT NULL DEFAULT '#64748B',
      is_active TINYINT(1) NOT NULL DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_timeline (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      event_type VARCHAR(100) NOT NULL,
      event_title VARCHAR(500) NOT NULL,
      event_description TEXT,
      outcome VARCHAR(100),
      agent_id VARCHAR(255),
      department VARCHAR(100),
      source_system VARCHAR(100) NOT NULL DEFAULT 'manual',
      ref_id VARCHAR(255),
      ref_type VARCHAR(50),
      metadata JSON,
      is_internal TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_ct_customer (customer_id),
      KEY idx_ct_brand (brand_id),
      KEY idx_ct_event_type (event_type),
      KEY idx_ct_created_at (created_at),
      KEY idx_ct_ref (ref_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeline_milestones (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      milestone_type VARCHAR(100) NOT NULL,
      label VARCHAR(255) NOT NULL,
      icon VARCHAR(10) DEFAULT '🏆',
      achieved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata JSON,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      KEY idx_tm_customer (customer_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeline_insights (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      insight_type VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      is_ai_generated TINYINT(1) NOT NULL DEFAULT 0,
      generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      KEY idx_ti_customer (customer_id)
    )
  `);

  // ─── Intelligent Follow-up & Workflow Automation Engine (IFWAE) ──────────────

  await pool.query(`
    CREATE TABLE IF NOT EXISTS followup_categories (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      group_name VARCHAR(100) NOT NULL,
      default_priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      default_sla_hours INT NOT NULL DEFAULT 24,
      icon VARCHAR(10) DEFAULT '📋',
      color VARCHAR(20) DEFAULT '#6B7280',
      is_active TINYINT(1) NOT NULL DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_followups (
      id VARCHAR(255) PRIMARY KEY,
      customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255),
      category_id VARCHAR(100),
      assigned_agent_id VARCHAR(255),
      related_order_id VARCHAR(255),
      related_ticket_id VARCHAR(255),
      related_opportunity_id VARCHAR(255),
      title VARCHAR(500) NOT NULL,
      description TEXT,
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      priority_score INT NOT NULL DEFAULT 50,
      status VARCHAR(50) NOT NULL DEFAULT 'scheduled',
      due_at DATETIME NOT NULL,
      reminder_at DATETIME,
      outcome VARCHAR(100),
      outcome_notes TEXT,
      reschedule_reason TEXT,
      escalation_level INT NOT NULL DEFAULT 0,
      source VARCHAR(100) NOT NULL DEFAULT 'manual',
      created_by_agent_id VARCHAR(255),
      completed_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      KEY idx_fup_customer (customer_id),
      KEY idx_fup_agent (assigned_agent_id),
      KEY idx_fup_status (status),
      KEY idx_fup_due_at (due_at),
      KEY idx_fup_brand (brand_id),
      KEY idx_fup_category (category_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS followup_reminders (
      id VARCHAR(255) PRIMARY KEY,
      followup_id VARCHAR(255) NOT NULL,
      remind_at DATETIME NOT NULL,
      channel VARCHAR(50) NOT NULL DEFAULT 'in_app',
      sent_at DATETIME,
      is_sent TINYINT(1) NOT NULL DEFAULT 0,
      FOREIGN KEY (followup_id) REFERENCES customer_followups(id) ON DELETE CASCADE,
      KEY idx_fr_followup (followup_id),
      KEY idx_fr_remind_at (remind_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      trigger_event VARCHAR(100) NOT NULL,
      conditions JSON,
      action_type VARCHAR(100) NOT NULL DEFAULT 'create_followup',
      action_config JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      priority_order INT NOT NULL DEFAULT 10,
      created_by VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_wr_trigger (trigger_event),
      KEY idx_wr_active (is_active)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS escalation_policies (
      id VARCHAR(255) PRIMARY KEY,
      category_id VARCHAR(100),
      name VARCHAR(255) NOT NULL,
      overdue_hours_l1 INT NOT NULL DEFAULT 4,
      overdue_hours_l2 INT NOT NULL DEFAULT 12,
      overdue_hours_l3 INT NOT NULL DEFAULT 24,
      is_active TINYINT(1) NOT NULL DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS escalation_log (
      id VARCHAR(255) PRIMARY KEY,
      followup_id VARCHAR(255) NOT NULL,
      from_agent_id VARCHAR(255),
      to_agent_id VARCHAR(255),
      escalation_level INT NOT NULL,
      reason VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (followup_id) REFERENCES customer_followups(id) ON DELETE CASCADE,
      KEY idx_el_followup (followup_id),
      KEY idx_el_created (created_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_audit_log (
      id VARCHAR(255) PRIMARY KEY,
      followup_id VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255),
      action VARCHAR(100) NOT NULL,
      old_status VARCHAR(50),
      new_status VARCHAR(50),
      notes TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_wal_followup (followup_id),
      KEY idx_wal_created (created_at)
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
  // ── IFWAE: customer_followups — migrate old table to new schema ──────────────
  // The old table only had: id, customer_id, assigned_agent_id, due_date, reason
  // CREATE TABLE IF NOT EXISTS silently skipped it; we must ALTER instead.
  const [fupCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_followups'"
  );
  const existingFupCols = fupCols.map((c) => c.COLUMN_NAME);
  const newFupCols = [
    ["brand_id", "VARCHAR(255)"],
    ["category_id", "VARCHAR(100)"],
    ["created_by_agent_id", "VARCHAR(255)"],
    ["related_order_id", "VARCHAR(255)"],
    ["related_ticket_id", "VARCHAR(255)"],
    ["related_opportunity_id", "VARCHAR(255)"],
    ["title", "VARCHAR(500) NOT NULL DEFAULT 'Follow-up'"],
    ["description", "TEXT"],
    ["priority", "VARCHAR(20) NOT NULL DEFAULT 'medium'"],
    ["priority_score", "INT NOT NULL DEFAULT 50"],
    ["status", "VARCHAR(50) NOT NULL DEFAULT 'scheduled'"],
    ["due_at", "DATETIME"],
    ["reminder_at", "DATETIME"],
    ["outcome", "VARCHAR(100)"],
    ["outcome_notes", "TEXT"],
    ["reschedule_reason", "TEXT"],
    ["escalation_level", "INT NOT NULL DEFAULT 0"],
    ["source", "VARCHAR(100) NOT NULL DEFAULT 'manual'"],
    ["completed_at", "DATETIME"],
    ["updated_at", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"],
  ];
  for (const [col, type] of newFupCols) {
    if (!existingFupCols.includes(col)) {
      await pool.query(`ALTER TABLE customer_followups ADD COLUMN ${col} ${type}`);
    }
  }
  // Backfill due_at from old due_date column if it exists and due_at is empty
  if (existingFupCols.includes("due_date") && !existingFupCols.includes("due_at")) {
    await pool.query("UPDATE customer_followups SET due_at = due_date WHERE due_at IS NULL AND due_date IS NOT NULL").catch(() => { });
  }
  // Backfill title from old reason column if it exists
  if (existingFupCols.includes("reason")) {
    await pool.query("UPDATE customer_followups SET title = COALESCE(reason, 'Follow-up') WHERE title = 'Follow-up' OR title IS NULL").catch(() => { });
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
  await pool.query(`DELETE FROM revoked_tokens WHERE expires_at < NOW()`).catch(() => { });

  // Seed CS Queue categories
  const csQueues = [
    { id: "csq_ctwa", name: "CTWA Leads", category: "sales", sla_minutes: 15, priority_base: 1, icon: "MessageSquare", color: "#EF4444" },
    { id: "csq_abandoned_cart", name: "Abandoned Cart", category: "sales", sla_minutes: 30, priority_base: 1, icon: "ShoppingCart", color: "#EF4444" },
    { id: "csq_checkout_assist", name: "Checkout Assistance", category: "sales", sla_minutes: 60, priority_base: 2, icon: "CreditCard", color: "#F97316" },
    { id: "csq_upsell", name: "High Value Prospects", category: "sales", sla_minutes: 120, priority_base: 2, icon: "TrendingUp", color: "#F97316" },
    { id: "csq_delivered_fu", name: "Delivered Order Follow-up", category: "success", sla_minutes: 480, priority_base: 3, icon: "PackageCheck", color: "#EAB308" },
    { id: "csq_repeat_purchase", name: "Repeat Purchase Campaign", category: "success", sla_minutes: 1440, priority_base: 3, icon: "RefreshCw", color: "#EAB308" },
    { id: "csq_wellness", name: "Wellness Follow-up", category: "success", sla_minutes: 1440, priority_base: 4, icon: "Heart", color: "#22C55E" },
    { id: "csq_complaints", name: "Open Complaints", category: "support", sla_minutes: 60, priority_base: 1, icon: "AlertTriangle", color: "#EF4444" },
    { id: "csq_delivery_issue", name: "Delivery Issues", category: "support", sla_minutes: 120, priority_base: 2, icon: "Truck", color: "#F97316" },
    { id: "csq_refund", name: "Refund Requests", category: "support", sla_minutes: 1440, priority_base: 2, icon: "RotateCcw", color: "#F97316" },
    { id: "csq_rto_recovery", name: "RTO Recovery", category: "operations", sla_minutes: 720, priority_base: 2, icon: "PackageX", color: "#F97316" },
    { id: "csq_address_verify", name: "Address Verification", category: "operations", sla_minutes: 240, priority_base: 3, icon: "MapPin", color: "#EAB308" },
    { id: "csq_dormant", name: "Dormant Customers", category: "retention", sla_minutes: 4320, priority_base: 4, icon: "Users", color: "#8B5CF6" },
    { id: "csq_vip", name: "VIP Customers", category: "retention", sla_minutes: 60, priority_base: 1, icon: "Star", color: "#EF4444" },
  ];
  for (const q of csQueues) {
    await pool.query(
      `INSERT IGNORE INTO cs_queues (id, name, category, sla_minutes, priority_base, icon, color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [q.id, q.name, q.category, q.sla_minutes, q.priority_base, q.icon, q.color]
    );
  }

  // Seed default opportunity pipeline stages
  const oppStages = [
    { id: "stage_new_lead", name: "New Lead", sort_order: 1, color: "#6B7280", is_won: 0, is_lost: 0 },
    { id: "stage_contact_attempt", name: "Contact Attempted", sort_order: 2, color: "#3B82F6", is_won: 0, is_lost: 0 },
    { id: "stage_connected", name: "Connected", sort_order: 3, color: "#8B5CF6", is_won: 0, is_lost: 0 },
    { id: "stage_interested", name: "Interested", sort_order: 4, color: "#F59E0B", is_won: 0, is_lost: 0 },
    { id: "stage_consultation", name: "Product Consultation", sort_order: 5, color: "#F97316", is_won: 0, is_lost: 0 },
    { id: "stage_payment_link", name: "Payment Link Shared", sort_order: 6, color: "#EC4899", is_won: 0, is_lost: 0 },
    { id: "stage_order_placed", name: "Order Placed", sort_order: 7, color: "#10B981", is_won: 0, is_lost: 0 },
    { id: "stage_won", name: "Won", sort_order: 8, color: "#16A34A", is_won: 1, is_lost: 0 },
    { id: "stage_lost", name: "Lost", sort_order: 9, color: "#DC2626", is_won: 0, is_lost: 1 },
  ];
  for (const s of oppStages) {
    await pool.query(
      `INSERT IGNORE INTO opportunity_stages (id, name, sort_order, color, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?)`,
      [s.id, s.name, s.sort_order, s.color, s.is_won, s.is_lost]
    );
  }

  // Seed Timeline Event Types
  const timelineEventTypes = [
    // Customer events
    { id: "customer_registered", category: "customer", label: "Customer Registered", icon: "🆕", color: "#6D28D9" },
    { id: "profile_updated", category: "customer", label: "Profile Updated", icon: "✏️", color: "#7C3AED" },
    { id: "address_updated", category: "customer", label: "Address Updated", icon: "📍", color: "#7C3AED" },
    // Order events
    { id: "order_created", category: "order", label: "Order Created", icon: "🛒", color: "#2563EB" },
    { id: "payment_successful", category: "order", label: "Payment Successful", icon: "💳", color: "#16A34A" },
    { id: "payment_failed", category: "order", label: "Payment Failed", icon: "❌", color: "#DC2626" },
    { id: "order_confirmed", category: "order", label: "Order Confirmed", icon: "✅", color: "#2563EB" },
    { id: "order_shipped", category: "order", label: "Order Shipped", icon: "📦", color: "#7C3AED" },
    { id: "out_for_delivery", category: "order", label: "Out for Delivery", icon: "🚚", color: "#D97706" },
    { id: "delivered", category: "order", label: "Delivered", icon: "🎉", color: "#16A34A" },
    { id: "order_cancelled", category: "order", label: "Order Cancelled", icon: "🚫", color: "#DC2626" },
    // Sales events
    { id: "ctwa_submitted", category: "sales", label: "CTWA Submitted", icon: "📲", color: "#059669" },
    { id: "abandoned_cart", category: "sales", label: "Abandoned Cart", icon: "🛍️", color: "#D97706" },
    { id: "payment_link_sent", category: "sales", label: "Payment Link Sent", icon: "🔗", color: "#059669" },
    { id: "offer_shared", category: "sales", label: "Offer Shared", icon: "🎁", color: "#059669" },
    { id: "opportunity_created", category: "sales", label: "Opportunity Created", icon: "💡", color: "#059669" },
    { id: "stage_change", category: "sales", label: "Stage Changed", icon: "➡️", color: "#0891B2" },
    { id: "deal_won", category: "sales", label: "Deal Won", icon: "🏆", color: "#16A34A" },
    { id: "deal_lost", category: "sales", label: "Deal Lost", icon: "😞", color: "#DC2626" },
    // Call events
    { id: "call_incoming", category: "call", label: "Incoming Call", icon: "📞", color: "#2563EB" },
    { id: "call_outgoing", category: "call", label: "Outgoing Call", icon: "📲", color: "#0891B2" },
    { id: "call_missed", category: "call", label: "Missed Call", icon: "📵", color: "#DC2626" },
    { id: "call_completed", category: "call", label: "Call Completed", icon: "✅", color: "#0891B2" },
    { id: "followup_scheduled", category: "call", label: "Follow-up Scheduled", icon: "📅", color: "#7C3AED" },
    // Support events
    { id: "ticket_created", category: "support", label: "Ticket Created", icon: "🎫", color: "#DC2626" },
    { id: "ticket_assigned", category: "support", label: "Ticket Assigned", icon: "👤", color: "#D97706" },
    { id: "ticket_escalated", category: "support", label: "Ticket Escalated", icon: "⚠️", color: "#DC2626" },
    { id: "ticket_resolved", category: "support", label: "Ticket Resolved", icon: "✅", color: "#16A34A" },
    { id: "refund_requested", category: "support", label: "Refund Requested", icon: "↩️", color: "#D97706" },
    { id: "refund_approved", category: "support", label: "Refund Approved", icon: "💚", color: "#16A34A" },
    { id: "complaint_registered", category: "support", label: "Complaint Registered", icon: "😤", color: "#DC2626" },
    // Internal
    { id: "internal_note", category: "internal", label: "Internal Note", icon: "🔒", color: "#92400E" },
  ];
  for (const t of timelineEventTypes) {
    await pool.query(
      `INSERT IGNORE INTO timeline_event_types (id, category, label, icon, color) VALUES (?, ?, ?, ?, ?)`,
      [t.id, t.category, t.label, t.icon, t.color]
    );
  }

  // ── Seed Follow-up Categories ────────────────────────────────────────────────
  const followupCats = [
    // Sales
    { id: "fcat_abandoned_cart", name: "Abandoned Cart", group_name: "sales", default_priority: "high", default_sla_hours: 4, icon: "🛒", color: "#DC2626" },
    { id: "fcat_ctwa_lead", name: "CTWA Lead", group_name: "sales", default_priority: "high", default_sla_hours: 1, icon: "💬", color: "#DC2626" },
    { id: "fcat_payment_pending", name: "Payment Pending", group_name: "sales", default_priority: "high", default_sla_hours: 2, icon: "💳", color: "#F97316" },
    { id: "fcat_consultation", name: "Product Consultation", group_name: "sales", default_priority: "medium", default_sla_hours: 12, icon: "🧪", color: "#7C3AED" },
    { id: "fcat_offer_reminder", name: "Offer Reminder", group_name: "sales", default_priority: "medium", default_sla_hours: 24, icon: "🎁", color: "#059669" },
    { id: "fcat_high_value_lead", name: "High Value Lead", group_name: "sales", default_priority: "critical", default_sla_hours: 1, icon: "💎", color: "#DC2626" },
    // Customer Success
    { id: "fcat_delivered_fu", name: "Delivered Order Follow-up", group_name: "success", default_priority: "medium", default_sla_hours: 48, icon: "📦", color: "#059669" },
    { id: "fcat_repeat_purchase", name: "Repeat Purchase", group_name: "success", default_priority: "medium", default_sla_hours: 72, icon: "🔄", color: "#059669" },
    { id: "fcat_review_request", name: "Review Request", group_name: "success", default_priority: "low", default_sla_hours: 120, icon: "⭐", color: "#D97706" },
    { id: "fcat_wellness_check", name: "Wellness Check", group_name: "success", default_priority: "low", default_sla_hours: 168, icon: "❤️", color: "#EC4899" },
    { id: "fcat_subscription", name: "Subscription Renewal", group_name: "success", default_priority: "high", default_sla_hours: 24, icon: "♻️", color: "#7C3AED" },
    // Support
    { id: "fcat_complaint", name: "Complaint Follow-up", group_name: "support", default_priority: "high", default_sla_hours: 8, icon: "😤", color: "#DC2626" },
    { id: "fcat_refund", name: "Refund Status", group_name: "support", default_priority: "high", default_sla_hours: 12, icon: "↩️", color: "#DC2626" },
    { id: "fcat_delivery_issue", name: "Delivery Issue", group_name: "support", default_priority: "high", default_sla_hours: 8, icon: "🚚", color: "#F97316" },
    { id: "fcat_ticket_pending", name: "Ticket Pending", group_name: "support", default_priority: "medium", default_sla_hours: 24, icon: "🎫", color: "#F97316" },
    // Operations
    { id: "fcat_rto_recovery", name: "RTO Recovery", group_name: "operations", default_priority: "high", default_sla_hours: 12, icon: "📦", color: "#F97316" },
    { id: "fcat_address_verify", name: "Address Verification", group_name: "operations", default_priority: "high", default_sla_hours: 4, icon: "📍", color: "#D97706" },
    { id: "fcat_payment_confirm", name: "Payment Confirmation", group_name: "operations", default_priority: "high", default_sla_hours: 2, icon: "✅", color: "#059669" },
    // Internal
    { id: "fcat_manager_review", name: "Manager Review", group_name: "internal", default_priority: "medium", default_sla_hours: 24, icon: "👔", color: "#6B7280" },
    { id: "fcat_quality_audit", name: "Quality Audit", group_name: "internal", default_priority: "low", default_sla_hours: 72, icon: "🔍", color: "#6B7280" },
  ];
  for (const c of followupCats) {
    await pool.query(
      `INSERT IGNORE INTO followup_categories (id, name, group_name, default_priority, default_sla_hours, icon, color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.name, c.group_name, c.default_priority, c.default_sla_hours, c.icon, c.color]
    );
  }

  // ── Seed Default Escalation Policies ─────────────────────────────────────────
  const escalationPolicies = [
    { id: "esc_default", category_id: null, name: "Default Policy", overdue_hours_l1: 4, overdue_hours_l2: 12, overdue_hours_l3: 24 },
    { id: "esc_critical", category_id: "fcat_ctwa_lead", name: "CTWA Critical", overdue_hours_l1: 1, overdue_hours_l2: 3, overdue_hours_l3: 8 },
    { id: "esc_sales", category_id: "fcat_abandoned_cart", name: "Abandoned Cart", overdue_hours_l1: 2, overdue_hours_l2: 6, overdue_hours_l3: 12 },
    { id: "esc_support", category_id: "fcat_complaint", name: "Complaint Policy", overdue_hours_l1: 2, overdue_hours_l2: 6, overdue_hours_l3: 12 },
    { id: "esc_refund", category_id: "fcat_refund", name: "Refund Policy", overdue_hours_l1: 4, overdue_hours_l2: 12, overdue_hours_l3: 24 },
  ];
  for (const p of escalationPolicies) {
    await pool.query(
      `INSERT IGNORE INTO escalation_policies (id, category_id, name, overdue_hours_l1, overdue_hours_l2, overdue_hours_l3) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, p.category_id, p.name, p.overdue_hours_l1, p.overdue_hours_l2, p.overdue_hours_l3]
    );
  }

  // ── Seed Default Workflow Rules ───────────────────────────────────────────────
  const defaultRules = [
    {
      id: "wr_cart_abandoned",
      name: "Abandoned Cart → Immediate Follow-up",
      trigger_event: "cart_abandoned",
      conditions: null,
      action_config: { category_id: "fcat_abandoned_cart", title: "Abandoned Cart Recovery", delay_hours: 0, priority: "high" },
    },
    {
      id: "wr_cart_retry_24h",
      name: "Abandoned Cart → 24h Retry",
      trigger_event: "cart_abandoned",
      conditions: null,
      action_config: { category_id: "fcat_abandoned_cart", title: "Cart Recovery Retry (24h)", delay_hours: 24, priority: "medium" },
    },
    {
      id: "wr_call_no_answer",
      name: "No Answer → Retry Follow-up",
      trigger_event: "call_no_answer",
      conditions: null,
      action_config: { category_id: "fcat_ctwa_lead", title: "Call Retry — No Answer", delay_hours: 2, priority: "high" },
    },
    {
      id: "wr_ticket_complaint",
      name: "Complaint Ticket → Daily Follow-up",
      trigger_event: "ticket_created",
      conditions: { priority: "high" },
      action_config: { category_id: "fcat_complaint", title: "Complaint Follow-up", delay_hours: 4, priority: "high" },
    },
    {
      id: "wr_order_delivered",
      name: "Order Delivered → Repeat Purchase Follow-up",
      trigger_event: "order_delivered",
      conditions: null,
      action_config: { category_id: "fcat_delivered_fu", title: "Post-Delivery Check-in", delay_hours: 48, priority: "medium" },
    },
    {
      id: "wr_payment_link",
      name: "Payment Link Sent → Payment Pending Follow-up",
      trigger_event: "payment_link_sent",
      conditions: null,
      action_config: { category_id: "fcat_payment_pending", title: "Payment Pending Reminder", delay_hours: 2, priority: "high" },
    },
    {
      id: "wr_opportunity_created",
      name: "New Opportunity → Consultation Follow-up",
      trigger_event: "opportunity_created",
      conditions: null,
      action_config: { category_id: "fcat_consultation", title: "Product Consultation Follow-up", delay_hours: 1, priority: "medium" },
    },
  ];
  for (const r of defaultRules) {
    await pool.query(
      `INSERT IGNORE INTO workflow_rules (id, name, trigger_event, conditions, action_config, priority_order) VALUES (?, ?, ?, ?, ?, ?)`,
      [r.id, r.name, r.trigger_event, r.conditions ? JSON.stringify(r.conditions) : null, JSON.stringify(r.action_config), 10]
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

// ─── Shopify Integration Schema ─────────────────────────────────────────────
export async function initShopifySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_stores (
      id VARCHAR(255) PRIMARY KEY,
      brand_id VARCHAR(255) NOT NULL,
      store_url VARCHAR(255) NOT NULL,
      access_token VARCHAR(255) NOT NULL,
      webhook_secret VARCHAR(255),
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_sync_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_customers (
      id VARCHAR(255) PRIMARY KEY,
      crm_customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(255),
      state VARCHAR(50),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (crm_customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      KEY idx_shopify_cust_crm (crm_customer_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_orders (
      id VARCHAR(255) PRIMARY KEY,
      crm_customer_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255) NOT NULL,
      order_number VARCHAR(100) NOT NULL,
      total_price DOUBLE,
      currency VARCHAR(10),
      financial_status VARCHAR(50),
      fulfillment_status VARCHAR(50),
      tags TEXT,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY (crm_customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_order_items (
      id VARCHAR(255) PRIMARY KEY,
      order_id VARCHAR(255) NOT NULL,
      product_id VARCHAR(255),
      variant_id VARCHAR(255),
      sku VARCHAR(255),
      name TEXT,
      quantity INT,
      price DOUBLE,
      FOREIGN KEY (order_id) REFERENCES shopify_orders(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_products (
      id VARCHAR(255) PRIMARY KEY,
      brand_id VARCHAR(255) NOT NULL,
      title TEXT NOT NULL,
      handle VARCHAR(255),
      status VARCHAR(50),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_variants (
      id VARCHAR(255) PRIMARY KEY,
      product_id VARCHAR(255) NOT NULL,
      sku VARCHAR(255),
      price DOUBLE,
      compare_at_price DOUBLE,
      inventory_quantity INT,
      FOREIGN KEY (product_id) REFERENCES shopify_products(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_sync_logs (
      id VARCHAR(255) PRIMARY KEY,
      store_id VARCHAR(255) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL,
      records_processed INT DEFAULT 0,
      records_failed INT DEFAULT 0,
      error_message TEXT,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (store_id) REFERENCES shopify_stores(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_event_queue (
      id VARCHAR(255) PRIMARY KEY,
      store_id VARCHAR(255) NOT NULL,
      topic VARCHAR(100) NOT NULL,
      payload MEDIUMTEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      retry_count INT DEFAULT 0,
      error_message TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (store_id) REFERENCES shopify_stores(id) ON DELETE CASCADE,
      KEY idx_shopify_eq_status (status)
    )
  `);

  // Add missing columns if they don't exist
  try {
    const [shopCols] = await pool.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shopify_stores'"
    );
    const existingShopCols = shopCols.map((c) => c.COLUMN_NAME);
    
    if (!existingShopCols.includes('last_sync_at')) {
      await pool.query(`ALTER TABLE shopify_stores ADD COLUMN last_sync_at DATETIME`);
    }
  } catch (err) {
    console.error("Error updating shopify_stores table:", err);
  }
}

export async function initKnowledgeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eklh_categories (
      id VARCHAR(255) PRIMARY KEY,
      parent_id VARCHAR(255) DEFAULT NULL,
      brand_id VARCHAR(255) DEFAULT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES eklh_categories(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS eklh_articles (
      id VARCHAR(255) PRIMARY KEY,
      category_id VARCHAR(255) NOT NULL,
      brand_id VARCHAR(255) DEFAULT NULL,
      department VARCHAR(100) DEFAULT NULL,
      title VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      author_id VARCHAR(255) NOT NULL,
      reviewer_id VARCHAR(255) DEFAULT NULL,
      effective_date DATETIME DEFAULT NULL,
      summary TEXT,
      views INT DEFAULT 0,
      rating_score FLOAT DEFAULT 0,
      rating_count INT DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES eklh_categories(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL,
      FOREIGN KEY (author_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES agents(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS eklh_article_versions (
      id VARCHAR(255) PRIMARY KEY,
      article_id VARCHAR(255) NOT NULL,
      version_num INT NOT NULL,
      content MEDIUMTEXT NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (article_id) REFERENCES eklh_articles(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES agents(id) ON DELETE CASCADE,
      UNIQUE KEY unique_version (article_id, version_num)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS eklh_article_tags (
      article_id VARCHAR(255) NOT NULL,
      tag VARCHAR(100) NOT NULL,
      PRIMARY KEY (article_id, tag),
      FOREIGN KEY (article_id) REFERENCES eklh_articles(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS eklh_learning_progress (
      user_id VARCHAR(255) NOT NULL,
      article_id VARCHAR(255) NOT NULL,
      completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, article_id),
      FOREIGN KEY (user_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (article_id) REFERENCES eklh_articles(id) ON DELETE CASCADE
    )
  `);
}

export async function initBISchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bi_dashboards (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      role_type VARCHAR(50) NOT NULL,
      brand_id VARCHAR(255) DEFAULT NULL,
      is_default BOOLEAN DEFAULT false,
      layout_config JSON,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bi_widgets (
      id VARCHAR(255) PRIMARY KEY,
      dashboard_id VARCHAR(255) NOT NULL,
      kpi_id VARCHAR(100) NOT NULL,
      title VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      grid_w INT DEFAULT 1,
      grid_h INT DEFAULT 1,
      grid_x INT DEFAULT 0,
      grid_y INT DEFAULT 0,
      config JSON,
      FOREIGN KEY (dashboard_id) REFERENCES bi_dashboards(id) ON DELETE CASCADE
    )
  `);

  // Seed default dashboards if they don't exist
  const count = await db.get("SELECT COUNT(*) as c FROM bi_dashboards");
  if (count.c === 0) {
    const execDashId = "dash_exec_01";
    await pool.query(
      "INSERT INTO bi_dashboards (id, name, role_type, is_default) VALUES (?, ?, ?, ?)",
      [execDashId, "Executive Overview", "admin", true]
    );

    // Seed some standard Executive widgets
    const execWidgets = [
      ["wid_01", execDashId, "revenue_today", "Today's Revenue", "kpi_card", 1, 1, 0, 0],
      ["wid_02", execDashId, "orders_today", "Orders Today", "kpi_card", 1, 1, 1, 0],
      ["wid_03", execDashId, "csat_score", "Customer Satisfaction", "kpi_card", 1, 1, 2, 0],
      ["wid_04", execDashId, "open_cases", "Open Cases", "kpi_card", 1, 1, 3, 0],
      ["wid_05", execDashId, "revenue_trend", "Revenue Trend (Last 7 Days)", "line_chart", 2, 2, 0, 1],
      ["wid_06", execDashId, "revenue_by_brand", "Revenue by Brand", "pie_chart", 1, 2, 2, 1],
      ["wid_07", execDashId, "agent_leaderboard", "Agent Leaderboard", "leaderboard", 1, 2, 3, 1]
    ];

    for (const w of execWidgets) {
      await pool.query(
        "INSERT INTO bi_widgets (id, dashboard_id, kpi_id, title, type, grid_w, grid_h, grid_x, grid_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        w
      );
    }

    const cseDashId = "dash_cse_01";
    await pool.query(
      "INSERT INTO bi_dashboards (id, name, role_type, is_default) VALUES (?, ?, ?, ?)",
      [cseDashId, "Agent Workspace", "agent", true]
    );

    const cseWidgets = [
      ["wid_11", cseDashId, "my_calls_assigned", "Calls Assigned", "kpi_card", 1, 1, 0, 0],
      ["wid_12", cseDashId, "my_calls_completed", "Calls Completed", "kpi_card", 1, 1, 1, 0],
      ["wid_13", cseDashId, "my_revenue", "My Revenue", "kpi_card", 1, 1, 2, 0],
      ["wid_14", cseDashId, "my_open_cases", "My Open Cases", "kpi_card", 1, 1, 3, 0],
      ["wid_15", cseDashId, "my_quick_actions", "Quick Actions", "action_panel", 4, 1, 0, 1]
    ];

    for (const w of cseWidgets) {
      await pool.query(
        "INSERT INTO bi_widgets (id, dashboard_id, kpi_id, title, type, grid_w, grid_h, grid_x, grid_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        w
      );
    }
  }
}

export async function initRADIPSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS radip_reports (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      type VARCHAR(50) NOT NULL,
      category VARCHAR(100) NOT NULL,
      query_config JSON,
      owner_id VARCHAR(255),
      brand_id VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radip_report_schedules (
      id VARCHAR(255) PRIMARY KEY,
      report_id VARCHAR(255) NOT NULL,
      frequency VARCHAR(50) NOT NULL,
      format VARCHAR(20) NOT NULL DEFAULT 'csv',
      recipients JSON NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES radip_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radip_kpi_history (
      id VARCHAR(255) PRIMARY KEY,
      date DATE NOT NULL,
      brand_id VARCHAR(255),
      kpi_key VARCHAR(100) NOT NULL,
      value DECIMAL(15,2) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radip_export_history (
      id VARCHAR(255) PRIMARY KEY,
      report_id VARCHAR(255) NOT NULL,
      format VARCHAR(20) NOT NULL,
      exported_by VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (exported_by) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  const count = await db.get("SELECT COUNT(*) as c FROM radip_reports WHERE type = 'standard'");
  if (count.c === 0) {
    const stdReports = [
      ["std_01", "Revenue by Brand", "Breakdown of revenue across all brands.", "standard", "Executive", "{}"],
      ["std_02", "Agent Leaderboard", "Performance ranking of all agents by calls and revenue.", "standard", "Employee Performance", "{}"],
      ["std_03", "Open vs Closed Cases", "Historical comparison of case resolution.", "standard", "Customer Support", "{}"],
      ["std_04", "Sales Pipeline Report", "Overview of current sales opportunities and stages.", "standard", "Sales", "{}"],
      ["std_05", "Customer Lifetime Value", "Historical LTV analysis across brands.", "standard", "Customer Analytics", "{}"],
      ["std_06", "Abandoned Cart Recovery", "Recovery rates and generated revenue from abandoned carts.", "standard", "Customer Success", "{}"]
    ];

    for (const r of stdReports) {
      await pool.query(
        "INSERT INTO radip_reports (id, name, description, type, category, query_config) VALUES (?, ?, ?, ?, ?, ?)",
        r
      );
    }
  }
}

export async function initPIKFSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pikf_kpi_definitions (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      default_weight DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      metric_type VARCHAR(50) NOT NULL, -- e.g., 'currency', 'percentage', 'count'
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pikf_targets (
      id VARCHAR(255) PRIMARY KEY,
      kpi_id VARCHAR(255) NOT NULL,
      target_type VARCHAR(50) NOT NULL, -- 'individual', 'team', 'department', 'brand'
      target_entity_id VARCHAR(255) NOT NULL, -- agent_id, team_id, etc.
      period VARCHAR(50) NOT NULL, -- 'daily', 'weekly', 'monthly'
      target_value DECIMAL(15,2) NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (kpi_id) REFERENCES pikf_kpi_definitions(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pikf_performance_scores (
      id VARCHAR(255) PRIMARY KEY,
      agent_id VARCHAR(255) NOT NULL,
      date DATE NOT NULL,
      score DECIMAL(5,2) NOT NULL, -- 0 to 100
      breakdown JSON, -- Detailed breakdown of how the score was calculated based on weights
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pikf_badges (
      id VARCHAR(255) PRIMARY KEY,
      agent_id VARCHAR(255) NOT NULL,
      badge_name VARCHAR(255) NOT NULL,
      badge_type VARCHAR(50) NOT NULL, -- 'auto', 'manual'
      awarded_by VARCHAR(255), -- NULL if 'auto'
      reason TEXT,
      awarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (awarded_by) REFERENCES agents(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pikf_coaching_plans (
      id VARCHAR(255) PRIMARY KEY,
      agent_id VARCHAR(255) NOT NULL,
      manager_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'completed'
      reason TEXT NOT NULL,
      action_items TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (manager_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Seed standard KPIs with default weights
  const count = await db.get("SELECT COUNT(*) as c FROM pikf_kpi_definitions");
  if (count.c === 0) {
    const defaultKPIs = [
      ["kpi_revenue", "Revenue Achievement", "Total revenue generated vs target", 25.00, "currency"],
      ["kpi_conversion", "Conversion Rate", "Percentage of successful calls/opportunities", 15.00, "percentage"],
      ["kpi_csat", "Customer Satisfaction", "Average CSAT score from tickets", 15.00, "percentage"],
      ["kpi_followup", "Follow-up Compliance", "Percentage of follow-ups completed on time", 10.00, "percentage"],
      ["kpi_sla", "SLA Compliance", "Percentage of tickets resolved within SLA", 10.00, "percentage"],
      ["kpi_productivity", "Productivity", "Volume of tasks and calls completed", 10.00, "count"],
      ["kpi_quality", "Quality Score", "Manual QA score for interactions", 10.00, "percentage"],
      ["kpi_attendance", "Attendance", "Days present vs scheduled", 5.00, "percentage"]
    ];

    for (const kpi of defaultKPIs) {
      await pool.query(
        "INSERT INTO pikf_kpi_definitions (id, name, description, default_weight, metric_type) VALUES (?, ?, ?, ?, ?)",
        kpi
      );
    }
  }
}

export async function initBAWOESchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bawoe_workflows (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      trigger_event VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      brand_id VARCHAR(255),
      definition JSON NOT NULL,
      version INT DEFAULT 1,
      created_by VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bawoe_executions (
      id VARCHAR(255) PRIMARY KEY,
      workflow_id VARCHAR(255) NOT NULL,
      trigger_payload JSON,
      status VARCHAR(50) NOT NULL DEFAULT 'running',
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (workflow_id) REFERENCES bawoe_workflows(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bawoe_logs (
      id VARCHAR(255) PRIMARY KEY,
      execution_id VARCHAR(255) NOT NULL,
      node_id VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL,
      output_data JSON,
      error_message TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (execution_id) REFERENCES bawoe_executions(id) ON DELETE CASCADE
    )
  `);

  const count = await db.get("SELECT COUNT(*) as c FROM bawoe_workflows");
  if (count.c === 0) {
    const defaultDefinition = {
      nodes: [
        { id: "1", type: "trigger", data: { event: "order_delivered" } },
        { id: "2", type: "condition", data: { field: "brand_id", operator: "==", value: "brd_cureka" } },
        { id: "3", type: "action", data: { action: "CREATE_FOLLOWUP", payload: { reason: "Post-Purchase Check-in", priority: "normal", days: 7 } } }
      ],
      edges: [
        { id: "e1-2", source: "1", target: "2" },
        { id: "e2-3", source: "2", target: "3", sourceHandle: "true" }
      ]
    };

    const admin = await db.get("SELECT id FROM agents WHERE role = 'admin' LIMIT 1");
    if (admin) {
      await pool.query(
        "INSERT INTO bawoe_workflows (id, name, description, trigger_event, status, brand_id, definition, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "wf_01",
          "Post-Purchase Check-in (Cureka)",
          "Automatically schedules a follow-up call 7 days after delivery.",
          "order_delivered",
          "active",
          null,
          JSON.stringify(defaultDefinition),
          admin.id
        ]
      );
    }
  }
}

export async function initUNCCSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uncc_notifications (
      id VARCHAR(255) PRIMARY KEY,
      assigned_to VARCHAR(255) NOT NULL, -- User ID
      brand_id VARCHAR(255),
      category VARCHAR(100) NOT NULL, -- 'Customer', 'Sales', 'Support', 'Operations', 'Workflow', 'Performance', 'System'
      priority VARCHAR(20) NOT NULL, -- 'Critical', 'High', 'Medium', 'Low'
      message TEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'unread', -- 'unread', 'read', 'completed', 'archived'
      action_type VARCHAR(100), -- E.g., 'APPROVE_REFUND', 'CALL_CUSTOMER'
      context_data JSON, -- Stores IDs like order_id, ticket_id, customer_id
      created_by VARCHAR(255), -- System or User ID
      due_at DATETIME,
      read_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_to) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    )
  `);

  // Seed default notifications for testing
  const count = await db.get("SELECT COUNT(*) as c FROM uncc_notifications");
  if (count.c === 0) {
    const admin = await db.get("SELECT id FROM agents WHERE role = 'admin' LIMIT 1");
    if (admin) {
      await pool.query(
        "INSERT INTO uncc_notifications (id, assigned_to, category, priority, message, status, action_type, context_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          `notif_${Date.now()}_1`,
          admin.id,
          'Sales',
          'High',
          '10 Abandoned Carts require follow-up',
          'unread',
          'VIEW_CARTS',
          JSON.stringify({ group_count: 10, brand_id: 'brd_cureka' })
        ]
      );

      await pool.query(
        "INSERT INTO uncc_notifications (id, assigned_to, category, priority, message, status, action_type, context_data, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 2 HOUR))",
        [
          `notif_${Date.now()}_2`,
          admin.id,
          'Operations',
          'Critical',
          'Refund Approval Pending for Order #1042',
          'unread',
          'APPROVE_REFUND',
          JSON.stringify({ order_id: 'ord_1042', customer_id: 'cust_01' })
        ]
      );
    }
  }
}

export async function initESCAMSSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS escams_audit_logs (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255),
      user_name VARCHAR(255),
      role VARCHAR(50),
      brand_id VARCHAR(255),
      module VARCHAR(100) NOT NULL,
      action VARCHAR(100) NOT NULL,
      entity VARCHAR(100),
      entity_id VARCHAR(255),
      old_value JSON,
      new_value JSON,
      ip_address VARCHAR(100),
      device VARCHAR(255),
      browser VARCHAR(255),
      session_id VARCHAR(255),
      status VARCHAR(20) DEFAULT 'SUCCESS',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS escams_sessions (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      login_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(100),
      device VARCHAR(255),
      browser VARCHAR(255),
      status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, TERMINATED, EXPIRED
      terminated_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS escams_alerts (
      id VARCHAR(255) PRIMARY KEY,
      type VARCHAR(100) NOT NULL,
      severity VARCHAR(20) NOT NULL, -- CRITICAL, HIGH, MEDIUM, LOW
      message TEXT NOT NULL,
      resolved TINYINT(1) DEFAULT 0,
      resolved_by VARCHAR(255),
      resolved_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (resolved_by) REFERENCES agents(id) ON DELETE SET NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS escams_revoked_tokens (
      token VARCHAR(500) PRIMARY KEY,
      revoked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason VARCHAR(255),
      user_id VARCHAR(255),
      FOREIGN KEY (user_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);
}
