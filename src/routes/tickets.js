import express from "express";
import { nanoid } from "nanoid";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { getBrandCondition } from "../utils/dbHelpers.js";
import { applySlaRules, autoAssignTicket, logTicketEvent } from "../services/ticketEngine.js";
import { createTimelineEvent } from "../services/timelineService.js";
import { processWorkflowRules } from "../services/followupService.js";

const router = express.Router();
router.use(requireAuth);

// GET /api/tickets
router.get("/", requireBrandAccess, async (req, res, next) => {
  try {
    const { status, priority, category_id, assigned_agent_id, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const brandFilter = getBrandCondition(req, "tickets");
    let sql = `SELECT tickets.*, customers.name as customer_name, brands.name as brand_name, agents.name as agent_name 
               FROM tickets 
               JOIN customers ON customers.id = tickets.customer_id
               JOIN brands ON brands.id = tickets.brand_id
               LEFT JOIN agents ON agents.id = tickets.assigned_agent_id
               ${brandFilter.join} 
               WHERE ${brandFilter.condition}`;
    const params = brandFilter.params || (brandFilter.param ? [brandFilter.param] : []);

    if (status) {
      sql += " AND tickets.status = ?";
      params.push(status);
    }
    if (priority) {
      sql += " AND tickets.priority = ?";
      params.push(priority);
    }
    if (category_id) {
      sql += " AND tickets.category_id = ?";
      params.push(category_id);
    }
    if (assigned_agent_id) {
      if (assigned_agent_id === "unassigned") {
        sql += " AND tickets.assigned_agent_id IS NULL";
      } else {
        sql += " AND tickets.assigned_agent_id = ?";
        params.push(assigned_agent_id);
      }
    }

    // Check SLAs dynamically on read to tag breached ones (or rely on cron, doing it here for simplicity)
    sql += ` ORDER BY tickets.created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
    const tickets = await db.all(sql, ...params);
    
    // Count total
    const countSql = `SELECT COUNT(*) as total FROM tickets ${brandFilter.join} WHERE ${brandFilter.condition}`;
    const { total } = await db.get(countSql, ...(brandFilter.params || (brandFilter.param ? [brandFilter.param] : [])));

    res.json({ tickets, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets
router.post("/", requireBrandAccess, async (req, res, next) => {
  try {
    const { brand_id, customer_id, category_id, sub_category_id, priority = "medium", source = "manual", department } = req.body;
    
    if (!brand_id || !customer_id) {
      return res.status(400).json({ error: "brand_id and customer_id are required" });
    }

    const id = "tkt_" + nanoid(10);
    await db.run(
      `INSERT INTO tickets (id, brand_id, customer_id, category_id, sub_category_id, priority, source, department, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      id, brand_id, customer_id, category_id || null, sub_category_id || null, priority, source, department || null
    );

    await logTicketEvent(id, "CREATED", `Ticket created via ${source}`, req.user.id);

    // Timeline event
    createTimelineEvent({
      customerId: customer_id, brandId: brand_id,
      eventType: "ticket_created",
      eventTitle: `Support ticket opened (${priority} priority)`,
      eventDescription: `Source: ${source}. Department: ${department || 'General'}.`,
      agentId: req.user.id, department, sourceSystem: "tickets",
      refId: id, refType: "ticket",
    }).catch(() => {});

    // Workflow automation: auto-create follow-up for high priority tickets
    processWorkflowRules("ticket_created", {
      customerId: customer_id, brandId: brand_id,
      priority, assignedAgentId: req.user.id, relatedTicketId: id,
    }).catch(() => {});

    // Run engines
    if (category_id) {
      await applySlaRules(id, category_id, priority);
    }
    await autoAssignTicket(id, brand_id);

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id
router.get("/:id", requireBrandAccess, async (req, res, next) => {
  try {
    const brandFilter = getBrandCondition(req, "tickets");
    const sql = `SELECT tickets.*, customers.name as customer_name, customers.phone as customer_phone, customers.email as customer_email, brands.name as brand_name, agents.name as agent_name 
               FROM tickets 
               JOIN customers ON customers.id = tickets.customer_id
               JOIN brands ON brands.id = tickets.brand_id
               LEFT JOIN agents ON agents.id = tickets.assigned_agent_id
               ${brandFilter.join} 
               WHERE tickets.id = ? AND ${brandFilter.condition}`;
    const params = [req.params.id];
    if (brandFilter.params) params.push(...brandFilter.params);
    else if (brandFilter.param) params.push(brandFilter.param);

    const ticket = await db.get(sql, ...params);
    if (!ticket) return res.status(404).json({ error: "Ticket not found or access denied" });

    const comments = await db.all("SELECT c.*, a.name as agent_name FROM ticket_comments c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.ticket_id = ? ORDER BY c.created_at ASC", ticket.id);
    const timeline = await db.all("SELECT t.*, a.name as agent_name FROM ticket_timeline t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.ticket_id = ? ORDER BY t.created_at DESC", ticket.id);

    res.json({ ticket, comments, timeline });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id
router.patch("/:id", requireBrandAccess, async (req, res, next) => {
  try {
    const { status, priority, assigned_agent_id } = req.body;
    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const updates = [];
    const params = [];
    
    if (status && status !== ticket.status) {
      updates.push("status = ?");
      params.push(status);
      if (status === 'resolved' || status === 'closed') {
        updates.push("resolved_at = NOW()");
      }
      await logTicketEvent(ticket.id, "STATUS_CHANGED", `Status changed from ${ticket.status} to ${status}`, req.user.id);
    }
    
    if (priority && priority !== ticket.priority) {
      updates.push("priority = ?");
      params.push(priority);
      await logTicketEvent(ticket.id, "PRIORITY_CHANGED", `Priority changed from ${ticket.priority} to ${priority}`, req.user.id);
      if (ticket.category_id) await applySlaRules(ticket.id, ticket.category_id, priority); // Re-apply SLA
    }
    
    if (assigned_agent_id !== undefined && assigned_agent_id !== ticket.assigned_agent_id) {
      updates.push("assigned_agent_id = ?");
      params.push(assigned_agent_id);
      await logTicketEvent(ticket.id, "REASSIGNED", assigned_agent_id ? `Ticket reassigned` : `Ticket unassigned`, req.user.id);
    }

    if (updates.length > 0) {
      updates.push("updated_at = NOW()");
      await db.run(`UPDATE tickets SET ${updates.join(", ")} WHERE id = ?`, ...params, ticket.id);
    }

    // Timeline events for status changes
    if (status && status !== ticket.status) {
      const eventMap = { resolved: "ticket_resolved", closed: "ticket_resolved", escalated: "ticket_escalated" };
      const evType = eventMap[status];
      if (evType) {
        createTimelineEvent({
          customerId: ticket.customer_id, brandId: ticket.brand_id,
          eventType: evType,
          eventTitle: `Ticket ${status} — #${ticket.id}`,
          eventDescription: `Ticket status changed to ${status}.`,
          agentId: req.user.id, department: ticket.department,
          sourceSystem: "tickets", refId: ticket.id, refType: "ticket",
          outcome: status,
        }).catch(() => {});
      }
    }
    if (assigned_agent_id !== undefined && assigned_agent_id !== ticket.assigned_agent_id) {
      createTimelineEvent({
        customerId: ticket.customer_id, brandId: ticket.brand_id,
        eventType: "ticket_assigned",
        eventTitle: `Ticket assigned to agent — #${ticket.id}`,
        agentId: req.user.id, department: ticket.department,
        sourceSystem: "tickets", refId: ticket.id, refType: "ticket",
      }).catch(() => {});
    }

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/comments
router.post("/:id/comments", requireBrandAccess, async (req, res, next) => {
  try {
    const { content, is_internal = 1 } = req.body;
    if (!content) return res.status(400).json({ error: "Content is required" });

    const ticket = await db.get("SELECT * FROM tickets WHERE id = ?", req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const id = "tcom_" + nanoid(10);
    await db.run(
      "INSERT INTO ticket_comments (id, ticket_id, agent_id, is_internal, content) VALUES (?, ?, ?, ?, ?)",
      id, ticket.id, req.user.id, is_internal, content
    );

    // If first response, stamp it
    if (!ticket.first_response_at) {
      await db.run("UPDATE tickets SET first_response_at = NOW() WHERE id = ?", ticket.id);
    }
    
    // Auto-change status from new/open to in_progress if agent responds
    if (ticket.status === 'open' || ticket.status === 'new') {
      await db.run("UPDATE tickets SET status = 'in_progress', updated_at = NOW() WHERE id = ?", ticket.id);
      await logTicketEvent(ticket.id, "STATUS_CHANGED", "Status auto-changed to in_progress due to response", req.user.id);
    }

    await logTicketEvent(ticket.id, "COMMENT_ADDED", is_internal ? "Internal note added" : "Public reply sent", req.user.id);

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// Admin Categories config endpoints (simple implementation)
router.get("/config/categories", async (req, res, next) => {
  try {
    const categories = await db.all("SELECT * FROM ticket_categories ORDER BY created_at ASC");
    res.json({ categories });
  } catch (err) { next(err); }
});

router.post("/config/categories", requireAuth, async (req, res, next) => {
  try {
    const { name, department_id } = req.body;
    const id = "tcat_" + nanoid(10);
    await db.run("INSERT INTO ticket_categories (id, name, department_id) VALUES (?, ?, ?)", id, name, department_id);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// Admin SLA Rules config endpoints (simple implementation)
router.get("/config/sla", async (req, res, next) => {
  try {
    const rules = await db.all("SELECT s.*, c.name as category_name FROM sla_rules s LEFT JOIN ticket_categories c ON c.id = s.category_id ORDER BY s.created_at ASC");
    res.json({ rules });
  } catch (err) { next(err); }
});

router.post("/config/sla", requireAuth, async (req, res, next) => {
  try {
    const { category_id, priority, first_response_minutes, resolution_minutes } = req.body;
    const id = "sla_" + nanoid(10);
    await db.run("INSERT INTO sla_rules (id, category_id, priority, first_response_minutes, resolution_minutes) VALUES (?, ?, ?, ?, ?)", id, category_id, priority, first_response_minutes, resolution_minutes);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

export default router;
