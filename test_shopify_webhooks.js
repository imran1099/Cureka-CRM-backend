import "dotenv/config";
import assert from "assert";
import crypto from "crypto";
import express from "express";
import { db } from "./src/db/connection.js";
import shopifyRoutes from "./src/routes/shopify.js";
import { encrypt } from "./src/utils/crypto.js";

// Helper to generate HMAC header
function generateHmac(body, secret) {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

async function runTests() {
  console.log("Setting up test database...");
  
  const app = express();
  app.use("/api/shopify", shopifyRoutes);
  
  // Start server
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/shopify/webhooks`;
  
  try {
    // Fetch a valid brand_id
    const brand = await db.get("SELECT id FROM brands LIMIT 1");
    if (!brand) throw new Error("No brands found in database");
    const brandId = brand.id;

    // Seed stores
    const store1Id = "test_store_1";
    const store1ClientSecret = "shpss_testsecret1";
    await db.run(
      `INSERT INTO shopify_stores (id, brand_id, store_url, client_secret_encrypted, webhook_secret, is_active) 
       VALUES (?, ?, ?, ?, ?, 1)`,
      store1Id, brandId, "test1.myshopify.com", encrypt(store1ClientSecret), null
    );

    const store2Id = "test_store_2";
    const store2ClientSecret = "shpss_testsecret2";
    await db.run(
      `INSERT INTO shopify_stores (id, brand_id, store_url, client_secret_encrypted, webhook_secret, is_active) 
       VALUES (?, ?, ?, ?, ?, 1)`,
      store2Id, brandId, "test2.myshopify.com", encrypt(store2ClientSecret), null
    );

    const storeLegacyId = "test_store_legacy";
    const legacySecret = "shpss_legacysecret";
    await db.run(
      `INSERT INTO shopify_stores (id, brand_id, store_url, client_secret_encrypted, webhook_secret, is_active) 
       VALUES (?, ?, ?, ?, ?, 1)`,
      storeLegacyId, brandId, "testlegacy.myshopify.com", null, legacySecret
    );
    
    const payload = JSON.stringify({ test: "data" });
    
    // Helper for requests
    const sendWebhook = async (storeId, hmac, topic = "customers/create") => {
      const headers = {
        "Content-Type": "application/json",
        "X-Shopify-Topic": topic
      };
      if (hmac !== undefined) headers["X-Shopify-Hmac-Sha256"] = hmac;
      
      const res = await fetch(`${baseUrl}/${storeId}`, {
        method: "POST",
        headers,
        body: payload
      });
      return res;
    };

    console.log("1. Testing Valid HMAC with primary store...");
    let res = await sendWebhook(store1Id, generateHmac(payload, store1ClientSecret));
    assert.strictEqual(res.status, 200);

    console.log("2. Testing Invalid HMAC...");
    res = await sendWebhook(store1Id, generateHmac(payload, "wrong_secret"));
    assert.strictEqual(res.status, 401);

    console.log("3. Testing Missing HMAC...");
    res = await sendWebhook(store1Id, undefined);
    assert.strictEqual(res.status, 400);

    console.log("4. Testing Missing client secret (no fallback)...");
    const storeMissingId = "test_store_missing";
    await db.run(
      `INSERT INTO shopify_stores (id, brand_id, store_url, is_active) VALUES (?, ?, ?, 1)`,
      storeMissingId, brandId, "testmissing.myshopify.com"
    );
    res = await sendWebhook(storeMissingId, generateHmac(payload, "anything"));
    assert.strictEqual(res.status, 401);

    console.log("5. Testing Existing store with legacy webhook_secret...");
    res = await sendWebhook(storeLegacyId, generateHmac(payload, legacySecret));
    assert.strictEqual(res.status, 200);

    console.log("6. Testing Multiple Shopify stores using different client secrets...");
    res = await sendWebhook(store2Id, generateHmac(payload, store2ClientSecret));
    assert.strictEqual(res.status, 200);

    console.log("All automated tests passed!");

  } finally {
    // Cleanup
    await db.run("DELETE FROM shopify_stores WHERE id IN (?, ?, ?, ?)", "test_store_1", "test_store_2", "test_store_legacy", "test_store_missing");
    server.close();
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
