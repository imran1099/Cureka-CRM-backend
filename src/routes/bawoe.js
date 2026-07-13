import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { triggerEvent } from "../services/bawoeService.js";

const router = express.Router();
router.use(requireAuth);

// 1. Get all workflows
router.get("/workflows", async (req, res, next) => {
  try {
    const workflows = await db.all("SELECT * FROM bawoe_workflows ORDER BY created_at DESC");
    res.json({ workflows });
  } catch (err) {
    next(err);
  }
});

// 2. Get a single workflow by ID
router.get("/workflows/:id", async (req, res, next) => {
  try {
    const wf = await db.get("SELECT * FROM bawoe_workflows WHERE id = ?", req.params.id);
    if (!wf) return res.status(404).json({ error: "Workflow not found" });
    res.json({ workflow: wf });
  } catch (err) {
    next(err);
  }
});

// 3. Create or Update a workflow
router.post("/workflows", async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'general_manager') {
      return res.status(403).json({ error: "Unauthorized to manage workflows" });
    }
    
    const { id, name, description, trigger_event, status, brand_id, definition } = req.body;
    
    if (id) {
      // Update
      await db.run(
        "UPDATE bawoe_workflows SET name = ?, description = ?, trigger_event = ?, status = ?, brand_id = ?, definition = ? WHERE id = ?",
        [name, description, trigger_event, status, brand_id, JSON.stringify(definition), id]
      );
      res.json({ success: true, id });
    } else {
      // Create
      const newId = `wf_${Date.now()}`;
      await db.run(
        "INSERT INTO bawoe_workflows (id, name, description, trigger_event, status, brand_id, definition, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [newId, name, description, trigger_event, status, brand_id, JSON.stringify(definition), req.user.id]
      );
      res.json({ success: true, id: newId });
    }
  } catch (err) {
    next(err);
  }
});

// 4. Get Executions (Monitoring)
router.get("/executions", async (req, res, next) => {
  try {
    // Get latest 100 executions
    const executions = await db.all(`
      SELECT e.id, e.status, e.started_at, e.completed_at, w.name as workflow_name
      FROM bawoe_executions e
      JOIN bawoe_workflows w ON e.workflow_id = w.id
      ORDER BY e.started_at DESC LIMIT 100
    `);
    res.json({ executions });
  } catch (err) {
    next(err);
  }
});

// 5. Get Logs for a specific execution
router.get("/executions/:id/logs", async (req, res, next) => {
  try {
    const logs = await db.all("SELECT * FROM bawoe_logs WHERE execution_id = ? ORDER BY created_at ASC", req.params.id);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// 6. Test Trigger (Trigger an event manually)
router.post("/test", async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'general_manager') {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const { event, payload } = req.body;
    
    // Asynchronously trigger
    triggerEvent(event, payload).catch(console.error);
    
    res.json({ success: true, message: `Dispatched event ${event}` });
  } catch (err) {
    next(err);
  }
});

export default router;
