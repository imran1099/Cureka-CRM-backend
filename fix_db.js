import 'dotenv/config';
import { db } from './src/db/connection.js';

async function fixTable() {
  try {
    await db.run('DROP TABLE IF EXISTS shopify_sync_logs');
    console.log('Dropped shopify_sync_logs');
    await db.run(`
      CREATE TABLE shopify_sync_logs (
        id VARCHAR(255) PRIMARY KEY,
        brand_id VARCHAR(255),
        sync_type VARCHAR(50),
        status VARCHAR(50),
        records_processed INT DEFAULT 0,
        records_failed INT NOT NULL DEFAULT 0,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        error_message TEXT
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
