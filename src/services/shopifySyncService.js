import { db } from "../db/connection.js";
import { nanoid } from "nanoid";
import { createTimelineEvent } from "./timelineService.js";

/**
 * Syncs a Shopify customer into the CRM.
 * Resolves duplicates by (1) Shopify ID, (2) Email, (3) Phone.
 */
export async function syncCustomer(storeId, shopifyCustomer, brandId) {
  if (!shopifyCustomer || !shopifyCustomer.id) return null;

  const shopifyId = String(shopifyCustomer.id);
  const email = shopifyCustomer.email?.toLowerCase().trim() || null;
  
  // Format phone number (e.g. basic clean up for matching)
  let phone = shopifyCustomer.phone || null;
  if (shopifyCustomer.default_address && shopifyCustomer.default_address.phone) {
    phone = shopifyCustomer.default_address.phone;
  }
  if (phone) phone = phone.replace(/\s+/g, '');

  let crmCustomerId = null;

  // 1. Match by Shopify ID
  const existingMapping = await db.get("SELECT crm_customer_id FROM shopify_customers WHERE id = ?", shopifyId);
  
  if (existingMapping) {
    crmCustomerId = existingMapping.crm_customer_id;
  } else {
    // 2. Match by Email
    if (!crmCustomerId && email) {
      const byEmail = await db.get("SELECT id FROM customers WHERE email = ?", email);
      if (byEmail) crmCustomerId = byEmail.id;
    }
    // 3. Match by Phone
    if (!crmCustomerId && phone) {
      const byPhone = await db.get("SELECT id FROM customers WHERE phone = ?", phone);
      if (byPhone) crmCustomerId = byPhone.id;
    }
  }

  const name = `${shopifyCustomer.first_name || ''} ${shopifyCustomer.last_name || ''}`.trim() || 'Unknown Customer';
  const city = shopifyCustomer.default_address?.city || null;
  
  if (!crmCustomerId) {
    // Create new CRM customer
    crmCustomerId = "cust_" + nanoid(12);
    await db.run(
      `INSERT INTO customers (id, name, phone, email, city, segment, source, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, 'Lead', 'shopify', NOW(), NOW())`,
      crmCustomerId, name, phone || 'N/A', email, city
    );
    
    // Timeline event for new customer creation via Shopify
    await createTimelineEvent({
      customerId: crmCustomerId,
      eventType: "profile_updated",
      eventTitle: "Customer Created via Shopify",
      eventDescription: `Imported from Shopify (ID: ${shopifyId})`,
      sourceSystem: "shopify",
      brandId
    });
  } else {
    // Update existing CRM customer if missing critical details
    // We only update if phone or email is missing in CRM but present in Shopify
    await db.run(
      `UPDATE customers 
       SET email = COALESCE(email, ?), 
           phone = COALESCE(phone, ?),
           updated_at = NOW()
       WHERE id = ?`,
      email, phone || 'N/A', crmCustomerId
    );
  }

  // Upsert into shopify_customers mapping
  if (existingMapping) {
    await db.run(
      "UPDATE shopify_customers SET email = ?, phone = ?, updated_at = NOW() WHERE id = ?",
      email, phone, shopifyId
    );
  } else {
    await db.run(
      "INSERT INTO shopify_customers (id, crm_customer_id, brand_id, email, phone) VALUES (?, ?, ?, ?, ?)",
      shopifyId, crmCustomerId, brandId, email, phone
    );
  }

  // Link customer to brand in customer_brands
  const cbExists = await db.get("SELECT id FROM customer_brands WHERE customer_id = ? AND brand_id = ?", crmCustomerId, brandId);
  if (!cbExists) {
    await db.run(
      "INSERT INTO customer_brands (id, customer_id, brand_id, source) VALUES (?, ?, ?, 'shopify')",
      "cb_" + nanoid(10), crmCustomerId, brandId
    );
  }

  return crmCustomerId;
}

/**
 * Syncs a Shopify order and triggers CRM workflows.
 */
