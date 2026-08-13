import { db } from "../db/connection.js";
import { getShopifyGraphQLClient } from "./shopifyAuthService.js";
import { nanoid } from "nanoid";
import { syncCustomer, syncOrder, syncProduct } from "./shopifySyncService.js";
import axios from "axios";
import readline from "readline";

/**
 * Initiates a Bulk Operation for Customers, Orders, or Products.
 */
export async function startBulkImport(storeId, entityType) {
  const { client, store } = await getShopifyGraphQLClient(storeId);
  
  let query = "";
  if (entityType === "customers") {
    query = `
      {
        customers {
          edges {
            node {
              id
              email
              phone
              firstName
              lastName
              defaultAddress {
                city
                phone
              }
            }
          }
        }
      }
    `;
  } else if (entityType === "orders") {
    query = `
      {
        orders {
          edges {
            node {
              id
              name
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              displayFinancialStatus
              displayFulfillmentStatus
              tags
              createdAt
              updatedAt
              customer {
                id
                email
                phone
                firstName
                lastName
              }
              lineItems {
                edges {
                  node {
                    id
                    title
                    sku
                    quantity
                    product {
                      id
                    }
                    variant {
                      id
                    }
                    originalTotalSet {
                      shopMoney {
                        amount
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
  } else if (entityType === "products") {
    query = `
      {
        products {
          edges {
            node {
              id
              title
              handle
              status
              variants {
                edges {
                  node {
                    id
                    sku
                    price
                    compareAtPrice
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `;
  } else {
    throw new Error(`Unsupported bulk import entity: ${entityType}`);
  }

  const mutation = `
    mutation {
      bulkOperationRunQuery(
        query: """
        ${query}
        """
      ) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await client.post("", { query: mutation });
  const data = response.data.data.bulkOperationRunQuery;
  
  if (data.userErrors && data.userErrors.length > 0) {
    throw new Error(`Bulk operation error: ${data.userErrors[0].message}`);
  }

  const logId = "ssl_" + nanoid(10);
  await db.run(
    "INSERT INTO shopify_sync_logs (id, brand_id, sync_type, status) VALUES (?, ?, ?, 'running')",
    logId, store.brand_id, entityType
  );

  return { bulkOperationId: data.bulkOperation.id, logId };
}

/**
 * Polls the bulk operation status. If completed, downloads and processes the JSONL file.
 */
export async function checkBulkImportStatus(storeId, logId) {
  const { client, store } = await getShopifyGraphQLClient(storeId);
  const log = await db.get("SELECT * FROM shopify_sync_logs WHERE id = ?", logId);
  if (!log) throw new Error("Sync log not found");

  if (log.status === 'completed' || log.status === 'failed') return log;

  const query = `
    query {
      currentBulkOperation {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        fileSize
        url
        partialDataUrl
      }
    }
  `;

  const response = await client.post("", { query });
  const operation = response.data.data.currentBulkOperation;

  if (!operation) return log;

  if (operation.status === 'COMPLETED') {
    if (operation.url) {
      // Process the JSONL file in the background so we don't block the API response
      processBulkData(operation.url, store, logId, log.sync_type).catch(e => console.error("Bulk process error:", e));
      await db.run("UPDATE shopify_sync_logs SET status = 'processing' WHERE id = ?", logId);
    } else {
      // No data to process
      await db.run("UPDATE shopify_sync_logs SET status = 'completed', completed_at = NOW() WHERE id = ?", logId);
    }
  } else if (operation.status === 'FAILED' || operation.status === 'CANCELED') {
    await db.run("UPDATE shopify_sync_logs SET status = 'failed', error_message = ?, completed_at = NOW() WHERE id = ?", operation.errorCode || 'Operation failed', logId);
  }

  return await db.get("SELECT * FROM shopify_sync_logs WHERE id = ?", logId);
}

/**
 * Downloads the JSONL file and processes line by line.
 */
async function processBulkData(url, store, logId, entityType) {
  let processed = 0;
  let failed = 0;
  
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });

    const rl = readline.createInterface({
      input: response.data,
      crlfDelay: Infinity
    });

    let currentOrder = null;

    for await (const line of rl) {
      if (!line.trim()) continue;
      const node = JSON.parse(line);
      
      try {
        if (entityType === "customers") {
          const shopifyCustomer = mapGraphQLCustomer(node);
          await syncCustomer(store.id, shopifyCustomer, store.brand_id);
          processed++;
        } else if (entityType === "orders") {
          if (!node.__parentId) {
            if (currentOrder) {
              await syncOrder(store.id, currentOrder, store.brand_id);
              processed++;
            }
            currentOrder = {
              id: node.id.split('/').pop(),
              order_number: node.name,
              created_at: node.createdAt,
              customer: node.customer ? {
                 id: node.customer.id.split('/').pop(),
                 email: node.customer.email,
                 phone: node.customer.phone,
                 first_name: node.customer.firstName,
                 last_name: node.customer.lastName
              } : null,
              line_items: []
            };
          } else {
            if (currentOrder && node.__parentId === `gid://shopify/Order/${currentOrder.id}`) {
              currentOrder.line_items.push({
                id: node.id.split('/').pop(),
                name: node.title,
                quantity: node.quantity,
                price: node.originalTotalSet?.shopMoney?.amount || 0
              });
            }
          }
        }
      } catch (err) {
        failed++;
        console.error(`Failed to process node from bulk import:`, err);
      }
    }

    if (currentOrder) {
      await syncOrder(store.id, currentOrder, store.brand_id);
      processed++;
    }

    await db.run(
      "UPDATE shopify_sync_logs SET status = 'completed', records_processed = ?, records_failed = ?, completed_at = NOW() WHERE id = ?",
      processed, failed, logId
    );
  } catch (error) {
    await db.run(
      "UPDATE shopify_sync_logs SET status = 'failed', error_message = ?, completed_at = NOW() WHERE id = ?",
      error.message, logId
    );
  }
}

function mapGraphQLCustomer(node) {
  return {
    id: node.id.split('/').pop(),
    email: node.email,
    phone: node.phone,
    first_name: node.firstName,
    last_name: node.lastName,
    default_address: node.defaultAddress
  };
}
