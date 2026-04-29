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
// Why we shell out to cloudflared/dpkg/systemctl rather than using a
// Node Cloudflare client: the user already has to use Cloudflare's
// dashboard to create the tunnel and bind a hostname. Once they have
// the token, the only operations we need are install/start/stop, all
// of which `cloudflared service install <token>` handles natively. No
// Cloudflare API key is required from the user.
//
// Privilege model: Lite runs as user `fpp`. FPP ships with passwordless
// sudo for the `fpp` user (that's the contract for FPP plugins). All
// shell-outs use `sudo` explicitly so we fail loudly if that contract
// is broken on a non-FPP host (rather than silently 500ing).
// ============================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = 'cloudflared';
const SERVICE_FILE = '/etc/systemd/system/cloudflared.service';
const BINARY_PATH = '/usr/bin/cloudflared';

// Cloudflare publishes per-arch .deb packages at:
//   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-<arch>.deb
// where <arch> is one of: amd64, arm64, armhf, 386. dpkg --print-architecture
// on Debian/Raspberry Pi OS returns these same strings, so we can pass
// it through directly. We don't support 386 here (no FPP target uses it)
// but it'd just work if someone did.
const SUPPORTED_ARCHES = ['amd64', 'arm64', 'armhf'];

// ============================================================
// Helpers
// ============================================================

// Run a shell command with a timeout, returning stdout/stderr/exit code.
// We never throw from here — every caller wants to surface the failure
// to the user, not crash the request handler.
function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 30000;
  return new Promise(resolve => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
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
  const [activeR, enabledR] = await Promise.all([
    run('systemctl', ['is-active', SERVICE_NAME], { timeout: 5000 }),
    run('systemctl', ['is-enabled', SERVICE_NAME], { timeout: 5000 }),
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
  };
}

// install — download and install the cloudflared .deb for the host arch.
// Idempotent: if already installed at the expected path, we no-op success.
async function install() {
  if (fs.existsSync(BINARY_PATH)) {
    return { ok: true, alreadyInstalled: true };
  }
  const arch = await detectArch();
  if (!arch) {
    return { ok: false, error: 'Unsupported or undetectable system architecture. cloudflared is only available for amd64, arm64, and armhf.' };
  }

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb`;
  const tmpFile = `/tmp/cloudflared-${arch}.deb`;

  // Download via curl (always present on FPP).
  // -fSL: fail on HTTP errors, follow redirects, silent except on error.
  const dl = await run('curl', ['-fSL', '-o', tmpFile, url], { timeout: 120000 });
  if (dl.code !== 0) {
    return { ok: false, error: `Download failed: ${dl.stderr.trim() || `exit ${dl.code}`}` };
  }

  // Install via dpkg.
  const inst = await run('sudo', ['dpkg', '-i', tmpFile], { timeout: 60000 });
  // Clean up the .deb regardless of success.
  try { fs.unlinkSync(tmpFile); } catch {}
  if (inst.code !== 0) {
    return { ok: false, error: `dpkg install failed: ${inst.stderr.trim() || `exit ${inst.code}`}` };
  }

  if (!fs.existsSync(BINARY_PATH)) {
    return { ok: false, error: 'Install reported success but cloudflared binary is not at /usr/bin/cloudflared.' };
  }
  return { ok: true, alreadyInstalled: false };
}

// setToken — register cloudflared as a systemd service with the given
// tunnel token. This is the operation that actually starts the tunnel.
//
// `cloudflared service install <token>` writes /etc/systemd/system/cloudflared.service
// with the token baked in, runs `daemon-reload`, and enables+starts the unit.
// If a previous service exists, we uninstall it first so we don't end up
// with stale config from an old token.
async function setToken(token) {
  if (!fs.existsSync(BINARY_PATH)) {
    return { ok: false, error: 'cloudflared is not installed. Install it first.' };
  }
  if (typeof token !== 'string' || token.trim().length < 20) {
    return { ok: false, error: 'Token looks invalid. Paste the full token from your Cloudflare Zero Trust dashboard.' };
  }
  // Token format from CF: a base64-ish blob, usually 200+ chars. We don't
  // validate strictly — let cloudflared reject it if malformed. We DO
  // refuse anything obviously not a token (newlines, spaces) because those
  // are the most common copy-paste accidents and a clear error here is
  // better than a confusing systemd failure.
  const cleaned = token.trim();
  if (/\s/.test(cleaned)) {
    return { ok: false, error: 'Token contains whitespace. Re-copy from Cloudflare — there should be no spaces or line breaks.' };
  }

  // Tear down any existing service first. cloudflared service install is
  // not idempotent — if a service exists with a different token it won't
  // be overwritten cleanly.
  if (fs.existsSync(SERVICE_FILE)) {
    const u = await run('sudo', [BINARY_PATH, 'service', 'uninstall'], { timeout: 30000 });
    // We don't fail the whole operation if uninstall fails; install will
    // surface the real problem with a clearer message. Just log it via
    // the returned value if anyone wants to diagnose.
    if (u.code !== 0) {
      // Best-effort; continue.
    }
  }

  const r = await run('sudo', [BINARY_PATH, 'service', 'install', cleaned], { timeout: 60000 });
  if (r.code !== 0) {
    // cloudflared writes useful info to stdout, errors to stderr. Surface
    // both because the helpful bit is sometimes in stdout (e.g. "your
    // token is invalid").
    const msg = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split('\n').slice(-3).join(' ');
    return { ok: false, error: `Service install failed: ${msg}` };
  }
  return { ok: true };
}

// start / stop / restart — operate on the existing service. Won't
// install or change the token. If the service doesn't exist, return
// a useful error.
async function start() {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed. Set a token first.' };
  }
  const r = await run('sudo', ['systemctl', 'start', SERVICE_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, error: `systemctl start failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true };
}

