// ============================================================
// ShowPilot — Viewer API
// Public endpoints consumed by the viewer page (browser).
// Enforces all viewer-side safeguards configured in admin.
// ============================================================

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const config = require('../lib/config-loader');
const { db, getConfig, getNowPlaying, getActiveViewerCount, getSequenceByName, castTiebreakVote } = require('../lib/db');
const { bustCoverUrl } = require('../lib/cover-art');

function ensureViewerToken(req, res) {
  let token = req.cookies[config.sessionCookieName + '_viewer'];
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    res.cookie(config.sessionCookieName + '_viewer', token, {
      httpOnly: true,
      sameSite: 'lax',
      // Auto-set secure flag when served over HTTPS. Same logic as admin
      // session cookie — req.secure respects Express's trust proxy.
      secure: !!req.secure,
      maxAge: 1000 * 60 * 60 * 24 * 365,
    });
  }
  return token;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex').substring(0, 16);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
}

// True if the client is on the same private LAN as FPP. Used to decide
// whether we can hand them a 192.168.x.x daemon URL or whether they need
// to go through our public proxy.
//
// Considered "same LAN" if:
//   - FPP host is a private/local IP (RFC 1918 / loopback / link-local), AND
//   - the client IP is also a private/local IP.
// Public-internet visitors get the proxy fallback only.
function isPrivateIp(ip) {
  if (!ip) return false;
  // Strip IPv6-mapped IPv4 prefix
  const v = ip.replace(/^::ffff:/, '');
  if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (v.startsWith('169.254.')) return true; // link-local
  // 172.16.0.0 – 172.31.255.255
  const m = v.match(/^172\.(\d+)\./);
  if (m) {
    const second = parseInt(m[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ipIsBlocked(cfg, ip) {
  if (!cfg.blocked_ips) return false;
  const list = cfg.blocked_ips.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(ip);
}

function isSequenceHidden(seq, cfg) {
  if (!cfg.hide_sequence_after_played || cfg.hide_sequence_after_played === 0) return false;
  if (!seq.last_played_at) return false;
  return seq.plays_since_hidden < cfg.hide_sequence_after_played;
}

// Per-sequence cooldown check (v0.3.2+). Returns null if the sequence
// is NOT in cooldown (or has cooldown disabled), or an ISO timestamp
// string indicating when the cooldown expires. The check is purely
// query-time — there's no scheduled job to clear it; it just naturally
// stops being true once enough time has passed.
//
// Used in three places: viewer state (so the UI can gray out), jukebox
// add (defense in depth — UI hides it but reject the request server-side
// too), and voting nomination (filter out cooled-down sequences).
function sequenceCooldownUntil(seq) {
  if (!seq.cooldown_minutes || seq.cooldown_minutes <= 0) return null;
  if (!seq.last_played_at) return null;
  // SQLite stores last_played_at as a UTC string ('YYYY-MM-DD HH:MM:SS').
  // Treat it as UTC by appending 'Z' if no timezone is present, so Date
  // parsing doesn't apply local-time interpretation.
  const lpa = String(seq.last_played_at);
  const utc = /[Z+\-]/.test(lpa.slice(-6)) ? lpa : lpa.replace(' ', 'T') + 'Z';
  const lastMs = Date.parse(utc);
  if (!Number.isFinite(lastMs)) return null;
  const untilMs = lastMs + seq.cooldown_minutes * 60_000;
  if (untilMs <= Date.now()) return null;
  return new Date(untilMs).toISOString();
}

function viewerPresenceCheck(req, cfg) {
  if (!cfg.check_viewer_present) return { ok: true };
  if (cfg.viewer_present_mode !== 'GPS') return { ok: true };
  if (!cfg.show_latitude || !cfg.show_longitude) {
    return { ok: false, error: 'Show location not configured on server' };
  }
  const lat = parseFloat(req.body?.viewerLat ?? req.query?.lat);
  const lng = parseFloat(req.body?.viewerLng ?? req.query?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'Location required to vote/request. Please allow location access.' };
  }
  const dist = distanceMiles(cfg.show_latitude, cfg.show_longitude, lat, lng);
  if (dist > cfg.check_radius_miles) {
    return { ok: false, error: `You must be within ${cfg.check_radius_miles} miles of the show to interact.` };
  }
  return { ok: true };
}

function runSafeguards(req, res, requiredMode) {
  const cfg = getConfig();
  if (cfg.viewer_control_mode !== requiredMode) {
    res.status(400).json({ error: `${requiredMode.toLowerCase()} is not currently enabled` });
    return null;
  }
  const ip = getClientIp(req);
  if (ipIsBlocked(cfg, ip)) {
    res.status(403).json({ error: 'Your IP has been blocked' });
    return null;
  }
  const presence = viewerPresenceCheck(req, cfg);
  if (!presence.ok) {
    res.status(403).json({ error: presence.error });
    return null;
  }
  return cfg;
}

// GET /api/time
// ============================================================
// Lightweight time endpoint for NTP-style clock sync. The viewer
// calls this in bursts of 3-5 to estimate clock skew between phone
// and server with ~10-20ms accuracy. The implementation is deliberately
// minimal — no auth, no DB, no logging — to minimize server-side
// processing latency, which would otherwise corrupt the round-trip
// time measurement and skew the offset calculation.
//
// Why this matters: phones' Date.now() can be off from real time by
// hundreds of ms or more, especially after waking from sleep, and
// each phone is off by a different amount. Without accurate clock
// sync, two phones aligning to "FPP position + elapsed since update"
// drift apart because they each compute "elapsed" using their own
// (wrong) clocks. With this endpoint, both phones derive an accurate
// server-time reference and align to the same target.
router.get('/time', (req, res) => {
  res.json({ t: Date.now() });
});

router.get('/state', (req, res) => {
  const cfg = getConfig();
  const nowPlaying = getNowPlaying();
  const activeViewers = getActiveViewerCount();

  const allSequences = db.prepare(`
    SELECT id, name, display_name, artist, category, image_url,
           duration_seconds, votable, jukeboxable,
           last_played_at, plays_since_hidden, cooldown_minutes
    FROM sequences
    WHERE visible = 1 AND is_psa = 0
    ORDER BY display_order, display_name
  `).all();

  const { bustSequenceCovers } = require('../lib/cover-art');
  // Filter sequences the viewer shouldn't see right now:
  //   1. count-based hide rule (hide_sequence_after_played) — pre-existing
  //   2. per-sequence cooldown (v0.3.2+) — sequence in cooldown drops out
  //      of the response entirely so user-authored viewer templates don't
  //      need to know about cooldown. They just render whatever's in the
  //      list. When the cooldown expires, the sequence reappears on the
  //      next poll.
  // Both rules can apply independently — a sequence can be hidden by
  // either or both.
  //
  // cooldown_minutes is used internally by the cooldown filter but isn't
  // needed by the viewer client. Strip it so we don't ship configuration
  // state to anonymous users. last_played_at and plays_since_hidden
  // were already exposed to viewers pre-v0.3.2 and we keep them for
  // backward compat with custom templates.
  const sequences = bustSequenceCovers(
    allSequences
      .filter(s => !isSequenceHidden(s, cfg))
      .filter(s => !sequenceCooldownUntil(s))
      .map(({ cooldown_minutes, ...rest }) => rest)
  );

  const voteCounts = db.prepare(`
    SELECT sequence_name, COUNT(*) AS count FROM votes WHERE round_id = ? GROUP BY sequence_name
  `).all(cfg.current_voting_round);

  // Queue: all unplayed entries, ordered by request time. This now includes
  // entries currently handed off to the plugin (handed_off_at IS NOT NULL,
  // played=0). The currently-playing viewer request will be the first such
  // entry; everything after it is genuinely "queued behind."
  const queueAll = db.prepare(`
    SELECT sequence_name, requested_at, handed_off_at FROM jukebox_queue
    WHERE played = 0 ORDER BY requested_at ASC
  `).all();

  // Filter out the currently-playing entry from the queue display
  const nowPlayingName = nowPlaying.sequence_name || null;
  const queue = queueAll.filter(q => q.sequence_name !== nowPlayingName);

  // "Next up" priority order:
  //   1. JUKEBOX mode + queue has entries (after now-playing) → first queued
  //   2. VOTING mode + votes cast → highest-voted song
  //   3. Otherwise → whatever the schedule says
  let nextUp = nowPlaying.next_sequence_name || null;
  if (cfg.viewer_control_mode === 'JUKEBOX' && queue.length > 0) {
    nextUp = queue[0].sequence_name;
  } else if (cfg.viewer_control_mode === 'VOTING') {
    const top = db.prepare(`
      SELECT sequence_name, COUNT(*) AS n FROM votes
      WHERE round_id = ?
      GROUP BY sequence_name
      ORDER BY n DESC
      LIMIT 1
    `).get(cfg.current_voting_round);
    if (top) nextUp = top.sequence_name;
  }

  res.json({
    showName: cfg.show_name,
    viewerControlMode: cfg.viewer_control_mode,
    nowPlaying: nowPlaying.sequence_name || null,
    nextScheduled: nextUp,
    activeViewers,
    sequences,
    voteCounts,
    queue,
    requiresLocation: cfg.check_viewer_present === 1 && cfg.viewer_present_mode === 'GPS',
    // Current voting round id. Viewers track this so they can detect a
    // round change (server advanced past their last vote) and clear
    // their local hasVoted flag. This is the "last-write-wins" backup
    // for the voteReset socket event, which can be missed when mobile
    // devices background-suspend or briefly drop network. Without it,
    // "You've already voted" persists across rounds until manual refresh.
    currentVotingRound: cfg.current_voting_round,
    // Tiebreak state (v0.24.0+) — viewers use this to render the
    // tiebreak banner when reconnecting mid-tiebreak (e.g. someone
    // opened the page after the tiebreakStarted socket event already
    // fired). Empty/false when no tiebreak active.
    tiebreak: cfg.tiebreak_active === 1 ? {
      candidates: (cfg.tiebreak_candidates || '').split(',').map(s => s.trim()).filter(Boolean),
      // Absolute deadline timestamp (ISO server time). Viewer computes
      // remaining = deadline - now using its server-time offset from
      // burst clock sync, so the displayed countdown is accurate
      // regardless of network/render lag.
      deadlineAtIso: cfg.tiebreak_deadline_at,
      startedAtIso: cfg.tiebreak_started_at,
    } : null,
  });
});

router.post('/heartbeat', (req, res) => {
  const token = ensureViewerToken(req, res);
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const ua = (req.headers['user-agent'] || '').substring(0, 255);

  db.prepare(`
    INSERT INTO active_viewers (viewer_token, last_seen, ip_hash, user_agent)
    VALUES (?, CURRENT_TIMESTAMP, ?, ?)
    ON CONFLICT(viewer_token) DO UPDATE SET
      last_seen = CURRENT_TIMESTAMP,
      ip_hash = excluded.ip_hash
  `).run(token, ipHash, ua);

  res.json({ ok: true, token });
});

router.post('/vote', (req, res) => {
  const cfg = runSafeguards(req, res, 'VOTING');
  if (!cfg) return;

  const { sequenceName } = req.body || {};
  if (!sequenceName) return res.status(400).json({ error: 'Missing sequenceName' });

  const seq = getSequenceByName(sequenceName);
  if (!seq) return res.status(404).json({ error: 'Unknown sequence' });
  if (!seq.votable || seq.is_psa) return res.status(400).json({ error: 'Sequence is not votable' });
  if (isSequenceHidden(seq, cfg)) {
    return res.status(400).json({ error: 'That sequence was recently played. Try another.' });
  }
  const cooldownUntilV = sequenceCooldownUntil(seq);
  if (cooldownUntilV) {
    return res.status(400).json({
      error: 'That sequence was recently played. It will be available again shortly.',
      cooldown_until: cooldownUntilV,
    });
  }

  const token = ensureViewerToken(req, res);

  if (cfg.prevent_multiple_votes) {
    const already = db.prepare(
      `SELECT 1 FROM votes WHERE viewer_token = ? AND round_id = ? LIMIT 1`
    ).get(token, cfg.current_voting_round);
    if (already) return res.status(409).json({ error: 'You have already voted this round' });
  }

  try {
    db.prepare(`
      INSERT INTO votes (sequence_id, sequence_name, viewer_token, round_id)
      VALUES (?, ?, ?, ?)
    `).run(seq.id, seq.name, token, cfg.current_voting_round);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'You have already voted this round' });
    }
    throw e;
  }

  // Diagnostic logging — emitted at info level so it shows up in pm2 logs.
  // Helps debug "votes always show 0" reports by confirming what was written.
  // Counts include all rounds for this token+sequence so we can spot if a
  // vote went into the wrong round_id (e.g. round was advanced unexpectedly).
  try {
    const totalForRound = db.prepare(
      `SELECT COUNT(*) AS n FROM votes WHERE round_id = ?`
    ).get(cfg.current_voting_round).n;
    const totalForSeq = db.prepare(
      `SELECT COUNT(*) AS n FROM votes WHERE sequence_name = ? AND round_id = ?`
    ).get(seq.name, cfg.current_voting_round).n;
    console.log(`[vote] seq="${seq.name}" round=${cfg.current_voting_round} token=${(token||'').slice(0,8)} → seq_total=${totalForSeq} round_total=${totalForRound}`);
  } catch (e) {
    console.warn('[vote] diagnostic logging failed:', e.message);
  }

  db.prepare(`UPDATE config SET interactions_since_last_psa = interactions_since_last_psa + 1 WHERE id = 1`).run();

  const io = req.app.get('io');
  if (io) {
    const counts = db.prepare(
      `SELECT sequence_name, COUNT(*) AS count FROM votes WHERE round_id = ? GROUP BY sequence_name`
    ).all(cfg.current_voting_round);
    io.emit('voteUpdate', { counts });
  }

  res.json({ ok: true });
});

