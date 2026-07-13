import axios from "axios";
import { db } from "../db/connection.js";
import { nanoid } from "nanoid";

/**
 * Validates a Shopify store URL and returns the normalized 'xxxx.myshopify.com' hostname.
 */
function normalizeStoreUrl(url) {
  let normalized = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!normalized.includes(".myshopify.com")) {
    normalized = `${normalized}.myshopify.com`;
  }
  return normalized;
}

/**
 * Connects or updates a Shopify store configuration.
 * Validates the access token before saving.
 */
export async function connectStore({ brandId, storeUrl, accessToken, webhookSecret }) {
  const normalizedUrl = normalizeStoreUrl(storeUrl);

  // Validate the access token by attempting to fetch the shop info
  try {
    const response = await axios.get(`https://${normalizedUrl}/admin/api/2024-01/shop.json`, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
      },
    });
    if (!response.data || !response.data.shop) {
      throw new Error("Invalid response from Shopify API");
    }
  } catch (error) {
    throw new Error("Failed to validate Shopify API token. Please ensure the token has appropriate scopes.");
  }

  // Check if store already exists for this brand
  const existingStore = await db.get("SELECT * FROM shopify_stores WHERE brand_id = ? AND store_url = ?", brandId, normalizedUrl);

  if (existingStore) {
    await db.run(
      "UPDATE shopify_stores SET access_token = ?, webhook_secret = ?, is_active = 1, updated_at = NOW() WHERE id = ?",
      accessToken, webhookSecret || null, existingStore.id
    );
    return existingStore.id;
  } else {
    const storeId = "store_" + nanoid(12);
    await db.run(
      "INSERT INTO shopify_stores (id, brand_id, store_url, access_token, webhook_secret, is_active) VALUES (?, ?, ?, ?, ?, 1)",
      storeId, brandId, normalizedUrl, accessToken, webhookSecret || null
    );
    return storeId;
  }
}

/**
 * Get the Shopify API Client for a specific store.
 */
export async function getShopifyClient(storeId) {
  const store = await db.get("SELECT * FROM shopify_stores WHERE id = ?", storeId);
  if (!store || !store.is_active) {
    throw new Error("Shopify store is not found or inactive.");
  }

  const client = axios.create({
    baseURL: `https://${store.store_url}/admin/api/2024-01`,
    headers: {
      "X-Shopify-Access-Token": store.access_token,
      "Content-Type": "application/json",
    },
  });

  // Adding rate limit handling interceptor
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers["retry-after"] || 2;
        console.warn(`Shopify Rate Limit hit for store ${storeId}. Retrying in ${retryAfter}s...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return client.request(error.config);
      }
      return Promise.reject(error);
    }
  );

  return { client, store };
}

/**
 * Get the Shopify GraphQL Client for a specific store.
 */
export async function getShopifyGraphQLClient(storeId) {
  const store = await db.get("SELECT * FROM shopify_stores WHERE id = ?", storeId);
  if (!store || !store.is_active) {
    throw new Error("Shopify store is not found or inactive.");
  }

  const client = axios.create({
    baseURL: `https://${store.store_url}/admin/api/2024-01/graphql.json`,
    headers: {
      "X-Shopify-Access-Token": store.access_token,
      "Content-Type": "application/json",
    },
  });

  return { client, store };
}
