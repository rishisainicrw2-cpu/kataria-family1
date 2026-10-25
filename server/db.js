// SQLite via Node's built-in node:sqlite (Node >= 22.5). Zero npm dependencies.
// NOTE: reconstructed from the schema of the project's earlier test databases after this file was
// accidentally overwritten; the schema below is the original one, verbatim.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const cfg = require('./config');

const db = new DatabaseSync(cfg.DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
  photo BLOB, photo_mime TEXT, photo_v INTEGER DEFAULT 0,
  prefs TEXT DEFAULT '{}', reset_hash TEXT, reset_expires INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS families(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, accent TEXT, currency TEXT DEFAULT '₹',
  sections TEXT, logo BLOB, logo_mime TEXT, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS memberships(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), perms TEXT DEFAULT '{}', joined_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS ix_mem_family ON memberships(family_id);

CREATE TABLE IF NOT EXISTS invites(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL, role TEXT NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, created_by TEXT, revoked INTEGER DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  type TEXT NOT NULL, name TEXT NOT NULL, plan_id TEXT, created_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS ix_rooms_family ON rooms(family_id);

CREATE TABLE IF NOT EXISTS room_members(
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(room_id,user_id));

CREATE TABLE IF NOT EXISTS room_state(
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room_id,user_id));

CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, text TEXT DEFAULT '', reply_to INTEGER,
  file_id TEXT, client_id TEXT, created_at INTEGER NOT NULL, edited_at INTEGER, deleted INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0);

CREATE INDEX IF NOT EXISTS ix_msg_room ON messages(room_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_client ON messages(room_id,user_id,client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reactions(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL, PRIMARY KEY(message_id,user_id,emoji));

CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  drive_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, category TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL, caption TEXT, album_id TEXT, plan_id TEXT, room_id TEXT,
  created_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS ix_files_family ON files(family_id,category);

CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, category TEXT, starts_at INTEGER NOT NULL, location TEXT, budget REAL,
  status TEXT NOT NULL DEFAULT 'upcoming', reminder_mins INTEGER DEFAULT 0, reminded INTEGER DEFAULT 0,
  room_id TEXT, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS plan_participants(
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp TEXT, PRIMARY KEY(plan_id,user_id));

CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, family_id TEXT NOT NULL,
  title TEXT NOT NULL, assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL, due_at INTEGER, done INTEGER DEFAULT 0,
  created_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS polls(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
  question TEXT NOT NULL, options TEXT NOT NULL, closed INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS votes(
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opt INTEGER NOT NULL, PRIMARY KEY(poll_id,user_id));

CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER, location TEXT,
  reminder_mins INTEGER DEFAULT 0, reminded INTEGER DEFAULT 0, created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS shopping_lists(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, name TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS shopping_items(
  id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE, name TEXT NOT NULL,
  qty REAL DEFAULT 1, price REAL, assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL, link TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS expenses(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, title TEXT NOT NULL, amount REAL NOT NULL,
  date TEXT NOT NULL, category TEXT, paid_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS expense_splits(
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(expense_id,user_id));

CREATE TABLE IF NOT EXISTS albums(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT,
  created_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, url TEXT, kind TEXT, read INTEGER DEFAULT 0, created_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id,id);

CREATE TABLE IF NOT EXISTS announcements(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT,
  created_by TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS drive_config(
  family_id TEXT PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE, refresh_enc TEXT, account TEXT,
  root_folder_id TEXT, folder_ids TEXT DEFAULT '{}', status TEXT DEFAULT 'connected', connected_at INTEGER);

CREATE TABLE IF NOT EXISTS push_subs(
  endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, sub TEXT NOT NULL);

-- Additional Google accounts pooled into the clan's storage. The first account stays in drive_config (it also holds the DB backups).
CREATE TABLE IF NOT EXISTS drive_extra(
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE, refresh_enc TEXT NOT NULL, account TEXT,
  root_folder_id TEXT, folder_ids TEXT DEFAULT '{}', status TEXT DEFAULT 'connected', connected_at INTEGER);

CREATE INDEX IF NOT EXISTS ix_drive_extra_family ON drive_extra(family_id);
`);

// Migration: which pooled account holds each file (NULL = the main account). Runs after a restore too, so older backups upgrade cleanly.
if (!db.prepare('PRAGMA table_info(files)').all().some(c => c.name === 'drive_acct')) db.exec('ALTER TABLE files ADD COLUMN drive_acct TEXT');
// Game IDs shown on a player's profile (BGMI UID, Free Fire ID). Optional text, digits only (checked in the API).
for (const col of ['bgmi_uid', 'ff_uid']) if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);

const stats = { writes: 0 };   // bumped on every write; the Drive backup job uses it to know when something changed
const cache = new Map();
function stmt(sql) { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; }
const clean = a => a.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const q = {
  get: (sql, ...p) => stmt(sql).get(...clean(p)),
  all: (sql, ...p) => stmt(sql).all(...clean(p)),
  run: (sql, ...p) => { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) stats.writes++; return stmt(sql).run(...clean(p)); },   // returns { changes, lastInsertRowid }
};
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
const uid = () => crypto.randomBytes(9).toString('base64url');   // 12-char url-safe id
const now = () => Date.now();
const json = (s, fallback = {}) => { if (s === null || s === undefined || s === '') return fallback; try { return JSON.parse(s); } catch { return fallback; } };

module.exports = { db, q, tx, uid, now, json, stats };
