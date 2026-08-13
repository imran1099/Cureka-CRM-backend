import 'dotenv/config';
import { db } from './src/db/connection.js';

async function inspect() {
  try {
    const storesCols = await db.all('DESCRIBE shopify_stores');
    console.log('\n--- shopify_stores columns ---');
    storesCols.forEach(c => console.log(c.Field, '|', c.Type, '| Null:', c.Null));
    
    const syncLogsCols = await db.all('DESCRIBE shopify_sync_logs');
    console.log('\n--- shopify_sync_logs columns ---');
    syncLogsCols.forEach(c => console.log(c.Field, '|', c.Type, '| Null:', c.Null));

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
inspect();
