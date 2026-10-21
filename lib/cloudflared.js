// ============================================================
// ShowPilot-Lite — Cloudflare Tunnel integration (v0.3.0+)
// ============================================================
// Exposes Lite to the public internet via a Cloudflare Tunnel without
// requiring port forwarding, DDNS, or a static IP. Works through CGNAT
// and most restrictive home ISP setups.
//
// Operator workflow:
//   1. Sign up for free Cloudflare account, set up Zero Trust dashboard
//   2. Create a tunnel, set the public hostname's service to
//      http://localhost:3100 (or whatever Lite's port is)
//   3. Copy the tunnel token from the dashboard
//   4. Paste it into Lite's Public Access card → service starts → done
//
// We do NOT manage the user's Cloudflare account. We just install the
// `cloudflared` binary as a systemd service with their token. They own
// the tunnel, the DNS, and the hostname; if they uninstall Lite their
// tunnel still exists in their Cloudflare dashboard for them to clean up.
//
// Privilege model (v0.5.51+): this file runs inside the main app, as the
// unprivileged `fpp` user, and never escalates privilege itself. Every
// action that needs root — installing the cloudflared package, writing
// the token/systemd unit files, starting/stopping/removing the service —
// is delegated over a local Unix socket to cfhelper-daemon.js, a small
// dedicated process that fpp_install.sh starts as its own root-owned
// systemd unit (showpilot-lite-cfhelper.service). That keeps the actual
// privileged code path isolated from the rest of this (much larger,
// HTTP-facing) admin application: a bug anywhere else in the app can no
// longer reach root through this feature. See cfhelper-daemon.js for the
// privileged side and the full rationale.
//
// getStatus() below is the one exception — it only reads the filesystem
// and runs read-only queries (dpkg --print-architecture, cloudflared
// --version, systemctl is-active/is-enabled), none of which need root, so
// it talks to the host directly rather than round-tripping through the
// helper.
// ============================================================

const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  SOCKET_PATH, SERVICE_NAME, SERVICE_FILE, BINARY_PATH, SUPPORTED_ARCHES,
} = require('./cfhelper-shared');

// ============================================================
// Helpers (unprivileged queries only — see module doc above)
// ============================================================

function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 30000;
  return new Promise(resolve => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, timedOut: false, spawnError: true });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError: false });
    });
  });
}

function detectArch() {
  return new Promise(resolve => {
    run('dpkg', ['--print-architecture'], { timeout: 5000 }).then(r => {
      if (r.code !== 0) return resolve(null);
      const arch = r.stdout.trim();
      if (!SUPPORTED_ARCHES.includes(arch)) return resolve(null);
      resolve(arch);
    });
  });
}

// rpc — send one { cmd, args } request to cfhelper-daemon.js over its
// Unix socket and resolve with its JSON response. One connection per
// call: these are infrequent, user-triggered actions, not a hot path, so
// there's no need for a persistent/multiplexed connection.
function rpc(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(SOCKET_PATH);
    let buf = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('cloudflared helper service did not respond in time — check `systemctl status showpilot-lite-cfhelper`'));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ cmd, args }) + '\n');
    });
    socket.on('data', d => { buf += d.toString(); });
    socket.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new Error('cloudflared helper service is not running — try restarting the ShowPilot-Lite plugin, or check `systemctl status showpilot-lite-cfhelper`'));
      } else {
        reject(err);
      }
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('cloudflared helper returned an invalid response'));
      }
    });
  });
}

function pingHelper(timeoutMs = 2000) {
  return rpc('ping', {}, timeoutMs).then(r => !!(r && r.ok)).catch(() => false);
}

// ============================================================
// Public API
// ============================================================