// ============================================================
// POST /api/tiebreak-vote
// ============================================================
// Casts a vote during an active tiebreak. Separate from /vote because
// the validation is different (must be a candidate; main-round voters
// allowed; uses tiebreak_votes table) and because the success response
// triggers a different toast on the client. Body: { sequenceName }.
router.post('/tiebreak-vote', (req, res) => {
  const cfg = runSafeguards(req, res, 'VOTING');
  if (!cfg) return;

  if (cfg.tiebreak_active !== 1) {
    return res.status(400).json({ error: 'No tiebreak in progress' });
  }
  const candidates = (cfg.tiebreak_candidates || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const { sequenceName } = req.body || {};
  if (!sequenceName) return res.status(400).json({ error: 'Missing sequenceName' });
  if (!candidates.includes(sequenceName)) {
    return res.status(400).json({ error: 'That sequence is not a tiebreak candidate' });
  }

  const seq = getSequenceByName(sequenceName);
  if (!seq) return res.status(404).json({ error: 'Unknown sequence' });

  const token = ensureViewerToken(req, res);
  const result = castTiebreakVote(token, sequenceName, cfg.current_voting_round, candidates);
  if (result === 'duplicate') {
    return res.status(409).json({ error: 'You have already voted in this tiebreak' });
  }
  if (result === 'invalid_candidate') {
    return res.status(400).json({ error: 'Invalid tiebreak candidate' });
  }

  // Diagnostic logging — mirror the main /vote endpoint.
  try {
    const totalForRound = db.prepare(
      `SELECT COUNT(*) AS n FROM tiebreak_votes WHERE round_id = ?`
    ).get(cfg.current_voting_round).n;
    console.log(`[tiebreak-vote] seq="${seq.name}" round=${cfg.current_voting_round} token=${(token||'').slice(0,8)} → tiebreak_round_total=${totalForRound}`);
  } catch (e) {
    console.warn('[tiebreak-vote] diagnostic logging failed:', e.message);
  }

  // Broadcast updated tiebreak vote tallies so connected viewers see
  // the count tick up. Combined with main-round counts on the client
  // side for the final score display.
  const io = req.app.get('io');
  if (io) {
    const tbCounts = db.prepare(
      `SELECT sequence_name, COUNT(*) AS count FROM tiebreak_votes WHERE round_id = ? GROUP BY sequence_name`
    ).all(cfg.current_voting_round);
    io.emit('tiebreakVoteUpdate', { counts: tbCounts });
  }

  res.json({ ok: true });
});

router.post('/jukebox/add', (req, res) => {
  const cfg = runSafeguards(req, res, 'JUKEBOX');
  if (!cfg) return;

  const { sequenceName } = req.body || {};
  if (!sequenceName) return res.status(400).json({ error: 'Missing sequenceName' });

  const seq = getSequenceByName(sequenceName);
  if (!seq) return res.status(404).json({ error: 'Unknown sequence' });
  if (!seq.jukeboxable || seq.is_psa) {
    return res.status(400).json({ error: 'Sequence is not available via jukebox' });
  }
  if (isSequenceHidden(seq, cfg)) {
    return res.status(400).json({ error: 'That sequence was recently played. Try another.' });
  }
  // Cooldown check (v0.3.2+). The viewer UI already hides cooled-down
  // sequences, but a stale page or a direct API caller could still try
  // to request one — reject server-side too.
  const cooldownUntil = sequenceCooldownUntil(seq);
  if (cooldownUntil) {
    return res.status(400).json({
      error: 'That sequence was recently played. It will be available again shortly.',
      cooldown_until: cooldownUntil,
    });
  }

  const token = ensureViewerToken(req, res);

  // queueSize, sequence-request-limit, and prevent-multiple-requests checks
  // should only count *pending* queue entries (handed_off_at IS NULL).
  // In-flight entries (handed_off_at IS NOT NULL but played=0) are already with
  // the plugin / FPP and shouldn't count against viewers anymore.

  if (cfg.jukebox_queue_depth > 0) {
    const queueSize = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue WHERE played = 0 AND handed_off_at IS NULL`
    ).get().n;
    if (queueSize >= cfg.jukebox_queue_depth) {
      return res.status(409).json({ error: 'The queue is full. Try again later.' });
    }
  }

  if (cfg.jukebox_sequence_request_limit > 0) {
    const seqCount = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue
       WHERE played = 0 AND handed_off_at IS NULL AND sequence_name = ?`
    ).get(seq.name).n;
    if (seqCount >= cfg.jukebox_sequence_request_limit) {
      return res.status(409).json({
        error: `That sequence has been requested the maximum number of times. Try another.`,
      });
    }
  }

  if (cfg.prevent_multiple_requests) {
    const limit = Math.max(1, parseInt(cfg.viewer_request_limit, 10) || 1);
    const existing = db.prepare(
      `SELECT COUNT(*) AS n FROM jukebox_queue
       WHERE viewer_token = ? AND played = 0 AND handed_off_at IS NULL`
    ).get(token).n;
    if (existing >= limit) {
      const noun = limit === 1 ? 'request' : 'requests';
      return res.status(409).json({
        error: `You already have ${existing} ${noun} in the queue. This show limits each viewer to ${limit} ${noun} at a time — please wait until your current ${noun} ${limit === 1 ? 'plays' : 'play'} before requesting another.`,
      });
    }
  }

  db.prepare(`
    INSERT INTO jukebox_queue (sequence_id, sequence_name, viewer_token)
    VALUES (?, ?, ?)
  `).run(seq.id, seq.name, token);

  db.prepare(`UPDATE config SET interactions_since_last_psa = interactions_since_last_psa + 1 WHERE id = 1`).run();

  const io = req.app.get('io');
  if (io) io.emit('queueUpdated');

  res.json({ ok: true });
});

