import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications — get my notifications
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const onlyUnread = req.query.unread === "true";

    const condition = onlyUnread ? "AND n.read_at IS NULL" : "";

    const notifications = await db.all(
      `SELECT n.id, n.type, n.title, n.body, n.link, n.read_at, n.created_at
       FROM notifications n
       WHERE n.recipient_id = ? ${condition}
       ORDER BY n.created_at DESC
       LIMIT ?`,
      req.user.id, limit
    );

    const unreadCount = await db.get(
      "SELECT COUNT(*) as cnt FROM notifications WHERE recipient_id = ? AND read_at IS NULL",
      req.user.id
    );

    res.json({ notifications, unread_count: unreadCount.cnt });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch("/:id/read", async (req, res, next) => {
  try {
    const notif = await db.get(
      "SELECT id FROM notifications WHERE id = ? AND recipient_id = ?",
      req.params.id, req.user.id
    );
    if (!notif) return res.status(404).json({ error: "Notification not found" });

    await db.run(
      "UPDATE notifications SET read_at = NOW() WHERE id = ? AND read_at IS NULL",
      req.params.id
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all — mark all as read
router.patch("/read-all", async (req, res, next) => {
  try {
    const result = await db.run(
      "UPDATE notifications SET read_at = NOW() WHERE recipient_id = ? AND read_at IS NULL",
      req.user.id
    );
    res.json({ marked: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/:id — dismiss a notification
router.delete("/:id", async (req, res, next) => {
  try {
    await db.run(
      "DELETE FROM notifications WHERE id = ? AND recipient_id = ?",
      req.params.id, req.user.id
    );
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
