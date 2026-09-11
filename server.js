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

// ---- CORS: only allow your actual site (and the admin panel's own origin) to call this API ----
// Add any other origins you need (e.g. a custom domain later) to this list.
const ALLOWED_ORIGINS = [
  'https://kushaagragiriwar.github.io',
  'https://kushaagra-comments-api.onrender.com', // the admin panel is served from here too
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

// CORS errors currently crash into a generic 500 HTML page, which breaks
// the admin login's fetch/JSON parsing. Return a clean JSON error instead.
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }
  next(err);
});

// ---- Database ----
// Works with Neon, Supabase, or any hosted Postgres that requires SSL
// (which is all of them) — this doesn't need to know which provider you used.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      alt TEXT NOT NULL DEFAULT '',
      featured BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Safe to run even if the column already exists from a previous deploy.
  await pool.query(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;`);
  // One-time seed: if the photos table is empty, populate it with the
  // photos that were already hardcoded into the site, so switching to the
  // dynamic system doesn't make the gallery empty on first deploy.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM photos');
  if (rows[0].count === 0) {
    const seedPhotos = [
      ['1PesN_J9r6QSmVPsRLNOTVknUgXMzQEGN', 'Kushaagra performing'],
      ['1x2lRjmr5zEWrB0Xwe89JK7vyh1HUuuHC', 'Kushaagra performing'],
      ['1MSq3M9N0Fcge7SqtMRBdr06kCy5EjCXJ', 'Kushaagra performing'],
      ['1WDfmvZTXP2ln3um7jnCobMuqsbOxb0u2', 'Duo performance'],
      ['19d7qjBMii7j6ljnACDoUB5LP6V4VGcKI', 'Duo performance'],
      ['1CCU5eVN57EJFeSMK6qmCuqHQGtZmM1si', 'Band performance at IIT Delhi'],
      ['1B-VqcZVGXBYHpGpNzj9v8LNe3f4ncG2_', 'Band performance'],
    ];
    for (const [fileId, alt] of seedPhotos) {
      const url = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
      await pool.query('INSERT INTO photos (url, alt) VALUES ($1, $2)', [url, alt]);
    }
    console.log('Seeded photos table with existing photos.');
  }
  console.log('Database ready.');
}

// Accepts either a raw Google Drive file ID, a full share link
// (https://drive.google.com/file/d/FILE_ID/view...), or an already-direct
// image URL — and returns a usable direct image URL either way.
function normalizePhotoUrl(input) {
  const driveIdMatch = input.match(/\/d\/([a-zA-Z0-9_-]+)/) || input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (driveIdMatch) {
    return `https://drive.google.com/thumbnail?id=${driveIdMatch[1]}&sz=w1000`;
  }
  // Looks like a bare Drive file ID (no slashes, no dots, decently long)
  if (/^[a-zA-Z0-9_-]{15,}$/.test(input.trim())) {
    return `https://drive.google.com/thumbnail?id=${input.trim()}&sz=w1000`;
  }
  // Otherwise assume it's already a usable direct image URL
  return input.trim();
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

// Get all photos (what visitors see on the public site's gallery)
app.get('/api/photos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, url, alt, featured, created_at FROM photos ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load photos.' });
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

// Add a new photo — accepts a Drive share link, a bare Drive file ID, or a
// direct image URL, and normalizes it to something the gallery can display.
app.post('/api/admin/photos', requireAdmin, async (req, res) => {
  const { url, alt } = req.body || {};
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'A photo link or file ID is required.' });
  }
  try {
    const normalizedUrl = normalizePhotoUrl(url);
    const result = await pool.query(
      'INSERT INTO photos (url, alt) VALUES ($1, $2) RETURNING id, url, alt, created_at',
      [normalizedUrl, (alt || '').trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add photo.' });
  }
});

// Delete a photo
app.delete('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM photos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete photo.' });
  }
});

// Toggle whether a photo is featured in the homepage hero slideshow
app.patch('/api/admin/photos/:id/featured', requireAdmin, async (req, res) => {
  const { featured } = req.body || {};
  try {
    const result = await pool.query(
      'UPDATE photos SET featured = $1 WHERE id = $2 RETURNING id, url, alt, featured, created_at',
      [!!featured, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Photo not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update photo.' });
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