// ============================================================
// NOW-PLAYING DISPLAY
//
// Provides metadata for the viewer page's now-playing bar:
// title, artist, cover art, elapsed time. Audio routes from
// the original ShowPilot are removed in Lite — FPP's SD card
// can't take the I/O of audio streaming alongside playback.
// External audio (PulseMesh, FM, Icecast) is assumed.
// ============================================================

// Page visuals endpoint — polled by viewer page so admin can toggle
// page snow / decoration / player-bar visibility live without forcing
// a refresh. Cheap: just one config read.
router.get('/visual-config', (req, res) => {
  const cfg = getConfig();
  // showNotPlaying is a non-sticky signal. Toggles freely as FPP starts/
  // stops between songs without forcing viewers to refresh.
  //
  // Threshold rationale: the plugin POSTs /api/plugin/position every ~1s
  // while a sequence is playing, and that handler bumps now_playing.last_updated.
  // 10s = ~10 missed position reports before we say "not playing" — comfortable
  // margin against transient network blips while still going stale within
  // seconds when FPP idles, the plugin hangs, or the network partitions.
  // (When FPP cleanly transitions to idle, the plugin POSTs /playing with an
  // empty sequence, which sets sequence_name = NULL and trips the first
  // branch below — instant, doesn't wait for the threshold.)
  let showNotPlaying = false;
  const np = getNowPlaying();
  if (!np || !np.sequence_name) {
    showNotPlaying = true;
  } else {
    // SQLite CURRENT_TIMESTAMP is UTC. last_updated is stored as 'YYYY-MM-DD HH:MM:SS'
    // (no TZ suffix). Adding 'Z' makes Date.parse treat it as UTC, matching how
    // it was written.
    const lastMs = Date.parse(np.last_updated + 'Z');
    if (!isFinite(lastMs) || (Date.now() - lastMs) > 10_000) {
      showNotPlaying = true;
    }
  }

  res.json({
    pageSnowEnabled: cfg.page_snow_enabled === 1,
    playerDecoration: cfg.player_decoration || 'none',
    playerDecorationAnimated: cfg.player_decoration_animated !== 0,
    playerCustomColor: cfg.player_custom_color || '',
    // Lite-only: admin can hide the now-playing bar entirely on viewer pages.
    showPlayerBar: cfg.viewer_show_player_bar !== 0,
    showNotPlaying,
  });
});

