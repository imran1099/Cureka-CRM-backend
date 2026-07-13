import "dotenv/config";
import express from "express";
import cors from "cors";
import { initSchema, initShopifySchema, initKnowledgeSchema, initBISchema, initRADIPSchema, initPIKFSchema, initBAWOESchema, initUNCCSchema, initESCAMSSchema } from "./db/connection.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import adminRoutes from "./routes/admin.js";
import insightsRoutes from "./routes/insights.js";
import brandsRoutes from "./routes/brands.js";
import usersRoutes from "./routes/users.js";
import rolesRoutes from "./routes/roles.js";
import departmentsRoutes from "./routes/departments.js";
import permissionsRoutes from "./routes/permissions.js";
import sessionsRoutes from "./routes/sessions.js";
import auditRoutes from "./routes/audit.js";
import notificationsRoutes from "./routes/notifications.js";
import ticketsRoutes from "./routes/tickets.js";
import callsRoutes from "./routes/calls.js";
import csccRoutes from "./routes/cscc.js";
import creRoutes from "./routes/cre.js";
import timelineRoutes from "./routes/timeline.js";
import followupsRoutes from "./routes/followups.js";
import shopifyRoutes from "./routes/shopify.js";
import knowledgeRoutes from "./routes/knowledge.js";
import biRoutes from "./routes/bi.js";
import radipRoutes from "./routes/radip.js";
import pikfRoutes from "./routes/pikf.js";
import bawoeRoutes from "./routes/bawoe.js";
import unccRoutes from "./routes/uncc.js";
import { checkEscalations } from "./services/followupService.js";
import { checkEscalations as checkUNCCEscalations } from "./services/unccService.js";
import { processShopifyQueue } from "./services/shopifyWebhookService.js";
import { initScheduler as initRADIPScheduler } from "./services/radipScheduler.js";

try {
  await initSchema();
  await initShopifySchema();
  await initKnowledgeSchema();
  await initBISchema();
  await initRADIPSchema();
  await initPIKFSchema();
  await initBAWOESchema();
  await initUNCCSchema();
  await initESCAMSSchema();
  console.log("Database schema initialized and IAM seeds applied.");
  
  // Initialize Background Workers
  initRADIPScheduler();
} catch (err) {
  console.error("Database schema initialization failed:", err);
}

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://cureka-crm-frontend.vercel.app",
  ],
  credentials: true
}));
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Existing routes
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/insights", insightsRoutes);
app.use("/api/brands", brandsRoutes);
app.use("/api/tickets", ticketsRoutes);
app.use("/api/calls", callsRoutes);
app.use("/api/cscc", csccRoutes);
app.use("/api/cre", creRoutes);
app.use("/api/timeline", timelineRoutes);
app.use("/api/followups", followupsRoutes);
app.use("/api/shopify", shopifyRoutes);
app.use("/api/knowledge", knowledgeRoutes);
app.use("/api/bi", biRoutes);
app.use("/api/radip", radipRoutes);
app.use("/api/pikf", pikfRoutes);
app.use("/api/bawoe", bawoeRoutes);
app.use("/api/uncc", unccRoutes);

// IAM routes
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/departments", departmentsRoutes);
app.use("/api/permissions", permissionsRoutes);
app.use("/api/sessions", sessionsRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/notifications", notificationsRoutes);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Cureka CRM server running on http://localhost:${PORT}`);
  // Escalation engine & Shopify Queue: runs periodically
  // Delay initial run by 5s to let DB migration complete first
  setTimeout(() => {
    checkEscalations().catch(console.error);
    processShopifyQueue().catch(console.error);
    
    // Regular cron intervals
    setInterval(() => checkEscalations().catch(console.error), 15 * 60 * 1000); // 15 mins
    setInterval(() => checkUNCCEscalations().catch(console.error), 60 * 1000); // 1 min
    setInterval(() => processShopifyQueue().catch(console.error), 10 * 1000); // 10s
  }, 5000);
});
