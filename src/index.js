import "dotenv/config";
import express from "express";
import cors from "cors";
import { initSchema } from "./db/connection.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import adminRoutes from "./routes/admin.js";
import insightsRoutes from "./routes/insights.js";

try {
  await initSchema();
  console.log("Database schema initialized successfully.");
} catch (err) {
  console.error("Database schema initialization failed:", err);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/insights", insightsRoutes);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Cureka CRM server running on http://localhost:${PORT}`);
});
