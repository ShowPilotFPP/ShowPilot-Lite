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
  setToken,
  start,
  stop,
  restart,
  uninstall,
  recentLogs,
};