async function stop() {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed.' };
  }
  const r = await run('sudo', ['systemctl', 'stop', SERVICE_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, error: `systemctl stop failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true };
}

async function restart() {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed.' };
  }
  const r = await run('sudo', ['systemctl', 'restart', SERVICE_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, error: `systemctl restart failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true };
}

// uninstall — remove the systemd service AND the cloudflared package.
// Two-step: `cloudflared service uninstall` removes the unit cleanly,
// then `apt-get remove` removes the binary. We do both because leaving
// the binary around with no service is just dead weight; the user
// asked to uninstall.
async function uninstall() {
  // Service uninstall first (only if service exists).
  if (fs.existsSync(SERVICE_FILE) && fs.existsSync(BINARY_PATH)) {
    const u = await run('sudo', [BINARY_PATH, 'service', 'uninstall'], { timeout: 30000 });
    if (u.code !== 0) {
      // Not fatal — keep going to apt remove. The unit file may have
      // been hand-edited and `service uninstall` is conservative.
    }
  }
  // Force-remove the unit file in case `service uninstall` left it.
  if (fs.existsSync(SERVICE_FILE)) {
    await run('sudo', ['rm', '-f', SERVICE_FILE], { timeout: 5000 });
    await run('sudo', ['systemctl', 'daemon-reload'], { timeout: 10000 });
  }
  // Remove package.
  if (fs.existsSync(BINARY_PATH)) {
    const r = await run('sudo', ['apt-get', 'remove', '-y', 'cloudflared'], { timeout: 60000 });
    if (r.code !== 0) {
      return { ok: false, error: `apt-get remove failed: ${r.stderr.trim() || `exit ${r.code}`}` };
    }
  }
  return { ok: true };
}

// recentLogs — return the last N lines from journalctl for the
// service. Useful for the operator to debug "why isn't my tunnel
// connecting" without having to ssh in.
async function recentLogs(lines = 50) {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed.' };
  }
  const safeN = Math.max(1, Math.min(500, parseInt(lines, 10) || 50));
  const r = await run('sudo', ['journalctl', '-u', SERVICE_NAME, '-n', String(safeN), '--no-pager', '--output=cat'], { timeout: 10000 });
  if (r.code !== 0) {
    return { ok: false, error: `journalctl failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  // Cloudflared logs include connection state and tunnel hostnames —
  // useful for the operator. We return the raw text; the UI displays
  // it in a <pre>.
  return { ok: true, logs: r.stdout };
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
