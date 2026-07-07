import "dotenv/config";
import express from "express";
import cors from "cors";
import { initSchema } from "./db/connection.js";
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

try {
  await initSchema();
  console.log("Database schema initialized and IAM seeds applied.");
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
});
