import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getNotifications, markNotificationAsRead, executeQuickAction } from "../services/unccService.js";

const router = express.Router();
router.use(requireAuth);

// 1. Get all notifications for the current user
router.get("/", async (req, res, next) => {
  try {
    const notifications = await getNotifications(req.user.id);
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

// 2. Mark a notification as read
router.put("/:id/read", async (req, res, next) => {
  try {
    await markNotificationAsRead(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 3. Execute a Quick Action
router.post("/:id/action", async (req, res, next) => {
  try {
    // The payload might contain additional data from the user (e.g., comments for approval)
    const result = await executeQuickAction(req.params.id, req.user.id, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
