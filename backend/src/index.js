const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3089;
const DB_PATH = path.join('/app/data', 'clipboard.db');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── DB init ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT DEFAULT '',
    content TEXT NOT NULL,
    contentType TEXT DEFAULT 'text',
    language TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    tags TEXT DEFAULT '[]',
    pinned INTEGER DEFAULT 0,
    favorite INTEGER DEFAULT 0,
    copyCount INTEGER DEFAULT 0,
    source TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    updatedAt TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_clip_type ON clips(contentType);
  CREATE INDEX IF NOT EXISTS idx_clip_pinned ON clips(pinned);
  CREATE INDEX IF NOT EXISTS idx_clip_category ON clips(category);

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    icon TEXT DEFAULT '📋',
    color TEXT DEFAULT '#6366f1'
  );
`);

// Seed default categories
const defaultCats = [
  { name: 'general',     icon: '📋', color: '#6366f1' },
  { name: 'infra',       icon: '🖥️', color: '#10b981' },
  { name: 'dev',         icon: '💻', color: '#3b82f6' },
  { name: 'templates',   icon: '📄', color: '#f59e0b' },
  { name: 'contacts',    icon: '👤', color: '#ec4899' },
  { name: 'credentials', icon: '🔑', color: '#ef4444' },
];
const insertCat = db.prepare(`INSERT OR IGNORE INTO categories (name, icon, color) VALUES (?, ?, ?)`);
for (const c of defaultCats) insertCat.run(c.name, c.icon, c.color);

// ── Helpers ──────────────────────────────────────────────────────────────────
function rowToClip(row) {
  if (!row) return null;
  return { ...row, pinned: !!row.pinned, favorite: !!row.favorite, tags: JSON.parse(row.tags || '[]') };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Stats
app.get('/api/stats', (_, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM clips').get().c;
  const byType = db.prepare('SELECT contentType, COUNT(*) as count FROM clips GROUP BY contentType').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM clips GROUP BY category').all();
  const mostCopied = db.prepare('SELECT id, title, copyCount FROM clips ORDER BY copyCount DESC LIMIT 5').all();
  res.json({ total, byType, byCategory, mostCopied });
});

// Search
app.get('/api/search', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = db.prepare(`
    SELECT * FROM clips
    WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
    ORDER BY pinned DESC, updatedAt DESC
    LIMIT 50
  `).all(q, q, q);
  res.json(rows.map(rowToClip));
});

// List clips
app.get('/api/clips', (req, res) => {
  const { type, category, pinned, q, sort = 'newest', limit = 50 } = req.query;
  let sql = 'SELECT * FROM clips WHERE 1=1';
  const params = [];
  if (type)     { sql += ' AND contentType = ?'; params.push(type); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (pinned)   { sql += ' AND pinned = 1'; }
  if (q)        { sql += ' AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)'; const p = `%${q}%`; params.push(p, p, p); }
  sql += sort === 'mostCopied' ? ' ORDER BY copyCount DESC' :
         sort === 'oldest'     ? ' ORDER BY createdAt ASC'  :
                                 ' ORDER BY pinned DESC, updatedAt DESC';
  sql += ` LIMIT ${parseInt(limit) || 50}`;
  res.json(db.prepare(sql).all(...params).map(rowToClip));
});

// Get clip
app.get('/api/clips/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(rowToClip(row));
});

// Create clip
app.post('/api/clips', (req, res) => {
  const { title = '', content, contentType = 'text', language = '', category = 'general', tags = [], pinned = 0, favorite = 0, source = '' } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const result = db.prepare(`
    INSERT INTO clips (title, content, contentType, language, category, tags, pinned, favorite, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, content, contentType, language, category, JSON.stringify(tags), pinned ? 1 : 0, favorite ? 1 : 0, source);
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(rowToClip(row));
});

// Update clip
app.patch('/api/clips/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const fields = ['title', 'content', 'contentType', 'language', 'category', 'tags', 'pinned', 'favorite', 'source'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'tags' ? JSON.stringify(req.body[f]) : f === 'pinned' || f === 'favorite' ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }
  if (updates.length === 0) return res.json(rowToClip(row));
  updates.push("updatedAt = datetime('now','localtime')");
  params.push(req.params.id);
  db.prepare(`UPDATE clips SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(rowToClip(db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id)));
});

// Delete clip
app.delete('/api/clips/:id', (req, res) => {
  const info = db.prepare('DELETE FROM clips WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Copy (increment count)
app.post('/api/clips/:id/copy', (req, res) => {
  db.prepare('UPDATE clips SET copyCount = copyCount + 1 WHERE id = ?').run(req.params.id);
  const row = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(rowToClip(row));
});

// List categories
app.get('/api/categories', (_, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});

// Create category
app.post('/api/categories', (req, res) => {
  const { name, icon = '📋', color = '#6366f1' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = db.prepare('INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)').run(name, icon, color);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    res.status(409).json({ error: 'Category already exists' });
  }
});

app.listen(PORT, () => console.log(`ClipBoard backend running on :${PORT}`));
