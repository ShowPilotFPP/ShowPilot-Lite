'use strict';
// ============================================================
// Visitor messages (ShowPilot v0.33.250+ / Lite v0.5.91+)
// ============================================================
// Visitors send a short message to the show owner from the viewer page
// ({MESSAGE_BOX} placeholder). Messages are private: they are only ever
// listed in the admin (Messages tab) and never shown on any public page.
//
// Off by default (config.visitor_messages_enabled = 0). Abuse limits are on
// by default: one message per visitor every few minutes, a nightly cap per
// visitor and per network address, a flood cap for the whole show, an
// optional word filter (matches are masked, not rejected, so a visitor
// can't probe the list), and the same access code / GPS checks used for
// voting and requests when those are turned on (routes/viewer.js).
//
// This file is byte-identical between ShowPilot and ShowPilot-Lite.
// ============================================================

const crypto = require('crypto');
const { db } = require('./db');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS visitor_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- UTC
  name TEXT,                                      -- optional, as typed (trimmed, max 40)
  message TEXT NOT NULL,                          -- word-filtered text
  filtered INTEGER DEFAULT 0,                     -- 1 = the word filter masked something
  viewer_hash TEXT,                               -- hash of the viewer cookie (rate limits only)
  ip_hash TEXT,                                   -- hash of the IP (rate limits only)
  is_read INTEGER DEFAULT 0
)`;
db.exec(CREATE_TABLE_SQL);
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_created ON visitor_messages(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_visitor_messages_viewer ON visitor_messages(viewer_hash, created_at)');

const NAME_MAX = 40;
const NIGHT_MODIFIER = '-12 hours'; // "per night" = the last 12 hours (bound as a value)
const SHOW_IDLE_MINUTES = 15;    // "during the show" = a song played in the last 15 minutes
const FLOOD_PER_HOUR = 300;      // whole show: stop accepting past this many in an hour

// Built-in word list, used while config.visitor_messages_filter_words is NULL.
// A trailing * matches any word starting with it.
const DEFAULT_FILTER_WORDS = [
  'fuck*', 'motherfuck*', 'shit*', 'bullshit', 'bitch*', 'cunt*', 'cock', 'cocks', 'dick', 'dicks', 'dickhead*',
  'pussy', 'pussies', 'asshole*', 'bastard*', 'slut*', 'whore*', 'fag', 'fags', 'faggot*', 'nigger*', 'nigga*',
  'retard*', 'twat*', 'wanker*', 'porn*', 'penis*', 'vagina*', 'tits', 'boobs', 'cum',
].join('\n');

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Normalized settings from the config row.
function settings(cfg) {
  const c = cfg || {};
  return {
    enabled: c.visitor_messages_enabled === 1,
    when: c.visitor_messages_when === 'always' ? 'always' : 'show',
    maxLength: clampInt(c.visitor_messages_max_length, 20, 1000, 280),
    cooldownMinutes: clampInt(c.visitor_messages_cooldown_minutes, 0, 120, 2),
    nightlyLimit: clampInt(c.visitor_messages_nightly_limit, 0, 100, 5),
    filterEnabled: c.visitor_messages_filter_enabled !== 0,
    filterWords: (c.visitor_messages_filter_words === null || c.visitor_messages_filter_words === undefined)
      ? DEFAULT_FILTER_WORDS : String(c.visitor_messages_filter_words),
  };
}

// Clean up values coming from the admin's PUT /config before they're saved.
function sanitizeSettings(updates) {
  const u = updates;
  if ('visitor_messages_enabled' in u) u.visitor_messages_enabled = u.visitor_messages_enabled ? 1 : 0;
  if ('visitor_messages_filter_enabled' in u) u.visitor_messages_filter_enabled = u.visitor_messages_filter_enabled ? 1 : 0;
  if ('visitor_messages_when' in u) u.visitor_messages_when = u.visitor_messages_when === 'always' ? 'always' : 'show';
  if ('visitor_messages_max_length' in u) u.visitor_messages_max_length = clampInt(u.visitor_messages_max_length, 20, 1000, 280);
  if ('visitor_messages_cooldown_minutes' in u) u.visitor_messages_cooldown_minutes = clampInt(u.visitor_messages_cooldown_minutes, 0, 120, 2);
  if ('visitor_messages_nightly_limit' in u) u.visitor_messages_nightly_limit = clampInt(u.visitor_messages_nightly_limit, 0, 100, 5);
  if ('visitor_messages_filter_words' in u) {
    // null = back to the built-in list; otherwise keep the text (max 20 KB).
    u.visitor_messages_filter_words = u.visitor_messages_filter_words === null ? null : String(u.visitor_messages_filter_words).slice(0, 20000);
  }
  return u;
}

// Is the show "on" for the purpose of the "only during the show" choice?
// Viewer control must not be Off, and a song must have played recently.
function showIsOn(cfg, np) {
  if (!cfg || cfg.viewer_control_mode === 'OFF') return false;
  if (!np || !np.last_updated) return false;
  const ms = Date.parse(String(np.last_updated).replace(' ', 'T') + (/[Z+]/.test(String(np.last_updated)) ? '' : 'Z'));
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) <= SHOW_IDLE_MINUTES * 60_000;
}

// What the viewer page needs (bootstrap + every /api/state poll).
function viewerState(cfg, np) {
  const s = settings(cfg);
  const open = s.enabled && (s.when === 'always' || showIsOn(cfg, np));
  return { enabled: s.enabled, open, maxLength: s.maxLength };
}

// ---- Word filter ----
// Same-length character folding, so match positions line up with the
// original text and only the offending letters get masked.
const FOLD = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't' };
function fold(text) {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    // Keep one output unit per input unit so indexes stay aligned.
    const f = FOLD[lower] || lower;
    out += f.length === ch.length ? f : ch;
  }
  return out;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
let filterCache = { src: null, re: null };
function filterRegex(words) {
  if (filterCache.src === words) return filterCache.re;
  const parts = String(words || '').split(/[\n,]+/).map(w => w.trim().toLowerCase()).filter(Boolean).slice(0, 2000)
    .map(w => w.endsWith('*') ? escapeRe(w.slice(0, -1)) + '[a-z]*' : escapeRe(w));
  const re = parts.length ? new RegExp('(?<![a-z])(?:' + parts.join('|') + ')(?![a-z])', 'g') : null;
  filterCache = { src: words, re };
  return re;
}
function applyFilter(text, words) {
  const re = filterRegex(words);
  if (!re) return { text, filtered: false };
  const folded = fold(text);
  if (folded.length !== text.length) return { text, filtered: false };
  const chars = text.split('');
  let hit = false;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(folded)) !== null) {
    if (!m[0].length) { re.lastIndex++; continue; }
    hit = true;
    for (let i = m.index; i < m.index + m[0].length; i++) chars[i] = '*';
  }
  return { text: hit ? chars.join('') : text, filtered: hit };
}

function hash(s) {
  return crypto.createHash('sha256').update('sp-msg:' + (s || '')).digest('hex').slice(0, 16);
}

function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

// Accept (or refuse) a message from a viewer.
// Returns { ok: true } or { ok: false, status, reason: 'closed'|'empty'|'tooSoon'|'busy', error, retryAfterSeconds? }
function submit(cfg, np, { text, name, viewerToken, ip }) {
  const s = settings(cfg);
  const vs = viewerState(cfg, np);
  if (!vs.enabled || !vs.open) {
    return { ok: false, status: 400, reason: 'closed', error: 'Messages are closed right now.' };
  }
  const rawText = String(text == null ? '' : text);
  if (rawText.trim().length > s.maxLength + 20) {
    return { ok: false, status: 400, reason: 'empty', error: 'That message is too long (' + s.maxLength + ' characters max).' };
  }
  let message = cleanText(rawText, s.maxLength);
  let who = cleanText(name, NAME_MAX).replace(/\n/g, ' ');
  if (!message) return { ok: false, status: 400, reason: 'empty', error: 'Please type a message first.' };

  const vh = hash(viewerToken || ('ip:' + (ip || '')));
  const ih = hash(ip || '');

  if (s.cooldownMinutes > 0) {
    const last = db.prepare('SELECT created_at FROM visitor_messages WHERE viewer_hash = ? ORDER BY id DESC LIMIT 1').get(vh);
    if (last) {
      const lastMs = Date.parse(String(last.created_at).replace(' ', 'T') + 'Z');
      const waitMs = lastMs + s.cooldownMinutes * 60_000 - Date.now();
      if (Number.isFinite(waitMs) && waitMs > 0) {
        const secs = Math.ceil(waitMs / 1000);
        const mins = Math.ceil(secs / 60);
        return { ok: false, status: 429, reason: 'tooSoon', retryAfterSeconds: secs,
          error: 'Thanks! You can send another message in ' + (secs < 60 ? secs + ' seconds.' : mins + (mins === 1 ? ' minute.' : ' minutes.')) };
      }
    }
  }
  if (s.nightlyLimit > 0) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE viewer_hash = ? AND created_at > datetime('now', ?)").get(vh, NIGHT_MODIFIER).n;
    if (n >= s.nightlyLimit) {
      return { ok: false, status: 429, reason: 'tooSoon', error: "Thanks for all your messages! That's the limit for tonight." };
    }
  }
  // Per network address: generous (families and phone carriers share
  // addresses), but stops one device from clearing its cookie to spam.
  const ipCap = s.nightlyLimit > 0 ? Math.max(20, s.nightlyLimit * 4) : 100;
  const ipCount = db.prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE ip_hash = ? AND created_at > datetime('now', ?)").get(ih, NIGHT_MODIFIER).n;
  if (ipCount >= ipCap) {
    return { ok: false, status: 429, reason: 'tooSoon', error: "Thanks for all your messages! That's the limit for tonight." };
  }
  const hourCount = db.prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE created_at > datetime('now', '-1 hours')").get().n;
  if (hourCount >= FLOOD_PER_HOUR) {
    return { ok: false, status: 503, reason: 'busy', error: 'Messages are busy right now. Please try again later.' };
  }

  let filtered = false;
  if (s.filterEnabled) {
    const a = applyFilter(message, s.filterWords);
    const b = who ? applyFilter(who, s.filterWords) : { text: who, filtered: false };
    message = a.text; who = b.text; filtered = a.filtered || b.filtered;
  }
  const info = db.prepare('INSERT INTO visitor_messages (name, message, filtered, viewer_hash, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .run(who || null, message, filtered ? 1 : 0, vh, ih);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

// ---- Admin ----
function unreadCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM visitor_messages WHERE is_read = 0').get().n;
}

function list({ filter = 'all', limit = 200, offset = 0 } = {}) {
  // Static SQL only (no string-built queries; Lite's plugin review rule).
  // unreadOnly is bound as 0/1: "? = 0 OR is_read = 0".
  const unreadOnly = filter === 'unread' ? 1 : 0;
  const lim = clampInt(limit, 1, 1000, 200);
  const off = clampInt(offset, 0, 1e9, 0);
  const rows = db.prepare('SELECT id, created_at, name, message, filtered, is_read FROM visitor_messages WHERE (? = 0 OR is_read = 0) ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(unreadOnly, lim, off);
  const total = db.prepare('SELECT COUNT(*) AS n FROM visitor_messages WHERE (? = 0 OR is_read = 0)').get(unreadOnly).n;
  return { messages: rows, total, unread: unreadCount() };
}

function cleanIds(ids) {
  return (Array.isArray(ids) ? ids : []).map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0).slice(0, 5000);
}

function setRead({ ids, all, read }) {
  const v = read === false ? 0 : 1;
  if (all) return db.prepare('UPDATE visitor_messages SET is_read = ?').run(v).changes;
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const stmt = db.prepare('UPDATE visitor_messages SET is_read = ? WHERE id = ?');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(v, id).changes, 0))();
}

function remove({ ids, allRead, all }) {
  if (all) return db.prepare('DELETE FROM visitor_messages').run().changes;
  if (allRead) return db.prepare('DELETE FROM visitor_messages WHERE is_read = 1').run().changes;
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const stmt = db.prepare('DELETE FROM visitor_messages WHERE id = ?');
  return db.transaction(() => list.reduce((n, id) => n + stmt.run(id).changes, 0))();
}

// CSV for spreadsheets. Cells starting with = + - @ are prefixed with ' so a
// visitor can't plant a formula.
function toCsv() {
  const rows = db.prepare('SELECT id, created_at, name, message, filtered, is_read FROM visitor_messages ORDER BY id DESC').all();
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [['Time (UTC)', 'Name', 'Message', 'Filtered', 'Read'].map(cell).join(',')];
  rows.forEach(r => lines.push([r.created_at, r.name || '', r.message, r.filtered ? 'yes' : '', r.is_read ? 'yes' : ''].map(cell).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  DEFAULT_FILTER_WORDS, settings, sanitizeSettings, showIsOn, viewerState, applyFilter,
  submit, unreadCount, list, setRead, remove, toCsv,
};
