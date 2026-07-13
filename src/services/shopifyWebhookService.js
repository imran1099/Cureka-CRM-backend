import crypto from "crypto";
import { db } from "../db/connection.js";
import { nanoid } from "nanoid";
import { syncCustomer, syncOrder, syncProduct } from "./shopifySyncService.js";

/**
 * Validates the Shopify Webhook HMAC signature.
 * Returns true if valid, false otherwise.
 */
export function validateShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret) return false;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");
  return hash === hmacHeader;
}

/**
 * Enqueues a verified webhook payload into the database for asynchronous processing.
 */
export async function enqueueWebhook(storeId, topic, payload) {
  const eventId = "eq_" + nanoid(14);
  await db.run(
    "INSERT INTO shopify_event_queue (id, store_id, topic, payload, status) VALUES (?, ?, ?, ?, 'pending')",
    eventId, storeId, topic, JSON.stringify(payload)
  );
  return eventId;
}

/**
 * Processes a single webhook event.
 */
async function processWebhookEvent(event) {
  const payload = JSON.parse(event.payload);
  const { store_id, topic } = event;

  // Retrieve brandId from store
  const store = await db.get("SELECT brand_id FROM shopify_stores WHERE id = ?", store_id);
  if (!store) throw new Error(`Store ${store_id} not found.`);

  const brandId = store.brand_id;

  switch (topic) {
    case "customers/create":
    case "customers/update":
      await syncCustomer(store_id, payload, brandId);
      break;
    
    case "orders/create":
    case "orders/updated":
    case "orders/paid":
    case "orders/cancelled":
    case "orders/fulfilled":
      await syncOrder(store_id, payload, brandId);
      break;

    case "products/create":
    case "products/update":
      await syncProduct(store_id, payload, brandId);
      break;
      
    // Future expansion: inventory/update, refunds/create, etc.
    default:
      console.log(`Unhandled Shopify webhook topic: ${topic}`);
      break;
  }
}

/**
 * Background worker to process pending webhook events.
 */
let isProcessingQueue = false;

export async function processShopifyQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    // Fetch up to 50 pending or failed (with retry_count < 3) events
    const events = await db.all(`
      SELECT * FROM shopify_event_queue 
      WHERE status = 'pending' OR (status = 'failed' AND retry_count < 3)
      ORDER BY created_at ASC 
      LIMIT 50
    `);

    for (const event of events) {
      try {
        // Mark as processing
        await db.run("UPDATE shopify_event_queue SET status = 'processing' WHERE id = ?", event.id);
        
        await processWebhookEvent(event);
        
        // Mark as completed
        await db.run("UPDATE shopify_event_queue SET status = 'completed', processed_at = NOW() WHERE id = ?", event.id);
      } catch (error) {
        console.error(`Error processing shopify event ${event.id}:`, error);
        await db.run(
          "UPDATE shopify_event_queue SET status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?",
          error.message || "Unknown error", event.id
        );
      }
    }
  } catch (globalError) {
    console.error("Shopify queue processor error:", globalError);
  } finally {
    isProcessingQueue = false;
  }
}
