// Comment system backend for the Kushaagra Giriwar artist site.
// Deploy this on Render (Web Service) + Render Postgres (or any Postgres).
//
// Endpoints:
//   POST   /api/comments              -> public, submit a comment (goes in as "pending")
//   GET    /api/comments              -> public, returns only "approved" comments
//   POST   /api/admin/login           -> body { password } -> returns a JWT
//   GET    /api/admin/comments        -> protected, returns ALL comments (pending + approved)
//   PATCH  /api/admin/comments/:id/approve  -> protected, approve a comment
//   DELETE /api/admin/comments/:id    -> protected, delete a comment
//   GET    /admin                     -> serves the admin moderation page

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ---- CORS: only allow your actual site to call this API ----
// Add any other origins you need (e.g. a custom domain later) to this list.
const ALLOWED_ORIGINS = [
  'https://kushaagragiriwar.github.io',
];
app.use(cors({
  origin: function (origin, callback) {
    // allow no-origin requests (e.g. curl, server-to-server) and allowed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
}));

// ---- Database ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Database ready.');
}

// ---- Config ----
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!JWT_SECRET || !ADMIN_PASSWORD) {
  console.warn('WARNING: JWT_SECRET and/or ADMIN_PASSWORD env vars are not set. Set them on Render before going live.');
}

// ---- Rate limiting on public submit endpoint (basic spam/abuse protection) ----
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 submissions per IP per window
  message: { error: 'Too many comments submitted. Please try again later.' },
});

// ---- Auth middleware for admin routes ----
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing admin token' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// PUBLIC ROUTES
// ---------------------------------------------------------------------------

// Submit a new comment (goes in as "pending" — not visible until approved)
app.post('/api/comments', submitLimiter, async (req, res) => {
  const { name, contact, message, website } = req.body || {};

  // Honeypot: real visitors never fill this hidden field; bots often do.
  if (website) {
    return res.status(200).json({ ok: true }); // silently pretend success
  }

  if (!name || !contact || !message) {
    return res.status(400).json({ error: 'Name, contact, and message are all required.' });
  }
  if (name.length > 100 || contact.length > 150 || message.length > 1000) {
    return res.status(400).json({ error: 'One of the fields is too long.' });
  }

  try {
    await pool.query(
      'INSERT INTO comments (name, contact, message, status) VALUES ($1, $2, $3, $4)',
      [name.trim(), contact.trim(), message.trim(), 'pending']
    );
    res.status(201).json({ ok: true, note: 'Thanks! Your comment is awaiting approval.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong saving your comment.' });
  }
});

// Get only approved comments (what visitors see on the public site)
app.get('/api/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, message, created_at
       FROM comments
       WHERE status = 'approved'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

// ---------------------------------------------------------------------------
// ADMIN ROUTES
// ---------------------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// All comments, pending + approved (for the moderation queue)
app.get('/api/admin/comments', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, contact, message, status, created_at
       FROM comments
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

// Approve a pending comment
app.patch('/api/admin/comments/:id/approve', requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE comments SET status = 'approved' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not approve comment.' });
  }
});

// Delete a comment (approved or pending)
app.delete('/api/admin/comments/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete comment.' });
  }
});

// Serve the admin moderation page (plain HTML/JS, no framework)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
  res.send('Kushaagra comments API is running. Admin panel: /admin');
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
