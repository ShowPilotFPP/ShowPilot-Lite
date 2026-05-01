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

  function mapErrorToId(error) {
    const msg = (error || '').toLowerCase();
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
    if (!els.length) return; // template doesn't include the placeholder; skip
    let text;
    if (timerStartedAtMs === null || timerDurationSec === null) {
      text = '--:--';
    } else {
      const elapsedSec = (Date.now() - timerStartedAtMs) / 1000;
      text = formatTimerText(timerDurationSec - elapsedSec);
    }
    els.forEach(el => { if (el.textContent !== text) el.textContent = text; });
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
    if (timerInterval === null && document.querySelector('[data-showpilot-timer]')) {
      timerInterval = setInterval(paintTimer, 1000);
    }
  }
  // Seed from bootstrap so the timer is correct before the first poll.
  if (boot.nowPlayingStartedAtIso || boot.nowPlayingDurationSeconds) {
    updateTimerFromState(boot.nowPlayingStartedAtIso, boot.nowPlayingDurationSeconds);
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
      showMessage(mapErrorToId(result.data?.error));
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
      showMessage(mapErrorToId(result.data?.error));
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
      const res = await fetch('/api/state', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
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

    // --- Now-playing timer (v0.5.9+) ---
    // The server sends started_at + duration on every state poll. Pass
    // both (even if null — that's how we know to render --:--).
    updateTimerFromState(data.nowPlayingStartedAtIso || null, data.nowPlayingDurationSeconds || null);

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
    const nowEl = document.querySelector('.now-playing-text');
    if (nowEl) {
      const nowDisplay = data.nowPlaying
        ? (data.sequences || []).find(s => s.name === data.nowPlaying)?.display_name || data.nowPlaying
        : '—';
      if (nowEl.textContent !== nowDisplay) nowEl.textContent = nowDisplay;
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
    const nextEl = document.querySelector('[data-showpilot-next], [data-openfalcon-next]');
    if (nextEl) {
      const nextDisplay = data.nextScheduled
        ? (data.sequences || []).find(s => s.name === data.nextScheduled)?.display_name || data.nextScheduled
        : '—';
      if (nextEl.textContent !== nextDisplay) nextEl.textContent = nextDisplay;
    }

    // --- Queue size & queue list ---
    const queueSizeEl = document.querySelector('[data-showpilot-queue-size], [data-openfalcon-queue-size]');
    if (queueSizeEl) queueSizeEl.textContent = String((data.queue || []).length);

    const queueListEl = document.querySelector('[data-showpilot-queue-list], [data-openfalcon-queue-list]');
    if (queueListEl) {
      const byName = Object.fromEntries((data.sequences || []).map(s => [s.name, s]));
      if ((data.queue || []).length === 0) {
        // Match the server-side renderQueue empty-state shape (v0.5.13+).
        queueListEl.innerHTML = '<div class="queue-empty">Queue is empty.</div>';
      } else {
        // Match the server-side renderQueue shape: each entry is its own
        // <div class="queue-item"> so RF Page Builder's `.queue-list > div`
        // selector matches.
        queueListEl.innerHTML = data.queue.map(e => {
          const seq = byName[e.sequence_name];
          const name = seq ? seq.display_name : e.sequence_name;
          return `<div class="queue-item" data-seq="${escapeAttr(e.sequence_name)}">${escapeHtml(name)}</div>`;
        }).join('');
      }
    }

    // --- Sequence cover images (live-update when admin changes a cover) ---
    // Each sequence-image carries data-seq-name so we can target it precisely.
    // The server returns image_url with a ?v=<mtime> cache-buster, so a different
    // src means the cover was updated.
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
    // so templates from earlier versions keep working.
    document.querySelectorAll('[data-showpilot-container="jukebox"], [data-openfalcon-container="jukebox"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'JUKEBOX' ? '' : 'none';
    });
    document.querySelectorAll('[data-showpilot-container="voting"], [data-openfalcon-container="voting"]').forEach(el => {
      el.style.display = data.viewerControlMode === 'VOTING' ? '' : 'none';
    });
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
      showMessage(mapErrorToId(result.data?.error));
    }
  };

  function escapeAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }
  function escapeJsString(s) {
    return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
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
    }
    function hideBar() {
      if (!_barVisible) return;
      _barVisible = false;
      panel.style.transform = 'translateY(100%)';
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

    function renderDecoration(theme, animate) {
      const animClass = animate ? ' of-deco-animate' : '';
      switch (theme) {
        case 'christmas':       return christmasLights(animClass);
        case 'halloween':       return halloweenSpooky(animClass);
        case 'easter':          return easterEggs(animClass);
        case 'stpatricks':      return stPatricksClovers(animClass);
        case 'independence':    return independenceFireworks(animClass);
        case 'valentines':      return valentinesHearts(animClass);
        case 'hanukkah':        return hanukkahStars(animClass);
        case 'thanksgiving':    return thanksgivingLeaves(animClass);
        case 'snow':            return snowFall(animClass);
        default:                return '';
      }
    }

    // ---- Decoration renderers (each returns HTML string) ----

    function christmasLights(animClass) {
      // String of bulbs across the TOP edge of the player, hanging down slightly.
      // Wire sits at top:0 (player edge), bulbs hang from it into the player area.
      const colors = [
        { core: '#fff5f0', mid: '#ef4444', edge: '#7f1d1d' }, // red
        { core: '#fffbeb', mid: '#facc15', edge: '#854d0e' }, // gold
        { core: '#f0fdf4', mid: '#22c55e', edge: '#14532d' }, // green
        { core: '#eff6ff', mid: '#3b82f6', edge: '#1e3a8a' }, // blue
        { core: '#faf5ff', mid: '#a855f7', edge: '#581c87' }, // purple
      ];
      const count = 18;
      let bulbs = '';
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const c = colors[i % colors.length];
        const delay = ((i * 0.23) % 2.0).toFixed(2);
        const id = 'ofg' + i;
        bulbs += `
          <svg class="of-bulb${animClass}" viewBox="0 0 14 22" width="18" height="28"
               style="left:${left}%;animation-delay:${delay}s;--bulb-color:${c.mid};">
            <defs>
              <radialGradient id="${id}" cx="35%" cy="40%" r="60%">
                <stop offset="0%" stop-color="${c.core}"/>
                <stop offset="40%" stop-color="${c.mid}"/>
                <stop offset="100%" stop-color="${c.edge}"/>
              </radialGradient>
            </defs>
            <rect x="5" y="0" width="4" height="3" fill="#1f2937" rx="0.5"/>
            <rect x="4" y="2" width="6" height="2" fill="#374151"/>
            <ellipse cx="7" cy="13" rx="5" ry="7" fill="url(#${id})"/>
            <ellipse cx="5" cy="10" rx="1.5" ry="2.5" fill="rgba(255,255,255,0.6)"/>
          </svg>`;
      }
      return `
        <style>
          #of-deco .of-wire {
            position:absolute; top:6px; left:0; right:0; height:2px;
            background: linear-gradient(180deg, #1f2937 0%, #0f172a 100%);
            border-radius: 1px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.5);
          }
          #of-deco .of-bulb {
            position:absolute; top:0; transform:translateX(-50%);
            filter: drop-shadow(0 0 6px var(--bulb-color));
          }
          #of-deco .of-bulb.of-deco-animate {
            animation: ofTwinkle 1.6s ease-in-out infinite;
          }
          @keyframes ofTwinkle {
            0%, 100% { filter: drop-shadow(0 0 1px rgba(0,0,0,0)) brightness(0.55); }
            50%      { filter: drop-shadow(0 0 12px var(--bulb-color)) brightness(1.4); }
          }
        </style>
        <div class="of-wire"></div>
        ${bulbs}
      `;
    }

    function halloweenSpooky(animClass) {
      const batSvg = `
        <svg viewBox="0 0 40 24" width="42" height="25">
          <g fill="#0a0a0a">
            <ellipse cx="20" cy="14" rx="3.5" ry="4"/>
            <path class="of-wing-l" d="M 17,12 Q 8,6 0,8 Q 4,11 6,16 Q 2,18 4,22 Q 10,18 14,18 Q 17,18 17,16 Z"
                  style="transform-origin:17px 13px"/>
            <path class="of-wing-r" d="M 23,12 Q 32,6 40,8 Q 36,11 34,16 Q 38,18 36,22 Q 30,18 26,18 Q 23,18 23,16 Z"
                  style="transform-origin:23px 13px"/>
            <path d="M 18,10 L 17,7 L 19,9 Z M 22,10 L 23,7 L 21,9 Z"/>
            <circle cx="18.5" cy="13" r="0.6" fill="#dc2626"/>
            <circle cx="21.5" cy="13" r="0.6" fill="#dc2626"/>
          </g>
        </svg>`;
      const pumpkinSvg = `
        <svg viewBox="0 0 24 22" width="34" height="32">
          <defs>
            <radialGradient id="ofPump" cx="40%" cy="40%" r="60%">
              <stop offset="0%" stop-color="#fb923c"/>
              <stop offset="60%" stop-color="#ea580c"/>
              <stop offset="100%" stop-color="#7c2d12"/>
            </radialGradient>
          </defs>
          <path d="M 11,2 Q 11,5 12,5 Q 13,5 13,2 L 13,4 Q 14,3 15,4" stroke="#15803d" stroke-width="1.2" fill="none"/>
          <ellipse cx="6" cy="13" rx="4" ry="7" fill="url(#ofPump)" opacity="0.85"/>
          <ellipse cx="18" cy="13" rx="4" ry="7" fill="url(#ofPump)" opacity="0.85"/>
          <ellipse cx="12" cy="13" rx="6" ry="8" fill="url(#ofPump)"/>
          <path d="M 8,11 L 10,13 L 8,13 Z" fill="#fde047"/>
          <path d="M 16,11 L 14,13 L 16,13 Z" fill="#fde047"/>
          <path d="M 9,16 Q 12,18 15,16 L 14,17 L 13,16 L 12,17 L 11,16 L 10,17 Z" fill="#fde047"/>
        </svg>`;
      return `
        <style>
          #of-deco .of-bat {
            position:absolute; top:8px; left:-50px;
            filter: drop-shadow(0 0 5px rgba(168,85,247,0.7));
          }
          #of-deco .of-bat.of-deco-animate { animation: ofBatFly 9s linear infinite; }
          #of-deco .of-bat.of-deco-animate .of-wing-l { animation: ofWingL 0.25s ease-in-out infinite; }
          #of-deco .of-bat.of-deco-animate .of-wing-r { animation: ofWingR 0.25s ease-in-out infinite; }
          @keyframes ofBatFly {
            0%   { transform: translateX(0)    translateY(0)  scale(0.8); opacity:0; }
            5%   { opacity: 1; }
            25%  { transform: translateX(28vw) translateY(-6px) scale(0.95); }
            50%  { transform: translateX(55vw) translateY(8px)  scale(1.05); }
            75%  { transform: translateX(80vw) translateY(-4px) scale(0.95); }
            95%  { opacity: 1; }
            100% { transform: translateX(110vw) translateY(0)   scale(0.8); opacity:0; }
          }
          @keyframes ofWingL { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(0.4); } }
          @keyframes ofWingR { 0%,100% { transform: scaleX(1); } 50% { transform: scaleX(0.4); } }
          #of-deco .of-pumpkin {
            position:absolute; bottom:6px;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));
          }
          #of-deco .of-pumpkin.left  { left: 8px;  }
          #of-deco .of-pumpkin.right { right: 8px; }
          #of-deco .of-pumpkin.of-deco-animate { animation: ofPumpBob 2.8s ease-in-out infinite; }
          @keyframes ofPumpBob {
            0%, 100% { transform: translateY(0) rotate(-5deg); }
            50%      { transform: translateY(-4px) rotate(5deg); }
          }
        </style>
        <span class="of-pumpkin left${animClass}">${pumpkinSvg}</span>
        <span class="of-pumpkin right${animClass}" style="animation-delay:1.4s;">${pumpkinSvg}</span>
        <span class="of-bat${animClass}" style="animation-delay:0s;">${batSvg}</span>
        <span class="of-bat${animClass}" style="animation-delay:3.2s;">${batSvg}</span>
        <span class="of-bat${animClass}" style="animation-delay:6.5s;">${batSvg}</span>
      `;
    }

    function easterEggs(animClass) {
      const eggColors = [
        { body: '#fbcfe8', stripe: '#ec4899' },
        { body: '#bae6fd', stripe: '#0284c7' },
        { body: '#bbf7d0', stripe: '#16a34a' },
        { body: '#fef08a', stripe: '#ca8a04' },
        { body: '#ddd6fe', stripe: '#7c3aed' },
      ];
      let html = `<style>
        #of-deco .of-egg {
          position:absolute; top:6px; transform:translateX(-50%);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        }
        #of-deco .of-egg.of-deco-animate { animation: ofEggWiggle 2.6s ease-in-out infinite; }
        @keyframes ofEggWiggle {
          0%,100% { transform: translateX(-50%) rotate(-12deg) translateY(0); }
          50%     { transform: translateX(-50%) rotate(12deg) translateY(-4px); }
        }
      </style>`;
      const count = 9;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const c = eggColors[i % eggColors.length];
        const delay = ((i * 0.32) % 2.6).toFixed(2);
        html += `
          <svg class="of-egg${animClass}" viewBox="0 0 12 16" width="22" height="28"
               style="left:${left}%;animation-delay:${delay}s;">
            <ellipse cx="6" cy="9" rx="5" ry="6.5" fill="${c.body}"/>
            <path d="M 1.5,8 Q 6,7 10.5,8" stroke="${c.stripe}" stroke-width="0.8" fill="none"/>
            <path d="M 1.5,11 Q 6,12 10.5,11" stroke="${c.stripe}" stroke-width="0.8" fill="none"/>
            <circle cx="4" cy="6" r="0.7" fill="${c.stripe}"/>
            <circle cx="8" cy="13" r="0.7" fill="${c.stripe}"/>
            <ellipse cx="4.5" cy="6" rx="1.5" ry="1.2" fill="rgba(255,255,255,0.5)"/>
          </svg>`;
      }
      return html;
    }

    function stPatricksClovers(animClass) {
      const cloverSvg = `
        <svg viewBox="0 0 16 16" width="22" height="22">
          <g fill="#16a34a" stroke="#14532d" stroke-width="0.4">
            <path d="M 8,8 Q 4,4 5,2 Q 7,1 8,4 Z"/>
            <path d="M 8,8 Q 12,4 11,2 Q 9,1 8,4 Z"/>
            <path d="M 8,8 Q 4,12 5,14 Q 7,15 8,12 Z"/>
            <path d="M 8,8 Q 12,12 11,14 Q 9,15 8,12 Z"/>
            <path d="M 8,12 L 9,16" stroke="#15803d" stroke-width="0.7"/>
          </g>
        </svg>`;
      let html = `<style>
        #of-deco .of-clover {
          position:absolute; top:8px; transform:translateX(-50%);
          filter: drop-shadow(0 0 4px rgba(34,197,94,0.7));
        }
        #of-deco .of-clover.of-deco-animate { animation: ofCloverSpin 5s linear infinite; }
        @keyframes ofCloverSpin {
          0%   { transform: translateX(-50%) rotate(0deg)   scale(1); }
          50%  { transform: translateX(-50%) rotate(180deg) scale(1.15); }
          100% { transform: translateX(-50%) rotate(360deg) scale(1); }
        }
      </style>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const left = 7 + (i * 86 / (count - 1));
        const delay = ((i * 0.5) % 5).toFixed(2);
        html += `<span class="of-clover${animClass}" style="left:${left}%;animation-delay:${delay}s;">${cloverSvg}</span>`;
      }
      return html;
    }

    function independenceFireworks(animClass) {
      const colors = ['#ef4444','#3b82f6','#ffffff','#facc15'];
      let html = `<style>
        #of-deco .of-burst {
          position:absolute; top:14px; width:50px; height:50px;
          transform:translateX(-50%);
        }
        #of-deco .of-burst .of-ray {
          position:absolute; top:50%; left:50%;
          width:24px; height:2px;
          transform-origin: 0 50%;
          border-radius: 1px;
        }
        #of-deco .of-burst.of-deco-animate { animation: ofBurst 2.6s ease-out infinite; }
        @keyframes ofBurst {
          0%   { transform: translateX(-50%) scale(0); opacity:1; }
          40%  { transform: translateX(-50%) scale(1); opacity:1; }
          100% { transform: translateX(-50%) scale(1.4); opacity:0; }
        }
      </style>`;
      const burstCount = 6;
      for (let b = 0; b < burstCount; b++) {
        const left = 8 + (b * 84 / (burstCount - 1));
        const color = colors[b % colors.length];
        const delay = ((b * 0.45) % 2.6).toFixed(2);
        let rays = '';
        for (let r = 0; r < 12; r++) {
          const angle = r * 30;
          rays += `<div class="of-ray" style="background:linear-gradient(90deg,${color},transparent);transform:translate(0,-50%) rotate(${angle}deg);box-shadow:0 0 6px ${color};"></div>`;
        }
        html += `<div class="of-burst${animClass}" style="left:${left}%;animation-delay:${delay}s;">${rays}</div>`;
      }
      return html;
    }

    function valentinesHearts(animClass) {
      const heartSvg = `
        <svg viewBox="0 0 16 14" width="22" height="20">
          <defs>
            <radialGradient id="ofHeart" cx="35%" cy="35%" r="65%">
              <stop offset="0%" stop-color="#fbcfe8"/>
              <stop offset="50%" stop-color="#ec4899"/>
              <stop offset="100%" stop-color="#9f1239"/>
            </radialGradient>
          </defs>
          <path d="M 8,13 C 8,13 1,8.5 1,4.5 C 1,2 2.8,1 4.5,1 C 6,1 7,2 8,3.5 C 9,2 10,1 11.5,1 C 13.2,1 15,2 15,4.5 C 15,8.5 8,13 8,13 Z"
                fill="url(#ofHeart)"/>
          <ellipse cx="5.5" cy="4" rx="1.5" ry="1" fill="rgba(255,255,255,0.5)"/>
        </svg>`;
      let html = `<style>
        #of-deco .of-heart {
          position:absolute; top:8px; transform:translateX(-50%);
          filter: drop-shadow(0 0 4px rgba(236,72,153,0.7));
        }
        #of-deco .of-heart.of-deco-animate { animation: ofHeartPulse 1.4s ease-in-out infinite; }
        @keyframes ofHeartPulse {
          0%, 100% { transform: translateX(-50%) scale(1); }
          50%      { transform: translateX(-50%) scale(1.3); }
        }
      </style>`;
      const count = 9;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const delay = ((i * 0.18) % 1.4).toFixed(2);
        html += `<span class="of-heart${animClass}" style="left:${left}%;animation-delay:${delay}s;">${heartSvg}</span>`;
      }
      return html;
    }

    function hanukkahStars(animClass) {
      const starSvg = `
        <svg viewBox="0 0 16 16" width="22" height="22">
          <defs>
            <linearGradient id="ofStar" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#dbeafe"/>
              <stop offset="50%" stop-color="#3b82f6"/>
              <stop offset="100%" stop-color="#1e3a8a"/>
            </linearGradient>
          </defs>
          <path d="M 8,1 L 14,12 L 2,12 Z" fill="url(#ofStar)" stroke="#1e3a8a" stroke-width="0.5"/>
          <path d="M 8,15 L 2,4 L 14,4 Z" fill="url(#ofStar)" stroke="#1e3a8a" stroke-width="0.5" opacity="0.85"/>
        </svg>`;
      let html = `<style>
        #of-deco .of-hstar {
          position:absolute; top:8px; transform:translateX(-50%);
        }
        #of-deco .of-hstar.of-deco-animate { animation: ofStarShine 2.2s ease-in-out infinite; }
        @keyframes ofStarShine {
          0%, 100% { filter: drop-shadow(0 0 2px #60a5fa) brightness(0.9); }
          50%      { filter: drop-shadow(0 0 12px #60a5fa) brightness(1.3); }
        }
      </style>`;
      const count = 7;
      for (let i = 0; i < count; i++) {
        const left = 8 + (i * 84 / (count - 1));
        const delay = ((i * 0.35) % 2.2).toFixed(2);
        html += `<span class="of-hstar${animClass}" style="left:${left}%;animation-delay:${delay}s;">${starSvg}</span>`;
      }
      return html;
    }

    function thanksgivingLeaves(animClass) {
      const leafColors = ['#dc2626','#ea580c','#ca8a04','#78350f'];
      const leafSvg = (color) => `
        <svg viewBox="0 0 16 18" width="22" height="25">
          <path d="M 8,1 Q 5,3 5,5 Q 2,5 2,8 Q 4,9 4,11 Q 2,12 3,14 Q 5,14 6,15 L 8,17 L 10,15 Q 11,14 13,14 Q 14,12 12,11 Q 12,9 14,8 Q 14,5 11,5 Q 11,3 8,1 Z"
                fill="${color}" stroke="#451a03" stroke-width="0.4"/>
          <path d="M 8,17 L 8,5" stroke="#451a03" stroke-width="0.5"/>
        </svg>`;
      let html = `<style>
        #of-deco .of-leaf {
          position:absolute; top:-6px; transform:translateX(-50%);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        }
        #of-deco .of-leaf.of-deco-animate { animation: ofLeafFall 6s ease-in-out infinite; }
        @keyframes ofLeafFall {
          0%   { transform: translateX(-50%) translateY(-12px) rotate(-30deg); opacity:0; }
          15%  { opacity: 1; }
          50%  { transform: translateX(-30%) translateY(30px)  rotate(60deg);  opacity:0.9; }
          100% { transform: translateX(-70%) translateY(80px)  rotate(220deg); opacity:0; }
        }
      </style>`;
      const count = 8;
      for (let i = 0; i < count; i++) {
        const left = 6 + (i * 88 / (count - 1));
        const delay = ((i * 0.7) % 6).toFixed(2);
        const color = leafColors[i % leafColors.length];
        html += `<span class="of-leaf${animClass}" style="left:${left}%;animation-delay:${delay}s;">${leafSvg(color)}</span>`;
      }
      return html;
    }

    function snowFall(animClass) {
      const flakeSvg = `
        <svg viewBox="0 0 14 14" width="18" height="18">
          <g stroke="#e0f2fe" stroke-width="0.8" stroke-linecap="round" fill="none" opacity="0.95">
            <line x1="7" y1="1" x2="7" y2="13"/>
            <line x1="1" y1="7" x2="13" y2="7"/>
            <line x1="2.5" y1="2.5" x2="11.5" y2="11.5"/>
            <line x1="2.5" y1="11.5" x2="11.5" y2="2.5"/>
            <path d="M 7,2 L 6,3 M 7,2 L 8,3"/>
            <path d="M 7,12 L 6,11 M 7,12 L 8,11"/>
            <path d="M 2,7 L 3,6 M 2,7 L 3,8"/>
            <path d="M 12,7 L 11,6 M 12,7 L 11,8"/>
          </g>
        </svg>`;
      let html = `<style>
        #of-deco .of-flake {
          position:absolute; top:-8px; transform:translateX(-50%);
          filter: drop-shadow(0 0 3px rgba(255,255,255,0.7));
        }
        #of-deco .of-flake.of-deco-animate { animation: ofFlakeFall 7s linear infinite; }
        @keyframes ofFlakeFall {
          0%   { transform: translateX(-50%) translateY(-12px) rotate(0); opacity:0; }
          15%  { opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translateX(-30%) translateY(85px) rotate(360deg); opacity:0; }
        }
      </style>`;
      const count = 14;
      for (let i = 0; i < count; i++) {
        const left = (i / (count - 1)) * 100;
        const delay = ((i * 0.5) % 7).toFixed(2);
        const scale = (0.7 + ((i * 7) % 6) / 10).toFixed(2);
        html += `<span class="of-flake${animClass}" style="left:${left}%;animation-delay:${delay}s;transform:translateX(-50%) scale(${scale});">${flakeSvg}</span>`;
      }
      return html;
    }
  })();
})();
