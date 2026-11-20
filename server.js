const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const db = require('./db');
const { seedIfEmpty } = require('./seed');

const PORT = Number(process.env.PORT) || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const TOKEN_TTL = '7d';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// JWT secret: use JWT_SECRET if set, otherwise generate one on first run and
// keep it in .jwt-secret so sessions survive restarts. Never hardcoded.
// ---------------------------------------------------------------------------
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = path.join(__dirname, '.jwt-secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    return secret;
  }
}
const JWT_SECRET = loadJwtSecret();

// ---------------------------------------------------------------------------
// App + basic hardening
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(404, 'Not found');
  return n;
}

function issueToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL,
  });
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(Number(payload.sub));
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

// Tiny in-memory rate limiter for auth endpoints (per IP).
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many attempts, try again later' });
    }
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

// Every note lookup is scoped to the logged-in user. A note owned by someone
// else is indistinguishable from a missing one (404), so IDs can't be probed.
const getOwnedNote = db.prepare(
  'SELECT id, title, body, created_at FROM notes WHERE id = ? AND user_id = ?'
);

function loadOwnedNote(req, res, next) {
  const note = getOwnedNote.get(parseId(req.params.id), req.user.id);
  if (!note) throw httpError(404, 'Note not found');
  req.note = note;
  next();
}

function publicAttachment(a) {
  return {
    id: a.id,
    original_name: a.original_name,
    mime_type: a.mime_type,
    size: a.size,
    created_at: a.created_at,
  };
}

function unlinkQuietly(storedName) {
  fs.unlink(path.join(UPLOAD_DIR, storedName), () => {});
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', authLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw httpError(400, 'Please enter a valid email address');
  }
  if (password.length < 8 || password.length > 128) {
    throw httpError(400, 'Password must be 8–128 characters');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw httpError(409, 'An account with that email already exists');
  }

  const hash = bcrypt.hashSync(password, 12);
  const info = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, hash);
  const user = { id: Number(info.lastInsertRowid), email };
  res.status(201).json({ token: issueToken(user), user });
});

// Dummy hash so unknown emails take the same time as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
  const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) throw httpError(401, 'Invalid email or password');

  const user = { id: row.id, email: row.email };
  res.json({ token: issueToken(user), user });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Notes routes (all require auth, all scoped to req.user)
// ---------------------------------------------------------------------------
app.get('/api/notes', requireAuth, (req, res) => {
  const notes = db
    .prepare(
      `SELECT n.id, n.title, substr(n.body, 1, 140) AS preview, n.created_at,
              (SELECT COUNT(*) FROM attachments a WHERE a.note_id = n.id) AS attachment_count
         FROM notes n
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC, n.id DESC`
    )
    .all(req.user.id);
  res.json({ notes });
});

app.post('/api/notes', requireAuth, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '');
  if (!title) throw httpError(400, 'Title is required');
  if (title.length > 200) throw httpError(400, 'Title must be 200 characters or fewer');
  if (body.length > 50000) throw httpError(400, 'Body must be 50,000 characters or fewer');

  const info = db
    .prepare('INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)')
    .run(req.user.id, title, body);
  const note = getOwnedNote.get(Number(info.lastInsertRowid), req.user.id);
  res.status(201).json({ note: { ...note, attachments: [] } });
});

app.get('/api/notes/:id', requireAuth, loadOwnedNote, (req, res) => {
  const attachments = db
    .prepare('SELECT * FROM attachments WHERE note_id = ? ORDER BY id')
    .all(req.note.id)
    .map(publicAttachment);
  res.json({ note: { ...req.note, attachments } });
});

app.delete('/api/notes/:id', requireAuth, loadOwnedNote, (req, res) => {
  const files = db
    .prepare('SELECT stored_name FROM attachments WHERE note_id = ?')
    .all(req.note.id);
  db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(req.note.id, req.user.id);
  files.forEach((f) => unlinkQuietly(f.stored_name));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
// Files are stored under a random server-generated name with no extension, so
// the client never controls the on-disk path. The original filename is kept in
// the DB for display / download only.
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(24).toString('hex')),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
  defParamCharset: 'utf8',
});

function cleanFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'file').slice(0, 200);
}

// Ownership is checked *before* multer runs, so nothing is written to disk for
// a note the caller doesn't own.
app.post(
  '/api/notes/:id/attachments',
  requireAuth,
  loadOwnedNote,
  upload.single('file'),
  (req, res) => {
    if (!req.file) throw httpError(400, 'No file uploaded (field name must be "file")');
    const info = db
      .prepare(
        'INSERT INTO attachments (note_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        req.note.id,
        cleanFilename(req.file.originalname),
        req.file.filename,
        String(req.file.mimetype || 'application/octet-stream').slice(0, 100),
        req.file.size
      );
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json({ attachment: publicAttachment(row) });
  }
);

const getOwnedAttachment = db.prepare(
  'SELECT * FROM attachments WHERE id = ? AND note_id = ?'
);

app.get('/api/notes/:id/attachments/:attId', requireAuth, loadOwnedNote, (req, res) => {
  const att = getOwnedAttachment.get(parseId(req.params.attId), req.note.id);
  if (!att) throw httpError(404, 'Attachment not found');

  const filePath = path.join(UPLOAD_DIR, att.stored_name);
  if (path.dirname(filePath) !== UPLOAD_DIR) throw httpError(404, 'Attachment not found');

  // Always served as a download with a generic content type, so an uploaded
  // HTML/SVG file can't execute in the app's origin.
  res.download(filePath, att.original_name, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store' },
  });
});

app.delete('/api/notes/:id/attachments/:attId', requireAuth, loadOwnedNote, (req, res) => {
  const att = getOwnedAttachment.get(parseId(req.params.attId), req.note.id);
  if (!att) throw httpError(404, 'Attachment not found');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  unlinkQuietly(att.stored_name);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Fallbacks + error handling
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`
        : err.message;
    return res.status(status).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

seedIfEmpty();

app.listen(PORT, () => {
  console.log(`Notes app running at http://localhost:${PORT}`);
});