export async function syncOrder(storeId, shopifyOrder, brandId) {
  if (!shopifyOrder || !shopifyOrder.id) return null;

  const shopifyId = String(shopifyOrder.id);
  
  // 1. Ensure customer is synced
  const crmCustomerId = await syncCustomer(storeId, shopifyOrder.customer, brandId);
  if (!crmCustomerId) {
    console.warn(`Cannot sync order ${shopifyId}: No customer attached.`);
    return null;
  }

  const orderNumber = shopifyOrder.order_number || shopifyOrder.name;
  const totalPrice = parseFloat(shopifyOrder.total_price || 0);
  const currency = shopifyOrder.currency;
  const financialStatus = shopifyOrder.financial_status || 'pending';
  const fulfillmentStatus = shopifyOrder.fulfillment_status || 'unfulfilled';
  const tags = shopifyOrder.tags || '';
  const createdAt = new Date(shopifyOrder.created_at).toISOString().slice(0, 19).replace('T', ' ');
  const updatedAt = new Date(shopifyOrder.updated_at).toISOString().slice(0, 19).replace('T', ' ');

  const existingOrder = await db.get("SELECT id, financial_status, fulfillment_status FROM shopify_orders WHERE id = ?", shopifyId);

  let isNew = false;
  if (existingOrder) {
    await db.run(
      `UPDATE shopify_orders 
       SET total_price = ?, financial_status = ?, fulfillment_status = ?, tags = ?, updated_at = ?
       WHERE id = ?`,
      totalPrice, financialStatus, fulfillmentStatus, tags, updatedAt, shopifyId
    );
  } else {
    isNew = true;
    await db.run(
      `INSERT INTO shopify_orders 
       (id, crm_customer_id, brand_id, order_number, total_price, currency, financial_status, fulfillment_status, tags, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      shopifyId, crmCustomerId, brandId, orderNumber, totalPrice, currency, financialStatus, fulfillmentStatus, tags, createdAt, updatedAt
    );
  }

  // Sync line items (simplified to delete and recreate for ease)
  await db.run("DELETE FROM shopify_order_items WHERE order_id = ?", shopifyId);
  if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
    for (const item of shopifyOrder.line_items) {
      await db.run(
        `INSERT INTO shopify_order_items (id, order_id, product_id, variant_id, sku, name, quantity, price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        String(item.id), shopifyId, String(item.product_id), String(item.variant_id), item.sku || '', item.name || '', parseInt(item.quantity || 1), parseFloat(item.price || 0)
      );
    }
  }

  // Workflow & Timeline Triggers
  if (isNew) {
    await createTimelineEvent({
      customerId: crmCustomerId,
      eventType: "order_placed",
      eventTitle: `Order ${orderNumber} Placed`,
      eventDescription: `Total: ${totalPrice} ${currency}`,
      sourceSystem: "shopify",
      brandId
    });
    
    // Workflow: High Value Order
    if (totalPrice > 10000) {
       // Example integration trigger (would be hooked into the rules engine)
       // For now just add an internal note
       await createTimelineEvent({
         customerId: crmCustomerId,
         eventType: "internal_note",
         eventTitle: "High Value Order Detected",
         eventDescription: `Order ${orderNumber} requires VIP attention.`,
         isInternal: true,
         sourceSystem: "system",
         brandId
       });
    }
  }

  // Financial Status updates
  if (existingOrder && existingOrder.financial_status !== financialStatus && financialStatus === 'paid') {
    await createTimelineEvent({
      customerId: crmCustomerId,
      eventType: "payment_received",
      eventTitle: `Payment Received for Order ${orderNumber}`,
      sourceSystem: "shopify",
      brandId
    });
  }

  // Refund tracking
  if (financialStatus === 'refunded' || financialStatus === 'partially_refunded') {
    if (!existingOrder || (existingOrder.financial_status !== 'refunded' && existingOrder.financial_status !== 'partially_refunded')) {
      await createTimelineEvent({
        customerId: crmCustomerId,
        eventType: "refund_processed",
        eventTitle: `Refund Processed for Order ${orderNumber}`,
        sourceSystem: "shopify",
        brandId
      });
      // Optionally create a support ticket for the refund context
    }
  }

  return shopifyId;
}

/**
 * Syncs a Shopify Product.
 */
export async function syncProduct(storeId, shopifyProduct, brandId) {
  if (!shopifyProduct || !shopifyProduct.id) return null;
  const shopifyId = String(shopifyProduct.id);
  
  const existing = await db.get("SELECT id FROM shopify_products WHERE id = ?", shopifyId);
  const title = shopifyProduct.title || 'Untitled';
  const handle = shopifyProduct.handle || '';
  const status = shopifyProduct.status || 'active';

  if (existing) {
    await db.run(
      "UPDATE shopify_products SET title = ?, handle = ?, status = ?, updated_at = NOW() WHERE id = ?",
      title, handle, status, shopifyId
    );
  } else {
    await db.run(
      "INSERT INTO shopify_products (id, brand_id, title, handle, status) VALUES (?, ?, ?, ?, ?)",
      shopifyId, brandId, title, handle, status
    );
  }

  // Sync Variants
  if (shopifyProduct.variants) {
    for (const v of shopifyProduct.variants) {
      const vId = String(v.id);
      const sku = v.sku || '';
      const price = parseFloat(v.price || 0);
      const compareAtPrice = parseFloat(v.compare_at_price || 0);
      const inventory = parseInt(v.inventory_quantity || 0);
      
      const exV = await db.get("SELECT id FROM shopify_variants WHERE id = ?", vId);
      if (exV) {
        await db.run(
          "UPDATE shopify_variants SET sku = ?, price = ?, compare_at_price = ?, inventory_quantity = ? WHERE id = ?",
          sku, price, compareAtPrice, inventory, vId
        );
      } else {
        await db.run(
          "INSERT INTO shopify_variants (id, product_id, sku, price, compare_at_price, inventory_quantity) VALUES (?, ?, ?, ?, ?, ?)",
          vId, shopifyId, sku, price, compareAtPrice, inventory
        );
      }
    }
  }

  return shopifyId;
}
