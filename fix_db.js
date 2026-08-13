import 'dotenv/config';
import { db } from './src/db/connection.js';

async function fixTable() {
  try {
    await db.run('DROP TABLE IF EXISTS shopify_sync_logs');
    console.log('Dropped shopify_sync_logs');
    await db.run(`
      CREATE TABLE shopify_sync_logs (
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
    console.log('Created shopify_sync_logs with correct schema');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixTable();
