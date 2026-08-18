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
  
  let phone = shopifyCustomer.phone || shopifyCustomer.default_address?.phone || null;
  if (phone) phone = phone.replace(/\\s+/g, '');

  let crmCustomerId = null;

  // 1. Match by Shopify ID on customers table
  const existingMapping = await db.get("SELECT id FROM customers WHERE shopify_customer_id = ?", shopifyId);
  
  if (existingMapping) {
    crmCustomerId = existingMapping.id;
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
      `INSERT INTO customers (id, name, phone, email, city, segment, source, shopify_customer_id, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, 'Lead', 'shopify', ?, NOW(), NOW())`,
      crmCustomerId, name, phone || 'N/A', email, city, shopifyId
    );
  } else {
    // Update existing CRM customer
    await db.run(
      `UPDATE customers 
       SET email = COALESCE(email, ?), 
           phone = COALESCE(phone, ?),
           shopify_customer_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      email, phone || 'N/A', shopifyId, crmCustomerId
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

  const orderDate = new Date(shopifyOrder.created_at || Date.now()).toISOString().slice(0, 19).replace('T', ' ');
  const orderNumber = shopifyOrder.order_number || shopifyOrder.name || shopifyId;
  const totalPrice = parseFloat(shopifyOrder.total_price || 0);
  const currency = shopifyOrder.currency || "INR";
  const financialStatus = shopifyOrder.financial_status || "pending";
  const fulfillmentStatus = shopifyOrder.fulfillment_status || "unfulfilled";
  const tags = shopifyOrder.tags || "";
  
  // Extract tracking number if available (from fulfillments)
  let trackingNumber = null;
  if (shopifyOrder.fulfillments && shopifyOrder.fulfillments.length > 0) {
    trackingNumber = shopifyOrder.fulfillments[0].tracking_number || shopifyOrder.fulfillments[0].tracking_company || null;
  }

  // 2. Upsert into shopify_orders
  const existingOrder = await db.get("SELECT id FROM shopify_orders WHERE id = ?", shopifyId);
  if (existingOrder) {
    await db.run(
      `UPDATE shopify_orders SET total_price = ?, currency = ?, financial_status = ?, fulfillment_status = ?, tags = ?, updated_at = NOW() WHERE id = ?`,
      totalPrice, currency, financialStatus, fulfillmentStatus, tags, shopifyId
    );
  } else {
    await db.run(
      `INSERT INTO shopify_orders (id, crm_customer_id, brand_id, order_number, total_price, currency, financial_status, fulfillment_status, tags, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      shopifyId, crmCustomerId, brandId, orderNumber, totalPrice, currency, financialStatus, fulfillmentStatus, tags, orderDate
    );
    
    // Add timeline event only for new orders
    await db.run(
      "INSERT INTO customer_timeline_events (id, customer_id, event_date, event_type, description) VALUES (?, ?, ?, ?, ?)",
      "te_" + nanoid(10), crmCustomerId, orderDate, "Order Placed", `Order #${orderNumber} placed via Shopify`
    );
  }

  if (!shopifyOrder.line_items || shopifyOrder.line_items.length === 0) {
    return shopifyId;
  }

  // 3. Upsert into shopify_order_items and purchase_history
  const incomingItemIds = shopifyOrder.line_items.map(item => String(item.id));

  // Remove items that are no longer in the order
  const currentItems = await db.all("SELECT id, shopify_line_item_id FROM purchase_history WHERE order_ref = ?", shopifyId);
  for (const row of currentItems) {
    if (!incomingItemIds.includes(row.shopify_line_item_id)) {
      await db.run("DELETE FROM purchase_history WHERE shopify_line_item_id = ?", row.shopify_line_item_id);
      await db.run("DELETE FROM shopify_order_items WHERE id = ?", row.shopify_line_item_id);
    }
  }

  for (const item of shopifyOrder.line_items) {
    const lineItemId = String(item.id);
    const productId = item.product_id ? String(item.product_id) : null;
    const variantId = item.variant_id ? String(item.variant_id) : null;
    const sku = item.sku || "";
    const productName = item.name || item.title || 'Unknown Product';
    const quantity = parseInt(item.quantity || 1);
    const amount = parseFloat(item.price || 0);

    // Upsert shopify_order_items
    const existingShopifyItem = await db.get("SELECT id FROM shopify_order_items WHERE id = ?", lineItemId);
    if (existingShopifyItem) {
      await db.run(
        "UPDATE shopify_order_items SET product_id = ?, variant_id = ?, sku = ?, name = ?, quantity = ?, price = ? WHERE id = ?",
        productId, variantId, sku, productName, quantity, amount, lineItemId
      );
    } else {
      await db.run(
        "INSERT INTO shopify_order_items (id, order_id, product_id, variant_id, sku, name, quantity, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        lineItemId, shopifyId, productId, variantId, sku, productName, quantity, amount
      );
    }

    // Upsert purchase_history
    const existingPhItem = await db.get("SELECT id FROM purchase_history WHERE shopify_line_item_id = ?", lineItemId);
    if (existingPhItem) {
      await db.run(
        "UPDATE purchase_history SET product_name = ?, quantity = ?, amount = ? WHERE shopify_line_item_id = ?",
        productName, quantity, amount, lineItemId
      );
    } else {
      await db.run(
        `INSERT INTO purchase_history (id, customer_id, order_date, product_name, quantity, amount, order_ref, shopify_line_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "ph_" + nanoid(10), crmCustomerId, orderDate, productName, quantity, amount, shopifyId, lineItemId
      );
    }
  }

  // 4. Update customer LTV and Last Order Date
  // Calculate LTV by summing all valid purchase_history amounts for this customer
  const ltvResult = await db.get(
    "SELECT SUM(amount * quantity) as total FROM purchase_history WHERE customer_id = ?", 
    crmCustomerId
  );
  const newLtv = ltvResult?.total || 0;
  
  await db.run(
    "UPDATE customers SET ltv = ?, last_order_date = ? WHERE id = ?",
    newLtv, orderDate, crmCustomerId
  );

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
