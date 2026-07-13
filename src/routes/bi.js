import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getDashboardForRole, calculateKPI, generateInsights } from "../services/biService.js";

const router = express.Router();
router.use(requireAuth);

// Get Dashboard Configuration
router.get("/dashboard", async (req, res, next) => {
  try {
    const role = req.user.role; // e.g. 'admin', 'manager', 'agent'
    const dashboard = await getDashboardForRole(role);
    if (!dashboard) return res.status(404).json({ error: "No dashboard found for role" });
    res.json({ dashboard });
  } catch (err) {
    next(err);
  }
});

// Bulk Fetch Widget Data
// Frontend sends { widgets: ['wid_01', 'wid_02'], filters: { brand_id: 'b1', date_range: 'today' } }
router.post("/widgets/data", async (req, res, next) => {
  try {
    const { widgets = [], filters = {} } = req.body;
    const userId = req.user.id;
    
    // We execute the aggregation for all requested widgets in parallel for speed
    const results = {};
    const promises = widgets.map(async (w) => {
      // In a real app, w is the widget ID, we might need to fetch the kpi_id first.
      // But let's assume the frontend passes an array of objects: { id: 'wid_1', kpi_id: 'revenue_today' }
      const data = await calculateKPI(w.kpi_id, filters, userId);
      results[w.id] = data;
    });
    
    await Promise.all(promises);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

// Get Insights
router.post("/insights", async (req, res, next) => {
  try {
    const { filters = {} } = req.body;
    const insights = await generateInsights(filters);
    res.json({ insights });
  } catch (err) {
    next(err);
  }
});

export default router;