// Now-playing display data — what the viewer's player bar shows: title,
// artist, cover art, elapsed time. No audio fields.
router.get('/now-playing', (req, res) => {
  const np = getNowPlaying();
  const cfg = getConfig();

  // Visual settings that always apply regardless of playback state — the
  // viewer page polls this endpoint as a single source of truth for both
  // "what's playing right now" and "how should the bar look."
  const visualConfig = {
    pageSnowEnabled: cfg.page_snow_enabled === 1,
    playerDecoration: cfg.player_decoration || 'none',
    playerDecorationAnimated: cfg.player_decoration_animated !== 0,
    playerCustomColor: cfg.player_custom_color || '',
    showPlayerBar: cfg.viewer_show_player_bar !== 0,
  };

  // OFF-mode rule (v0.4.1+): when viewer control is off, the show is
  // hands-off from ShowPilot's perspective — no votes, no requests, no
  // PSAs, AND no now-playing display. The viewer page should look quiet,
  // not surface a player bar implying ShowPilot is active. We return
  // playing:false so the client's existing hideBar() path runs (no
  // client change needed). Visual config still flows through so themes
  // remain consistent if/when the bar reappears later.
  if (cfg.viewer_control_mode === 'OFF') {
    return res.json({ playing: false, ...visualConfig });
  }

  if (!np || !np.sequence_name) {
    return res.json({ playing: false, ...visualConfig });
  }
  const seq = getSequenceByName(np.sequence_name);
  if (!seq) {
    return res.json({ playing: true, sequenceName: np.sequence_name, ...visualConfig });
  }

  // How long has this song been playing? Used by the bar to show
  // elapsed time / progress (display-only — no audio scheduling).
  const startedAtMs = np.started_at ? new Date(np.started_at.replace(' ', 'T') + 'Z').getTime() : null;
  const elapsedSec = startedAtMs ? Math.max(0, (Date.now() - startedAtMs) / 1000) : 0;

  res.json({
    playing: true,
    sequenceName: np.sequence_name,
    displayName: seq.display_name || np.sequence_name,
    artist: seq.artist || '',
    imageUrl: bustCoverUrl(seq.image_url) || null,
    durationSec: seq.duration_seconds || null,
    elapsedSec: Math.round(elapsedSec * 10) / 10,
    startedAt: np.started_at,
    ...visualConfig,
  });
});

module.exports = router;
