// ============================================================
// ShowPilot — Remote Falcon Compatibility Layer
//
// Provides the global functions that RF-style templates expect
// to call from inline onclick handlers, mapped to ShowPilot's
// real API. Also handles showing the standard error message divs
// RF templates include (requestSuccessful, alreadyVoted, etc.)
// ============================================================

(function () {
  'use strict';

  const boot = window.__SHOWPILOT__ || {};
  let cachedLocation = null;
  let hasVoted = false;
  // Vote shifting (v0.5.6+): when allowVoteChange is true, a user who has
  // already voted can click another song to switch. Track which song they
  // last voted for so we can no-op a click on the same one and show
  // friendlier feedback ("Vote changed" vs. "Vote cast").
  // allowVoteChange is read from boot first and refreshed on every /api/state.
  let votedFor = null;
  let allowVoteChange = !!boot.allowVoteChange;
  // Last-known voting round id, refreshed on every /api/state response.
  // When this changes (server advanced past our vote), we clear hasVoted
  // so the user can vote in the new round. Backup mechanism for
  // voteReset socket events that may be missed on mobile when the
  // socket dies during backgrounding.
  let lastKnownRoundId = null;
  // Show name as last seen from the server. When this changes, we update
  // document.title — but only if the title currently matches what we last
  // saw, so a template that hard-coded its own <title> isn't stomped on.
  let lastKnownShowName = null;
  // Tiebreak state — separate from main-round vote tracking. A user who
  // voted in the main round can still cast a tiebreak vote; this flag
  // tracks the latter independently.
  let hasTiebreakVoted = false;
  // Active tiebreak metadata. Populated by socket event 'tiebreakStarted'
  // OR by /api/state when reconnecting mid-tiebreak (page reload during
  // a tiebreak window). Null when no tiebreak is in progress.
  let tiebreakState = null; // { candidates: [{sequenceName,...}], deadline_ms }
  let tiebreakCountdownTimer = null;

  // Now-playing timer (v0.5.9+).
  // RF compatibility: implements the {NOW_PLAYING_TIMER} placeholder
  // (countdown of remaining time in the current sequence). The renderer
  // emits <span data-showpilot-timer> elements with initial server-computed
  // text; this code ticks them client-side once a second. State is the
  // server-anchored start time + duration. When either is missing, the
  // ticker writes --:--; once remaining hits zero, it writes 0:00 and
  // stops updating until /api/state reports a new song.
  //
  // Lite has no audio engine so there's no clockOffset to reuse — the
  // timer ticks at second granularity off the client's local Date.now()
  // and the server's started_at. Sub-second sync isn't visible at m:ss
  // granularity.
  let timerStartedAtMs = null;     // ms epoch when the song started (server's clock)
  let timerDurationSec = null;     // seconds, total length
  let timerInterval = null;        // setInterval handle
  // v0.33.206: estimated (server clock − this device's clock), from the
  // serverNowMs in /api/state responses. Keeps {NOW_PLAYING_TIMER} and the
  // progress bar right on phones whose clock is off. Lowest-round-trip
  // sample of the last few polls wins (least network asymmetry).
  let viewerClockOffsetMs = 0;
  let clockSamples = [];           // [{ rtt, offset }]
  function serverNowMs() { return Date.now() + viewerClockOffsetMs; }
  // Rough seed from the page's bootstrap (off by however long the page took
  // to arrive); the first /api/state poll replaces it with a timed sample.
  if (typeof boot.serverNowMs === 'number' && isFinite(boot.serverNowMs)) {
    viewerClockOffsetMs = boot.serverNowMs - Date.now();
  }
  function noteServerTime(serverMs, sentAt, receivedAt) {
    if (typeof serverMs !== 'number' || !isFinite(serverMs)) return;
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || rtt > 10000) return;
    clockSamples.push({ rtt, offset: serverMs - (sentAt + receivedAt) / 2 });
    if (clockSamples.length > 8) clockSamples.shift();
    let best = clockSamples[0];
    for (const c of clockSamples) if (c.rtt < best.rtt) best = c;
    viewerClockOffsetMs = best.offset;
  }
  // Rough seed from the page's bootstrap (off by however long the page took
  // to arrive); the first /api/state poll replaces it with a timed sample.
  if (typeof boot.serverNowMs === 'number' && isFinite(boot.serverNowMs)) {
    viewerClockOffsetMs = boot.serverNowMs - Date.now();
  }

  // ======= Error/success message helpers =======
  // RF templates include divs with these IDs; we show the appropriate one.
  // Vote-specific success goes to #voteSuccessful when present (so templates
  // can word it differently from the jukebox "Successfully Added"); falls
  // back to #requestSuccessful for templates that don't define a separate
  // vote message. This keeps backward compatibility with all imported RF
  // templates while letting newer templates differentiate the two flows.
  const MSG_IDS = {
    success: 'requestSuccessful',
    voteSuccess: 'voteSuccessful',
    invalidLocation: 'invalidLocation',
    invalidLocationCode: 'invalidLocationCode',
    failed: 'requestFailed',
    alreadyQueued: 'requestPlaying',
    queueFull: 'queueFull',
    alreadyVoted: 'alreadyVoted',
  };

  function showMessage(id, durationMs, textOverride) {
    let el = document.getElementById(id);
    let usedFallback = false;
    // Fallback: if a vote-specific success isn't defined in this template,
    // use the generic success element. Some templates only have one.
    if (!el && id === MSG_IDS.voteSuccess) {
      el = document.getElementById(MSG_IDS.success);
      usedFallback = true;
    }
    if (!el) {
      console.warn('[ShowPilot] no element with id', id, '— message could not be displayed');
      return;
    }
    // If we fell back from voteSuccess to requestSuccess, override the
    // text so the user doesn't see jukebox wording ("Successfully Added")
    // for a vote action. We stash the original HTML the first time we
    // override so the element returns to its original wording for
    // subsequent jukebox successes (templates may use the same element
    // for both, just changing wording per-action).
    //
    // Templates with their own #voteSuccessful div get whatever wording
    // they put inside it; this only kicks in for templates that don't
    // define one. textOverride lets callers pass custom wording too.
    const desiredText = textOverride || (
      (id === MSG_IDS.voteSuccess || (usedFallback && id === MSG_IDS.voteSuccess))
        ? 'You\'ve Successfully Voted! 🗳️'
        : null
    );
    if (desiredText) {
      if (!el.__showpilotOriginalHtml) {
        el.__showpilotOriginalHtml = el.innerHTML;
      }
      el.textContent = desiredText;
    } else if (el.__showpilotOriginalHtml) {
      // Restore original wording for non-vote uses of the same element
      el.innerHTML = el.__showpilotOriginalHtml;
    }
    el.style.display = 'block';
    // Tap-to-dismiss: most templates style these as floating overlays
    // with cursor: pointer, but no actual click handler. Add one so
    // users who tap the message can dismiss it immediately rather than
    // wait for the timeout. Idempotent — set once per element.
    if (!el.__showpilotDismissBound) {
      el.addEventListener('click', () => { el.style.display = 'none'; });
      el.__showpilotDismissBound = true;
    }
    if (el.__showpilotHideTimer) clearTimeout(el.__showpilotHideTimer);
    el.__showpilotHideTimer = setTimeout(() => {
      el.style.display = 'none';
    }, durationMs || 3000);
  }

  function mapErrorToId(error, data) {
    if (data && data.invalidLocationCode) return MSG_IDS.invalidLocationCode;
    const msg = (error || '').toLowerCase();
    if (msg.includes('access code')) return MSG_IDS.invalidLocationCode;
    if (msg.includes('location')) return MSG_IDS.invalidLocation;
    if (msg.includes('already voted')) return MSG_IDS.alreadyVoted;
    if (msg.includes('already') && (msg.includes('request') || msg.includes('queue'))) return MSG_IDS.alreadyQueued;
    if (msg.includes('queue is full') || msg.includes('full')) return MSG_IDS.queueFull;
    return MSG_IDS.failed;
  }

  // ======= Now-playing timer ({NOW_PLAYING_TIMER}) =======
  // Format remaining seconds as m:ss. Negative/NaN → 0:00 (timer expired).
  // null → --:-- (no song or duration unknown). Matches RF's display.
  function formatTimerText(remainingSec) {
    if (remainingSec === null || !isFinite(remainingSec)) return '--:--';
    const sec = Math.max(0, Math.floor(remainingSec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // Update every <span data-showpilot-timer> on the page with the current
  // remaining-time text. Called from the 1-second interval AND once
  // immediately on each /api/state poll (in case the song changed and the
  // tick is up to a second away from firing). Idempotent.
  function paintTimer() {
    const els = document.querySelectorAll('[data-showpilot-timer]');
    const bars = document.querySelectorAll('[data-showpilot-progress]');
    if (!els.length && !bars.length) return; // nothing on the page to update
    let text;
    let frac = null;
    if (timerStartedAtMs === null || timerDurationSec === null) {
      text = '--:--';
    } else {
      const elapsedSec = (serverNowMs() - timerStartedAtMs) / 1000;
      text = formatTimerText(timerDurationSec - elapsedSec);
      frac = Math.min(1, Math.max(0, elapsedSec / timerDurationSec));
    }
    els.forEach(el => { if (el.textContent !== text) el.textContent = text; });
    // Progress bars (v0.33.206+): fixed bar and {NOW_PLAYING_PROGRESS}.
    bars.forEach(bar => {
      bar.classList.toggle('sp-progress--idle', frac === null);
      const fill = bar.querySelector('.sp-progress-fill');
      if (fill) fill.style.width = (frac === null ? 0 : Math.round(frac * 1000) / 10) + '%';
      const tEl = bar.querySelector('[data-showpilot-progress-time]');
      if (tEl && tEl.textContent !== text) tEl.textContent = text;
      bar.setAttribute('aria-valuenow', frac === null ? '0' : String(Math.round(frac * 100)));
    });
    if (typeof placeProgressBar === 'function') placeProgressBar();
  }

  // ======= Song progress bar (v0.33.206+, placement v0.33.207+) =======
  // Admin setting: a slim bar with time left on every viewer page regardless
  // of template. Placement:
  //   'player' (default) — sits on the top edge of the Listen-on-Phone player
  //       while it's open; when the player is closed/minimized (or the build
  //       has no player, e.g. ShowPilot-Lite) it sits on the bottom edge of
  //       the screen instead.
  //   'top' — a strip across the top of the screen (stored 'screen-top').
  // Color: the admin override if set, else the player's theme accent
  // (--of-border of an of-theme-* decoration), else a light default. Custom
  // player colors only change the background (--of-border stays a faint
  // default), so they fall through to the light default.
  // Templates can instead place {NOW_PLAYING_PROGRESS}; both share
  // paintTimer() and the CSS below (overridable: .sp-progress,
  // .sp-progress-track, .sp-progress-fill, .sp-progress-time,
  // --sp-progress-color).
  let lastProgressCfgKey = null;
  let progressCfg = null;
  function ensureProgressStyles() {
    if (document.getElementById('sp-progress-styles')) return;
    const st = document.createElement('style');
    st.id = 'sp-progress-styles';
    st.textContent =
      '.sp-progress{--sp-progress-color:#f5f5f5;display:flex;align-items:center;gap:10px;box-sizing:border-box;' +
        'font:600 13px/1 system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;color:#fff;transition:opacity .3s}' +
      '.sp-progress-track{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.22);overflow:hidden}' +
      '.sp-progress-fill{height:100%;width:0;border-radius:999px;background:var(--sp-progress-color);transition:width 1s linear}' +
      '.sp-progress--idle{opacity:0}' +
      '.sp-progress--inline{width:100%;color:inherit}' +
      '.sp-progress--inline .sp-progress-track{background:rgba(127,127,127,.3)}' +
      // Top-of-screen strip
      '.sp-progress--fixed{position:fixed;left:0;right:0;z-index:9990;padding:8px 14px;pointer-events:none;' +
        'background:rgba(10,10,14,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
      '.sp-progress--top{top:0;padding-top:calc(8px + env(safe-area-inset-top,0px))}' +
      '.sp-progress--fixed.sp-progress--no-time{padding-top:0;padding-bottom:0;background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none}' +
      '.sp-progress--fixed.sp-progress--no-time .sp-progress-track{height:4px;border-radius:0;background:rgba(127,127,127,.25)}' +
      '.sp-progress--fixed.sp-progress--no-time .sp-progress-fill{border-radius:0}' +
      // Edge bar: on the player's top edge, or the screen's bottom edge
      '.sp-progress--edge{left:0;right:0;height:4px;padding:0;pointer-events:none;display:block}' +
      '.sp-progress--edge .sp-progress-track{height:4px;border-radius:0;background:rgba(127,127,127,.28)}' +
      '.sp-progress--edge .sp-progress-fill{border-radius:0}' +
      '.sp-progress--edge .sp-progress-time{position:absolute;bottom:calc(100% + 6px);padding:4px 9px;border-radius:999px;' +
        'font-size:12px;background:rgba(10,10,14,.78);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
      '.sp-progress--onplayer{position:absolute;top:0;z-index:3}' +
      '.sp-progress--onplayer .sp-progress-time{right:12px}' +
      '.sp-progress--screenbottom{position:fixed;bottom:env(safe-area-inset-bottom,0px);z-index:9990}' +
      '.sp-progress--screenbottom .sp-progress-time{left:10px}' +
      '.sp-progress--no-time .sp-progress-time{display:none}' +
      '@media (prefers-reduced-motion:reduce){.sp-progress-fill{transition:none}}';
    document.head.appendChild(st);
  }
  // The player's theme accent, or '' when no decoration theme is active.
  function playerThemeColor() {
    const panel = document.getElementById('of-listen-panel');
    if (!panel || !/(^|\s)of-theme-/.test(panel.className)) return '';
    try { return (getComputedStyle(panel).getPropertyValue('--of-border') || '').trim(); } catch (_) { return ''; }
  }
  function playerIsOpen() {
    const panel = document.getElementById('of-listen-panel');
    return !!(panel && panel.style.display !== 'none' && panel.style.transform !== 'translateY(100%)');
  }
  // Put the bar in the right place and color. Cheap; runs every paint tick
  // and on player open/close/theme events.
  function placeProgressBar() {
    const cfg = progressCfg;
    const bar = document.getElementById('sp-progress-fixed');
    const color = (cfg && cfg.color) || playerThemeColor();
    document.querySelectorAll('[data-showpilot-progress]').forEach(el => {
      if (color) {
        if (el.style.getPropertyValue('--sp-progress-color') !== color) el.style.setProperty('--sp-progress-color', color);
      } else if (el.style.getPropertyValue('--sp-progress-color')) {
        el.style.removeProperty('--sp-progress-color');
      }
    });
    if (!bar || !cfg) return;
    const idle = bar.classList.contains('sp-progress--idle') ? ' sp-progress--idle' : '';
    const noTime = cfg.showTime ? '' : ' sp-progress--no-time';
    let placement, parent;
    if (cfg.position === 'top') {
      placement = 'sp-progress--fixed sp-progress--top';
      parent = document.body;
    } else if (playerIsOpen()) {
      placement = 'sp-progress--edge sp-progress--onplayer';
      parent = document.getElementById('of-listen-panel');
    } else {
      placement = 'sp-progress--edge sp-progress--screenbottom';
      parent = document.body;
    }
    if (bar.parentNode !== parent) parent.appendChild(bar);
    const cls = 'sp-progress ' + placement + noTime + idle;
    if (bar.className !== cls) bar.className = cls;
  }
  window.addEventListener('showpilot:player-mode', () => placeProgressBar());
  window.addEventListener('showpilot:player-theme', () => placeProgressBar());
  function applyProgressBarConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const key = JSON.stringify(cfg);
    if (key === lastProgressCfgKey) return;
    lastProgressCfgKey = key;
    progressCfg = cfg;
    ensureProgressStyles();
    let bar = document.getElementById('sp-progress-fixed');
    if (!cfg.enabled) {
      if (bar) bar.remove();
      placeProgressBar(); // still colors inline {NOW_PLAYING_PROGRESS} bars
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sp-progress-fixed';
      bar.className = 'sp-progress sp-progress--idle';
      bar.setAttribute('data-showpilot-progress', '');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Song progress');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.innerHTML = '<div class="sp-progress-track"><div class="sp-progress-fill"></div></div>' +
        '<span class="sp-progress-time" data-showpilot-progress-time>--:--</span>';
      document.body.appendChild(bar);
    }
    placeProgressBar();
    if (timerInterval === null) timerInterval = setInterval(paintTimer, 1000);
    paintTimer();
  }
  // Update the anchor values from a /api/state response (or bootstrap).
  // We accept ISO string + duration in seconds. When the song or its anchor
  // changes, we replace state and immediately re-paint so the user doesn't
  // see a stale value for up to a second. The 1-second interval is started
  // on first call and lives for the page lifetime — cheap and ensures we
  // don't miss updates if a /api/state poll is delayed.
  function updateTimerFromState(startedAtIso, durationSeconds) {
    const newStartMs = startedAtIso ? Date.parse(startedAtIso) : null;
    const newDurSec = (typeof durationSeconds === 'number' && isFinite(durationSeconds) && durationSeconds > 0)
      ? durationSeconds : null;
    if (newStartMs !== timerStartedAtMs || newDurSec !== timerDurationSec) {
      timerStartedAtMs = newStartMs && isFinite(newStartMs) ? newStartMs : null;
      timerDurationSec = newDurSec;
      paintTimer();
    }
    if (timerInterval === null && document.querySelector('[data-showpilot-timer], [data-showpilot-progress]')) {
      timerInterval = setInterval(paintTimer, 1000);
    }
  }
  // Seed from bootstrap so the timer is correct before the first poll.
  if (boot.nowPlayingStartedAtIso || boot.nowPlayingDurationSeconds) {
    updateTimerFromState(boot.nowPlayingStartedAtIso, boot.nowPlayingDurationSeconds);
  }
  // Inline {NOW_PLAYING_PROGRESS} needs the styles even with the setting off.
  if (document.querySelector('[data-showpilot-progress]')) ensureProgressStyles();
  if (boot.progressBar) {
    if (document.body) applyProgressBarConfig(boot.progressBar);
    else document.addEventListener('DOMContentLoaded', () => applyProgressBarConfig(boot.progressBar));
  }

  // ======= GPS =======
  async function getLocation() {
    if (cachedLocation) return cachedLocation;
    if (!navigator.geolocation) {
      throw new Error('Location not supported');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(cachedLocation);
        },
        () => reject(new Error('Location required but denied')),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  // Force-fresh location fetch — used by the audio gate at the moment the
  // user taps the player button. Bypasses the browser's position cache
  // (maximumAge: 0) so we get the user's CURRENT physical location, not
  // a cached reading from when they were elsewhere. This is the copyright
  // safeguard: even if they granted permission earlier at home and drove
  // to the show, or vice versa, this re-evaluates from scratch.
  function getFreshLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location not supported on this device'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          cachedLocation = loc; // update cache for follow-up requests
          resolve(loc);
        },
        (err) => {
          // Translate browser error codes to friendly messages
          let msg = 'Location required to listen';
          if (err.code === 1) msg = 'Location permission denied. Audio is restricted to listeners present at the show.';
          else if (err.code === 2) msg = 'Could not determine your location.';
          else if (err.code === 3) msg = 'Location lookup timed out.';
          reject(new Error(msg));
        },
        // maximumAge: 0 forces a brand-new GPS reading every tap.
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  // Best-effort location fetch. Used by interaction endpoints (vote/jukebox)
  // that already have their own location-required logic. NOT used by the
  // audio gate — that uses getFreshLocation() above for stricter checks.
  function tryGetLocationSilently() {
    if (cachedLocation || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        cachedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      },
      () => { /* silently ignore */ },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  // ============================================================
  // ============================================================
  // API HELPERS
  // ============================================================

  // Build query string with viewer location for endpoints that need it
  function locationQuery() {
    if (!cachedLocation) return '';
    return `?lat=${encodeURIComponent(cachedLocation.lat)}&lng=${encodeURIComponent(cachedLocation.lng)}`;
  }

  async function buildBody(baseBody) {
    const body = { ...baseBody };
    if (boot.requiresLocation) {
      try {
        const loc = await getLocation();
        body.viewerLat = loc.lat;
        body.viewerLng = loc.lng;
      } catch (e) {
        showMessage(MSG_IDS.invalidLocation);
        throw e;
      }
    }
    if (boot.requiresLocationCode) {
      const codeEl = document.getElementById('locationCodeInput');
      body.locationCode = codeEl ? codeEl.value.trim() : '';
    }
    return body;
  }

  // ======= API calls =======
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // Globals exposed to template onclick handlers
  window.ShowPilotVote = async function (sequenceName) {
    // If a tiebreak is in progress, route through the tiebreak path
    // instead. Voting for a candidate goes via /api/tiebreak-vote;
    // voting for a non-candidate is rejected with a clear message.
    if (tiebreakState) {
      const candidateNames = tiebreakState.candidates.map(c => c.sequenceName);
      if (candidateNames.includes(sequenceName)) {
        return window.ShowPilotTiebreakVote(sequenceName);
      } else {
        // Non-candidate vote during tiebreak. Show a clear message.
        // Falls back to alreadyVoted message id since most templates
        // have it, with text users will recognize as "voting blocked."
        showMessage(MSG_IDS.alreadyVoted);
        return;
      }
    }
    if (hasVoted) {
      // Vote shifting: if the admin allows changing votes, let the click
      // through so the server can swap. Otherwise the existing block.
      if (!allowVoteChange) {
        showMessage(MSG_IDS.alreadyVoted);
        return;
      }
      // No-op: user clicked the same song they already voted for. Don't
      // round-trip; just acknowledge silently. (We could show "still
      // voted!" but that risks looking buggy.)
      if (votedFor === sequenceName) {
        return;
      }
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/vote', body);
    if (result.ok) {
      hasVoted = true;
      votedFor = sequenceName;
      // Vote-specific success message. showMessage falls back to the
      // generic #requestSuccessful element if #voteSuccessful isn't
      // defined in the active template (backward compat for RF imports).
      // On a successful shift, override the text so users understand
      // their vote moved rather than "you've already voted."
      if (result.data && result.data.shifted) {
        showMessage(MSG_IDS.voteSuccess, undefined, 'Vote changed! 🗳️');
      } else {
        showMessage(MSG_IDS.voteSuccess);
      }
      // (v0.5.11+) Refresh state immediately so the count cell updates
      // the moment the server acks the vote, regardless of socket health.
      // Without this, count updates rely entirely on the voteUpdate
      // socket event reaching the browser — which is fast on a healthy
      // connection but unreliable behind some proxies or when socket.io
      // can't establish (mixed-content, blocked WebSockets, etc.). The
      // 3-second poll loop catches it eventually but feels broken to a
      // user clicking and watching a counter that doesn't move. Mirrors
      // ShowPilotRequest's behavior, which has always done this.
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data));
    }
  };

  window.ShowPilotRequest = async function (sequenceName) {
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }

    const result = await postJson('/api/jukebox/add', body);
    if (result.ok) {
      showMessage(MSG_IDS.success);
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data));
    }
  };

  // ======= Public template API aliases =======
  // ShowPilot's canonical names are ShowPilotRequest / ShowPilotVote, but
  // we expose every alias a viewer template might call so that:
  //   1. Existing templates written for the old "OpenFalcon" name keep working
  //   2. Imported Remote Falcon templates work unmodified — RF's own JS
  //      exposed `RemoteFalconRequest` / `RemoteFalconVote` plus generic
  //      `request` / `vote`. We honor all of those.
  // Removing any alias would break user-facing templates with no warning,
  // so this list is append-only.
  window.OpenFalconRequest = window.ShowPilotRequest;
  window.OpenFalconVote = window.ShowPilotVote;
  window.RemoteFalconRequest = window.ShowPilotRequest;
  window.RemoteFalconVote = window.ShowPilotVote;
  window.vote = window.ShowPilotVote;
  window.request = window.ShowPilotRequest;

  // ======= Live state refresh =======
  async function refreshState() {
    try {
      const sentAt = Date.now();
      const res = await fetch('/api/state', { credentials: 'include' });
      const receivedAt = Date.now(); // headers in; before parsing the body
      if (!res.ok) return;
      const data = await res.json();
      noteServerTime(data.serverNowMs, sentAt, receivedAt);
      applyStateUpdate(data);
    } catch {}
  }

  function applyStateUpdate(data) {
    // --- Vote counts ---
    if (data.voteCounts) {
      // First clear all existing counts to 0 so a removed vote drops visibly
      const allCells = document.querySelectorAll('[data-seq-count]');
      allCells.forEach(el => {
        el.textContent = '0';
      });
      // Build a name → cell map by reading the actual attribute values
      // back from the DOM. This avoids the CSS attribute-selector pitfall
      // where names with quotes, brackets, or other special chars don't
      // match — getAttribute returns the un-escaped value, so a direct
      // string compare always works regardless of how the attribute was
      // serialized in the HTML.
      const cellByName = {};
      allCells.forEach(el => {
        const n = el.getAttribute('data-seq-count');
        if (n) cellByName[n] = el;
      });
      data.voteCounts.forEach(v => {
        const el = cellByName[v.sequence_name];
        if (el) el.textContent = String(v.count);
      });
    }

    // --- Allow-vote-change feature flag (v0.5.6+) ---
    // Refresh the local copy on every state poll so admin toggling the
    // setting mid-show propagates without a viewer reload.
    if (typeof data.allowVoteChange === 'boolean') {
      allowVoteChange = data.allowVoteChange;
    }

    // --- Location code flag (v0.5.26+) ---
    if (typeof data.requiresLocationCode === 'boolean') {
      boot.requiresLocationCode = data.requiresLocationCode;
    }

    // --- Show name → document title (v0.5.17+) ---
    // Admin renaming the show in settings updates every viewer's tab
    // title within a poll. We only overwrite document.title if it
    // currently matches the previously-seen show name — that way a
    // template that hard-coded its own <title> (which the server-side
    // renderer respects) keeps it.
    if (data.showName) {
      if (lastKnownShowName === null) {
        lastKnownShowName = data.showName;
      } else if (data.showName !== lastKnownShowName) {
        if (document.title === lastKnownShowName) {
          document.title = data.showName;
        }
        lastKnownShowName = data.showName;
      }
    }

    // --- Now-playing timer (v0.5.9+) ---
    // The server sends started_at + duration on every state poll. Pass
    // both (even if null — that's how we know to render --:--).
    updateTimerFromState(data.nowPlayingStartedAtIso || null, data.nowPlayingDurationSeconds || null);
    if (data.progressBar) applyProgressBarConfig(data.progressBar);

    // --- Reset "already voted" gate when the round id changes ---
    // Round-id check is the backup for voteReset socket events which
    // mobile devices can miss when backgrounded. If the server has
    // moved past our recorded round, our local "already voted" flag
    // is stale and must clear.
    if (typeof data.currentVotingRound === 'number') {
      if (lastKnownRoundId !== null && data.currentVotingRound !== lastKnownRoundId) {
        // Round advanced. Clear local vote state regardless of whether
        // the new round has zero votes yet (someone else may have
        // already voted before this client polled).
        hasVoted = false;
        hasTiebreakVoted = false;
        votedFor = null;
      }
      lastKnownRoundId = data.currentVotingRound;
    }
    // Legacy fallback: if we have no round id (older server) but vote
    // counts came back empty, the round was reset. Same effect.
    if (data.viewerControlMode === 'VOTING' && data.voteCounts && data.voteCounts.length === 0) {
      hasVoted = false;
      votedFor = null;
    }

    // --- Tiebreak state (v0.24.0+) ---
    // If the server reports a tiebreak in progress and we don't already
    // have one displayed, render the UI now. This handles page-reload
    // mid-tiebreak — the socket event already fired before we connected,
    // so we rely on /api/state to surface the active tiebreak. If the
    // server says no tiebreak but we have one displayed (race or dump),
    // clean up.
    if (data.tiebreak && data.tiebreak.candidates && data.tiebreak.candidates.length >= 2) {
      if (!tiebreakState) {
        // Compute deadline. Server sends ISO timestamp for the absolute
        // deadline (capped at song-end on the server side). Append 'Z'
        // since SQLite stores UTC without the marker.
        const deadlineMs = data.tiebreak.deadlineAtIso
          ? new Date(data.tiebreak.deadlineAtIso + 'Z').getTime()
          : Date.now() + 60000;
        // Look up display info for each candidate from the sequences list
        const seqByName = {};
        (data.sequences || []).forEach(s => { seqByName[s.name] = s; });
        const candidates = data.tiebreak.candidates.map(name => {
          const seq = seqByName[name] || {};
          return {
            sequenceName: name,
            displayName: seq.display_name || name,
            artist: seq.artist || '',
            imageUrl: seq.image_url || '',
          };
        });
        showTiebreakUI({
          candidates,
          deadlineAtMs: deadlineMs,
        });
      }
    } else if (tiebreakState) {
      // Server says no tiebreak but we have one. Clean up.
      clearTiebreakUI();
    }

    // --- NOW_PLAYING text ---
    const nowEls = document.querySelectorAll('.now-playing-text');
    if (nowEls.length) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      nowEls.forEach(el => {
        if (el.textContent !== nowDisplay) el.textContent = nowDisplay;
      });
    }

    // --- NOW_PLAYING_IMAGE (v0.5.13+) ---
    // Updates any <img data-showpilot-now-img> elements when the playing
    // song changes. Hides the image when no song is playing, or when the
    // current song has no cover art (image_url empty / null on the
    // sequence row).
    const nowImgEls = document.querySelectorAll('[data-showpilot-now-img]');
    if (nowImgEls.length) {
      const nowSeq = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)
        : null;
      const nowImgUrl = nowSeq && nowSeq.image_url ? nowSeq.image_url : '';
      nowImgEls.forEach(el => {
        if (nowImgUrl) {
          if (el.getAttribute('src') !== nowImgUrl) el.setAttribute('src', nowImgUrl);
          if (el.style.display === 'none') el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      });
    }

    // --- NEXT_PLAYLIST text (RF templates use .body_text inside the jukebox container) ---
    // We can't reliably pick "the right" .body_text element without a data attribute,
    // so we tag it during render-time. Fall back: leave it alone.
    // In templates we render server-side, we add data-showpilot-next to the NEXT_PLAYLIST spot.
    // The data-openfalcon-* selectors are kept for backward compat with templates
    // written against the old name.
    // querySelectorAll so templates that place {NEXT_PLAYLIST} both outside and
    // inside the jukebox container (e.g. as the jukebox "Up Next" display) get
    // every copy updated — querySelector would silently skip the second one.
    const nextEls = document.querySelectorAll('[data-showpilot-next], [data-openfalcon-next]');
    if (nextEls.length) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      nextEls.forEach(el => {
        if (el.textContent !== nextDisplay) el.textContent = nextDisplay;
      });
    }

    // --- Queue size & queue list ---
    const queueSizeEls = document.querySelectorAll('[data-showpilot-queue-size], [data-openfalcon-queue-size]');
    queueSizeEls.forEach(el => { el.textContent = String((data.queue || []).length); });

    const queueListEls = document.querySelectorAll('[data-showpilot-queue-list], [data-openfalcon-queue-list]');
    if (queueListEls.length) {
      const byName = Object.fromEntries((data.sequences || []).map(s => [s.name, s]));
      const queueHtml = (data.queue || []).length === 0
        // Match the server-side renderQueue empty-state shape (v0.5.13+).
        ? '<div class="queue-empty">Queue is empty.</div>'
        // Match the server-side renderQueue shape: each entry is its own
        // <div class="queue-item"> so RF Page Builder's `.queue-list > div`
        // selector matches.
        : data.queue.map(e => {
            const seq = byName[e.sequence_name];
            const name = seq ? seq.display_name : e.sequence_name;
            return `<div class="queue-item" data-seq="${escapeAttr(e.sequence_name)}">${escapeHtml(name)}</div>`;
          }).join('');
      queueListEls.forEach(el => { el.innerHTML = queueHtml; });
    }

    // --- Sequence list live rebuild (v0.5.17+) ---
    // When admin adds/removes/reorders/renames sequences (or edits
    // display_name / artist / image_url), the viewer's clickable grid is
    // stale until refresh. We mirror renderPlaylistGrid from
    // lib/viewer-renderer.js client-side and rebuild the affected
    // wrapper's innerHTML when the data signature changes.
    //
    // We find the wrapper by walking up from any [data-seq] element.
    // Templates have at most two wrappers (one in the jukebox container,
    // one in the voting container, if they support both modes). If the
    // server-rendered list was empty at page load, there are no [data-seq]
    // anchors and we can't find the wrapper — viewers in that narrow case
    // need a refresh to see newly-added sequences. Documented as known.
    rebuildPlaylistGridIfNeeded(data);

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated. After rebuildPlaylistGridIfNeeded this is
    // typically a no-op (the rebuild used the new url) — kept as a lighter-weight
    // path for the "only the cover changed" case where rebuild was skipped.
    (data.sequences || []).forEach(seq => {
      if (!seq.image_url) return;
      const imgs = document.querySelectorAll(`img[data-seq-name="${CSS.escape(seq.name)}"]`);
      imgs.forEach(img => {
        if (img.getAttribute('src') !== seq.image_url) {
          img.setAttribute('src', seq.image_url);
        }
      });
    });

    // --- Mode container visibility ---
    // Both data-showpilot-container and data-openfalcon-container are honored
    // so templates from earlier versions keep working. We toggle via the
    // HTML5 `hidden` attribute (matching the server-side renderer in
    // v0.5.18+), AND clear any inline `display:none` left by older
    // server renders (in case the user is running a viewer page that
    // was loaded before a server upgrade). Idempotent on repeat calls.
    function setVisible(el, visible) {
      if (visible) {
        el.removeAttribute('hidden');
        if (el.style && el.style.display === 'none') el.style.display = '';
      } else {
        el.setAttribute('hidden', '');
        if (el.style) el.style.display = 'none';
      }
    }
    document.querySelectorAll('[data-showpilot-container="jukebox"], [data-openfalcon-container="jukebox"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'JUKEBOX');
    });
    document.querySelectorAll('[data-showpilot-container="voting"], [data-openfalcon-container="voting"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'VOTING');
    });
    // After-hours: visible when viewer control is OFF. Mirror of the server-side
    // logic in viewer-renderer.js, so flipping the admin "Off" toggle propagates
    // to viewers within one poll without requiring a reload.
    document.querySelectorAll('[data-showpilot-container="afterhours"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'OFF');
    });
    document.querySelectorAll('[data-showpilot-container="race"]').forEach(el => {
      setVisible(el, data.viewerControlMode === 'RACE');
    });
    if (data.viewerControlMode === 'RACE') {
      document.querySelectorAll('[data-showpilot-container="jukebox"], [data-showpilot-container="voting"]').forEach(el => {
        setVisible(el, false);
      });
    }
    if (data.race) {
      applyRaceTapUpdate({
        counts: data.race.tapCounts || [],
        bars: buildRaceBars(data.race.tapCounts || []),
        leadingSequence: data.race.tapCounts?.[0]?.sequence_name || null,
      });
      if (data.race.winner) {
        if (data.race.winner !== _lastShownRaceWinner) {
          _lastShownRaceWinner = data.race.winner;
          const winSeq = (data.sequences || []).find(s => s.name === data.race.winner);
          showRaceWinner({
            sequenceName: data.race.winner,
            displayName: winSeq ? winSeq.display_name : data.race.winner,
            artist: winSeq ? (winSeq.artist || '') : '',
            tapCount: data.race.tapCounts?.[0]?.count || null,
          });
        } else {
          document.querySelectorAll('.race-tap-btn').forEach(b => { b.disabled = true; });
        }
        if (_raceTimerInterval) { clearInterval(_raceTimerInterval); _raceTimerInterval = null; }
        const countdownEl = document.getElementById('showpilot-race-countdown');
        if (countdownEl) countdownEl.textContent = 'Race over — next song coming up!';
      } else {
        updateRaceTimer(data.race.endsAt);
      }
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Heartbeat (for active viewer count)
  setInterval(() => {
    fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  }, 15000);

  // Poll state every 3s for live updates (Socket.io provides instant updates too)
  setInterval(refreshState, 3000);

  // ============================================================
  // Tiebreak UI (v0.24.0+)
  // ============================================================
  // Renders a sticky banner at the top of the page when a tiebreak is
  // active, plus visual emphasis on the tied candidates within the
  // existing voting list. The banner shows a countdown timer and
  // lists the tied songs as tap targets — tapping casts a tiebreak
  // vote via /api/tiebreak-vote (rather than the regular /api/vote).
  //
  // Design intent: the existing voting list stays intact so users can
  // see the score progression. We just overlay an urgent banner and
  // mark the candidates with a visible badge so users know which two
  // are eligible for the tiebreak vote.
  function showTiebreakUI(data) {
    if (!data || !Array.isArray(data.candidates) || data.candidates.length < 2) return;
    // The deadline is a wall-clock moment, computed server-side as
    // min(timer-cap, current-song-end). The viewer countdown is just
    // (deadline - now) capped at 0 — no need to know the configured
    // timer duration, just the absolute end moment.
    const deadlineMs = data.deadlineAtMs || (data.startedAtMs && data.durationSec
      ? data.startedAtMs + data.durationSec * 1000
      : Date.now() + 60000);
    tiebreakState = {
      candidates: data.candidates,
      deadlineMs,
    };
    hasTiebreakVoted = false;
    renderTiebreakBanner();
    markTiebreakCandidatesInList();
    startTiebreakCountdown();
  }

  function clearTiebreakUI() {
    tiebreakState = null;
    if (tiebreakCountdownTimer) {
      clearInterval(tiebreakCountdownTimer);
      tiebreakCountdownTimer = null;
    }
    const banner = document.getElementById('showpilot-tiebreak-banner');
    if (banner) banner.remove();
    document.querySelectorAll('.cell-vote-playlist').forEach(el => {
      el.classList.remove('showpilot-tiebreak-candidate');
      const badge = el.querySelector('.showpilot-tie-badge');
      if (badge) badge.remove();
    });
  }

  function renderTiebreakBanner() {
    let banner = document.getElementById('showpilot-tiebreak-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'showpilot-tiebreak-banner';
      // Inline styles — keeps the banner self-contained even if a
      // template's CSS doesn't include rules for it. Templates can
      // restyle by setting CSS variables (--showpilot-tiebreak-bg etc.)
      // or by overriding #showpilot-tiebreak-banner directly.
      banner.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'z-index: 9997',
        'padding: 14px 18px',
        'background: var(--showpilot-tiebreak-bg, linear-gradient(135deg, #d63031, #6c0e0e))',
        'color: var(--showpilot-tiebreak-text, #fff)',
        'font-family: var(--showpilot-toast-font, system-ui, -apple-system, sans-serif)',
        'box-shadow: 0 6px 18px rgba(0,0,0,0.5)',
        'animation: showpilot-tb-shake 0.7s cubic-bezier(.36,.07,.19,.97) both',
        'animation-iteration-count: 2',
      ].join(';');
      document.body.appendChild(banner);
      // Add keyframes once
      if (!document.getElementById('showpilot-tb-keyframes')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'showpilot-tb-keyframes';
        styleEl.textContent = `
          @keyframes showpilot-tb-shake {
            10%, 90% { transform: translate3d(-1px, 0, 0); }
            20%, 80% { transform: translate3d(2px, 0, 0); }
            30%, 50%, 70% { transform: translate3d(-3px, 0, 0); }
            40%, 60% { transform: translate3d(3px, 0, 0); }
          }
          @keyframes showpilot-tb-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.7); }
            50% { box-shadow: 0 0 0 10px rgba(255, 80, 80, 0); }
          }
          .showpilot-tiebreak-candidate {
            outline: 3px solid var(--showpilot-tiebreak-accent, #ff5050) !important;
            outline-offset: -3px;
            animation: showpilot-tb-pulse 1.5s infinite;
          }
          .showpilot-tie-badge {
            display: inline-block;
            background: var(--showpilot-tiebreak-bg, #d63031);
            color: var(--showpilot-tiebreak-text, #fff);
            font-size: 0.7rem;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 999px;
            margin-left: 8px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            vertical-align: middle;
          }
          #showpilot-tiebreak-banner button {
            background: rgba(255,255,255,0.18);
            border: 1px solid rgba(255,255,255,0.4);
            color: inherit;
            font-family: inherit;
            font-size: 0.95rem;
            font-weight: 600;
            padding: 8px 14px;
            margin: 4px;
            border-radius: 8px;
            cursor: pointer;
          }
          #showpilot-tiebreak-banner button:hover {
            background: rgba(255,255,255,0.3);
          }
          #showpilot-tiebreak-banner button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        `;
        document.head.appendChild(styleEl);
      }
    }
    if (!tiebreakState) return;
    const candList = tiebreakState.candidates.map(c => `
      <button data-tb-candidate="${escapeAttr(c.sequenceName)}" onclick="window.ShowPilotTiebreakVote('${escapeJsString(c.sequenceName)}')">
        ${escapeHtml(c.displayName || c.sequenceName)}
      </button>
    `).join('');
    banner.innerHTML = `
      <div style="text-align:center;">
        <div style="font-weight:800;font-size:1.05rem;letter-spacing:0.05em;text-transform:uppercase;">
          ⚡ Tiebreak — Vote Now ⚡
        </div>
        <div style="font-size:0.85rem;opacity:0.9;margin-top:4px;">
          Vote within <span id="showpilot-tb-countdown">--</span>s or all votes are dumped.
        </div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;justify-content:center;">
          ${candList}
        </div>
      </div>
    `;
  }

  function markTiebreakCandidatesInList() {
    if (!tiebreakState) return;
    const candidateNames = tiebreakState.candidates.map(c => c.sequenceName);
    document.querySelectorAll('.cell-vote-playlist').forEach(el => {
      const seqName = el.getAttribute('data-seq');
      if (seqName && candidateNames.includes(seqName)) {
        el.classList.add('showpilot-tiebreak-candidate');
        if (!el.querySelector('.showpilot-tie-badge')) {
          const badge = document.createElement('span');
          badge.className = 'showpilot-tie-badge';
          badge.textContent = 'TIE';
          el.appendChild(badge);
        }
      }
    });
  }

  function startTiebreakCountdown() {
    if (tiebreakCountdownTimer) clearInterval(tiebreakCountdownTimer);
    const tick = () => {
      if (!tiebreakState) return;
      const remaining = Math.max(0, Math.ceil((tiebreakState.deadlineMs - Date.now()) / 1000));
      const cdEl = document.getElementById('showpilot-tb-countdown');
      if (cdEl) cdEl.textContent = String(remaining);
      if (remaining <= 0) {
        // Visual feedback that timer is up. Server will emit tiebreakFailed
        // (or we'll get a state update with no tiebreak active) shortly,
        // and that will clean us up.
        if (cdEl) cdEl.textContent = 'time up';
      }
    };
    tick();
    tiebreakCountdownTimer = setInterval(tick, 250);
  }

  function showTiebreakFailedToast(data) {
    // Use the existing winner-toast infrastructure with different content.
    // We don't have the renderer's showWinnerToast helper exposed to us,
    // so just log and rely on the "votes dumped" implication being clear
    // when the tiebreak banner disappears. Templates can listen for the
    // socket event themselves if they want a custom failure UI.
    console.info('[ShowPilot] tiebreak expired — votes dumped:', data);
  }

  // Vote click during tiebreak — routes to the tiebreak endpoint instead
  // of the main vote endpoint. Exposed globally so the banner buttons can
  // call it directly. Returns nothing; uses showMessage for feedback.
  window.ShowPilotTiebreakVote = async function(sequenceName) {
    if (hasTiebreakVoted) {
      showMessage(MSG_IDS.alreadyVoted);
      return;
    }
    let body;
    try { body = await buildBody({ sequenceName }); }
    catch { return; }
    const result = await postJson('/api/tiebreak-vote', body);
    if (result.ok) {
      hasTiebreakVoted = true;
      showMessage(MSG_IDS.voteSuccess);
      // (v0.5.11+) Same reasoning as ShowPilotVote — refresh immediately
      // so the user sees their tiebreak vote register without waiting on
      // the tiebreakVoteUpdate socket event.
      refreshState();
    } else {
      showMessage(mapErrorToId(result.data?.error, result.data));
    }
  };

  function escapeAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }
  function escapeJsString(s) {
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  }

  // ============================================================
  // Playlist grid live rebuild (v0.5.17+)
  // ============================================================
  // Mirrors lib/viewer-renderer.js#renderPlaylistGrid so the viewer's
  // clickable list updates without a refresh when admin edits the
  // sequence list. Called from applyStateUpdate on every state poll.
  //
  // We find playlist wrappers by walking up from any [data-seq]
  // element. The wrapper is the parent that holds rows. Templates may
  // have one (single-mode template) or two (dual-mode template, one
  // wrapper per mode-container). We rebuild each wrapper independently
  // and only when its computed signature differs from the data — so
  // unchanged wrappers don't churn the DOM and unrelated event handlers
  // / hover state survive.
  //
  // The empty-initial-load edge case: if the page was rendered with
  // zero sequences, there are no [data-seq] anchors to find a wrapper
  // by, and a subsequent admin sequence-add won't appear until the
  // viewer refreshes. Acceptable trade-off — alternative would be
  // emitting a sentinel element on every {PLAYLISTS} substitution,
  // which risks breaking template CSS that targets direct-child
  // siblings (.voting_table grid-template-columns, etc.).

  // Stable signature of the desired grid contents — name, display_name,
  // artist, image_url, and vote count. Order matters (admin-controlled
  // ordering is meaningful). Mode is included so a JUKEBOX→VOTING flip
  // forces a rebuild even if sequences are identical.
  function computeGridSignature(sequences, voteCountsByName, mode, catOpts) {
    const parts = [mode, 'cat:' + (catOpts && catOpts.categoryHeaders === false ? '0' : '1') + ':' + ((catOpts && catOpts.uncategorizedLabel) || '')];
    for (const s of sequences) {
      parts.push(
        s.name + '|' +
        (s.display_name || '') + '|' +
        (s.artist || '') + '|' +
        (s.image_url || '') + '|' +
        (s.category || '') + '|' +
        (voteCountsByName[s.name] || 0)
      );
    }
    return parts.join('\n');
  }

  // Mirror of the server's renderPlaylistGrid — must produce IDENTICAL
  // markup so click handlers and template CSS keep working. If you
  // change one side, change the other.
  //
  // Note: we use escapeHtml (not escapeAttr) for data-seq and
  // data-seq-name values because that's what the server-side renderer
  // does — escapeAttr doesn't escape ' or > and would produce
  // divergent markup for sequences with those chars in their names.
  // Mirror of lib/viewer-renderer.js#withCategoryHeaders — change both.
  // The list arrives pre-grouped from /api/state; emit a header row each
  // time the category changes.
  function withCategoryHeaders(sequences, opts, rowFn) {
    const on = !opts || opts.categoryHeaders !== false;
    const anyCat = on && sequences.some(s => s.category && String(s.category).trim());
    if (!anyCat) return sequences.map(rowFn);
    const other = (opts && typeof opts.uncategorizedLabel === 'string' && opts.uncategorizedLabel.trim()) || 'Other';
    const out = [];
    let prevKey = null;
    for (const seq of sequences) {
      const label = (seq.category && String(seq.category).trim()) || other;
      const key = label.toLowerCase();
      if (key !== prevKey) {
        out.push(`<div class="sequence-category-header" data-showpilot-category="${escapeHtml(label)}">${escapeHtml(label)}</div>`);
        prevKey = key;
      }
      out.push(rowFn(seq));
    }
    return out;
  }

  function renderRowsForMode(sequences, voteCountsByName, mode, catOpts) {
    return withCategoryHeaders(sequences, catOpts, seq => {
      const safeNameJs = escapeJsString(seq.name);
      const safeNameAttr = escapeHtml(seq.name);
      const safeDisplay = escapeHtml(seq.display_name || seq.name);
      const safeArtist = seq.artist ? escapeHtml(seq.artist) : '';
      const count = voteCountsByName[seq.name] || 0;
      // width/height are presentational hints — author CSS overrides them.
      // See lib/viewer-renderer.js renderPlaylistGrid for the full rationale.
      // Mirror the server-side defaults here so live rebuilds (mode flip,
      // sequence list change) don't reintroduce native-resolution images.
      const artImg = seq.image_url
        ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(seq.image_url)}" alt="" width="40" loading="lazy" />`
        : '';
      if (mode === 'VOTING') {
        return `<div class="cell-vote-playlist sequence-item" onclick="ShowPilotVote('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="cell-vote-playlist-artist sequence-artist">${safeArtist}</div><span class="sequence-votes" data-seq-votes="${safeNameAttr}">${count}</span></div></div><div class="cell-vote" data-seq-count="${safeNameAttr}">${count}</div>`;
      } else {
        return `<div class="jukebox-list sequence-item" onclick="ShowPilotRequest('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="jukebox-list-artist sequence-artist">${safeArtist}</div><span class="sequence-requests" data-seq-requests="${safeNameAttr}"></span></div></div>`;
      }
    }).join('');
  }

  // Find the unique playlist wrapper(s) by walking up from existing rows.
  // Returns 0, 1, or 2 elements depending on template shape.
  function findPlaylistWrappers() {
    const wrappers = new Set();
    document.querySelectorAll('[data-seq]').forEach(el => {
      // Skip queue items and tiebreak candidate buttons — they also use
      // data-seq but live in different parents. Identify them by class.
      if (el.classList.contains('queue-item')) return;
      if (el.hasAttribute('data-tb-candidate')) return;
      if (el.parentElement) wrappers.add(el.parentElement);
    });
    return Array.from(wrappers);
  }

  // Per-wrapper signature cache so we only rebuild on actual change.
  // WeakMap so detached wrappers GC normally.
  const _gridSigCache = new WeakMap();

  function rebuildPlaylistGridIfNeeded(data) {
    const sequences = data.sequences || [];
    const mode = data.viewerControlMode || 'OFF';
    // Only meaningful in JUKEBOX or VOTING; in OFF the mode containers
    // are hidden, so rebuilding their stale contents wastes work but
    // doesn't hurt. Skip to keep churn low.
    if (mode !== 'JUKEBOX' && mode !== 'VOTING') return;

    const voteCountsByName = {};
    (data.voteCounts || []).forEach(v => { voteCountsByName[v.sequence_name] = v.count; });
    const catOpts = { categoryHeaders: data.categoryHeaders, uncategorizedLabel: data.uncategorizedLabel };
    const desiredSig = computeGridSignature(sequences, voteCountsByName, mode, catOpts);

    const wrappers = findPlaylistWrappers();
    if (wrappers.length === 0) return; // Empty-initial-load edge case.

    for (const wrapper of wrappers) {
      // Determine which mode this wrapper belongs to. Walk up to the
      // nearest [data-showpilot-container] ancestor and read its mode.
      // If no container ancestor (single-mode template with no mode
      // container), assume the active mode.
      let targetMode = mode;
      let cur = wrapper;
      while (cur && cur !== document.body) {
        const c = cur.getAttribute && cur.getAttribute('data-showpilot-container');
        if (c === 'jukebox') { targetMode = 'JUKEBOX'; break; }
        if (c === 'voting') { targetMode = 'VOTING'; break; }
        cur = cur.parentElement;
      }
      // Only rebuild a wrapper whose mode matches the active mode —
      // the inactive one is hidden anyway and won't be seen.
      if (targetMode !== mode) continue;

      const wrapperSig = _gridSigCache.get(wrapper);
      if (wrapperSig === desiredSig) continue;

      wrapper.innerHTML = renderRowsForMode(sequences, voteCountsByName, targetMode, catOpts);
      _gridSigCache.set(wrapper, desiredSig);
    }
  }

  // Initial heartbeat + immediate state refresh
  fetch('/api/heartbeat', { method: 'POST', credentials: 'include' }).catch(() => {});
  refreshState();

  // Try Socket.io if available for instant updates
  try {
    if (window.io) {
      const socket = window.io();
      socket.on('voteUpdate', () => refreshState());
      socket.on('queueUpdated', () => refreshState());
      socket.on('nowPlaying', () => refreshState());
      socket.on('nextScheduled', () => refreshState());
      socket.on('voteReset', () => {
        hasVoted = false;
        hasTiebreakVoted = false;
        votedFor = null;
        // Clear any tiebreak banner that's still on screen — round
        // moved on (either resolution succeeded or timer expired).
        clearTiebreakUI();
        refreshState();
      });
      socket.on('sequencesReordered', () => refreshState());
      socket.on('sequencesSynced', () => refreshState());
      // Mode toggle (admin flipping JUKEBOX / VOTING / OFF) — fires
      // server-side in routes/plugin.js. Without this, viewers wait up
      // to 3s for the next poll to see the after-hours block appear or
      // the active grid swap. With it, propagation is instant.
      socket.on('viewerModeChanged', () => refreshState());
      // ---- Tiebreak events (v0.24.0+) ----
      socket.on('tiebreakStarted', (data) => {
        showTiebreakUI(data);
      });
      socket.on('tiebreakFailed', (data) => {
        showTiebreakFailedToast(data);
        clearTiebreakUI();
      });
      socket.on('tiebreakVoteUpdate', () => refreshState());
      // On reconnect (after network blip or mobile background-suspend),
      // resync state immediately. Otherwise we'd keep showing whatever
      // round we had before disconnect, including a stale "already
      // voted" gate. Socket.io fires 'connect' both on initial connect
      // and on each reconnect, so this covers both.
      socket.on('connect', () => refreshState());

      // ---- Race mode socket events (v0.33.155+) ----
      socket.on('raceStarted', (data) => {
        initRaceUI(data);
        refreshState();
      });
      socket.on('raceTapUpdate', (data) => {
        applyRaceTapUpdate(data);
      });
      socket.on('raceWinner', (data) => {
        showRaceWinner(data);
      });
      socket.on('raceEnded', () => {
        refreshState();
      });
    }
  } catch {}

  // Mobile devices commonly suspend background tabs aggressively. When
  // the user comes back to the page (visibilitychange to 'visible'),
  // pull a fresh state so we don't continue working from stale data.
  // Pairs with the socket reconnect handler above — covers the case
  // where the socket reconnected silently in the background but the
  // tab missed events while suspended.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshState();
    }
  });

  // ============================================================
  // PAGE EFFECTS — full-screen ambient overlays (snow, leaves,
  // fireworks, hearts, stars, bats, confetti, petals, embers,
  // bubbles, rain — plus 'none').
  //
  // Three knobs from the server:
  //   pageEffect          — string id (see EFFECTS table below)
  //   pageEffectColor     — '' for the effect's default, or any CSS color
  //   pageEffectIntensity — 'subtle' | 'medium' | 'heavy'
  //
  // See ShowPilot main's rf-compat.js for the full engine rationale —
  // this is a code-for-code parity port (non-audio change, ships to
  // both repos per the both-versions-every-time rule).
  // ============================================================
  // Long-name truncation guard (v0.5.14+)
  // ============================================================
  // Some imported third-party templates (e.g. RF Page Builder)
  // style `.sequence-name` with `white-space: nowrap; overflow: hidden;
  // text-overflow: ellipsis;`. That assumes one-line song titles. Real
  // shows have titles like "Walk the Dinosaur (From Ice Age: Dawn of
  // the Dinosaurs)" which then truncate to "Walk the Din…". The
  // template author can't anticipate every show's catalog, and asking
  // every operator to learn CSS to fix it is a non-starter.
  //
  // Strategy: inject a defensive rule that allows wrapping AND caps at
  // 2 lines. We scope it to .sequence-name inside .sequence-item —
  // that's RF Page Builder territory. Built-in ShowPilot-Lite templates
  // and canonical RF templates never style .sequence-name (they target
  // .jukebox-list / .cell-vote-playlist descendants), so this override
  // is invisible to them.
  //
  // We use !important + a 2-class selector so RFPB's existing rules
  // don't beat us. Mirrors main 0.32.14 verbatim.
  // ============================================================
  (function initSequenceNameWrap() {
    if (document.getElementById('of-seqname-wrap-style')) return; // idempotent
    const style = document.createElement('style');
    style.id = 'of-seqname-wrap-style';
    style.textContent = `
      .sequence-item .sequence-name {
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 2 !important;
        line-clamp: 2 !important;
        -webkit-box-orient: vertical !important;
        word-break: break-word;
        min-width: 0;
      }
      .sequence-item .sequence-artist {
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 1 !important;
        line-clamp: 1 !important;
        -webkit-box-orient: vertical !important;
        word-break: break-word;
        min-width: 0;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  })();

  // ============================================================
  (function initPageEffects() {
    const prefersReduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;

    let layer = null;
    let styleEl = null;
    let last = { name: null, color: null, intensity: null };

    function ensureStyle() {
      if (styleEl) return;
      styleEl = document.createElement('style');
      styleEl.textContent = `
        @keyframes ofPageFall {
          0%   { transform: translateY(-30px) rotate(0deg); }
          100% { transform: translateY(108vh) rotate(360deg); }
        }
        @keyframes ofPageDrift {
          0%   { transform: translateY(-30px) rotate(-25deg); }
          100% { transform: translateY(108vh) rotate(335deg); }
        }
        @keyframes ofPageSway {
          0%   { margin-left: 0; }
          100% { margin-left: var(--of-sway, 30px); }
        }
        @keyframes ofPageRise {
          0%   { transform: translateY(110vh) rotate(0deg); opacity: 0; }
          10%  { opacity: var(--of-peak-opacity, 0.8); }
          90%  { opacity: var(--of-peak-opacity, 0.8); }
          100% { transform: translateY(-30px) rotate(360deg); opacity: 0; }
        }
        @keyframes ofPageTwinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50%      { opacity: 1;   transform: scale(1.1); }
        }
        @keyframes ofPageBatFly {
          0%   { transform: translateX(-12vw) translateY(0); }
          100% { transform: translateX(112vw) translateY(var(--of-bat-dy, 8vh)); }
        }
        @keyframes ofPageBatFlap {
          0%, 100% { transform: scaleY(1); }
          50%      { transform: scaleY(0.55); }
        }
        @keyframes ofPageRain {
          0%   { transform: translateY(-30vh); }
          100% { transform: translateY(108vh); }
        }
        @keyframes ofPageBurst {
          0%   { transform: scale(0); opacity: 0; }
          10%  { opacity: 1; }
          70%  { opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
      `;
      document.head.appendChild(styleEl);
    }

    const COUNTS = {
      snow:      [25, 50, 90],
      leaves:    [15, 30, 55],
      fireworks: [3,  6,  12],
      hearts:    [20, 40, 70],
      stars:     [30, 60, 110],
      bats:      [3,  6,  10],
      confetti:  [40, 80, 140],
      petals:    [20, 40, 70],
      embers:    [25, 50, 90],
      bubbles:   [15, 30, 55],
      rain:      [60, 120, 200],
    };
    function pickCount(name, intensity) {
      const arr = COUNTS[name];
      if (!arr) return 0;
      const idx = intensity === 'subtle' ? 0 : intensity === 'heavy' ? 2 : 1;
      return arr[idx];
    }

    const EFFECTS = {
      snow: {
        defaultColor: '#ffffff',
        build(root, color, count) {
          const flakeSvg = (col) => `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><g stroke="${col}" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.9"><line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="2.5" y1="2.5" x2="11.5" y2="11.5"/><line x1="2.5" y1="11.5" x2="11.5" y2="2.5"/><path d="M 7,2 L 6,3 M 7,2 L 8,3"/><path d="M 7,12 L 6,11 M 7,12 L 8,11"/><path d="M 2,7 L 3,6 M 2,7 L 3,8"/><path d="M 12,7 L 11,6 M 12,7 L 11,8"/></g></svg>`;
          const svgMarkup = flakeSvg(color);
          for (let i = 0; i < count; i++) {
            const flake = document.createElement('div');
            const size = 8 + Math.random() * 14;
            const left = Math.random() * 100;
            const duration = 8 + Math.random() * 10;
            const delay = -Math.random() * duration;
            const sway = 20 + Math.random() * 40;
            const opacity = 0.4 + Math.random() * 0.5;
            flake.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size}px;opacity:${opacity};filter:drop-shadow(0 0 2px ${color}66);animation:ofPageFall ${duration}s linear infinite, ofPageSway ${duration / 2}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            flake.innerHTML = svgMarkup;
            root.appendChild(flake);
          }
        },
      },
      leaves: {
        defaultColor: '#d2691e',
        build(root, color, count) {
          const leafSvg = (col) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 C8 4, 4 8, 4 13 C4 18, 8 22, 12 22 C16 22, 20 18, 20 13 C20 8, 16 4, 12 2 Z M12 4 L12 22" fill="${col}" stroke="${col}" stroke-width="0.5"/></svg>`;
          for (let i = 0; i < count; i++) {
            const leaf = document.createElement('div');
            const size = 16 + Math.random() * 18;
            const left = Math.random() * 100;
            const duration = 10 + Math.random() * 12;
            const delay = -Math.random() * duration;
            const sway = 60 + Math.random() * 80;
            const opacity = 0.55 + Math.random() * 0.4;
            const hueShift = Math.round(-20 + Math.random() * 40);
            leaf.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size}px;opacity:${opacity};filter:hue-rotate(${hueShift}deg) drop-shadow(0 1px 2px rgba(0,0,0,0.3));animation:ofPageDrift ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            leaf.innerHTML = leafSvg(color);
            root.appendChild(leaf);
          }
        },
      },
      fireworks: {
        defaultColor: '#ff5050',
        build(root, color, count) {
          const sparksPerBurst = 14;
          for (let i = 0; i < count; i++) {
            const burst = document.createElement('div');
            const cx = 10 + Math.random() * 80;
            const cy = 8 + Math.random() * 50;
            const burstDuration = 1.6 + Math.random() * 1.2;
            const cycle = 4 + Math.random() * 5;
            const cycleDelay = Math.random() * cycle;
            const baseHue = Math.round(Math.random() * 360);
            burst.style.cssText = `position:absolute;left:${cx}vw;top:${cy}vh;width:0;height:0;`;
            for (let s = 0; s < sparksPerBurst; s++) {
              const angle = (s / sparksPerBurst) * Math.PI * 2;
              const dist = 60 + Math.random() * 50;
              const dx = Math.cos(angle) * dist;
              const dy = Math.sin(angle) * dist;
              const spark = document.createElement('div');
              spark.style.cssText = `position:absolute;left:0;top:0;width:6px;height:6px;border-radius:50%;background:${color};filter:hue-rotate(${baseHue}deg) drop-shadow(0 0 6px ${color});transform-origin:0 0;animation:sparkFly_${i}_${s} ${cycle}s ease-out infinite;animation-delay:${cycleDelay}s;`;
              const style = document.createElement('style');
              style.textContent = `@keyframes sparkFly_${i}_${s} { 0%,${(burstDuration/cycle*100).toFixed(0)}% { transform: translate(0,0); opacity: 1; } ${(burstDuration/cycle*100*0.6).toFixed(0)}% { opacity: 1; } ${(burstDuration/cycle*100).toFixed(0)}% { transform: translate(${dx}px,${dy}px); opacity: 0; } 100% { transform: translate(${dx}px,${dy}px); opacity: 0; } }`;
              root.appendChild(style);
              burst.appendChild(spark);
            }
            root.appendChild(burst);
          }
        },
      },
      hearts: {
        defaultColor: '#ff4d8d',
        build(root, color, count) {
          const heartSvg = (col) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 21 C 12 21, 4 14, 4 8.5 C 4 5, 6.5 3, 9 3 C 10.5 3, 12 4, 12 5.5 C 12 4, 13.5 3, 15 3 C 17.5 3, 20 5, 20 8.5 C 20 14, 12 21, 12 21 Z" fill="${col}" stroke="${col}" stroke-width="0.5"/></svg>`;
          const svgMarkup = heartSvg(color);
          for (let i = 0; i < count; i++) {
            const heart = document.createElement('div');
            const size = 12 + Math.random() * 18;
            const left = Math.random() * 100;
            const duration = 10 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const sway = 30 + Math.random() * 50;
            const opacity = 0.5 + Math.random() * 0.4;
            heart.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;--of-peak-opacity:${opacity};filter:drop-shadow(0 0 4px ${color}77);animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            heart.innerHTML = svgMarkup;
            root.appendChild(heart);
          }
        },
      },
      stars: {
        defaultColor: '#fff5b3',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const star = document.createElement('div');
            const size = 2 + Math.random() * 3;
            const left = Math.random() * 100;
            const top = Math.random() * 95;
            const duration = 1.5 + Math.random() * 3;
            const delay = -Math.random() * duration;
            star.style.cssText = `position:absolute;left:${left}vw;top:${top}vh;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 ${size * 2}px ${color};animation:ofPageTwinkle ${duration}s ease-in-out infinite;animation-delay:${delay}s;`;
            root.appendChild(star);
          }
        },
      },
      bats: {
        defaultColor: '#1a0033',
        build(root, color, count) {
          const batSvg = (col) => `<svg viewBox="0 0 32 18" xmlns="http://www.w3.org/2000/svg"><path d="M16 5 L13 2 L11 4 L8 2 L5 4 L2 5 L0 9 L4 8 L7 11 L11 9 L13 12 L16 10 L19 12 L21 9 L25 11 L28 8 L32 9 L30 5 L27 4 L24 2 L21 4 L19 2 Z" fill="${col}"/></svg>`;
          const svgMarkup = batSvg(color);
          for (let i = 0; i < count; i++) {
            const bat = document.createElement('div');
            const size = 24 + Math.random() * 18;
            const top = 5 + Math.random() * 60;
            const duration = 10 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const dy = -8 + Math.random() * 16;
            const flapDuration = 0.25 + Math.random() * 0.2;
            const inner = document.createElement('div');
            inner.style.cssText = `width:${size}px;height:${size * 9 / 16}px;animation:ofPageBatFlap ${flapDuration}s ease-in-out infinite;`;
            inner.innerHTML = svgMarkup;
            bat.style.cssText = `position:absolute;left:0;top:${top}vh;animation:ofPageBatFly ${duration}s linear infinite;animation-delay:${delay}s;--of-bat-dy:${dy}vh;`;
            bat.appendChild(inner);
            root.appendChild(bat);
          }
        },
      },
      confetti: {
        defaultColor: '#ff4d4d',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const piece = document.createElement('div');
            const w = 4 + Math.random() * 6;
            const h = 8 + Math.random() * 8;
            const left = Math.random() * 100;
            const duration = 5 + Math.random() * 6;
            const delay = -Math.random() * duration;
            const sway = 30 + Math.random() * 70;
            const hueShift = Math.round(-60 + Math.random() * 120);
            piece.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${w}px;height:${h}px;background:${color};filter:hue-rotate(${hueShift}deg);animation:ofPageFall ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(piece);
          }
        },
      },
      petals: {
        defaultColor: '#ffb3d1',
        build(root, color, count) {
          const petalSvg = (col) => `<svg viewBox="0 0 16 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 C 4 6, 2 14, 8 23 C 14 14, 12 6, 8 1 Z" fill="${col}" stroke="${col}" stroke-width="0.3" opacity="0.85"/></svg>`;
          const svgMarkup = petalSvg(color);
          for (let i = 0; i < count; i++) {
            const petal = document.createElement('div');
            const size = 12 + Math.random() * 12;
            const left = Math.random() * 100;
            const duration = 12 + Math.random() * 10;
            const delay = -Math.random() * duration;
            const sway = 80 + Math.random() * 100;
            const opacity = 0.5 + Math.random() * 0.4;
            petal.style.cssText = `position:absolute;left:${left}vw;top:-30px;width:${size}px;height:${size * 1.5}px;opacity:${opacity};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.2));animation:ofPageDrift ${duration}s linear infinite, ofPageSway ${duration / 3}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            petal.innerHTML = svgMarkup;
            root.appendChild(petal);
          }
        },
      },
      embers: {
        defaultColor: '#ff7a1a',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const ember = document.createElement('div');
            const size = 2 + Math.random() * 4;
            const left = Math.random() * 100;
            const duration = 6 + Math.random() * 6;
            const delay = -Math.random() * duration;
            const sway = 20 + Math.random() * 40;
            const opacity = 0.6 + Math.random() * 0.4;
            ember.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 ${size * 3}px ${color}aa, 0 0 ${size * 6}px ${color}55;--of-peak-opacity:${opacity};animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(ember);
          }
        },
      },
      bubbles: {
        defaultColor: '#a0d8ef',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const bubble = document.createElement('div');
            const size = 14 + Math.random() * 26;
            const left = Math.random() * 100;
            const duration = 9 + Math.random() * 8;
            const delay = -Math.random() * duration;
            const sway = 25 + Math.random() * 50;
            const opacity = 0.3 + Math.random() * 0.4;
            bubble.style.cssText = `position:absolute;left:${left}vw;top:110vh;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle at 30% 30%, ${color}cc, ${color}55 70%, ${color}11 100%);border:1px solid ${color}88;--of-peak-opacity:${opacity};animation:ofPageRise ${duration}s linear infinite, ofPageSway ${duration / 2.5}s ease-in-out infinite alternate;animation-delay:${delay}s, ${delay}s;--of-sway:${sway}px;`;
            root.appendChild(bubble);
          }
        },
      },
      rain: {
        defaultColor: '#a8c5e0',
        build(root, color, count) {
          for (let i = 0; i < count; i++) {
            const drop = document.createElement('div');
            const left = Math.random() * 100;
            const len = 12 + Math.random() * 20;
            const duration = 0.5 + Math.random() * 0.7;
            const delay = -Math.random() * duration;
            const opacity = 0.25 + Math.random() * 0.45;
            drop.style.cssText = `position:absolute;left:${left}vw;top:0;width:1px;height:${len}px;background:linear-gradient(to bottom, ${color}00, ${color});opacity:${opacity};animation:ofPageRain ${duration}s linear infinite;animation-delay:${delay}s;`;
            root.appendChild(drop);
          }
        },
      },
    };

    function buildLayer() {
      ensureStyle();
      const el = document.createElement('div');
      el.id = 'of-page-effects';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = `position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:9990;overflow:hidden;`;
      return el;
    }

    function teardown() {
      if (layer) { layer.remove(); layer = null; }
    }

    function applyEffect(rawName, rawColor, rawIntensity) {
      const name = String(rawName || 'none').toLowerCase();
      const intensity = (rawIntensity === 'subtle' || rawIntensity === 'heavy') ? rawIntensity : 'medium';
      const color = (rawColor && String(rawColor).trim()) || '';

      if (last.name === name && last.color === color && last.intensity === intensity) return;
      last = { name, color, intensity };

      teardown();
      const def = EFFECTS[name];
      if (!def) return;

      const effectiveColor = color || def.defaultColor;
      const count = pickCount(name, intensity);
      if (count <= 0) return;

      layer = buildLayer();
      try {
        def.build(layer, effectiveColor, count);
        document.body.appendChild(layer);
      } catch (err) {
        teardown();
      }
    }

    const bootstrap = window.__SHOWPILOT__ || {};
    const initialName = bootstrap.pageEffect != null
      ? bootstrap.pageEffect
      : (bootstrap.pageSnowEnabled ? 'snow' : 'none');
    applyEffect(initialName, bootstrap.pageEffectColor || '', bootstrap.pageEffectIntensity || 'medium');

    window._ofApplyEffect = applyEffect;
    window._ofApplySnowState = function (enabled) {
      applyEffect(enabled ? 'snow' : 'none', '', 'medium');
    };
  })();

  // ============================================================
  // VISUAL CONFIG POLL — runs unconditionally. Drives snow toggle and
  // signals the player bar when the show isn't actively playing. Cheap
  // to call (one DB read on the server side); fires every 5s as a
  // backstop alongside the socket.io updates.
  // ============================================================
  (function initVisualConfigPoll() {
    async function poll() {
      try {
        const r = await fetch('/api/visual-config', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          if (typeof window._ofApplyEffect === 'function') {
            const name = data.pageEffect != null
              ? data.pageEffect
              : (data.pageSnowEnabled ? 'snow' : 'none');
            window._ofApplyEffect(name, data.pageEffectColor || '', data.pageEffectIntensity || 'medium');
          } else if (typeof window._ofApplySnowState === 'function') {
            window._ofApplySnowState(!!data.pageSnowEnabled);
          }
          // showPlayerBar is the admin's master switch for the now-playing bar.
          // When false, hide entirely; when true, the playing/notPlaying state
          // controls actual visibility.
          if (typeof window._ofApplyShowPlayerBar === 'function') {
            window._ofApplyShowPlayerBar(data.showPlayerBar !== false);
          }
          // Show-not-playing toggles freely as FPP starts/stops between songs.
          if (typeof window._ofApplyShowNotPlaying === 'function') {
            window._ofApplyShowNotPlaying(!!data.showNotPlaying);
          }
        }
      } catch {}
    }
    setInterval(poll, 5000);
    poll(); // immediate initial poll
  })();


  // ============================================================
  // NOW-PLAYING BAR (Lite — display only, no audio)
  // ============================================================
  // Builds a sticky-bottom bar that shows what FPP is currently
  // playing: cover art, title, artist. Auto-shows when a sequence
  // is playing, auto-hides when not. No audio playback — Lite is
  // for installs delivering audio externally (PulseMesh, FM, Icecast).
  //
  // The decoration system from the full ShowPilot is preserved:
  // seasonal themes (christmas, halloween, etc.) style the bar.
  // ============================================================
  // ---- Player bar / UI translation table ----
  const _PLAYER_STRINGS = {
    es: {
      "Show isn't playing right now": 'El espectáculo no está en marcha ahora',
      'Winner!': '¡Ganador!',
      'Language:': 'Idioma:',
    },
    fr: {
      "Show isn't playing right now": 'Le spectacle n’est pas en cours maintenant',
      'Winner!': 'Gagnant !',
      'Language:': 'Langue :',
    },
    de: {
      "Show isn't playing right now": 'Die Show läuft gerade nicht',
      'Winner!': 'Gewinner!',
      'Language:': 'Sprache:',
    },
    pt: {
      "Show isn't playing right now": 'O show não está tocando agora',
      'Winner!': 'Vencedor!',
      'Language:': 'Idioma:',
    },
    it: {
      "Show isn't playing right now": 'Lo show non è in corso adesso',
      'Winner!': 'Vincitore!',
      'Language:': 'Lingua:',
    },
    pl: {
      "Show isn't playing right now": 'Pokóz nie jest teraz odtwarzany',
      'Winner!': 'Zwycięzca!',
      'Language:': 'Język:',
    },
  };
  function _pt(str) {
    const preferred = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    const lang = preferred.split('-')[0].toLowerCase();
    const table = _PLAYER_STRINGS[lang];
    return (table && table[str]) || str;
  }

  (function initNowPlayingBar() {
    const boot = window.__SHOWPILOT__ || {};

    // Admin master switch — when off, the bar is never shown regardless
    // of playback state. Updated live via the visual-config poll below.
    let showPlayerBarEnabled = boot.showPlayerBar !== false;

    // ---- Theme palettes (player bar colors per decoration) ----
    // Same palettes as full ShowPilot so existing themes apply identically.
    const themeStyle = document.createElement('style');
    themeStyle.textContent = `
      #of-listen-panel {
        --of-bg: rgba(20,20,30,0.97);
        --of-border: rgba(255,255,255,0.15);
        --of-glow: rgba(0,0,0,0);
        --of-text: #fff;
        --of-text-dim: #aaa;
        background: var(--of-bg) !important;
        border-top: 1px solid var(--of-border) !important;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.5), 0 -2px 12px var(--of-glow);
        color: var(--of-text);
        transition: background 0.4s, border-color 0.4s, box-shadow 0.4s, transform 0.25s ease-out;
      }
      #of-listen-panel.of-theme-christmas {
        --of-bg: linear-gradient(180deg, rgba(127,29,29,0.97), rgba(20,83,45,0.97));
        --of-border: rgba(254,202,202,0.8);
        --of-glow: rgba(239,68,68,0.5);
      }
      #of-listen-panel.of-theme-halloween {
        --of-bg: linear-gradient(180deg, rgba(88,28,135,0.97), rgba(154,52,18,0.97));
        --of-border: rgba(253,186,116,0.8);
        --of-glow: rgba(251,146,60,0.5);
      }
      #of-listen-panel.of-theme-easter {
        --of-bg: linear-gradient(180deg, rgba(168,85,247,0.95), rgba(96,165,250,0.95));
        --of-border: rgba(251,207,232,0.9);
        --of-glow: rgba(251,207,232,0.5);
      }
      #of-listen-panel.of-theme-stpatricks {
        --of-bg: linear-gradient(180deg, rgba(21,128,61,0.97), rgba(20,83,45,0.97));
        --of-border: rgba(134,239,172,0.8);
        --of-glow: rgba(34,197,94,0.5);
      }
      #of-listen-panel.of-theme-independence {
        --of-bg: linear-gradient(180deg, rgba(30,64,175,0.97), rgba(153,27,27,0.97));
        --of-border: rgba(255,255,255,0.85);
        --of-glow: rgba(96,165,250,0.5);
      }
      #of-listen-panel.of-theme-valentines {
        --of-bg: linear-gradient(180deg, rgba(190,24,93,0.97), rgba(112,26,117,0.97));
        --of-border: rgba(251,207,232,0.85);
        --of-glow: rgba(244,114,182,0.5);
      }
      #of-listen-panel.of-theme-hanukkah {
        --of-bg: linear-gradient(180deg, rgba(29,78,216,0.97), rgba(30,58,138,0.97));
        --of-border: rgba(191,219,254,0.85);
        --of-glow: rgba(96,165,250,0.5);
      }
      #of-listen-panel.of-theme-thanksgiving {
        --of-bg: linear-gradient(180deg, rgba(154,52,18,0.97), rgba(120,53,15,0.97));
        --of-border: rgba(253,186,116,0.8);
        --of-glow: rgba(234,88,12,0.5);
      }
      #of-listen-panel.of-theme-snow {
        --of-bg: linear-gradient(180deg, rgba(30,64,175,0.95), rgba(15,23,42,0.97));
        --of-border: rgba(186,230,253,0.85);
        --of-glow: rgba(186,230,253,0.5);
      }
      #of-listen-panel.of-theme-newyear {
        --of-bg: linear-gradient(180deg, rgba(15,23,42,0.97), rgba(49,46,129,0.97));
        --of-border: rgba(250,204,21,0.8);
        --of-glow: rgba(250,204,21,0.45);
      }
      #of-listen-panel.of-theme-dayofthedead {
        --of-bg: linear-gradient(180deg, rgba(157,23,77,0.97), rgba(76,29,149,0.97));
        --of-border: rgba(251,146,60,0.85);
        --of-glow: rgba(236,72,153,0.5);
      }
      #of-listen-panel.of-theme-diwali {
        --of-bg: linear-gradient(180deg, rgba(127,29,29,0.97), rgba(49,46,129,0.97));
        --of-border: rgba(251,191,36,0.85);
        --of-glow: rgba(251,191,36,0.5);
      }
      #of-listen-panel.of-theme-kwanzaa {
        --of-bg: linear-gradient(180deg, rgba(20,83,45,0.97), rgba(17,24,39,0.97));
        --of-border: rgba(220,38,38,0.8);
        --of-glow: rgba(34,197,94,0.45);
      }
      #of-listen-panel.of-theme-lunarnewyear {
        --of-bg: linear-gradient(180deg, rgba(185,28,28,0.97), rgba(127,29,29,0.97));
        --of-border: rgba(250,204,21,0.85);
        --of-glow: rgba(239,68,68,0.5);
      }
      #of-listen-panel.of-theme-mardigras {
        --of-bg: linear-gradient(180deg, rgba(88,28,135,0.97), rgba(21,128,61,0.97));
        --of-border: rgba(234,179,8,0.85);
        --of-glow: rgba(168,85,247,0.5);
      }

      /* Marquee scroll for long titles/artists */
      @keyframes ofMarquee {
        0%   { transform: translateX(0); }
        15%  { transform: translateX(0); }
        50%  { transform: translateX(var(--of-marquee-offset, 0)); }
        65%  { transform: translateX(var(--of-marquee-offset, 0)); }
        100% { transform: translateX(0); }
      }
      #of-listen-title.of-marquee-on,
      #of-listen-artist.of-marquee-on {
        animation: ofMarquee var(--of-marquee-duration, 10s) ease-in-out infinite;
      }
      #of-listen-title-wrap:hover #of-listen-title,
      #of-listen-artist-wrap:hover #of-listen-artist {
        animation-play-state: paused;
      }
    `;
    document.head.appendChild(themeStyle);

    // ---- Sticky-bottom panel ----
    const panel = document.createElement('div');
    panel.id = 'of-listen-panel';
    panel.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      padding: 12px 16px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 14px; line-height: 1.4;
      display: none;
      transform: translateY(100%);
      backdrop-filter: blur(8px);
    `;
    panel.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto; display: flex; gap: 12px; align-items: center; position: relative; z-index: 2;">
        <img id="of-listen-cover" src="" alt=""
             style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;
                    background: #333; flex-shrink: 0;" />
        <div style="flex: 1; min-width: 0;">
          <div id="of-listen-title-wrap" style="overflow: hidden; white-space: nowrap;">
            <div id="of-listen-title" style="font-weight: 600; display: inline-block;
                 white-space: nowrap;">Loading…</div>
          </div>
          <div id="of-listen-artist-wrap" style="overflow: hidden; white-space: nowrap;">
            <div id="of-listen-artist" style="font-size: 12px; color: rgba(255,255,255,0.65);
                 display: inline-block; white-space: nowrap;"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // ---- DOM refs ----
    const titleEl = panel.querySelector('#of-listen-title');
    const titleWrap = panel.querySelector('#of-listen-title-wrap');
    const artistEl = panel.querySelector('#of-listen-artist');
    const artistWrap = panel.querySelector('#of-listen-artist-wrap');
    const coverEl = panel.querySelector('#of-listen-cover');

    // ---- Marquee scrolling for long titles/artists ----
    function setupMarquee(textEl, wrapEl) {
      textEl.classList.remove('of-marquee-on');
      textEl.style.removeProperty('--of-marquee-offset');
      textEl.style.removeProperty('--of-marquee-duration');
      requestAnimationFrame(() => {
        const overflow = textEl.scrollWidth - wrapEl.clientWidth;
        if (overflow > 4) {
          const offset = -(overflow + 12);
          const speed = 30; // px per second
          const duration = Math.max(6, (Math.abs(offset) * 2) / speed);
          textEl.style.setProperty('--of-marquee-offset', offset + 'px');
          textEl.style.setProperty('--of-marquee-duration', duration + 's');
          textEl.classList.add('of-marquee-on');
        }
      });
    }

    let _marqueeResizeTimer = null;
    window.addEventListener('resize', () => {
      if (_marqueeResizeTimer) clearTimeout(_marqueeResizeTimer);
      _marqueeResizeTimer = setTimeout(() => {
        if (titleEl.textContent) setupMarquee(titleEl, titleWrap);
        if (artistEl.textContent) setupMarquee(artistEl, artistWrap);
      }, 250);
    });

    // ---- Show/hide bar ----
    let _barVisible = false;
    function showBar() {
      if (_barVisible || !showPlayerBarEnabled) return;
      _barVisible = true;
      panel.style.display = 'block';
      // Force reflow so the transform transition runs from the off-screen state
      void panel.offsetHeight;
      panel.style.transform = 'translateY(0)';
      // Lets the song progress bar move onto the player bar (main v0.33.207).
      try { window.dispatchEvent(new CustomEvent('showpilot:player-mode', { detail: { mode: 'open' } })); } catch {}
    }
    function hideBar() {
      if (!_barVisible) return;
      _barVisible = false;
      panel.style.transform = 'translateY(100%)';
      try { window.dispatchEvent(new CustomEvent('showpilot:player-mode', { detail: { mode: 'closed' } })); } catch {}
      // Wait for transition to finish before display:none, so it slides out
      setTimeout(() => {
        if (!_barVisible) panel.style.display = 'none';
      }, 260);
    }

    // ---- Show-not-playing handling ----
    // Visual-config poll calls this when FPP isn't playing a sequence.
    // We just hide the bar — there's nothing to display.
    function applyShowNotPlaying(notPlaying) {
      if (notPlaying) hideBar();
    }
    window._ofApplyShowNotPlaying = applyShowNotPlaying;

    // ---- Master visibility toggle (admin's viewer_show_player_bar setting) ----
    function applyShowPlayerBar(enabled) {
      showPlayerBarEnabled = enabled;
      if (!enabled) hideBar();
    }
    window._ofApplyShowPlayerBar = applyShowPlayerBar;

    // ---- Update display from now-playing data ----
    let _lastSequenceName = null;
    function updateDisplay(data) {
      if (!data || !data.playing) {
        hideBar();
        return;
      }
      // Apply decoration / theme based on visual-config in the response
      applyDecoration(
        data.playerDecoration || 'none',
        data.playerDecorationAnimated !== false,
        data.playerCustomColor || ''
      );

      const newTitle = data.displayName || data.sequenceName || '';
      const newArtist = data.artist || '';
      const newCover = data.imageUrl || '';
      const sequenceChanged = data.sequenceName !== _lastSequenceName;
      _lastSequenceName = data.sequenceName;

      if (titleEl.textContent !== newTitle) {
        titleEl.textContent = newTitle;
        setupMarquee(titleEl, titleWrap);
      }
      if (artistEl.textContent !== newArtist) {
        artistEl.textContent = newArtist;
        setupMarquee(artistEl, artistWrap);
      }
      if (coverEl.getAttribute('src') !== newCover) {
        coverEl.src = newCover;
        coverEl.style.display = newCover ? '' : 'none';
      }
      if (sequenceChanged || !_barVisible) {
        showBar();
      }
    }

    // ---- Polling ----
    // Polls /api/now-playing every 5 seconds. Cheap (single SQLite read).
    // socket.io 'now-playing' broadcasts (if present) trigger immediate
    // updates; the poll is the backstop for socket failures and templates
    // that don't subscribe.
    async function poll() {
      if (!showPlayerBarEnabled) return;
      try {
        const r = await fetch('/api/now-playing', { credentials: 'include' });
        if (r.ok) {
          const data = await r.json();
          updateDisplay(data);
        }
      } catch {}
    }
    setInterval(poll, 5000);
    poll(); // immediate

    // Optional socket.io live updates — if window.io is loaded, listen for
    // 'now-playing' broadcasts and refetch immediately so the bar reacts
    // within ~100ms of FPP starting a new sequence instead of waiting
    // up to 5s for the next poll.
    if (typeof window.io === 'function') {
      try {
        const sock = window.io();
        sock.on('now-playing', poll);
        sock.on('config-updated', poll);
      } catch (e) {
        // Socket not reachable — the 5s poll covers us.
      }
    }
    // ---- Player decoration ----
    let currentDecoration = null;
    let currentDecorationAnimated = null;
    let currentCustomColor = null;
    let decoLayer = null;

    function applyDecoration(theme, animated, customColor) {
      theme = theme || 'none';
      animated = (animated !== false);
      const customColorKey = customColor || '';
      if (theme === currentDecoration && animated === currentDecorationAnimated && customColorKey === currentCustomColor) return;
      currentDecoration = theme;
      currentDecorationAnimated = animated;
      currentCustomColor = customColorKey;

      // Update panel theme class — strip all existing of-theme-* and add new one
      panel.className = panel.className.split(/\s+/)
        .filter(c => !c.startsWith('of-theme-'))
        .join(' ').trim();
      // Clear any prior inline background overrides
      panel.style.removeProperty('background');
      panel.style.removeProperty('background-image');
      panel.style.removeProperty('background-color');
      if (theme !== 'none') {
        panel.classList.add('of-theme-' + theme);
      } else if (customColorKey) {
        // Custom color when no theme — must use !important to beat the CSS rule's !important.
        // Value is either a hex like "#1a1a2e" OR a CSS gradient like "linear-gradient(...)".
        // background-color only takes solid colors; gradients go in background-image.
        const isGradient = customColorKey.indexOf('gradient') >= 0;
        if (isGradient) {
          panel.style.setProperty('background-color', 'transparent', 'important');
          panel.style.setProperty('background-image', customColorKey, 'important');
        } else {
          panel.style.setProperty('background-image', 'none', 'important');
          panel.style.setProperty('background-color', customColorKey, 'important');
        }
      }
      // (else: leave defaults, base CSS rule applies)
      // Lets the song progress bar pick up the new theme color (main v0.33.207).
      try { window.dispatchEvent(new CustomEvent('showpilot:player-theme', { detail: { theme } })); } catch {}

      // Create overlay layer if missing.
      // Lives INSIDE the player bar (top:0, left:0, full width/height) so the
      // colored player background gives decorations contrast. overflow:visible
      // so animations like falling leaves can spill below the player edge.
      if (!decoLayer) {
        decoLayer = document.createElement('div');
        decoLayer.id = 'of-deco';
        decoLayer.style.cssText = `
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none; overflow: visible;
          z-index: 0;
        `;
        panel.style.position = panel.style.position || 'fixed';
        panel.style.overflow = 'visible';
        // Insert decoration as the FIRST child so player content sits on top
        panel.insertBefore(decoLayer, panel.firstChild);
      }

      // Honor user's prefers-reduced-motion at OS level
      const prefersReduced = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animate = animated && !prefersReduced;

      decoLayer.innerHTML = renderDecoration(theme, animate);
      // Reset panel padding-top in case previous decoration needed extra room
      panel.style.paddingTop = (theme === 'none') ? '12px' : '20px';

      // ---- Toast/banner theme inheritance (v0.24.4+) ----
      // Make the winner toast match the player's color palette by mapping
      // the player's CSS variables (--of-bg, --of-border, --of-glow) onto
      // the toast's variables (--showpilot-toast-*). Templates that set
      // their own --showpilot-toast-* vars in their CSS still win because
      // we only fill values that aren't already template-set.
      //
      // requestAnimationFrame waits one frame so the panel's computed
      // styles reflect the just-applied class change. Reading them
      // synchronously here would return the OLD theme's values.
      requestAnimationFrame(applyPlayerThemeToToast);
    }

    // Read the player panel's computed theme variables and propagate them
    // to the toast/banner CSS variables on :root. Idempotent — safe to call
    // multiple times. Only sets a toast variable if (a) the player has a
    // value for it AND (b) the toast variable isn't already set by the
    // template's own stylesheet (we check inline-style only, since
    // template-set values in stylesheets have lower specificity than
    // root.style and would get overridden silently if we always wrote).
    function applyPlayerThemeToToast() {
      try {
        const root = document.documentElement;
        const panelEl = document.getElementById('of-listen-panel');
        if (!panelEl) return;
        const cs = getComputedStyle(panelEl);

        // For custom solid/gradient colors (no theme class), the panel
        // has inline background-image/background-color rather than the
        // theme's --of-bg. Use whichever is actually rendering.
        const ofBg = (cs.getPropertyValue('--of-bg') || '').trim();
        const inlineImg = (panelEl.style.backgroundImage || '').trim();
        const inlineColor = (panelEl.style.backgroundColor || '').trim();
        const effectiveBg = inlineImg && inlineImg !== 'none'
          ? inlineImg
          : (inlineColor && inlineColor !== 'transparent' ? inlineColor : ofBg);

        const ofBorder = (cs.getPropertyValue('--of-border') || '').trim();
        const ofGlow = (cs.getPropertyValue('--of-glow') || '').trim();

        // Helper — set a toast var only if we have a player value AND
        // the user hasn't already explicitly set it (via inline root style).
        // Template-set CSS rules are NOT inline — they have lower
        // specificity and root.style overrides them, which is what we want
        // unless the template explicitly opted into theme-matching by
        // leaving the var unset. (Templates wanting custom colors should
        // use !important in their CSS to win against this.)
        const setIfPlayerHasValue = (varName, value) => {
          if (!value) return;
          root.style.setProperty(varName, value);
        };
        setIfPlayerHasValue('--showpilot-toast-bg', effectiveBg);
        setIfPlayerHasValue('--showpilot-toast-border', ofBorder);
        setIfPlayerHasValue('--showpilot-toast-accent', ofGlow);
      } catch (e) {
        // Non-fatal — toast just stays default-themed
      }
    }
    // Expose for the winner toast script (injected separately) so it can
    // re-apply on each toast render in case the theme changed since the
    // last appearance.
    window.ShowPilotApplyPlayerThemeToToast = applyPlayerThemeToToast;

    // ---- Player decorations (v0.33.224 redesign) ----
    // Each theme returns HTML (with its own <style>) for the decoration layer
    // (#of-deco) inside the Listen-on-Phone player. Design rules:
    // - Things that fly or perch (bats, pumpkins, fireworks, menorah, eggs)
    //   live on/above the player's top edge, never over its controls or text.
    // - Only transform/opacity are animated (cheap on phones); no animated
    //   filters.
    // - Every element gets its own timing/size/path (seeded, so it's the same
    //   on every load), and each theme also looks deliberate when static
    //   (animations off or prefers-reduced-motion).
    function renderDecoration(theme, animate) {
      const A = animate ? ' ofd-anim' : '';
      switch (theme) {
        case 'christmas':    return decoChristmas(A);
        case 'halloween':    return decoHalloween(A);
        case 'easter':       return decoEaster(A);
        case 'stpatricks':   return decoStPatricks(A);
        case 'independence': return decoIndependence(A);
        case 'valentines':   return decoValentines(A);
        case 'hanukkah':     return decoHanukkah(A);
        case 'thanksgiving': return decoThanksgiving(A);
        case 'snow':         return decoSnow(A);
        case 'newyear':      return decoNewYear(A);
        case 'dayofthedead': return decoDayOfDead(A);
        case 'diwali':       return decoDiwali(A);
        case 'kwanzaa':      return decoKwanzaa(A);
        case 'lunarnewyear': return decoLunarNewYear(A);
        case 'mardigras':    return decoMardiGras(A);
        default:             return '';
      }
    }

    // Deterministic pseudo-random (same layout every load).
    function decoRand(seed) {
      let s = seed >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }
    const decoBase = `
      #of-deco .ofd { position:absolute; pointer-events:none; }
      #of-deco .ofd svg { display:block; overflow:visible; }
    `;

    // ---------- Christmas: C9 bulbs on a scalloped green wire ----------
    function decoChristmas(A) {
      const N = 16;
      const palette = [
        ['#ff3b3b', '#b91c1c'], ['#22c55e', '#15803d'], ['#3b82f6', '#1d4ed8'],
        ['#ff9f1a', '#c2410c'], ['#ffe14d', '#ca8a04'],
      ];
      const r = decoRand(12);
      let wire = '';
      for (let i = 0; i < N; i++) {
        const x0 = (i / N) * 1000, x1 = ((i + 1) / N) * 1000;
        wire += `${i ? '' : 'M' + x0 + ',3 '}Q${(x0 + x1) / 2},20 ${x1},3 `;
      }
      let clips = '', bulbs = '';
      for (let i = 0; i <= N; i++) clips += `<circle cx="${(i / N) * 1000}" cy="3" r="2.2"/>`;
      for (let i = 0; i < N; i++) {
        const [hi, lo] = palette[i % palette.length];
        const dur = (2.6 + r() * 3.4).toFixed(2);
        const delay = (-r() * 6).toFixed(2);
        const twinkle = (i % 5 === 2) ? ' ofd-twinkle' : '';
        const tilt = ((r() - 0.5) * 16).toFixed(1);
        bulbs += `
          <div class="ofd ofd-bulb${A}${twinkle}" style="left:${((i + 0.5) / N) * 100}%;--c:${hi};--dur:${dur}s;--delay:${delay}s;transform:translateX(-50%) rotate(${tilt}deg)">
            <div class="ofd-halo"></div>
            <svg viewBox="0 0 20 36" width="15" height="27" aria-hidden="true">
              <defs><linearGradient id="ofdB${i}" x1="0" x2="1">
                <stop offset="0" stop-color="${lo}"/><stop offset=".45" stop-color="${hi}"/><stop offset="1" stop-color="${lo}"/>
              </linearGradient></defs>
              <rect x="6.5" y="0" width="7" height="8" rx="1.2" fill="#166534"/>
              <rect x="6.5" y="1.5" width="7" height="1" fill="#14532d"/>
              <rect x="6.5" y="4" width="7" height="1" fill="#14532d"/>
              <path d="M4,11 C4,8.5 16,8.5 16,11 C18.5,18 14,27 10,35 C6,27 1.5,18 4,11 Z" fill="url(#ofdB${i})"/>
              <path d="M6.2,12 C6,17 7.2,23 8.8,28" stroke="rgba(255,255,255,.55)" stroke-width="1.3" fill="none" stroke-linecap="round"/>
              <path class="ofd-hot" d="M4,11 C4,8.5 16,8.5 16,11 C18.5,18 14,27 10,35 C6,27 1.5,18 4,11 Z" fill="#fff"/>
            </svg>
          </div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-wire { left:0; right:0; top:0; height:24px; width:100%; }
        #of-deco .ofd-bulb { top:9px; }
        #of-deco .ofd-bulb .ofd-halo { position:absolute; left:50%; top:62%; width:34px; height:34px; margin:-17px 0 0 -17px;
          border-radius:50%; background: radial-gradient(circle, var(--c) 0%, transparent 68%); opacity:.55; }
        #of-deco .ofd-bulb .ofd-hot { opacity:.18; }
        #of-deco .ofd-bulb.ofd-anim .ofd-halo { animation: ofdGlow var(--dur) ease-in-out var(--delay) infinite alternate; }
        #of-deco .ofd-bulb.ofd-anim .ofd-hot  { animation: ofdHot  var(--dur) ease-in-out var(--delay) infinite alternate; }
        #of-deco .ofd-bulb.ofd-twinkle.ofd-anim .ofd-halo, #of-deco .ofd-bulb.ofd-twinkle.ofd-anim .ofd-hot { animation-name: ofdTwinkle; animation-direction: normal; animation-duration: calc(var(--dur) * 1.6); }
        @keyframes ofdGlow { from { opacity:.38; transform:scale(.85); } to { opacity:.75; transform:scale(1.08); } }
        @keyframes ofdHot  { from { opacity:.08; } to { opacity:.28; } }
        @keyframes ofdTwinkle { 0%,55%,100% { opacity:.6; } 65% { opacity:.05; } 72% { opacity:.7; } 80% { opacity:.12; } 88% { opacity:.65; } }
      </style>
      <svg class="ofd ofd-wire" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
        <path d="${wire}" fill="none" stroke="#14532d" stroke-width="2.2" vector-effect="non-scaling-stroke"/>
        <path d="${wire}" fill="none" stroke="rgba(134,239,172,.25)" stroke-width=".8" vector-effect="non-scaling-stroke" transform="translate(0,-.6)"/>
        <g fill="#0f3d21">${clips}</g>
      </svg>
      ${bulbs}`;
    }

    // ---------- Halloween: realistic bats + perched jack-o'-lanterns ----------
    function decoBatSvg(id) {
      // viewBox 0 0 100 60; shoulders at (46,26) and (54,26).
      const wingR = 'M54,25 L70,15 Q77,11 83,14 L99,23 Q91,27 89,37 Q82,33 75,41 Q68,36 57,38 Q55,33 54,25 Z';
      const bonesR = 'M70,15 L89,37 M70,15 L75,41 M70,15 L99,23 M63,20 L57,38';
      const mirror = (d) => d.replace(/(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/g, (m, x, y) => (100 - parseFloat(x)) + ',' + y);
      const wingL = mirror(wingR), bonesL = mirror(bonesR);
      return `
        <svg viewBox="0 0 100 60" aria-hidden="true">
          <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#2a1f33"/><stop offset="1" stop-color="#0c0810"/>
          </linearGradient></defs>
          <g class="ofd-bat-body">
            <g class="ofd-wing ofd-wing-l">
              <path d="${wingL}" fill="url(#${id})"/>
              <path d="${bonesL}" stroke="#3b2d47" stroke-width=".9" fill="none" stroke-linecap="round"/>
              <path d="M30,15 l-2,-3 l3,1 Z" fill="#0c0810"/>
            </g>
            <g class="ofd-wing ofd-wing-r">
              <path d="${wingR}" fill="url(#${id})"/>
              <path d="${bonesR}" stroke="#3b2d47" stroke-width=".9" fill="none" stroke-linecap="round"/>
              <path d="M70,15 l2,-3 l-3,1 Z" fill="#0c0810"/>
            </g>
            <path d="M50,20 C55,20 56.5,26 55.5,32 C54.8,38 52,43 50,44 C48,43 45.2,38 44.5,32 C43.5,26 45,20 50,20 Z" fill="#1c1422"/>
            <path d="M46.2,21.5 L44.8,14.5 L48.6,19.6 Z M53.8,21.5 L55.2,14.5 L51.4,19.6 Z" fill="#1c1422"/>
            <circle cx="48.3" cy="23.2" r=".75" fill="#f59e0b" opacity=".85"/>
            <circle cx="51.7" cy="23.2" r=".75" fill="#f59e0b" opacity=".85"/>
            <path d="M47.5,43 L46,48 M52.5,43 L54,48" stroke="#1c1422" stroke-width="1.3" stroke-linecap="round"/>
          </g>
        </svg>`;
    }
    function decoPumpkinSvg(id) {
      return `
        <svg viewBox="0 0 60 48" aria-hidden="true">
          <defs>
            <radialGradient id="${id}" cx="45%" cy="38%" r="65%">
              <stop offset="0" stop-color="#ffb347"/><stop offset=".55" stop-color="#f06d0e"/><stop offset="1" stop-color="#9a3406"/>
            </radialGradient>
            <radialGradient id="${id}g" cx="50%" cy="55%" r="60%">
              <stop offset="0" stop-color="#fff7c2"/><stop offset=".45" stop-color="#ffd23f"/><stop offset="1" stop-color="#ff8c00"/>
            </radialGradient>
          </defs>
          <path d="M29,9 C28,4 30,1 34,0.5 C33,3 32,6 32.5,9 Z" fill="#4d5d2a"/>
          <path d="M33,4 C37,2 41,3 42,6" stroke="#5c7a2e" stroke-width="1.2" fill="none" stroke-linecap="round"/>
          <ellipse cx="14" cy="28" rx="12" ry="17" fill="url(#${id})"/>
          <ellipse cx="46" cy="28" rx="12" ry="17" fill="url(#${id})"/>
          <ellipse cx="22" cy="28" rx="11" ry="19" fill="url(#${id})"/>
          <ellipse cx="38" cy="28" rx="11" ry="19" fill="url(#${id})"/>
          <ellipse cx="30" cy="28" rx="10" ry="19.5" fill="url(#${id})"/>
          <path d="M22,11 C19,20 19,37 22,46 M38,11 C41,20 41,37 38,46 M14,12 C9,20 9,37 14,45 M46,12 C51,20 51,37 46,45" stroke="rgba(110,35,0,.45)" stroke-width="1" fill="none"/>
          <g class="ofd-carve" fill="url(#${id}g)">
            <path d="M17,22 L24,21 L21,15 Z"/>
            <path d="M43,22 L36,21 L39,15 Z"/>
            <path d="M28.2,27 L31.8,27 L30,24 Z"/>
            <path d="M14,31 C19,39 41,39 46,31 L42,32 L40,35 L37,32.5 L34,36 L31,33 L28,36.5 L25,33 L22,35.5 L19.5,32.5 Z"/>
          </g>
        </svg>`;
    }
    function decoHalloween(A) {
      const r = decoRand(31);
      const bats = [
        { top: -44, size: 58, dur: 13, dir: 'ltr', flap: .19, glide: true },
        { top: -30, size: 40, dur: 17, dir: 'rtl', flap: .16, glide: false },
        { top: -58, size: 32, dur: 21, dir: 'ltr', flap: .15, glide: true },
        { top: -22, size: 48, dur: 15, dir: 'rtl', flap: .18, glide: true },
      ];
      let html = '';
      bats.forEach((b, i) => {
        const far = b.size < 42 ? `opacity:${b.size < 36 ? .7 : .85};` : '';
        html += `
          <div class="ofd ofd-bat ${b.dir}${A}" style="top:${b.top}px;--dur:${b.dur}s;--delay:${(-r() * b.dur).toFixed(2)}s;${far}${A ? '' : `left:${14 + i * 22}%;`}">
            <div class="ofd-bat-bob" style="--bob:${(2.1 + r() * 1.4).toFixed(2)}s">
              <div class="ofd-bat-flap ${b.glide ? 'glide' : ''}" style="width:${b.size}px;height:${(b.size * .6).toFixed(0)}px;--flap:${b.flap}s;--cycle:${(b.flap * 7).toFixed(2)}s">
                ${decoBatSvg('ofdBat' + i)}
              </div>
            </div>
          </div>`;
      });
      html += `
        <div class="ofd ofd-pumpkin${A}" style="left:10px;width:46px;--fl:1.7s">${decoPumpkinSvg('ofdPk1')}</div>
        <div class="ofd ofd-pumpkin${A}" style="right:12px;width:36px;--fl:2.3s">${decoPumpkinSvg('ofdPk2')}</div>`;
      return `<style>${decoBase}
        #of-deco .ofd-bat { left:0; }
        #of-deco .ofd-bat.rtl .ofd-bat-flap { transform: scaleX(-1); }
        #of-deco .ofd-bat.ofd-anim.ltr { animation: ofdBatL var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-bat.ofd-anim.rtl { animation: ofdBatR var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-bat.ofd-anim .ofd-bat-bob { animation: ofdBatBob var(--bob) ease-in-out infinite alternate; }
        #of-deco .ofd-bat-flap svg { width:100%; height:100%; }
        #of-deco .ofd-bat .ofd-wing { transform-box: view-box; }
        #of-deco .ofd-bat .ofd-wing-l { transform-origin: 46px 25px; transform: rotate(8deg); }
        #of-deco .ofd-bat .ofd-wing-r { transform-origin: 54px 25px; transform: rotate(-8deg); }
        #of-deco .ofd-bat.ofd-anim .ofd-wing-l { animation: ofdFlapL var(--flap) cubic-bezier(.45,0,.55,1) infinite; }
        #of-deco .ofd-bat.ofd-anim .ofd-wing-r { animation: ofdFlapR var(--flap) cubic-bezier(.45,0,.55,1) infinite; }
        #of-deco .ofd-bat.ofd-anim .ofd-bat-body { transform-box: view-box; animation: ofdLift var(--flap) ease-in-out infinite; }
        #of-deco .ofd-bat.ofd-anim .glide .ofd-wing-l { animation: ofdGlideL var(--cycle) linear infinite; }
        #of-deco .ofd-bat.ofd-anim .glide .ofd-wing-r { animation: ofdGlideR var(--cycle) linear infinite; }
        #of-deco .ofd-bat.ofd-anim .glide .ofd-bat-body { animation: ofdGlideLift var(--cycle) linear infinite; }
        /* Quick downstroke (0-38%), slower upstroke. Up = wing tips raised. */
        @keyframes ofdFlapR { 0% { transform: rotate(-38deg); } 38% { transform: rotate(30deg) scaleY(.92); } 100% { transform: rotate(-38deg); } }
        @keyframes ofdFlapL { 0% { transform: rotate(38deg); }  38% { transform: rotate(-30deg) scaleY(.92); } 100% { transform: rotate(38deg); } }
        @keyframes ofdLift  { 0%,100% { transform: translateY(1.5px); } 45% { transform: translateY(-2px); } }
        /* Four flaps, then a short glide with wings held slightly raised. */
        @keyframes ofdGlideR {
          0% { transform: rotate(-38deg); } 8% { transform: rotate(30deg); } 15% { transform: rotate(-38deg); }
          23% { transform: rotate(30deg); } 30% { transform: rotate(-38deg); } 38% { transform: rotate(30deg); }
          45% { transform: rotate(-38deg); } 53% { transform: rotate(30deg); } 60% { transform: rotate(-12deg); }
          95% { transform: rotate(-10deg); } 100% { transform: rotate(-38deg); } }
        @keyframes ofdGlideL {
          0% { transform: rotate(38deg); } 8% { transform: rotate(-30deg); } 15% { transform: rotate(38deg); }
          23% { transform: rotate(-30deg); } 30% { transform: rotate(38deg); } 38% { transform: rotate(-30deg); }
          45% { transform: rotate(38deg); } 53% { transform: rotate(-30deg); } 60% { transform: rotate(12deg); }
          95% { transform: rotate(10deg); } 100% { transform: rotate(38deg); } }
        @keyframes ofdGlideLift { 0%,60% { transform: translateY(0); } 80% { transform: translateY(2.5px); } 100% { transform: translateY(0); } }
        @keyframes ofdBatL { from { transform: translateX(-90px); } to { transform: translateX(calc(100vw + 90px)); } }
        @keyframes ofdBatR { from { transform: translateX(calc(100vw + 90px)); } to { transform: translateX(-90px); } }
        @keyframes ofdBatBob {
          0% { transform: translateY(0) rotate(-3deg); } 30% { transform: translateY(-9px) rotate(4deg); }
          55% { transform: translateY(4px) rotate(-5deg); } 80% { transform: translateY(-5px) rotate(2deg); } 100% { transform: translateY(6px) rotate(-2deg); } }
        #of-deco .ofd-pumpkin { bottom:100%; margin-bottom:-6px; }
        #of-deco .ofd-pumpkin svg { width:100%; height:auto; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
        #of-deco .ofd-pumpkin.ofd-anim .ofd-carve { animation: ofdFlicker var(--fl) steps(1) infinite; }
        @keyframes ofdFlicker { 0% { opacity:1; } 12% { opacity:.78; } 19% { opacity:.96; } 41% { opacity:.84; } 47% { opacity:1; } 68% { opacity:.72; } 74% { opacity:.93; } 90% { opacity:.86; } }
      </style>${html}`;
    }

    // ---------- Snow: crystal flakes drifting down + a snow cap ----------
    function decoFlakeSvg(arms) {
      let d = '';
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3, c = Math.cos(a), s = Math.sin(a);
        const pt = (x, y) => `${(10 + x * c - y * s).toFixed(2)},${(10 + x * s + y * c).toFixed(2)}`;
        d += `M${pt(0, 0)} L${pt(9, 0)} M${pt(5, 0)} L${pt(7.2, arms)} M${pt(5, 0)} L${pt(7.2, -arms)} `;
      }
      return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${d}" stroke="#fff" stroke-width="1.1" stroke-linecap="round" fill="none"/></svg>`;
    }
    function decoSnow(A) {
      const r = decoRand(7);
      let flakes = '';
      for (let i = 0; i < 14; i++) {
        const size = 7 + Math.round(r() * 9);
        flakes += `
          <div class="ofd ofd-flake${A}" style="left:${(3 + r() * 94).toFixed(1)}%;${A ? '' : `top:${(12 + r() * 50).toFixed(0)}%;`}width:${size}px;height:${size}px;--dur:${(7 + r() * 7).toFixed(2)}s;--delay:${(-r() * 14).toFixed(2)}s;--sway:${(2.5 + r() * 2.5).toFixed(2)}s;opacity:${(.55 + r() * .45).toFixed(2)}">
            <div class="ofd-flake-sway">${decoFlakeSvg(1.6 + r() * 1.8)}</div>
          </div>`;
      }
      let cap = 'M0,0 L0,5 ';
      for (let x = 0; x <= 1000; x += 40) cap += `Q${x + 20},${10 + ((x / 40) % 3) * 2.2} ${x + 40},5 `;
      cap += 'L1000,0 Z';
      return `<style>${decoBase}
        #of-deco .ofd-cap { left:0; right:0; top:-3px; width:100%; height:14px; filter: drop-shadow(0 1px 1.5px rgba(30,64,175,.35)); }
        #of-deco .ofd-flake { top:-24px; }
        #of-deco .ofd-flake svg { width:100%; height:100%; }
        #of-deco .ofd-flake.ofd-anim { animation: ofdFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-flake.ofd-anim .ofd-flake-sway { animation: ofdSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdFall { 0% { transform: translateY(0) rotate(0); opacity:0; } 8% { opacity:1; } 85% { opacity:1; } 100% { transform: translateY(150px) rotate(200deg); opacity:0; } }
        @keyframes ofdSway { from { transform: translateX(-10px); } to { transform: translateX(10px); } }
      </style>
      <svg class="ofd ofd-cap" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><path d="${cap}" fill="#f8fbff"/></svg>
      ${flakes}`;
    }

    // ---------- Thanksgiving: maple + oak leaves tumbling down ----------
    function decoThanksgiving(A) {
      const maple = 'M10,1 L11.6,5.4 L14.6,3.6 L14,7.6 L18.4,7 L16.2,10 L19,11.4 L14.2,13.4 L14.8,15.2 L11,14.2 L10.6,19 L9.4,19 L9,14.2 L5.2,15.2 L5.8,13.4 L1,11.4 L3.8,10 L1.6,7 L6,7.6 L5.4,3.6 L8.4,5.4 Z';
      const oak = 'M10,1 C12,2 11,4 13,4.5 C15.5,5 14,7.5 15.5,8.5 C17.5,10 15,12 16,13.5 C17,15.5 13.5,15.5 12,17 C11.2,18 10.6,19 10,19 C9.4,19 8.8,18 8,17 C6.5,15.5 3,15.5 4,13.5 C5,12 2.5,10 4.5,8.5 C6,7.5 4.5,5 7,4.5 C9,4 8,2 10,1 Z';
      const colors = ['#c2410c', '#b45309', '#d97706', '#9a3412', '#a16207', '#dc2626', '#ca8a04'];
      const r = decoRand(55);
      let leaves = '';
      for (let i = 0; i < 10; i++) {
        const size = 13 + Math.round(r() * 8), c = colors[i % colors.length];
        leaves += `
          <div class="ofd ofd-leaf${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `top:${(8 + r() * 55).toFixed(0)}%;transform:rotate(${Math.round(r() * 360)}deg);`}width:${size}px;height:${size}px;--dur:${(8 + r() * 6).toFixed(2)}s;--delay:${(-r() * 14).toFixed(2)}s;--sway:${(2 + r() * 2).toFixed(2)}s">
            <div class="ofd-leaf-sway"><div class="ofd-leaf-tumble" style="--tum:${(2.4 + r() * 2).toFixed(2)}s">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="${i % 3 ? maple : oak}" fill="${c}"/><path d="M10,19 L10,6" stroke="rgba(60,20,0,.55)" stroke-width=".8"/></svg>
            </div></div>
          </div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-leaf { top:-26px; }
        #of-deco .ofd-leaf svg { width:100%; height:100%; }
        #of-deco .ofd-leaf.ofd-anim { animation: ofdLeafFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-sway { animation: ofdLeafSway var(--sway) ease-in-out infinite alternate; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-tumble { animation: ofdTumble var(--tum) linear infinite; }
        @keyframes ofdLeafFall { 0% { transform: translateY(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px); opacity:0; } }
        @keyframes ofdLeafSway { from { transform: translateX(-16px) rotate(-18deg); } to { transform: translateX(16px) rotate(18deg); } }
        @keyframes ofdTumble { from { transform: rotateX(0) rotateY(0) rotate(0); } to { transform: rotateX(360deg) rotateY(180deg) rotate(90deg); } }
      </style>${leaves}`;
    }

    // ---------- St. Patrick's: shamrocks drifting + gold glints ----------
    function decoStPatricks(A) {
      const leaf = 'M10,10 C7.5,7 4,6.5 4.2,4 C4.4,1.8 7.4,1.6 8.5,3.4 C9.2,1.4 12.4,1.6 12.6,3.8 C12.8,6.2 11.5,7.6 10,10 Z';
      const shamrock = (fill) => `<svg viewBox="0 0 20 22" aria-hidden="true"><g fill="${fill}">
          <path d="${leaf}"/><path d="${leaf}" transform="rotate(120 10 10)"/><path d="${leaf}" transform="rotate(240 10 10)"/></g>
          <path d="M10,11 C10.5,15 12,18 13.5,21" stroke="${fill}" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`;
      const greens = ['#16a34a', '#22c55e', '#15803d', '#4ade80'];
      const r = decoRand(17);
      let html = '';
      for (let i = 0; i < 9; i++) {
        const size = 13 + Math.round(r() * 8);
        html += `
          <div class="ofd ofd-leaf${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `top:${(8 + r() * 55).toFixed(0)}%;`}width:${size}px;height:${(size * 1.1).toFixed(0)}px;--dur:${(9 + r() * 6).toFixed(2)}s;--delay:${(-r() * 15).toFixed(2)}s;--sway:${(2.2 + r() * 2).toFixed(2)}s">
            <div class="ofd-leaf-sway"><div class="ofd-leaf-tumble" style="--tum:${(3 + r() * 2).toFixed(2)}s">${shamrock(greens[i % greens.length])}</div></div>
          </div>`;
      }
      for (let i = 0; i < 6; i++) {
        html += `<div class="ofd ofd-glint${A}" style="left:${(8 + i * 16 + r() * 6).toFixed(1)}%;top:${(-6 + r() * 10).toFixed(0)}px;--delay:${(-r() * 3).toFixed(2)}s">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5,0 L6,4 L10,5 L6,6 L5,10 L4,6 L0,5 L4,4 Z" fill="#fde047"/></svg></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-leaf { top:-26px; }
        #of-deco .ofd-leaf svg { width:100%; height:100%; }
        #of-deco .ofd-leaf.ofd-anim { animation: ofdCloverFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-sway { animation: ofdCloverSway var(--sway) ease-in-out infinite alternate; }
        #of-deco .ofd-leaf.ofd-anim .ofd-leaf-tumble { animation: ofdCloverTumble var(--tum) linear infinite; }
        @keyframes ofdCloverFall { 0% { transform: translateY(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px); opacity:0; } }
        @keyframes ofdCloverSway { from { transform: translateX(-14px) rotate(-15deg); } to { transform: translateX(14px) rotate(15deg); } }
        @keyframes ofdCloverTumble { from { transform: rotateY(0) rotate(0); } to { transform: rotateY(360deg) rotate(60deg); } }
        #of-deco .ofd-glint { opacity:.7; }
        #of-deco .ofd-glint.ofd-anim { animation: ofdGlint 3s ease-in-out var(--delay) infinite; }
        @keyframes ofdGlint { 0%,70%,100% { opacity:0; transform: scale(.4) rotate(0); } 82% { opacity:1; transform: scale(1.1) rotate(45deg); } }
      </style>${html}`;
    }

    // ---------- Valentine's: hearts rising and fading ----------
    function decoValentines(A) {
      const heart = 'M10,17.5 C10,17.5 1.5,12 1.5,6.5 C1.5,3.6 3.6,1.8 6,1.8 C7.8,1.8 9.2,2.9 10,4.4 C10.8,2.9 12.2,1.8 14,1.8 C16.4,1.8 18.5,3.6 18.5,6.5 C18.5,12 10,17.5 10,17.5 Z';
      const colors = [['#f43f5e', '#be123c'], ['#fb7185', '#e11d48'], ['#ec4899', '#be185d'], ['#fda4af', '#f43f5e']];
      const r = decoRand(14);
      let html = '';
      for (let i = 0; i < 10; i++) {
        const size = 11 + Math.round(r() * 10), [a, b] = colors[i % colors.length];
        html += `
          <div class="ofd ofd-heart${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `bottom:${(20 + r() * 60).toFixed(0)}%;`}width:${size}px;height:${size}px;--dur:${(6 + r() * 5).toFixed(2)}s;--delay:${(-r() * 11).toFixed(2)}s;--sway:${(1.8 + r() * 1.6).toFixed(2)}s">
            <div class="ofd-heart-sway"><svg viewBox="0 0 20 20" aria-hidden="true">
              <defs><linearGradient id="ofdH${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
              <path d="${heart}" fill="url(#ofdH${i})"/><ellipse cx="6.2" cy="5.6" rx="2" ry="1.3" fill="rgba(255,255,255,.55)" transform="rotate(-25 6.2 5.6)"/></svg></div>
          </div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-heart { bottom:0; }
        #of-deco .ofd-heart svg { width:100%; height:100%; }
        #of-deco .ofd-heart.ofd-anim { animation: ofdRise var(--dur) ease-out var(--delay) infinite; }
        #of-deco .ofd-heart.ofd-anim .ofd-heart-sway { animation: ofdHeartSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdRise { 0% { transform: translateY(10px) scale(.6); opacity:0; } 12% { opacity:.95; } 70% { opacity:.85; } 100% { transform: translateY(-150px) scale(1.05); opacity:0; } }
        @keyframes ofdHeartSway { from { transform: translateX(-8px) rotate(-10deg); } to { transform: translateX(8px) rotate(10deg); } }
      </style>${html}`;
    }

    // ---------- Easter: patterned eggs nestled in grass on the top edge ----------
    function decoEaster(A) {
      const eggs = [
        ['#fbcfe8', '#db2777', 'zig'], ['#bae6fd', '#0284c7', 'dots'], ['#fef08a', '#ca8a04', 'bands'],
        ['#bbf7d0', '#16a34a', 'zig'], ['#ddd6fe', '#7c3aed', 'dots'], ['#fed7aa', '#ea580c', 'bands'], ['#a5f3fc', '#0891b2', 'zig'],
      ];
      const pattern = (kind, c) => kind === 'zig'
        ? `<path d="M2,12 L4.5,9.5 L7,12 L9.5,9.5 L12,12 L14.5,9.5 L17,12" stroke="${c}" stroke-width="1.4" fill="none"/><path d="M3,16 H17" stroke="${c}" stroke-width="1.2"/>`
        : kind === 'dots'
          ? `<g fill="${c}"><circle cx="7" cy="9" r="1.3"/><circle cx="13" cy="9" r="1.3"/><circle cx="10" cy="13" r="1.3"/><circle cx="6" cy="16" r="1.1"/><circle cx="14" cy="16" r="1.1"/></g>`
          : `<path d="M3.2,9 Q10,11 16.8,9 M2.4,13 Q10,15.2 17.6,13" stroke="${c}" stroke-width="1.8" fill="none"/>`;
      const r = decoRand(3);
      let html = '';
      eggs.forEach(([base, c, kind], i) => {
        html += `
          <div class="ofd ofd-egg${A}" style="left:${(6 + i * 14.2).toFixed(1)}%;--delay:${(-r() * 7).toFixed(2)}s">
            <svg viewBox="0 0 20 24" width="16" height="20" aria-hidden="true">
              <defs><clipPath id="ofdE${i}"><path d="M10,1 C15,1 18.5,9 18.5,14.5 C18.5,20 14.8,23 10,23 C5.2,23 1.5,20 1.5,14.5 C1.5,9 5,1 10,1 Z"/></clipPath></defs>
              <path d="M10,1 C15,1 18.5,9 18.5,14.5 C18.5,20 14.8,23 10,23 C5.2,23 1.5,20 1.5,14.5 C1.5,9 5,1 10,1 Z" fill="${base}"/>
              <g clip-path="url(#ofdE${i})">${pattern(kind, c)}</g>
              <ellipse cx="6.8" cy="7" rx="1.8" ry="3" fill="rgba(255,255,255,.55)" transform="rotate(20 6.8 7)"/>
            </svg>
          </div>`;
      });
      let grass = '';
      for (let x = 0; x <= 1000; x += 9) grass += `M${x},18 Q${x + 2},${6 + (x % 27) / 3} ${x + 4},${2 + (x % 13) / 2} Q${x + 3},${10 + (x % 7)} ${x + 7},18 Z `;
      return `<style>${decoBase}
        #of-deco .ofd-grass { left:0; right:0; top:-14px; width:100%; height:18px; }
        #of-deco .ofd-egg { top:-16px; transform-origin: 50% 100%; }
        #of-deco .ofd-egg.ofd-anim { animation: ofdWobble 7s ease-in-out var(--delay) infinite; }
        @keyframes ofdWobble { 0%,78%,100% { transform: rotate(0); } 82% { transform: rotate(-12deg); } 86% { transform: rotate(10deg); } 90% { transform: rotate(-6deg); } 94% { transform: rotate(3deg); } }
      </style>
      ${html}
      <svg class="ofd ofd-grass" viewBox="0 0 1000 18" preserveAspectRatio="none" aria-hidden="true"><path d="${grass}" fill="#4ade80"/><path d="M0,16 H1000 V18 H0 Z" fill="#22c55e"/></svg>`;
    }

    // ---------- Hanukkah: menorah with flickering flames + stars ----------
    function decoHanukkah(A) {
      let candles = '', flames = '';
      for (let i = 0; i < 9; i++) {
        const x = 8 + i * 9, shamash = i === 4, top = shamash ? 4 : 10;
        candles += `<rect x="${x - 1.6}" y="${top + 6}" width="3.2" height="${shamash ? 14 : 8}" rx=".8" fill="${shamash ? '#e0f2fe' : (i % 2 ? '#93c5fd' : '#f8fafc')}"/>`;
        flames += `<g class="ofd-flame" style="transform-origin:${x}px ${top + 6}px;--fd:${(0.9 + ((i * 37) % 7) / 10).toFixed(2)}s"><path d="M${x},${top} C${x + 2.4},${top + 3} ${x + 2},${top + 6} ${x},${top + 6.4} C${x - 2},${top + 6} ${x - 2.4},${top + 3} ${x},${top} Z" fill="#fbbf24"/><path d="M${x},${top + 2.4} C${x + 1},${top + 4} ${x + .8},${top + 5.6} ${x},${top + 5.8} C${x - .8},${top + 5.6} ${x - 1},${top + 4} ${x},${top + 2.4} Z" fill="#fff7d6"/></g>`;
      }
      const menorah = `
        <svg viewBox="0 0 88 46" aria-hidden="true">
          <defs><linearGradient id="ofdGold" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#b45309"/></linearGradient></defs>
          ${candles}
          <g fill="none" stroke="url(#ofdGold)" stroke-width="2.2" stroke-linecap="round">
            <path d="M44,20 V40"/>
            ${[1, 2, 3, 4].map(k => `<path d="M${44 - k * 9},18 V${20 + k * 1.5} Q${44 - k * 9},${30 + k * 2} 44,${30 + k * 2}"/><path d="M${44 + k * 9},18 V${20 + k * 1.5} Q${44 + k * 9},${30 + k * 2} 44,${30 + k * 2}"/>`).join('')}
          </g>
          <path d="M34,44 H54 L50,40 H38 Z" fill="url(#ofdGold)"/>
          ${flames}
        </svg>`;
      const r = decoRand(8);
      let stars = '';
      for (let i = 0; i < 7; i++) {
        stars += `<div class="ofd ofd-star${A}" style="left:${(26 + i * 11 + r() * 4).toFixed(1)}%;top:${(-20 + r() * 16).toFixed(0)}px;--delay:${(-r() * 4).toFixed(2)}s;--sz:${(9 + r() * 6).toFixed(0)}px">
          <svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="${i % 2 ? '#bfdbfe' : '#e5e7eb'}" stroke-width="1.4" stroke-linejoin="round"><path d="M10,2 L17,14 H3 Z"/><path d="M10,18 L3,6 H17 Z"/></g></svg></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-menorah { left:12px; bottom:100%; margin-bottom:-4px; width:78px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #of-deco .ofd-menorah svg { width:100%; height:auto; }
        #of-deco .ofd-flame { transform-box: view-box; }
        #of-deco .ofd-menorah.ofd-anim .ofd-flame { animation: ofdFlame var(--fd) ease-in-out infinite alternate; }
        @keyframes ofdFlame { 0% { transform: scale(1,1) skewX(0); } 40% { transform: scale(.92,1.12) skewX(4deg); } 70% { transform: scale(1.05,.94) skewX(-3deg); } 100% { transform: scale(.97,1.06) skewX(2deg); } }
        #of-deco .ofd-star { width:var(--sz); height:var(--sz); opacity:.75; }
        #of-deco .ofd-star svg { width:100%; height:100%; }
        #of-deco .ofd-star.ofd-anim { animation: ofdStar 4s ease-in-out var(--delay) infinite; }
        @keyframes ofdStar { 0%,100% { opacity:.25; transform: scale(.85); } 50% { opacity:.95; transform: scale(1.05); } }
      </style>
      <div class="ofd ofd-menorah${A}">${menorah}</div>${stars}`;
    }

    // ---------- Independence Day: rockets bursting above the player ----------
    function decoIndependence(A) {
      const bursts = [
        { x: 12, y: -52, c: '#ef4444', c2: '#fecaca' }, { x: 34, y: -64, c: '#f8fafc', c2: '#bfdbfe' },
        { x: 57, y: -48, c: '#3b82f6', c2: '#dbeafe' }, { x: 78, y: -60, c: '#ef4444', c2: '#fde68a' },
        { x: 92, y: -46, c: '#f8fafc', c2: '#fecaca' },
      ];
      const r = decoRand(4);
      let html = '';
      bursts.forEach((b, i) => {
        let rays = '';
        const n = 14;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + r() * .15, len = 18 + r() * 6;
          const x2 = (30 + Math.cos(a) * len).toFixed(1), y2 = (30 + Math.sin(a) * len).toFixed(1);
          const x1 = (30 + Math.cos(a) * len * .45).toFixed(1), y1 = (30 + Math.sin(a) * len * .45).toFixed(1);
          rays += `<path d="M${x1},${y1} L${x2},${y2}" stroke="${k % 2 ? b.c : b.c2}"/><circle cx="${x2}" cy="${y2}" r="1.5" fill="${b.c2}"/>`;
        }
        const d = (-r() * 4.5).toFixed(2), dur = (3.8 + r() * 1.6).toFixed(2);
        html += `
          <div class="ofd ofd-rocket${A}" style="left:${b.x}%;--d:${d}s;--dur:${dur}s"></div>
          <div class="ofd ofd-burst${A}" style="left:${b.x}%;top:${b.y}px;--d:${d}s;--dur:${dur}s">
            <svg viewBox="0 0 60 60" width="60" height="60" aria-hidden="true"><g stroke-width="1.6" stroke-linecap="round">${rays}</g></svg></div>`;
      });
      return `<style>${decoBase}
        #of-deco .ofd-burst { margin-left:-30px; opacity:.9; transform: scale(.9); }
        #of-deco .ofd-rocket { bottom:100%; width:2px; height:16px; margin-left:-1px; border-radius:1px; opacity:0;
          background: linear-gradient(to top, rgba(253,230,138,0), #fde68a); }
        #of-deco .ofd-burst.ofd-anim  { opacity:0; animation: ofdBurst  var(--dur) ease-out var(--d) infinite; }
        #of-deco .ofd-rocket.ofd-anim { animation: ofdRocket var(--dur) ease-in var(--d) infinite; }
        @keyframes ofdRocket { 0% { transform: translateY(20px); opacity:0; } 5% { opacity:1; } 30% { transform: translateY(-34px); opacity:.9; } 34%,100% { transform: translateY(-40px); opacity:0; } }
        @keyframes ofdBurst  { 0%,32% { transform: scale(.1); opacity:0; } 36% { opacity:1; } 60% { transform: scale(1); opacity:.9; } 78% { transform: scale(1.12) translateY(4px); opacity:0; } 100% { opacity:0; } }
      </style>${html}`;
    }

    // ---------- shared helpers for the newer themes ----------
    // A candle/lamp flame (outer + inner) centred at (x, y = flame tip).
    function decoFlame(x, y, h, cls) {
      return `<g class="${cls}" style="transform-origin:${x}px ${y + h}px;--fd:${(0.8 + ((x * 13) % 7) / 10).toFixed(2)}s">
        <path d="M${x},${y} C${x + h * .38},${y + h * .45} ${x + h * .32},${y + h * .95} ${x},${y + h} C${x - h * .32},${y + h * .95} ${x - h * .38},${y + h * .45} ${x},${y} Z" fill="#fbbf24"/>
        <path d="M${x},${y + h * .38} C${x + h * .16},${y + h * .62} ${x + h * .13},${y + h * .9} ${x},${y + h * .93} C${x - h * .13},${y + h * .9} ${x - h * .16},${y + h * .62} ${x},${y + h * .38} Z" fill="#fff7d6"/>
      </g>`;
    }
    // Falling confetti pieces (rectangles and curls) in the given colours.
    function decoConfetti(A, colors, count, seed, prefix) {
      const r = decoRand(seed);
      let html = '';
      for (let i = 0; i < count; i++) {
        const c = colors[i % colors.length], curl = i % 4 === 3;
        const w = curl ? 10 : 5 + Math.round(r() * 3), h = curl ? 10 : 8 + Math.round(r() * 4);
        const shape = curl
          ? `<svg viewBox="0 0 10 10" width="${w}" height="${h}" aria-hidden="true"><path d="M1,8 C3,1 6,9 9,2" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`
          : `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect width="${w}" height="${h}" rx="1" fill="${c}"/></svg>`;
        html += `<div class="ofd ${prefix}-bit${A}" style="left:${(2 + r() * 96).toFixed(1)}%;${A ? '' : `top:${(10 + r() * 60).toFixed(0)}%;transform:rotate(${Math.round(r() * 180)}deg);`}--dur:${(5 + r() * 5).toFixed(2)}s;--delay:${(-r() * 10).toFixed(2)}s;--sway:${(1.2 + r() * 1.6).toFixed(2)}s;--spin:${(0.9 + r() * 1.4).toFixed(2)}s">
          <div class="${prefix}-sway"><div class="${prefix}-spin">${shape}</div></div></div>`;
      }
      return html;
    }
    function decoConfettiCss(prefix) {
      return `
        #of-deco .${prefix}-bit { top:-18px; }
        #of-deco .${prefix}-bit.ofd-anim { animation: ${prefix}Fall var(--dur) linear var(--delay) infinite; }
        #of-deco .${prefix}-bit.ofd-anim .${prefix}-sway { animation: ${prefix}Sway var(--sway) ease-in-out infinite alternate; }
        #of-deco .${prefix}-bit.ofd-anim .${prefix}-spin { animation: ${prefix}Spin var(--spin) linear infinite; }
        @keyframes ${prefix}Fall { 0% { transform: translateY(0); opacity:0; } 6% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px); opacity:0; } }
        @keyframes ${prefix}Sway { from { transform: translateX(-9px); } to { transform: translateX(9px); } }
        @keyframes ${prefix}Spin { from { transform: rotateX(0) rotateY(0) rotate(0); } to { transform: rotateX(360deg) rotateY(180deg) rotate(180deg); } }`;
    }

    // ---------- New Year's: confetti, a glittering ball, sparkle bursts ----------
    function decoNewYear(A) {
      const confetti = decoConfetti(A, ['#facc15', '#e5e7eb', '#fde68a', '#f59e0b', '#cbd5e1', '#fef3c7'], 18, 101, 'ofdny');
      let facets = '';
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 8; col++) {
          const x = 6 + col * 5.2 - (row % 2) * 2.6, y = 6 + row * 4.6;
          if ((x - 24) ** 2 + (y - 22) ** 2 > 16.5 ** 2) continue;
          facets += `<rect class="ofd-facet" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="4.4" height="3.8" rx=".5" style="--fa:${((row * 3 + col * 5) % 9) * 0.22}s" fill="${(row + col) % 3 ? '#e2e8f0' : '#fef3c7'}"/>`;
        }
      }
      const ball = `
        <svg viewBox="0 0 48 46" aria-hidden="true">
          <defs><radialGradient id="ofdNyBall" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#94a3b8"/><stop offset="1" stop-color="#1e293b"/></radialGradient>
            <clipPath id="ofdNyClip"><circle cx="24" cy="22" r="17"/></clipPath></defs>
          <path d="M24,0 V5" stroke="#cbd5e1" stroke-width="1.2"/>
          <circle cx="24" cy="22" r="17" fill="url(#ofdNyBall)"/>
          <g clip-path="url(#ofdNyClip)" opacity=".85">${facets}</g>
          <circle cx="18" cy="15" r="3.4" fill="#fff" opacity=".8"/>
        </svg>`;
      const r = decoRand(66);
      let sparks = '';
      for (let i = 0; i < 5; i++) {
        sparks += `<div class="ofd ofd-nyspark${A}" style="left:${(10 + i * 19 + r() * 6).toFixed(1)}%;top:${(-30 + r() * 20).toFixed(0)}px;--delay:${(-r() * 3.5).toFixed(2)}s">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><g stroke="${i % 2 ? '#fde68a' : '#f8fafc'}" stroke-width="1.4" stroke-linecap="round">
            <path d="M12,2 V7 M12,17 V22 M2,12 H7 M17,12 H22 M5,5 L8.5,8.5 M15.5,15.5 L19,19 M19,5 L15.5,8.5 M8.5,15.5 L5,19"/></g></svg></div>`;
      }
      return `<style>${decoBase}${decoConfettiCss('ofdny')}
        #of-deco .ofd-nyball { right:18%; bottom:100%; margin-bottom:6px; width:40px; filter: drop-shadow(0 0 8px rgba(250,204,21,.45)); }
        #of-deco .ofd-nyball svg { width:100%; height:auto; }
        #of-deco .ofd-nyball.ofd-anim { transform-origin: 50% 0; animation: ofdNySwing 5s ease-in-out infinite alternate; }
        #of-deco .ofd-nyball.ofd-anim .ofd-facet { animation: ofdNyFacet 2s ease-in-out var(--fa) infinite; }
        @keyframes ofdNySwing { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
        @keyframes ofdNyFacet { 0%,100% { opacity:.55; } 50% { opacity:1; fill:#fff; } }
        #of-deco .ofd-nyspark { opacity:.8; }
        #of-deco .ofd-nyspark.ofd-anim { animation: ofdNySpark 3.5s ease-out var(--delay) infinite; }
        @keyframes ofdNySpark { 0%,60% { opacity:0; transform: scale(.2) rotate(0); } 70% { opacity:1; } 90% { opacity:0; transform: scale(1.2) rotate(30deg); } 100% { opacity:0; } }
      </style>
      <div class="ofd ofd-nyball${A}">${ball}</div>${sparks}${confetti}`;
    }

    // ---------- Día de los Muertos: papel picado banner + marigold petals ----------
    function decoDayOfDead(A) {
      const flagColors = ['#ec4899', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#a855f7', '#ef4444'];
      const N = 12;
      let cord = 'M0,3 ';
      for (let i = 0; i < N; i++) cord += `Q${((i + 0.5) / N) * 1000},9 ${((i + 1) / N) * 1000},3 `;
      const patterns = [
        'M6,7 h8 v2 h-8 Z M10,11 m-2.4,0 a2.4,2.4 0 1,0 4.8,0 a2.4,2.4 0 1,0 -4.8,0 Z M5,15 l2,-1.5 l2,1.5 l2,-1.5 l2,1.5 l2,-1.5 v1.4 l-2,1.5 l-2,-1.5 l-2,1.5 l-2,-1.5 l-2,1.5 Z',
        'M10,5 l1.6,3.4 l3.6,.4 l-2.7,2.5 l.8,3.6 l-3.3,-1.9 l-3.3,1.9 l.8,-3.6 l-2.7,-2.5 l3.6,-.4 Z M5,17 h10 v1.4 h-10 Z',
        'M7,8 m-1.6,0 a1.6,1.6 0 1,0 3.2,0 a1.6,1.6 0 1,0 -3.2,0 M13,8 m-1.6,0 a1.6,1.6 0 1,0 3.2,0 a1.6,1.6 0 1,0 -3.2,0 M10,12 l-1.2,2 h2.4 Z M6,16 q4,2.6 8,0 v1.2 q-4,2.6 -8,0 Z',
      ];
      let flags = '';
      for (let i = 0; i < N; i++) {
        const c = flagColors[i % flagColors.length];
        flags += `<div class="ofd ofd-picado${A}" style="left:${((i + 0.5) / N) * 100}%;--delay:${(-(i * 0.37) % 3).toFixed(2)}s;--dur:${(2.6 + (i % 4) * 0.35).toFixed(2)}s">
          <svg viewBox="0 0 20 24" width="20" height="24" aria-hidden="true">
            <path fill-rule="evenodd" fill="${c}" d="M0,0 H20 V20 L17.5,22.5 L15,20 L12.5,22.5 L10,20 L7.5,22.5 L5,20 L2.5,22.5 L0,20 Z ${patterns[i % patterns.length]}"/>
          </svg></div>`;
      }
      const r = decoRand(91);
      let petals = '';
      for (let i = 0; i < 12; i++) {
        const c = i % 3 ? '#f97316' : '#facc15', s = 7 + Math.round(r() * 5);
        petals += `<div class="ofd ofd-petal${A}" style="left:${(3 + r() * 94).toFixed(1)}%;${A ? '' : `top:${(20 + r() * 50).toFixed(0)}%;`}--dur:${(7 + r() * 5).toFixed(2)}s;--delay:${(-r() * 12).toFixed(2)}s;--sway:${(1.8 + r() * 1.6).toFixed(2)}s">
          <div class="ofd-petal-sway"><svg viewBox="0 0 10 12" width="${s}" height="${(s * 1.2).toFixed(0)}" aria-hidden="true"><path d="M5,0 C8.5,2 9.5,7 5,12 C0.5,7 1.5,2 5,0 Z" fill="${c}"/><path d="M5,2 V10" stroke="rgba(154,52,18,.5)" stroke-width=".6"/></svg></div></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-cord { left:0; right:0; top:0; width:100%; height:12px; }
        #of-deco .ofd-picado { top:5px; margin-left:-10px; transform-origin: 50% 0; opacity:.95; }
        #of-deco .ofd-picado.ofd-anim { animation: ofdPicado var(--dur) ease-in-out var(--delay) infinite alternate; }
        @keyframes ofdPicado { from { transform: rotate(-5deg) skewX(-3deg); } to { transform: rotate(5deg) skewX(3deg); } }
        #of-deco .ofd-petal { top:-20px; }
        #of-deco .ofd-petal.ofd-anim { animation: ofdPetalFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-petal.ofd-anim .ofd-petal-sway { animation: ofdPetalSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdPetalFall { 0% { transform: translateY(0) rotate(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px) rotate(240deg); opacity:0; } }
        @keyframes ofdPetalSway { from { transform: translateX(-12px); } to { transform: translateX(12px); } }
      </style>
      <svg class="ofd ofd-cord" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true"><path d="${cord}" fill="none" stroke="#fde68a" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
      ${flags}${petals}`;
    }

    // ---------- Diwali: diya lamps on the edge + rising embers ----------
    function decoDiwali(A) {
      const diya = (i) => `
        <svg viewBox="0 0 40 30" aria-hidden="true">
          <defs><linearGradient id="ofdDiya${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#d9772b"/><stop offset="1" stop-color="#7c2d12"/></linearGradient>
            <radialGradient id="ofdDiyaG${i}"><stop offset="0" stop-color="rgba(255,200,80,.85)"/><stop offset="1" stop-color="rgba(255,160,40,0)"/></radialGradient></defs>
          <circle class="ofd-diya-glow" cx="30" cy="8" r="13" fill="url(#ofdDiyaG${i})"/>
          <path d="M3,15 C8,27 30,29 37,15 C37,13 33,12.5 30,13 L6,13 C4,13 3,13.5 3,15 Z" fill="url(#ofdDiya${i})"/>
          <path d="M3.5,14.5 C10,17 30,17 36.5,14.5" stroke="#fbbf24" stroke-width="1.1" fill="none"/>
          <g fill="#fcd34d"><circle cx="12" cy="20" r="1"/><circle cx="20" cy="21.5" r="1"/><circle cx="28" cy="20" r="1"/></g>
          <path d="M29,13 C30,11 32,11 33,13" stroke="#3f2a12" stroke-width="1" fill="none"/>
          ${decoFlame(31, 1, 11, 'ofd-flame')}
        </svg>`;
      const spots = [8, 30, 52, 74, 92];
      let html = '';
      spots.forEach((x, i) => { html += `<div class="ofd ofd-diya${A}" style="left:${x}%">${diya(i)}</div>`; });
      const r = decoRand(23);
      const ember = ['#fde047', '#fb923c', '#f472b6', '#a78bfa', '#34d399'];
      for (let i = 0; i < 12; i++) {
        html += `<div class="ofd ofd-ember${A}" style="left:${(4 + r() * 92).toFixed(1)}%;${A ? '' : `top:${(-40 + r() * 30).toFixed(0)}px;`}--dur:${(4 + r() * 4).toFixed(2)}s;--delay:${(-r() * 8).toFixed(2)}s;--c:${ember[i % ember.length]}"></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-diya { bottom:100%; margin-bottom:-5px; width:38px; margin-left:-19px; filter: drop-shadow(0 2px 2px rgba(0,0,0,.5)); }
        #of-deco .ofd-diya svg { width:100%; height:auto; }
        #of-deco .ofd-flame { transform-box: view-box; }
        #of-deco .ofd-diya.ofd-anim .ofd-flame { animation: ofdFlame var(--fd) ease-in-out infinite alternate; }
        #of-deco .ofd-diya.ofd-anim .ofd-diya-glow { animation: ofdDiyaGlow 1.9s ease-in-out infinite alternate; }
        @keyframes ofdFlame { 0% { transform: scale(1,1) skewX(0); } 40% { transform: scale(.92,1.12) skewX(4deg); } 70% { transform: scale(1.05,.94) skewX(-3deg); } 100% { transform: scale(.97,1.06) skewX(2deg); } }
        @keyframes ofdDiyaGlow { from { opacity:.65; } to { opacity:1; } }
        #of-deco .ofd-ember { bottom:100%; width:3px; height:3px; border-radius:50%; background: var(--c); box-shadow: 0 0 4px var(--c); opacity:.8; }
        #of-deco .ofd-ember.ofd-anim { animation: ofdEmber var(--dur) ease-out var(--delay) infinite; }
        @keyframes ofdEmber { 0% { transform: translate(0,0); opacity:0; } 15% { opacity:1; } 100% { transform: translate(10px,-70px); opacity:0; } }
      </style>${html}`;
    }

    // ---------- Kwanzaa: kinara with seven candles + kente-inspired band ----------
    function decoKwanzaa(A) {
      const colors = ['#dc2626', '#dc2626', '#dc2626', '#111827', '#16a34a', '#16a34a', '#16a34a'];
      let candles = '', flames = '';
      colors.forEach((c, i) => {
        const x = 9 + i * 10, h = i === 3 ? 16 : 13 - Math.abs(3 - i) * 0.6, top = 26 - h;
        candles += `<rect x="${x - 2.2}" y="${top}" width="4.4" height="${h}" rx="1" fill="${c}" stroke="${c === '#111827' ? '#4b5563' : 'none'}" stroke-width=".6"/>`;
        flames += decoFlame(x, top - 7.5, 7, 'ofd-flame');
      });
      const kinara = `
        <svg viewBox="0 0 88 40" aria-hidden="true">
          <defs><linearGradient id="ofdWood" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#a16207"/><stop offset="1" stop-color="#57300d"/></linearGradient></defs>
          ${candles}
          <path d="M4,26 H84 L80,31 H8 Z" fill="url(#ofdWood)"/>
          <path d="M20,31 L16,39 H72 L68,31 Z" fill="url(#ofdWood)" opacity=".92"/>
          <path d="M8,28.5 H80" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>
          ${flames}
        </svg>`;
      let band = '';
      const bc = ['#dc2626', '#111827', '#16a34a', '#eab308'];
      for (let x = 0, k = 0; x < 1000; x += 25, k++) {
        band += `<rect x="${x}" y="0" width="25" height="5" fill="${bc[k % 4]}"/><rect x="${x + 7}" y="1.5" width="11" height="2" fill="${bc[(k + 2) % 4]}"/>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-kente { left:0; right:0; top:0; width:100%; height:5px; opacity:.9; }
        #of-deco .ofd-kinara { left:12px; bottom:100%; margin-bottom:-4px; width:82px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #of-deco .ofd-kinara svg { width:100%; height:auto; }
        #of-deco .ofd-flame { transform-box: view-box; }
        #of-deco .ofd-kinara.ofd-anim .ofd-flame { animation: ofdFlame var(--fd) ease-in-out infinite alternate; }
        @keyframes ofdFlame { 0% { transform: scale(1,1) skewX(0); } 40% { transform: scale(.92,1.12) skewX(4deg); } 70% { transform: scale(1.05,.94) skewX(-3deg); } 100% { transform: scale(.97,1.06) skewX(2deg); } }
      </style>
      <svg class="ofd ofd-kente" viewBox="0 0 1000 5" preserveAspectRatio="none" aria-hidden="true">${band}</svg>
      <div class="ofd ofd-kinara${A}">${kinara}</div>`;
    }

    // ---------- Lunar New Year: red lanterns on a gold cord + blossom petals ----------
    function decoLunarNewYear(A) {
      const N = 7;
      let cord = 'M0,2 ';
      for (let i = 0; i < N; i++) cord += `Q${((i + 0.5) / N) * 1000},12 ${((i + 1) / N) * 1000},2 `;
      const r = decoRand(88);
      let lanterns = '';
      for (let i = 0; i < N; i++) {
        lanterns += `<div class="ofd ofd-lantern${A}" style="left:${((i + 0.5) / N) * 100}%;--dur:${(2.8 + r() * 1.6).toFixed(2)}s;--delay:${(-r() * 3).toFixed(2)}s">
          <svg viewBox="0 0 24 40" width="17" height="28" aria-hidden="true">
            <defs><radialGradient id="ofdLan${i}" cx="40%" cy="45%" r="65%"><stop offset="0" stop-color="#ff6b5b"/><stop offset=".6" stop-color="#dc2626"/><stop offset="1" stop-color="#7f1d1d"/></radialGradient></defs>
            <path d="M12,0 V5" stroke="#eab308" stroke-width="1"/>
            <rect x="7" y="4" width="10" height="3" rx="1" fill="#eab308"/>
            <ellipse cx="12" cy="17" rx="10" ry="10.5" fill="url(#ofdLan${i})"/>
            <path d="M12,6.5 C7,10 7,24 12,27.5 M12,6.5 C17,10 17,24 12,27.5 M4,12 C8,15 16,15 20,12 M4,22 C8,19 16,19 20,22" stroke="rgba(120,20,20,.55)" stroke-width=".8" fill="none"/>
            <rect x="7" y="26.5" width="10" height="3" rx="1" fill="#eab308"/>
            <path d="M10,29.5 V39 M12,29.5 V40 M14,29.5 V39" stroke="#eab308" stroke-width="1" stroke-linecap="round"/>
          </svg></div>`;
      }
      let petals = '';
      for (let i = 0; i < 10; i++) {
        const s = 7 + Math.round(r() * 4);
        petals += `<div class="ofd ofd-bloom${A}" style="left:${(3 + r() * 94).toFixed(1)}%;${A ? '' : `top:${(20 + r() * 50).toFixed(0)}%;`}--dur:${(8 + r() * 5).toFixed(2)}s;--delay:${(-r() * 13).toFixed(2)}s;--sway:${(2 + r() * 1.5).toFixed(2)}s">
          <div class="ofd-bloom-sway"><svg viewBox="0 0 10 10" width="${s}" height="${s}" aria-hidden="true"><path d="M5,0.5 C8,1.5 9.5,5 5,9.5 C0.5,5 2,1.5 5,0.5 Z" fill="${i % 2 ? '#fbcfe8' : '#f9a8d4'}"/></svg></div></div>`;
      }
      return `<style>${decoBase}
        #of-deco .ofd-lcord { left:0; right:0; top:0; width:100%; height:14px; }
        #of-deco .ofd-lantern { top:4px; margin-left:-8.5px; transform-origin: 50% 0; filter: drop-shadow(0 0 5px rgba(239,68,68,.55)); }
        #of-deco .ofd-lantern.ofd-anim { animation: ofdLantern var(--dur) ease-in-out var(--delay) infinite alternate; }
        @keyframes ofdLantern { from { transform: rotate(-6deg); } to { transform: rotate(6deg); } }
        #of-deco .ofd-bloom { top:-18px; }
        #of-deco .ofd-bloom.ofd-anim { animation: ofdBloomFall var(--dur) linear var(--delay) infinite; }
        #of-deco .ofd-bloom.ofd-anim .ofd-bloom-sway { animation: ofdBloomSway var(--sway) ease-in-out infinite alternate; }
        @keyframes ofdBloomFall { 0% { transform: translateY(0) rotate(0); opacity:0; } 8% { opacity:1; } 88% { opacity:1; } 100% { transform: translateY(150px) rotate(220deg); opacity:0; } }
        @keyframes ofdBloomSway { from { transform: translateX(-11px); } to { transform: translateX(11px); } }
      </style>
      <svg class="ofd ofd-lcord" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><path d="${cord}" fill="none" stroke="#eab308" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
      ${lanterns}${petals}`;
    }

    // ---------- Mardi Gras: draped beads, a feathered mask, confetti ----------
    function decoMardiGras(A) {
      const beadColors = ['#7e22ce', '#16a34a', '#eab308'];
      let beads = '';
      const strands = 4;
      for (let s = 0; s < strands; s++) {
        const x0 = (s / strands) * 1000, x1 = ((s + 1) / strands) * 1000, sag = 16 + (s % 2) * 4;
        for (let k = 0; k <= 26; k++) {
          const t = k / 26, x = x0 + (x1 - x0) * t, y = 3 + sag * 4 * t * (1 - t);
          beads += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="4.2" ry="3.2" fill="${beadColors[(s + k) % 3]}"/><ellipse cx="${(x - 1.2).toFixed(1)}" cy="${(y - 1).toFixed(1)}" rx="1.2" ry=".9" fill="rgba(255,255,255,.6)"/>`;
        }
      }
      const mask = `
        <svg viewBox="0 0 56 40" aria-hidden="true">
          <defs><linearGradient id="ofdMask" x1="0" x2="1"><stop offset="0" stop-color="#7e22ce"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#7e22ce"/></linearGradient></defs>
          <path class="ofd-plume" d="M40,18 C44,6 50,1 54,0 C52,6 49,12 43,19 Z" fill="#16a34a"/>
          <path class="ofd-plume" d="M38,18 C39,7 43,2 47,-1 C46,6 45,12 41,19 Z" fill="#eab308"/>
          <path d="M4,22 C8,14 20,14 28,19 C36,14 48,14 52,22 C50,32 38,34 28,27 C18,34 6,32 4,22 Z" fill="url(#ofdMask)" stroke="#eab308" stroke-width="1.2"/>
          <path fill="#1f0f2e" d="M11,22 C14,18.5 20,18.5 22.5,22.5 C19,25.5 14,25.5 11,22 Z M45,22 C42,18.5 36,18.5 33.5,22.5 C37,25.5 42,25.5 45,22 Z"/>
          <g fill="#fde68a"><circle cx="28" cy="23" r="1.2"/><circle cx="8" cy="20" r=".9"/><circle cx="48" cy="20" r=".9"/></g>
        </svg>`;
      const confetti = decoConfetti(A, ['#7e22ce', '#16a34a', '#eab308', '#a855f7', '#22c55e', '#facc15'], 14, 202, 'ofdmg');
      return `<style>${decoBase}${decoConfettiCss('ofdmg')}
        #of-deco .ofd-beads { left:0; right:0; top:0; width:100%; height:26px; }
        #of-deco .ofd-mask { right:16px; bottom:100%; margin-bottom:-4px; width:54px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
        #of-deco .ofd-mask svg { width:100%; height:auto; }
        #of-deco .ofd-mask .ofd-plume { transform-box: view-box; transform-origin: 42px 19px; }
        #of-deco .ofd-mask.ofd-anim .ofd-plume { animation: ofdPlume 3s ease-in-out infinite alternate; }
        @keyframes ofdPlume { from { transform: rotate(-4deg); } to { transform: rotate(5deg); } }
      </style>
      <svg class="ofd ofd-beads" viewBox="0 0 1000 26" preserveAspectRatio="none" aria-hidden="true">${beads}</svg>
      <div class="ofd ofd-mask${A}">${mask}</div>${confetti}`;
    }
  })();
})();
