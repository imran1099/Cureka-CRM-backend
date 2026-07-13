import express from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/auth.js";
import { requireBrandAccess } from "../middleware/rbac.js";
import { nanoid } from "nanoid";

const router = express.Router();
router.use(requireAuth);

// ─── CATEGORIES ─────────────────────────────────────────────────────────────

router.get("/categories", async (req, res, next) => {
  try {
    const { brand_id } = req.query;
    let sql = "SELECT * FROM eklh_categories";
    const params = [];
    if (brand_id) {
      sql += " WHERE brand_id = ? OR brand_id IS NULL";
      params.push(brand_id);
    }
    sql += " ORDER BY name ASC";
    const categories = await db.all(sql, ...params);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

router.post("/categories", async (req, res, next) => {
  try {
    const { name, description, parent_id, brand_id } = req.body;
    const id = "cat_" + nanoid(8);
    await db.run(
      "INSERT INTO eklh_categories (id, parent_id, brand_id, name, description) VALUES (?, ?, ?, ?, ?)",
      id, parent_id || null, brand_id || null, name, description || null
    );
    res.status(201).json({ id, name });
  } catch (err) {
    next(err);
  }
});

// ─── ARTICLES ───────────────────────────────────────────────────────────────

router.get("/articles", requireBrandAccess, async (req, res, next) => {
  try {
    const { query, category_id, status = "published", limit = 50 } = req.query;
    let sql = `
      SELECT a.*, c.name as category_name, ag.name as author_name 
      FROM eklh_articles a
      LEFT JOIN eklh_categories c ON a.category_id = c.id
      LEFT JOIN agents ag ON a.author_id = ag.id
      WHERE a.status = ?
    `;
    const params = [status];

    if (category_id) {
      sql += " AND a.category_id = ?";
      params.push(category_id);
    }

    if (query) {
      sql += " AND (a.title LIKE ? OR a.summary LIKE ?)";
      params.push(`%${query}%`, `%${query}%`);
    }
    
    // Check Brand Filter from requireBrandAccess middleware
    if (req.query.brand_id) {
       sql += " AND (a.brand_id = ? OR a.brand_id IS NULL)";
       params.push(req.query.brand_id);
    }

    sql += " ORDER BY a.updated_at DESC LIMIT ?";
    params.push(Number(limit));

    const articles = await db.all(sql, ...params);
    res.json({ articles });
  } catch (err) {
    next(err);
  }
});

router.post("/articles", requireBrandAccess, async (req, res, next) => {
  try {
    const { title, summary, category_id, brand_id, department, content, tags } = req.body;
    const articleId = "art_" + nanoid(10);
    const versionId = "ver_" + nanoid(10);
    const authorId = req.user.id;

    await db.transaction(async (conn) => {
      await conn.execute(
        "INSERT INTO eklh_articles (id, category_id, brand_id, department, title, summary, author_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')",
        [articleId, category_id, brand_id || null, department || null, title, summary, authorId]
      );
      await conn.execute(
        "INSERT INTO eklh_article_versions (id, article_id, version_num, content, created_by) VALUES (?, ?, 1, ?, ?)",
        [versionId, articleId, content, authorId]
      );
      if (tags && tags.length > 0) {
        for (const tag of tags) {
          await conn.execute("INSERT INTO eklh_article_tags (article_id, tag) VALUES (?, ?)", [articleId, tag]);
        }
      }
    });

    res.status(201).json({ id: articleId });
  } catch (err) {
    next(err);
  }
});

router.get("/articles/:id", requireBrandAccess, async (req, res, next) => {
  try {
    const article = await db.get(`
      SELECT a.*, c.name as category_name, ag.name as author_name, rev.name as reviewer_name
      FROM eklh_articles a
      LEFT JOIN eklh_categories c ON a.category_id = c.id
      LEFT JOIN agents ag ON a.author_id = ag.id
      LEFT JOIN agents rev ON a.reviewer_id = rev.id
      WHERE a.id = ?
    `, req.params.id);

    if (!article) return res.status(404).json({ error: "Article not found" });

    // Increment Views
    await db.run("UPDATE eklh_articles SET views = views + 1 WHERE id = ?", article.id);

    // Get latest version content
    const version = await db.get("SELECT * FROM eklh_article_versions WHERE article_id = ? ORDER BY version_num DESC LIMIT 1", article.id);
    
    // Get tags
    const tags = await db.all("SELECT tag FROM eklh_article_tags WHERE article_id = ?", article.id);

    // Get reading progress for current user
    const progress = await db.get("SELECT * FROM eklh_learning_progress WHERE article_id = ? AND user_id = ?", article.id, req.user.id);

    res.json({ article: { ...article, content: version?.content, version_num: version?.version_num, tags: tags.map(t => t.tag), is_read: !!progress } });
  } catch (err) {
    next(err);
  }
});

// Submit for review
router.post("/articles/:id/submit", async (req, res, next) => {
  try {
    await db.run("UPDATE eklh_articles SET status = 'pending_review' WHERE id = ?", req.params.id);
    res.json({ message: "Submitted for review" });
  } catch (err) {
    next(err);
  }
});

// Publish
router.post("/articles/:id/publish", async (req, res, next) => {
  try {
    // Only Managers/Admin can publish
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
       return res.status(403).json({ error: "Insufficient permissions" });
    }
    await db.run("UPDATE eklh_articles SET status = 'published', reviewer_id = ?, effective_date = NOW() WHERE id = ?", req.user.id, req.params.id);
    res.json({ message: "Published successfully" });
  } catch (err) {
    next(err);
  }
});

// Mark as read (LMS tracking)
router.post("/articles/:id/read", async (req, res, next) => {
  try {
    await db.run(
      "INSERT IGNORE INTO eklh_learning_progress (user_id, article_id) VALUES (?, ?)",
      req.user.id, req.params.id
    );
    res.json({ message: "Marked as read" });
  } catch (err) {
    next(err);
  }
});

// ─── CONTEXT-AWARE RECOMMENDATIONS ──────────────────────────────────────────

router.get("/recommend", requireBrandAccess, async (req, res, next) => {
  try {
    // Expected query parameters representing context: intent, product, tag
    const { intent, product, tag, limit = 5 } = req.query;
    
    // We will do a basic keyword matching against tags and title for recommendations.
    // In a real AI system, this would hit an embeddings database.
    let searchTerms = [];
    if (intent) searchTerms.push(intent);
    if (product) searchTerms.push(product);
    if (tag) searchTerms.push(tag);
    
    if (searchTerms.length === 0) {
      return res.json({ recommendations: [] });
    }

    let sql = `
      SELECT DISTINCT a.id, a.title, a.summary, c.name as category_name
      FROM eklh_articles a
      LEFT JOIN eklh_article_tags t ON a.id = t.article_id
      LEFT JOIN eklh_categories c ON a.category_id = c.id
      WHERE a.status = 'published' AND (
    `;
    const params = [];
    const conditions = [];

    searchTerms.forEach(term => {
      conditions.push(`a.title LIKE ? OR t.tag LIKE ?`);
      params.push(`%${term}%`, `%${term}%`);
    });

    sql += conditions.join(" OR ") + `) `;
    
    if (req.query.brand_id) {
       sql += " AND (a.brand_id = ? OR a.brand_id IS NULL)";
       params.push(req.query.brand_id);
    }
    
    sql += " LIMIT ?";
    params.push(Number(limit));

    const recommendations = await db.all(sql, ...params);
    res.json({ recommendations });
  } catch (err) {
    next(err);
  }
});

export default router;
