import axios from "axios";
import { db } from "../db/connection.js";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../utils/crypto.js";

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

const refreshLocks = new Map();

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
 * Connects or updates a Shopify store configuration using Client Credentials Grant.
 */
export async function connectStore({ brandId, storeUrl, clientId, clientSecret, webhookSecret }) {
  if (!brandId || !storeUrl || !clientId || !clientSecret) {
    throw new Error("Missing required credentials");
  }

  const normalizedUrl = normalizeStoreUrl(storeUrl);

  // Exchange client credentials for a token
  let tokenData;
  try {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const response = await axios.post(
      `https://${normalizedUrl}/admin/oauth/access_token`,
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    tokenData = response.data;
  } catch (error) {
    if (error.response?.data?.error === "shop_not_permitted") {
      throw new Error("This Shopify app and store are not in the same Shopify organization. Client Credentials authentication only works when they belong to the same organization.");
    }
    if (error.response?.status === 401 || error.response?.status === 400) {
      throw new Error("Shopify authentication failed. Check the Client ID and Client Secret.");
    }
    throw new Error("Shopify is temporarily unavailable. Please try again.");
  }

  if (!tokenData.access_token) {
    throw new Error("Shopify authentication failed. No access token returned.");
  }

  // Validate the token works
  try {
    await axios.get(`https://${normalizedUrl}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
      headers: { "X-Shopify-Access-Token": tokenData.access_token },
    });
  } catch (err) {
    throw new Error("Failed to validate Shopify API token. Please ensure the token has appropriate scopes.");
  }

  // Encrypt secrets
  const encryptedSecret = encrypt(clientSecret);
  const encryptedToken = encrypt(tokenData.access_token);
  // Add 5 min buffer to expiry date so we don't save a date that is too late
  const expiresInMs = (tokenData.expires_in * 1000) || (86400 * 1000);
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString().slice(0, 19).replace('T', ' ');

  // Save to DB
  const existingStore = await db.get("SELECT * FROM shopify_stores WHERE brand_id = ? AND store_url = ?", brandId, normalizedUrl);

  let storeId;
  if (existingStore) {
    storeId = existingStore.id;
    await db.run(
      `UPDATE shopify_stores 
       SET client_id = ?, client_secret_encrypted = ?, access_token_encrypted = ?, access_token_expires_at = ?, webhook_secret = ?, is_active = 1, updated_at = NOW() 
       WHERE id = ?`,
      clientId, encryptedSecret, encryptedToken, expiresAt, webhookSecret || null, storeId
    );
  } else {
    storeId = "store_" + nanoid(12);
    await db.run(
      `INSERT INTO shopify_stores (id, brand_id, store_url, client_id, client_secret_encrypted, access_token_encrypted, access_token_expires_at, webhook_secret, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      storeId, brandId, normalizedUrl, clientId, encryptedSecret, encryptedToken, expiresAt, webhookSecret || null
    );
  }

  return { id: storeId, store_url: normalizedUrl, is_active: true };
}

/**
 * Retrieves and automatically refreshes a valid Shopify Access Token
 */
export async function getShopifyAccessToken(storeId) {
  if (refreshLocks.has(storeId)) {
    return refreshLocks.get(storeId);
  }

  const tokenPromise = (async () => {
    try {
      const store = await db.get("SELECT * FROM shopify_stores WHERE id = ?", storeId);
      if (!store || !store.is_active) {
        throw new Error("Shopify store is not found or inactive.");
      }

      // Check if we can use existing token
      // Buffer of 5 minutes (300000 ms)
      const refreshThreshold = Date.now() + (5 * 60 * 1000);
      
      // If store is old and uses old access_token field but no client_id, we can only return old token if it works
      if (!store.client_id) {
        if (store.access_token) return store.access_token;
        throw new Error("Store needs re-authentication with Client Credentials.");
      }

      if (store.access_token_encrypted && store.access_token_expires_at) {
        const expiresAtMs = new Date(store.access_token_expires_at).getTime();
        if (expiresAtMs > refreshThreshold) {
          return decrypt(store.access_token_encrypted);
        }
      }

      // Need new token
      const clientSecret = decrypt(store.client_secret_encrypted);
      const params = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: store.client_id,
        client_secret: clientSecret,
      });

      const response = await axios.post(
        `https://${store.store_url}/admin/oauth/access_token`,
        params.toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );

      const tokenData = response.data;
      if (!tokenData.access_token) {
        throw new Error("Failed to refresh Shopify access token.");
      }

      const encryptedToken = encrypt(tokenData.access_token);
      const expiresInMs = (tokenData.expires_in * 1000) || (86400 * 1000);
      const expiresAt = new Date(Date.now() + expiresInMs).toISOString().slice(0, 19).replace('T', ' ');

      await db.run(
        "UPDATE shopify_stores SET access_token_encrypted = ?, access_token_expires_at = ?, updated_at = NOW() WHERE id = ?",
        encryptedToken, expiresAt, storeId
      );

      return tokenData.access_token;
    } finally {
      refreshLocks.delete(storeId);
    }
  })();

  refreshLocks.set(storeId, tokenPromise);
  return tokenPromise;
}

/**
 * Get the Shopify API Client for a specific store.
 */
export async function getShopifyClient(storeId) {
  const store = await db.get("SELECT * FROM shopify_stores WHERE id = ?", storeId);
  if (!store || !store.is_active) {
    throw new Error("Shopify store is not found or inactive.");
  }

  const accessToken = await getShopifyAccessToken(storeId);

  const client = axios.create({
    baseURL: `https://${store.store_url}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  // Adding rate limit handling interceptor
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response && error.response.status === 429) {
        let retries = error.config._retryCount || 0;
        if (retries < 3) {
          error.config._retryCount = retries + 1;
          const retryAfter = error.response.headers["retry-after"] || 2;
          console.warn(`Shopify Rate Limit hit for store ${storeId}. Retrying (${error.config._retryCount}/3) in ${retryAfter}s...`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          return client.request(error.config);
        }
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

  const accessToken = await getShopifyAccessToken(storeId);

  const client = axios.create({
    baseURL: `https://${store.store_url}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  
  // Adding rate limit handling interceptor
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response && error.response.status === 429) {
        let retries = error.config._retryCount || 0;
        if (retries < 3) {
          error.config._retryCount = retries + 1;
          const retryAfter = error.response.headers["retry-after"] || 2;
          console.warn(`Shopify Rate Limit hit for store ${storeId}. Retrying (${error.config._retryCount}/3) in ${retryAfter}s...`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          return client.request(error.config);
        }
      }
      return Promise.reject(error);
    }
  );

  return { client, store };
}