// getStatus — synchronous-style state snapshot. Reads filesystem and
// runs systemctl is-active. Safe to call frequently (the UI polls it).
//
// Returned shape:
//   {
//     installed: boolean,        // is the binary present?
//     version: string|null,      // cloudflared --version output
//     configured: boolean,       // does the systemd unit exist?
//     active: boolean,           // is the service running right now?
//     enabled: boolean,          // will it start on boot?
//     arch: string|null,         // detected architecture for install
//     archSupported: boolean,    // is the host arch one we can install on?
//     helperReachable: boolean,  // is cfhelper-daemon.js up? (install/
//                                // setToken/start/stop/... all need it)
//   }
async function getStatus() {
  const installed = fs.existsSync(BINARY_PATH);
  let version = null;
  if (installed) {
    const r = await run(BINARY_PATH, ['--version'], { timeout: 5000 });
    if (r.code === 0) {
      // Output looks like: "cloudflared version 2024.x.y (built ...)"
      version = r.stdout.split('\n')[0].trim() || null;
    }
  }

  const configured = fs.existsSync(SERVICE_FILE);

  // is-active and is-enabled return non-zero if not active / not enabled,
  // but their stdout contains the actual state. We trust the exit code
  // for the boolean and ignore stderr.
  const [activeR, enabledR, helperReachable] = await Promise.all([
    run('systemctl', ['is-active', SERVICE_NAME], { timeout: 5000 }),
    run('systemctl', ['is-enabled', SERVICE_NAME], { timeout: 5000 }),
    pingHelper(),
  ]);
  const active = activeR.code === 0 && activeR.stdout.trim() === 'active';
  const enabled = enabledR.code === 0 && enabledR.stdout.trim() === 'enabled';

  const arch = await detectArch();
  return {
    installed,
    version,
    configured,
    active,
    enabled,
    arch,
    archSupported: !!arch,
    helperReachable,
  };
}

// 240s, not 180s: the daemon's own worst case for this call is ~195s
// (15s GitHub Releases API + 120s download + 60s dpkg), so a 180s client
// timeout could report "helper did not respond in time" on a slow Pi
// while the install was in fact still running to a successful finish.
// Keep this comfortably above the sum of the daemon-side timeouts.
async function install() {
  return rpc('install', {}, 240000);
}

// v0.5.78+: in-place upgrade via the helper; keeps token + unit. Same
// worst-case budget as install (API + download + dpkg) plus a restart.
async function update() {
  const r = await rpc('update', {}, 255000);
  if (r && !r.ok && /unknown command/.test(r.error || '')) {
    return { ok: false, error: 'The tunnel helper is running an older version. Restart the showpilot-lite-cfhelper service (or reboot) and try again.' };
  }
  return r;
}

// Installed vs latest release. Unprivileged — only reads the binary's
// version and queries GitHub. Latest is cached for an hour to stay well
// under GitHub's unauthenticated rate limit.
let latestCache = { version: null, checkedAt: 0 };
function parseVersion(str) {
  const m = String(str || '').match(/(\d{4}\.\d+\.\d+)/);
  return m ? m[1] : null;
}
function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
async function checkForUpdate() {
  let current = null;
  if (fs.existsSync(BINARY_PATH)) {
    const r = await run(BINARY_PATH, ['--version'], { timeout: 5000 });
    if (r.code === 0) current = parseVersion(r.stdout);
  }
  if (!latestCache.version || Date.now() - latestCache.checkedAt > 60 * 60 * 1000) {
    const resp = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
      headers: { 'User-Agent': 'ShowPilot-Lite', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from GitHub`);
    const v = parseVersion((await resp.json()).tag_name);
    if (!v) throw new Error('Could not read latest release tag');
    latestCache = { version: v, checkedAt: Date.now() };
  }
  const latest = latestCache.version;
  return {
    ok: true,
    current,
    latest,
    updateAvailable: !!(current && latest && compareVersions(latest, current) > 0),
  };
}

async function setToken(token) {
  return rpc('setToken', { token }, 30000);
}

async function start() {
  return rpc('start', {}, 15000);
}

async function stop() {
  return rpc('stop', {}, 15000);
}

async function restart() {
  return rpc('restart', {}, 15000);
}

async function uninstall() {
  return rpc('uninstall', {}, 60000);
}

async function recentLogs(lines = 50) {
  return rpc('recentLogs', { lines }, 10000);
}

module.exports = {
  getStatus,
  install,
  update,
  checkForUpdate,
  setToken,
  start,
  stop,
  restart,
  uninstall,
  recentLogs,
};
