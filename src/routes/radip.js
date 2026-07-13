import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { executeStandardReport, executeCustomReport, exportReport } from "../services/radipService.js";
import { addSchedule, removeSchedule } from "../services/radipScheduler.js";

const router = express.Router();
router.use(requireAuth);

// 1. Get List of Available Reports
router.get("/reports", async (req, res, next) => {
  try {
    const reports = await db.all("SELECT id, name, description, type, category FROM radip_reports ORDER BY category, name");
    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

// 2. Execute a specific report
router.post("/execute/:reportId", async (req, res, next) => {
  try {
    const { reportId } = req.params;
    const { filters = {} } = req.body;
    
    // Check if it's standard or custom
    const reportMeta = await db.get("SELECT * FROM radip_reports WHERE id = ?", reportId);
    if (!reportMeta) return res.status(404).json({ error: "Report not found" });

    let data;
    if (reportMeta.type === 'standard') {
      data = await executeStandardReport(reportId, filters);
    } else {
      let config = reportMeta.query_config;
      if (typeof config === 'string') config = JSON.parse(config);
      data = await executeCustomReport(config, filters);
    }

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// 3. Ad-hoc Execution (Report Builder Preview)
router.post("/build/preview", async (req, res, next) => {
  try {
    const { config, filters = {} } = req.body;
    const data = await executeCustomReport(config, filters);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// 4. Save Custom Report
router.post("/reports", async (req, res, next) => {
  try {
    const { name, description, category, query_config } = req.body;
    const id = `cust_${Date.now()}`;
    await db.run(
      "INSERT INTO radip_reports (id, name, description, type, category, query_config, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, name, description, 'custom', category, JSON.stringify(query_config), req.user.id]
    );
    res.json({ success: true, id });
  } catch (err) {
    next(err);
  }
});

// 5. Export Report
router.post("/export/:reportId", async (req, res, next) => {
  try {
    const { reportId } = req.params;
    const { filters = {}, format = 'csv' } = req.body;
    
    const reportMeta = await db.get("SELECT * FROM radip_reports WHERE id = ?", reportId);
    if (!reportMeta) return res.status(404).json({ error: "Report not found" });

    let data;
    if (reportMeta.type === 'standard') {
      data = await executeStandardReport(reportId, filters);
    } else {
      let config = reportMeta.query_config;
      if (typeof config === 'string') config = JSON.parse(config);
      data = await executeCustomReport(config, filters);
    }

    const exportedString = await exportReport(data, format);

    // Log the export action
    await db.run(
      "INSERT INTO radip_export_history (id, report_id, format, exported_by) VALUES (?, ?, ?, ?)",
      [`exp_${Date.now()}`, reportId, format, req.user.id]
    );

    res.json({ success: true, exportData: exportedString, format });
  } catch (err) {
    next(err);
  }
});

// 6. Schedule a Report
router.post("/schedules", async (req, res, next) => {
  try {
    const { report_id, frequency, format, recipients } = req.body;
    const schedId = await addSchedule(report_id, frequency, format, recipients, req.user.id);
    res.json({ success: true, scheduleId: schedId });
  } catch (err) {
    next(err);
  }
});

export default router;
