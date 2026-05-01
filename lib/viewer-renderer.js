// ============================================================
// ShowPilot — Viewer Page Template Renderer
//
// Takes an HTML template (user-authored, possibly imported from
// Remote Falcon) and renders it into a live page by replacing
// placeholder tokens with current state.
//
// Supported content placeholders (case-sensitive):
//   {NOW_PLAYING}      — current sequence display name
//   {NEXT_PLAYLIST}    — next scheduled/requested sequence
//   {JUKEBOX_QUEUE}    — pending request list (UL)
//   {QUEUE_SIZE}       — count of pending requests
//   {QUEUE_DEPTH}      — configured max queue depth
//   {LOCATION_CODE}    — location-based access code (placeholder)
//   {PLAYLISTS}        — grid of sequences with vote/request buttons
//
// Attribute-style placeholders (swapped on a DIV's opening tag to
// toggle visibility — RF compat):
//   {jukebox-dynamic-container}
//   {playlist-voting-dynamic-container}
//   {location-code-dynamic-container}
//   {after-hours-message}
//
// Injects /rf-compat.js before </body> so RF-style templates'
// onclick handlers (vote, request) work against our API.
// ============================================================

const { db } = require('./db');
const { bustCoverUrl } = require('./cover-art');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeJsString(s) {
  // Safe to put inside a single-quoted JS string embedded in an HTML attribute
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Format a remaining-seconds value as m:ss for the {NOW_PLAYING_TIMER}
// placeholder. RF-compatible — they show m:ss too. Negative or NaN values
// render as 0:00 (timer hit zero or never had a duration). null renders as
// the placeholder text --:-- (no song playing, or duration unknown).
function formatTimer(remainingSec) {
  if (remainingSec === null || !isFinite(remainingSec)) return '--:--';
  const sec = Math.max(0, Math.floor(remainingSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// Compute the timer text we'll render server-side at first paint. The
// client takes over after page load and ticks it every second. We use
// server-time (Date.now() on the server) here; clock skew between
// server and client doesn't matter for the FIRST paint because the
// browser sees this as static text. Once rf-compat reads /api/state
// and starts ticking, it uses ITS Date.now() against startedAtMs from
// the response — so any skew is consistent and the countdown stays
// monotonic. Returns '--:--' for missing inputs.
function computeInitialTimerText(startedAtIso, durationSeconds) {
  if (!startedAtIso || !durationSeconds) return '--:--';
  const startedMs = Date.parse(startedAtIso);
  if (!isFinite(startedMs)) return '--:--';
  const elapsedSec = (Date.now() - startedMs) / 1000;
  return formatTimer(durationSeconds - elapsedSec);
}

function renderPlaylistGrid(sequences, mode, voteCounts) {
  // Emits markup that satisfies BOTH the canonical Remote Falcon class
  // spec AND the third-party RF Page Builder runtime conventions
  // (v0.5.13+). The rules:
  //
  //   Canonical RF expects:
  //     .jukebox-list / .jukebox-list-artist / .sequence-image
  //     .cell-vote-playlist / .cell-vote-playlist-artist / .cell-vote / .sequence-image
  //
  //   RF Page Builder (rfpagebuilder.com, third-party) expects:
  //     .sequence-item containing  > div  containing  .sequence-image
  //                                                   .sequence-name
  //                                                   .sequence-artist
  //                                                   .sequence-requests | .sequence-votes
  //
  // We satisfy both by:
  //   - Adding 'sequence-item' alongside 'jukebox-list' / 'cell-vote-playlist'
  //     on the outer clickable element.
  //   - Adding ONE inner <div> that acts as both the natural flex wrapper AND
  //     the '.sequence-item > div' selector target.
  //   - Wrapping the display name in <span class="sequence-name">. A span is
  //     inline-level so it doesn't change layout for RF templates that
  //     expected the name as a direct text node; CSS color/font properties
  //     inherit from the parent, so RF typography still works.
  //   - Adding 'sequence-artist' as an extra class on the existing artist div
  //     (preserves '.jukebox-list-artist' / '.cell-vote-playlist-artist' for
  //     RF templates).
  //   - Emitting an empty '.sequence-requests' / '.sequence-votes' element
  //     keyed by sequence name — so RF Page Builder templates that style
  //     these selectors get the right structure even though we don't
  //     currently track per-sequence request counts. The text content stays
  //     empty by default; future feature could populate it.
  //
  // None of this breaks existing canonical RF templates. The added classes
  // are extra, the inner wrapper div doesn't change CSS that targets
  // descendants of '.jukebox-list' (descendant selectors still match through
  // the wrapper), and the data attributes for live updates
  // (data-seq, data-seq-count) are unchanged.
  const rows = sequences.map(seq => {
    const safeNameJs = escapeJsString(seq.name);
    const safeNameAttr = escapeHtml(seq.name);
    const safeDisplay = escapeHtml(seq.display_name);
    const safeArtist = seq.artist ? escapeHtml(seq.artist) : '';
    const count = (voteCounts && voteCounts[seq.name]) || 0;
    const bustedUrl = bustCoverUrl(seq.image_url);
    const artImg = bustedUrl
      ? `<img class="sequence-image" data-seq-name="${safeNameAttr}" src="${escapeHtml(bustedUrl)}" alt="" loading="lazy" />`
      : '';

    if (mode === 'VOTING') {
      return `<div class="cell-vote-playlist sequence-item" onclick="ShowPilotVote('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="cell-vote-playlist-artist sequence-artist">${safeArtist}</div><span class="sequence-votes" data-seq-votes="${safeNameAttr}">${count}</span></div></div><div class="cell-vote" data-seq-count="${safeNameAttr}">${count}</div>`;
    } else {
      return `<div class="jukebox-list sequence-item" onclick="ShowPilotRequest('${safeNameJs}')" data-seq="${safeNameAttr}"><div>${artImg}<span class="sequence-name">${safeDisplay}</span><div class="jukebox-list-artist sequence-artist">${safeArtist}</div><span class="sequence-requests" data-seq-requests="${safeNameAttr}"></span></div></div>`;
    }
  }).join('');
  return rows;
}

function renderQueue(queue, sequences) {
  if (!queue.length) return '<div class="queue-empty">Queue is empty.</div>';
  const byName = Object.fromEntries(sequences.map(s => [s.name, s]));
  // Wrap each entry in a div (v0.5.13+). RF Page Builder's queue CSS
  // targets `.queue-list > div`; canonical RF templates don't care
  // whether the items are <br/>-separated or <div>-wrapped because they
  // mostly just style the parent .queue-list container.
  return queue.map(entry => {
    const seq = byName[entry.sequence_name];
    return `<div class="queue-item" data-seq="${escapeHtml(entry.sequence_name)}">${escapeHtml(seq?.display_name || entry.sequence_name)}</div>`;
  }).join('');
}

// Substitute every {PLAYLISTS} occurrence with markup matching its
// enclosing mode container (v0.5.18+). Called AFTER the dynamic-
// container substitutions so the per-mode markers are in the text.
//
// Why per-slot context: a dual-mode template has two {PLAYLISTS} —
// one inside <div data-showpilot-container="jukebox">, one inside
// <div data-showpilot-container="voting">. If both are filled with
// the active mode's markup, the inactive (hidden) container has
// wrong-shape rows — and the moment admin flips modes and the
// inactive container becomes visible, viewers see jukebox-shaped
// rows in a voting layout (or vice versa) for a beat before the
// client-side rebuild catches up. Filling each slot with its OWN
// container's mode at server-render eliminates that flash entirely.
function substitutePlaylistsContextAware(html, sequences, activeMode, voteCountsMap) {
  const placeholder = '{PLAYLISTS}';
  const parts = [];
  let cursor = 0;

  while (cursor < html.length) {
    const idx = html.indexOf(placeholder, cursor);
    if (idx < 0) {
      parts.push(html.slice(cursor));
      break;
    }
    parts.push(html.slice(cursor, idx));
    const accum = parts.join('');
    const slotMode = detectEnclosingContainerMode(accum) || activeMode;
    parts.push(renderPlaylistGrid(sequences, slotMode, voteCountsMap));
    cursor = idx + placeholder.length;
  }

  return parts.join('');
}

// Given the HTML emitted so far, return 'JUKEBOX' or 'VOTING' if the
// current cursor position is inside an open mode-container, else
// null. Walk balances <div...> opens against </div> closes from the
// most recent marker.
function detectEnclosingContainerMode(emittedSoFar) {
  const jukeIdx = emittedSoFar.lastIndexOf('data-showpilot-container="jukebox"');
  const voteIdx = emittedSoFar.lastIndexOf('data-showpilot-container="voting"');
  const lastIdx = Math.max(jukeIdx, voteIdx);
  if (lastIdx < 0) return null;
  const slotMode = jukeIdx > voteIdx ? 'JUKEBOX' : 'VOTING';

  let depth = 1;
  const tagEnd = emittedSoFar.indexOf('>', lastIdx);
  if (tagEnd < 0) return null;
  let i = tagEnd + 1;

  const openRe = /<div\b[^>]*>/gi;
  const closeStr = '</div>';

  while (i < emittedSoFar.length) {
    openRe.lastIndex = i;
    const openMatch = openRe.exec(emittedSoFar);
    const closeMatch = emittedSoFar.indexOf(closeStr, i);

    const openAt = openMatch ? openMatch.index : -1;
    const closeAt = closeMatch;

    if (openAt < 0 && closeAt < 0) break;

    if (closeAt >= 0 && (openAt < 0 || closeAt < openAt)) {
      depth--;
      if (depth === 0) return null;
      i = closeAt + closeStr.length;
    } else {
      depth++;
      i = openAt + openMatch[0].length;
    }
  }

  return slotMode;
}

function renderTemplate(template, state) {
  if (!template) return '<!-- No template available -->';

  // Backward compatibility: callers historically passed `template.html` as a
  // string. Now we'd rather have the whole row so we can use other fields
  // (like favicon_url). Detect both shapes.
  const templateHtml = typeof template === 'string' ? template : template.html;
  const templateRow = typeof template === 'string' ? {} : template;
  if (!templateHtml) return '<!-- Template has no HTML -->';

  const cfg = state.config || {};
  const mode = cfg.viewer_control_mode || 'OFF';
  // After-hours == "viewer control is off". When admin flips the mode to OFF,
  // {after-hours-message} blocks become visible and the jukebox/voting blocks
  // hide (they're already gated separately on mode === 'JUKEBOX' / 'VOTING').
  // A future "show hours" config could OR additional conditions in here.
  const isAfterHours = mode === 'OFF';
  const locationCodeRequired = false; // TODO: when location-code mode is built
  const voteCountsMap = {};
  (state.voteCounts || []).forEach(v => { voteCountsMap[v.sequence_name] = v.count; });

  let html = templateHtml;

  // ---- Content placeholders ----
  const nowDisplay = state.nowPlaying
    ? (state.sequences.find(s => s.name === state.nowPlaying)?.display_name || state.nowPlaying)
    : '—';
  const nextDisplay = state.nextScheduled
    ? (state.sequences.find(s => s.name === state.nextScheduled)?.display_name || state.nextScheduled)
    : '—';

  // Wrap text placeholders in spans with data attributes so compat JS can update them live
  html = html.split('{NOW_PLAYING}').join(
    `<span class="now-playing-text" data-showpilot-now>${escapeHtml(nowDisplay)}</span>`
  );
  html = html.split('{NEXT_PLAYLIST}').join(
    `<span data-showpilot-next>${escapeHtml(nextDisplay)}</span>`
  );

  // {NOW_PLAYING_TIMER} (v0.5.9+) — countdown of time remaining in the
  // current sequence. RF compat: same placeholder name, same general
  // behavior. Server-side we compute the initial mm:ss based on
  // started_at and duration; client-side rf-compat ticks it every
  // second. Renders --:-- when no song is playing or the duration is
  // unknown (sequence row missing duration_seconds), 0:00 once time
  // expires. Format is always m:ss (no leading zero on minutes — matches
  // typical media-player display).
  const initialTimerText = computeInitialTimerText(
    state.nowPlayingStartedAtIso,
    state.nowPlayingDurationSeconds
  );
  html = html.split('{NOW_PLAYING_TIMER}').join(
    `<span data-showpilot-timer>${initialTimerText}</span>`
  );

  // {NOW_PLAYING_IMAGE} (v0.5.13+) — emits an <img> of the currently-
  // playing sequence's cover art. ShowPilot extension to the RF placeholder
  // vocabulary, added because some third-party page-building tools generate
  // templates that put '{NOW_PLAYING}' inside an image wrapper, expecting an
  // image — but RF's spec is that {NOW_PLAYING} is the song NAME (text).
  // Rather than guess from context, we offer this explicit placeholder for
  // template authors who want the image. Renders as nothing if no song is
  // playing or the sequence has no cover art (so layout doesn't break).
  // The src is updated client-side by rf-compat on song change.
  const nowPlayingSeq = state.nowPlaying
    ? state.sequences.find(s => s.name === state.nowPlaying)
    : null;
  const nowPlayingImageUrl = nowPlayingSeq && nowPlayingSeq.image_url
    ? bustCoverUrl(nowPlayingSeq.image_url)
    : '';
  html = html.split('{NOW_PLAYING_IMAGE}').join(
    nowPlayingImageUrl
      ? `<img class="sequence-image now-playing-image" data-showpilot-now-img src="${escapeHtml(nowPlayingImageUrl)}" alt="" />`
      : `<img class="sequence-image now-playing-image" data-showpilot-now-img src="" alt="" style="display:none" />`
  );

  html = html.split('{QUEUE_SIZE}').join(
    `<span data-showpilot-queue-size>${(state.queue || []).length}</span>`
  );
  html = html.split('{QUEUE_DEPTH}').join(String(cfg.jukebox_queue_depth || 0));
  html = html.split('{LOCATION_CODE}').join('');
  html = html.split('{JUKEBOX_QUEUE}').join(
    `<div data-showpilot-queue-list>${renderQueue(state.queue || [], state.sequences || [])}</div>`
  );

  // ---- Attribute-style placeholders ----
  // Each placeholder substitutes to attributes inserted directly into
  // an opening tag. We emit two things:
  //   1. data-showpilot-container="<mode>" — a marker rf-compat uses
  //      to live-toggle visibility on mode change without a reload.
  //   2. The HTML5 `hidden` boolean attribute when the container
  //      should be hidden at server-render time. We use `hidden`
  //      rather than `style="display:none"` because:
  //        - A template author may already have a `style="..."` on
  //          the same opening tag; emitting a second `style` attr
  //          is invalid HTML and browsers honor only the first one
  //          (so our display:none would be silently dropped). This
  //          was a real bug observed in the wild — see v0.5.18 notes.
  //        - `hidden` is one boolean attribute, can't conflict, and
  //          rf-compat toggles via removeAttribute('hidden') /
  //          setAttribute('hidden', '') for symmetry.
  //        - Inline `style.display = 'none'` set by JS still works
  //          for backwards-compat with templates that built their
  //          own visibility logic.
  //
  // NOTE: We MUST do these container substitutions BEFORE {PLAYLISTS}
  // so the per-slot context-aware logic below can see the markers
  // and pick the right per-mode markup for each {PLAYLISTS}.
  html = html.split('{jukebox-dynamic-container}').join(
    `data-showpilot-container="jukebox"${mode === 'JUKEBOX' ? '' : ' hidden'}`
  );
  html = html.split('{playlist-voting-dynamic-container}').join(
    `data-showpilot-container="voting"${mode === 'VOTING' ? '' : ' hidden'}`
  );
  html = html.split('{location-code-dynamic-container}').join(
    locationCodeRequired ? '' : 'hidden'
  );
  html = html.split('{after-hours-message}').join(
    `data-showpilot-container="afterhours"${isAfterHours ? '' : ' hidden'}`
  );

  // ---- {PLAYLISTS} substitution (context-aware) ----
  // Each {PLAYLISTS} slot may live inside a jukebox-container, a
  // voting-container, or neither (single-mode template with no
  // wrapper). The server should emit markup matching the SLOT'S
  // container, not the active mode — that way the client-side
  // live-rebuild has correct shapes to start from when admin flips
  // modes, and the inactive (hidden) container can become visible
  // without showing wrong-shape markup for a single frame.
  html = substitutePlaylistsContextAware(
    html,
    state.sequences || [],
    mode,
    voteCountsMap
  );

  // ---- Inject <title> from cfg.show_name if the template doesn't define its own ----
  // We only inject when the template's <head> has no <title> at all. If the user
  // wrote their own <title> in the template HTML, we respect it. This keeps the
  // global Show Name as a sensible default while leaving advanced users in
  // control if they want template-specific titles.
  const hasTitle = /<title[^>]*>/i.test(html);
  if (!hasTitle && cfg.show_name) {
    const safeTitle = String(cfg.show_name).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const titleTag = `<title>${safeTitle}</title>\n`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', titleTag + '</head>');
    } else if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + titleTag);
    } else {
      // Template has no <head> at all — prepend a minimal head so the title
      // exists in the served HTML for the browser tab. Browsers tolerate
      // <title> outside <head> in quirks mode anyway, but proper structure
      // is friendlier to clients that parse strictly.
      html = `<head>${titleTag}</head>\n` + html;
    }
  }

  // ---- Inject custom favicon link into <head> if the template has one set ----
  // We don't try to detect or replace existing <link rel="icon"> tags the user
  // may have hand-written into their template — instead we append our tag. The
  // last <link rel="icon"> in the head wins per browser spec, so a custom
  // template that hardcoded its own favicon would still get overridden by an
  // explicit favicon set in the admin UI. That's the right precedence: UI
  // setting is the authoritative source.
  if (templateRow.favicon_url) {
    const safeUrl = String(templateRow.favicon_url).replace(/"/g, '&quot;');
    // Mime type hint helps browsers handle SVG vs PNG vs ICO correctly when
    // the URL doesn't have an extension (e.g. data: URLs). We can't reliably
    // sniff the type from a URL string, so we omit `type=` and let the browser
    // figure it out from the response/data — works fine for common formats.
    const faviconTag = `<link rel="icon" href="${safeUrl}">\n`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', faviconTag + '</head>');
    } else {
      // Template has no <head> at all — prepend the tag at the very top so it
      // at least exists in the served HTML (browsers will treat it as if it
      // were in head as long as it appears before any rendering begins).
      html = faviconTag + html;
    }
  }

  // ---- Inject compat script before </body> ----
  // State is exposed as a JSON blob the compat layer reads on load.
  const bootstrap = {
    mode,
    requiresLocation: cfg.check_viewer_present === 1 && cfg.viewer_present_mode === 'GPS',
    showName: cfg.show_name,
    // Vote shifting (v0.5.6+): when on, the client lets the user click a
    // different song to change their vote instead of being told they
    // already voted.
    allowVoteChange: cfg.allow_vote_change === 1,
    // Now-playing timer (v0.5.9+) — when set, the client uses these to
    // start ticking the {NOW_PLAYING_TIMER} placeholder before the first
    // /api/state poll arrives. Both null when no song or duration unknown.
    nowPlayingStartedAtIso: state.nowPlayingStartedAtIso || null,
    nowPlayingDurationSeconds: state.nowPlayingDurationSeconds || null,
    pageSnowEnabled: cfg.page_snow_enabled === 1 || cfg.page_effect === 'snow',
    pageEffect: cfg.page_effect || (cfg.page_snow_enabled === 1 ? 'snow' : 'none'),
    pageEffectColor: cfg.page_effect_color || '',
    pageEffectIntensity: cfg.page_effect_intensity || 'medium',
    // Now-playing player bar visibility (Lite). When false, the bar
    // is hidden entirely on the viewer page — for admins who want a
    // pure voting/jukebox UI with no song display.
    showPlayerBar: cfg.viewer_show_player_bar !== 0,
  };
  // Socket.io client is loaded before rf-compat.js so window.io is
  // defined when the viewer-side code initializes. Loaded from same
  // origin; the path is served automatically by the socket.io
  // middleware on the server.
  const injection = `
  <script>window.__SHOWPILOT__ = ${JSON.stringify(bootstrap)};</script>
  <script src="/socket.io/socket.io.js"></script>
  <script src="/rf-compat.js?v=50"></script>
  `;
  if (html.includes('</body>')) {
    html = html.replace('</body>', injection + '</body>');
  } else {
    html = html + injection;
  }

  // ---- PWA manifest + service worker (v0.23.0+) ----
  // When admin has enabled "Install as App" for the viewer, inject the
  // manifest link and service-worker registration. Browsers require
  // BOTH a manifest reference in <head> AND a registered service worker
  // for PWA install eligibility. The manifest itself is served by
  // /viewer-manifest.json (gated server-side by the same flag — so
  // injecting the link without enabling the flag would just produce
  // a 404 on the manifest, harmless).
  if (cfg.pwa_viewer_enabled === 1) {
    const pwaHead = `
  <link rel="manifest" href="/viewer-manifest.json" />
  <meta name="theme-color" content="#000000" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="/viewer-icon" />
`;
    // Inject a small floating "Install" button that appears when the
    // browser fires beforeinstallprompt. Bottom-left so it doesn't
    // interfere with the now-playing player bar. Uses the configured
    // icon. Auto-hides after install or dismiss.
    //
    // Style is intentionally subtle — a small pill, not a full bar —
    // because the viewer template is the main visual experience and
    // we don't want to obscure it. Listeners who care will see the
    // button; everyone else can ignore it.
    const pwaScript = `
  <script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/sw.js').catch(function(err) {
        console.warn('[ShowPilot PWA] service worker registration failed:', err);
      });
    });
  }
  // Capture beforeinstallprompt and surface a button. The button is
  // hidden by default (no point showing it before the browser is
  // ready), shown when the event fires, and removed after the user
  // either installs or dismisses. localStorage flag prevents re-showing
  // after dismissal — pressing dismiss many times in a row is annoying.
  (function() {
    var DISMISSED_KEY = 'showpilot_pwa_install_dismissed';
    if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    var btn = null;
    function makeBtn() {
      btn = document.createElement('div');
      btn.id = 'showpilot-pwa-install';
      btn.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:9999;display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.85);color:#fff;padding:8px 14px;border-radius:24px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.4);backdrop-filter:blur(8px);cursor:pointer;border:1px solid rgba(255,255,255,0.15);';
      var img = document.createElement('img');
      img.src = '/viewer-icon';
      img.alt = '';
      img.style.cssText = 'width:24px;height:24px;border-radius:6px;';
      var label = document.createElement('span');
      label.textContent = 'Install app';
      label.style.cssText = 'font-weight:500;';
      var dismiss = document.createElement('span');
      dismiss.textContent = '×';
      dismiss.style.cssText = 'opacity:0.6;font-size:18px;line-height:1;padding:0 4px;margin-left:4px;';
      dismiss.onclick = function(e) {
        e.stopPropagation();
        localStorage.setItem(DISMISSED_KEY, '1');
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      };
      btn.appendChild(img);
      btn.appendChild(label);
      btn.appendChild(dismiss);
      btn.onclick = function() {
        if (window.__deferredInstallPrompt) {
          window.__deferredInstallPrompt.prompt();
          window.__deferredInstallPrompt.userChoice.finally(function() {
            window.__deferredInstallPrompt = null;
            if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          });
        }
      };
      document.body.appendChild(btn);
    }
    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      window.__deferredInstallPrompt = e;
      // Defer slightly so we don't show during the initial paint. Lets
      // the user see the page first, then notice the button.
      setTimeout(function() { if (!btn) makeBtn(); }, 1500);
    });
    // Hide button if the app gets installed via another path.
    window.addEventListener('appinstalled', function() {
      localStorage.setItem(DISMISSED_KEY, '1');
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    });
  })();
  </script>
`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', pwaHead + '</head>');
    } else {
      // Fallback: prepend at the start. Less ideal but functional.
      html = pwaHead + html;
    }
    if (html.includes('</body>')) {
      html = html.replace('</body>', pwaScript + '</body>');
    } else {
      html = html + pwaScript;
    }
  }

  // ---- Admin shortcut pill (v0.23.6+) ----
  // When the request comes from someone with a valid admin session,
  // render a small floating button that takes them to the admin
  // dashboard. Anonymous viewers don't see this — it's invisible to
  // anyone not already logged in as admin. Saves the round-trip of
  // "view show, want to tweak something, type out admin URL."
  //
  // Server-side detection (state.isAdmin) is preferred over client-side
  // because the admin session cookie is httpOnly and can't be read by JS.
  // The button is positioned in the top-right (out of the way of the
  // bottom-left install pill from the PWA injection above).
  if (state.isAdmin) {
    const adminPill = `
  <a href="/admin/" id="showpilot-admin-pill" title="Open admin dashboard"
     style="position:fixed;top:14px;right:14px;z-index:9999;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(0,0,0,0.75);color:#fff;text-decoration:none;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:500;border-radius:18px;border:1px solid rgba(255,255,255,0.2);box-shadow:0 2px 8px rgba(0,0,0,0.3);backdrop-filter:blur(6px);">
    <span aria-hidden="true" style="font-size:14px;line-height:1;">⚙</span>
    <span>Admin</span>
  </a>
`;
    if (html.includes('</body>')) {
      html = html.replace('</body>', adminPill + '</body>');
    } else {
      html = html + adminPill;
    }
  }

  // ---- Voting winner toast (v0.23.7+) ----
  // Always injected (not gated by mode) — the listener is cheap and a
  // mode change shouldn't require a page refresh to receive winner
  // notifications. The toast only renders when the server emits
  // 'votingRoundEnded', which only happens during voting mode.
  //
  // Designed to celebrate the winner without obscuring the player or
  // covering the song list. Centered at the top with auto-dismiss.
  // socket.io is already loaded by the rf-compat injection above, so
  // we don't need to re-include it here — just hook the existing
  // window.io connection or open a new one if not yet established.
  const winnerToast = `
  <style>
    #showpilot-winner-toast {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(-120%);
      z-index: 9998;
      max-width: calc(100vw - 32px);
      min-width: 240px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      /* Themable colors — templates can override --showpilot-toast-* CSS
         variables to match their palette. The defaults are a neutral
         dark gradient that works across most themes (Halloween orange,
         Christmas blue, Independence Day red/blue/white, etc.) without
         clashing. Templates that want a stronger color can set just
         --showpilot-toast-bg and --showpilot-toast-text. */
      background: var(--showpilot-toast-bg, linear-gradient(135deg, rgba(30, 30, 40, 0.96), rgba(15, 15, 25, 0.96)));
      color: var(--showpilot-toast-text, #fff);
      border: 1px solid var(--showpilot-toast-border, rgba(255, 255, 255, 0.18));
      font-family: var(--showpilot-toast-font, system-ui, -apple-system, sans-serif);
      font-size: 14px;
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
      transition: transform 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.3s;
      pointer-events: none;
      opacity: 0;
    }
    #showpilot-winner-toast.shown {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
    #showpilot-winner-toast .swt-img {
      width: 44px; height: 44px;
      border-radius: 8px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(0,0,0,0.2);
    }
    #showpilot-winner-toast .swt-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    #showpilot-winner-toast .swt-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.85;
      color: var(--showpilot-toast-accent, inherit);
    }
    #showpilot-winner-toast .swt-name {
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70vw;
    }
    #showpilot-winner-toast .swt-artist {
      font-size: 12px;
      opacity: 0.85;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70vw;
    }
  </style>
  <script>
  (function() {
    function showWinnerToast(data) {
      if (!data || !data.displayName) return;
      // Match toast colors to current player theme. The helper is set up
      // by rf-compat.js when applyDecoration runs; if it's not yet
      // available (race during page load), we just skip and use defaults.
      try { if (typeof window.ShowPilotApplyPlayerThemeToToast === 'function') {
        window.ShowPilotApplyPlayerThemeToToast();
      }} catch (_) {}
      // Build (or reuse) the toast element. Single shared element so
      // rapid successive winners don't pile up multiple toasts on screen.
      var toast = document.getElementById('showpilot-winner-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'showpilot-winner-toast';
        document.body.appendChild(toast);
      }
      var imgHtml = data.imageUrl
        ? '<img class="swt-img" src="' + data.imageUrl.replace(/"/g,'&quot;') + '" alt="" />'
        : '<div class="swt-img"></div>';
      var artistHtml = data.artist
        ? '<span class="swt-artist">' + String(data.artist).replace(/</g,'&lt;') + '</span>'
        : '';
      toast.innerHTML = imgHtml +
        '<div class="swt-body">' +
        '<span class="swt-label">🎉 Winner!</span>' +
        '<span class="swt-name">' + String(data.displayName).replace(/</g,'&lt;') + '</span>' +
        artistHtml +
        '</div>';
      // Show via class so the CSS transition handles slide-in.
      // requestAnimationFrame ensures the browser has applied the
      // initial styles before the .shown class triggers the transition;
      // without it, fresh-created elements skip the animation.
      requestAnimationFrame(function() {
        toast.classList.add('shown');
      });
      // Auto-dismiss after 6 seconds. The transition handles slide-out.
      // Clear any prior dismiss timer so successive wins don't fight.
      if (toast.__dismissTimer) clearTimeout(toast.__dismissTimer);
      toast.__dismissTimer = setTimeout(function() {
        toast.classList.remove('shown');
      }, 6000);
    }

    // Hook up to the socket.io connection. rf-compat.js already opens
    // one for live position updates; we either reuse it (if exposed)
    // or open our own. Either way is cheap and idempotent.
    function connectSocket() {
      if (typeof io === 'undefined') {
        // socket.io.js hasn't loaded yet — try again shortly. The rf-compat
        // injection loads it; this just covers the race window before
        // that script runs.
        setTimeout(connectSocket, 250);
        return;
      }
      try {
        var sock = io();
        sock.on('votingRoundEnded', showWinnerToast);
      } catch (e) {
        console.warn('[ShowPilot] Could not subscribe to voting events:', e);
      }
    }
    connectSocket();
  })();
  </script>
`;
  if (html.includes('</body>')) {
    html = html.replace('</body>', winnerToast + '</body>');
  } else {
    html = html + winnerToast;
  }

  return html;
}

function getActiveTemplate() {
  const row = db.prepare(`
    SELECT * FROM viewer_page_templates WHERE is_active = 1 LIMIT 1
  `).get();
  return row || null;
}

module.exports = { renderTemplate, getActiveTemplate, escapeHtml };
