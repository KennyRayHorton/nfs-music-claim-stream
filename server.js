import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import cookieParser from 'cookie-parser';
import mime from 'mime-types';
import { customAlphabet } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = new Database(path.join(__dirname, 'data.sqlite'));
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3001';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// --- DB ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  file_path TEXT NOT NULL,
  cover_url TEXT
);
CREATE TABLE IF NOT EXISTS nfc_tags (
  code TEXT PRIMARY KEY,
  album_slug TEXT NOT NULL,
  claimed_by_user_id INTEGER,
  claimed_at DATETIME,
  FOREIGN KEY (album_slug) REFERENCES albums(slug)
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, device_id)
);
`);

// seed demo album + tag
const count = db.prepare('SELECT COUNT(*) as c FROM albums').get().c;
if (!count) {
  db.prepare('INSERT INTO albums (slug, title, artist, file_path, cover_url) VALUES (?,?,?,?,?)')
    .run('olivia-alexandra-ep', 'Olivia Alexandra EP', 'Kenny Ray Horton', path.join(__dirname, 'music/sample.mp3'), '/public/cover-placeholder.png');
  db.prepare('INSERT OR IGNORE INTO nfc_tags (code, album_slug) VALUES (?,?)').run('DEMO1234', 'olivia-alexandra-ep');
  console.log('Seeded album and demo tag code: DEMO1234');
}

// --- App basics ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan('dev'));

// Helpers
const nano6 = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
function issueAuthToken(userId, deviceId) {
  return jwt.sign({ uid: userId, did: deviceId, kind: 'auth' }, JWT_SECRET, { expiresIn: '30d' });
}
function issueStreamToken(userId, albumSlug, deviceId) {
  return jwt.sign({ uid: userId, slug: albumSlug, did: deviceId, kind: 'stream' }, JWT_SECRET, { expiresIn: '60s' });
}
function getUserFromReq(req) {
  const token = req.cookies['krh_auth'];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'auth') return null;
    return { id: payload.uid, deviceId: payload.did };
  } catch (e) { return null; }
}
function ensureDevice(userId, deviceId) {
  try { db.prepare('INSERT OR IGNORE INTO devices (user_id, device_id) VALUES (?,?)').run(userId, deviceId); } catch (_) {}
  const cnt = db.prepare('SELECT COUNT(*) as c FROM devices WHERE user_id = ?').get(userId).c;
  return cnt <= 2; // allow up to 2 devices
}

// Routes
app.get('/', (req, res) => {
  res.render('home');
});

// Claim page: first-tap binds tag to a user
app.get('/claim/:code', (req, res) => {
  const tag = db.prepare('SELECT * FROM nfc_tags WHERE code = ?').get(req.params.code);
  if (!tag) return res.status(404).render('message', { title: 'Invalid tag', message: 'This NFC code is not recognized.' });
  const user = getUserFromReq(req);
  if (!tag.claimed_by_user_id) {
    if (!user) return res.render('claim', { code: tag.code, album_slug: tag.album_slug, step: 'need_login' });
    // bind now
    db.prepare('UPDATE nfc_tags SET claimed_by_user_id = ?, claimed_at = CURRENT_TIMESTAMP WHERE code = ?').run(user.id, tag.code);
    return res.redirect(`/play/${encodeURIComponent(tag.album_slug)}`);
  } else {
    if (user && user.id === tag.claimed_by_user_id) {
      return res.redirect(`/play/${encodeURIComponent(tag.album_slug)}`);
    }
    return res.status(403).render('message', { title: 'Already claimed', message: 'This NFC has already been claimed by an owner.' });
  }
});

// Start OTP login
app.post('/auth/start', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const code = nano6();
  const expiresAt = new Date(Date.now() + 10*60*1000).toISOString(); // 10 min
  db.prepare('INSERT INTO login_codes (email, code, expires_at) VALUES (?,?,?)').run(email.toLowerCase(), code, expiresAt);
  // Upsert user
  db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').run(email.toLowerCase());
  console.log(`[LOGIN CODE] ${email} -> ${code} (valid 10 min)`);
  // In production: send email with code/magic link
  res.json({ ok: true, notice: 'A login code has been sent to your email (for demo, check server logs).' });
});

app.post('/auth/verify', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
  const row = db.prepare('SELECT * FROM login_codes WHERE email = ? AND code = ? AND used = 0 ORDER BY id DESC').get(email.toLowerCase(), code);
  if (!row) return res.status(400).json({ error: 'Invalid code' });
  if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Code expired' });
  db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // device id cookie (bind user to up to 2 devices)
  let deviceId = req.cookies['krh_device'];
  if (!deviceId) {
    deviceId = 'd_' + Math.random().toString(36).slice(2, 10);
    res.cookie('krh_device', deviceId, { httpOnly: true, sameSite: 'lax', maxAge: 365*24*60*60*1000 });
  }
  const ok = ensureDevice(user.id, deviceId);
  if (!ok) return res.status(403).json({ error: 'Device limit reached (2). Manage devices from your account.' });
  const authToken = issueAuthToken(user.id, deviceId);
  res.cookie('krh_auth', authToken, { httpOnly: true, sameSite: 'lax', maxAge: 30*24*60*60*1000 });
  res.json({ ok: true });
});

// Player page: owner only (or same user if claimed)
app.get('/play/:slug', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE slug = ?').get(req.params.slug);
  if (!album) return res.status(404).render('message', { title: 'Not found', message: 'Album does not exist.' });
  const tag = db.prepare('SELECT * FROM nfc_tags WHERE album_slug = ?').get(album.slug);
  const user = getUserFromReq(req);
  if (!tag || !tag.claimed_by_user_id) {
    return res.status(403).render('message', { title: 'Not claimed yet', message: 'Please claim this album via its NFC tag first.' });
  }
  if (!user || user.id !== tag.claimed_by_user_id) {
    return res.status(403).render('message', { title: 'Not your tag', message: 'This album belongs to a different owner.' });
  }
  // generate a short-lived stream token
  const token = issueStreamToken(user.id, album.slug, user.deviceId);
  res.render('player', { album, token });
});

// Issue fresh stream token (AJAX) to keep playback alive
app.post('/api/stream-token', (req, res) => {
  const user = getUserFromReq(req);
  const { slug } = req.body;
  if (!user || !slug) return res.status(401).json({ error: 'Unauthorized' });
  const tag = db.prepare('SELECT * FROM nfc_tags WHERE album_slug = ?').get(slug);
  if (!tag || tag.claimed_by_user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
  const token = issueStreamToken(user.id, slug, user.deviceId);
  res.json({ token });
});

// Stream endpoint guarded by 60s token + device binding
app.get('/stream/:slug', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).send('Missing token');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'stream') return res.status(403).send('Invalid token');
    const user = getUserFromReq(req);
    if (!user || user.id !== payload.uid || user.deviceId !== payload.did) return res.status(403).send('Device mismatch');
    if (payload.slug !== req.params.slug) return res.status(403).send('Slug mismatch');
    const album = db.prepare('SELECT * FROM albums WHERE slug = ?').get(req.params.slug);
    if (!album) return res.status(404).send('Not found');
    const filePath = album.file_path;
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;
    const contentType = mime.contentType(path.extname(filePath)) || 'audio/mpeg';

    res.setHeader('Content-Type', contentType);
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/,'').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;
      if (start >= total || end >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end(); return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', (end - start) + 1);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    return res.status(401).send('Invalid or expired token');
  }
});

// Simple account page and device management (list only in demo)
app.get('/me', (req, res) => {
  const user = getUserFromReq(req);
  if (!user) return res.render('message', { title: 'Not signed in', message: 'Please sign in via an NFC claim flow.' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const devices = db.prepare('SELECT device_id, created_at FROM devices WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  res.render('me', { user: u, devices });
});

// Views
app.get('/demo', (req, res) => {
  // helper page showing how to test the flow
  res.render('demo', { tagUrl: `${APP_BASE_URL}/claim/DEMO1234` });
});

// --- Views & static assets ---
