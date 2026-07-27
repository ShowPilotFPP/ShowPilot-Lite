// ============================================================
// ShowPilot-Lite — Cloudflare Tunnel privileged helper (v0.5.51+)
// ============================================================
// Everything in here runs as root, as its own systemd unit
// (showpilot-lite-cfhelper.service, started by fpp_install.sh — a hook
// that fppd already runs as root, so no privilege escalation is needed to
// set it up). It listens on a local Unix socket and performs the small,
// fixed set of privileged actions the Cloudflare Tunnel feature needs:
// installing the cloudflared package, writing its token/systemd unit, and
// starting/stopping/restarting/removing that service.
//
// Why a separate process instead of the main app calling sudo directly:
// the main app (lib/cloudflared.js + everything else under routes/) is a
// large, network-facing admin surface with a login page, file uploads,
// template rendering, etc. If it could reach root via sudo from any of
// its request handlers, a bug ANYWHERE in that surface — not just in the
// Cloudflare Tunnel feature itself — would be a continuous root
// escalation. Splitting the actual privileged operations into this small,
// single-purpose daemon means only THIS file's narrow, fixed command set
// is root-reachable; the rest of the app never escalates privilege at all.
//
// Transport: newline-delimited JSON over a Unix socket
// (/run/showpilot-lite-cfhelper/cfhelper.sock). The systemd unit sets
// Group=fpp, so the RuntimeDirectory it creates (mode 0750) and the
// socket file we chmod below (0660) are both reachable by the `fpp` user
// the main app runs as, and by no one else.
// ============================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  SOCKET_PATH, SERVICE_NAME, SERVICE_FILE, BINARY_PATH, TOKEN_DIR, TOKEN_FILE, SUPPORTED_ARCHES,
} = require('./cfhelper-shared');

// ============================================================
// Process helpers
// ============================================================

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
// Privileged operations (formerly the sudo'd calls in lib/cloudflared.js)
// ============================================================

async function ping() {
  return { ok: true };
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

  const assetName = `cloudflared-linux-${arch}.deb`;

  // Cloudflare doesn't publish a separate checksums/signature file for
  // these release assets, but GitHub itself computes and publishes a
  // sha256 digest for every release asset via the Releases API — fetch
  // that ahead of the download so we can verify the downloaded bytes
  // actually match what GitHub has on record for this release, instead of
  // trusting the download URL/CDN blindly. Defense in depth on top of
  // HTTPS: it catches a compromised release artifact or a CDN swap, not a
  // compromised GitHub account/API itself. Best-effort — if GitHub's API
  // is unreachable we still proceed with the download but skip the
  // checksum comparison rather than failing the whole install on it.
  let expectedDigest = null;
  try {
    const relResp = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
      headers: { 'User-Agent': 'ShowPilot-Lite-cfhelper', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (relResp.ok) {
      const rel = await relResp.json();
      const asset = (rel.assets || []).find(a => a.name === assetName);
      if (asset && typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
        expectedDigest = asset.digest.slice('sha256:'.length);
      }
    }
  } catch {
    // Non-fatal — see comment above.
  }

  const tmpFile = path.join(require('os').tmpdir(), `cloudflared-${arch}-${Date.now()}.deb`);
  let dlResp;
  try {
    dlResp = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    return { ok: false, error: `Download failed: ${err.message}` };
  }
  if (!dlResp.ok || !dlResp.body) {
    return { ok: false, error: `Download failed: HTTP ${dlResp.status}` };
  }
  const buf = Buffer.from(await dlResp.arrayBuffer());

  if (expectedDigest) {
    const actualDigest = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualDigest !== expectedDigest) {
      return {
        ok: false,
        error: `Downloaded package failed checksum verification (expected sha256 ${expectedDigest}, got ${actualDigest}) — refusing to install a package that doesn't match GitHub's published checksum.`,
      };
    }
  }

  try {
    fs.writeFileSync(tmpFile, buf);
  } catch (err) {
    return { ok: false, error: `Could not write downloaded package: ${err.message}` };
  }

  const inst = await run('dpkg', ['-i', tmpFile], { timeout: 60000 });
  try { fs.unlinkSync(tmpFile); } catch {}
  if (inst.code !== 0) {
    return { ok: false, error: `dpkg install failed: ${inst.stderr.trim() || `exit ${inst.code}`}` };
  }

  if (!fs.existsSync(BINARY_PATH)) {
    return { ok: false, error: 'Install reported success but cloudflared binary is not at /usr/bin/cloudflared.' };
  }
  return { ok: true, alreadyInstalled: false };
}

// setToken — write the tunnel token to a mode-0600 file and install our
// own systemd unit that points cloudflared at it via --token-file.
//
// Why not `cloudflared service install <token>`? That helper writes the
// token directly into ExecStart= in the unit file, which:
//   1. Puts the token in /etc/systemd/system/cloudflared.service (mode
//      0644, world-readable on most systems)
//   2. Puts the token in argv at runtime, visible via `ps -ef` and
//      /proc/<pid>/cmdline to anyone with shell access
// Our own unit references --token-file, which keeps the token confined
// to a single 0600-mode file owned by root.
async function setToken({ token } = {}) {
  if (typeof token !== 'string' || token.trim().length < 20) {
    return { ok: false, error: 'Token looks invalid. Paste the full token from your Cloudflare Zero Trust dashboard.' };
  }
  const cleaned = token.trim();
  if (/\s/.test(cleaned)) {
    return { ok: false, error: 'Token contains whitespace. Re-copy from Cloudflare — there should be no spaces or line breaks.' };
  }
  if (!fs.existsSync(BINARY_PATH)) {
    return { ok: false, error: 'cloudflared is not installed. Install it first.' };
  }

  // Tear down any existing service first (old `service install`-created
  // unit, or a stale one from a previous token) — best-effort, the
  // daemon-reload + overwrite below produces a consistent result either way.
  if (fs.existsSync(SERVICE_FILE)) {
    await run(BINARY_PATH, ['service', 'uninstall'], { timeout: 30000 });
    await run('systemctl', ['stop', SERVICE_NAME], { timeout: 15000 });
  }

  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(TOKEN_DIR, 0o700);
  } catch (err) {
    return { ok: false, error: `Could not create ${TOKEN_DIR}: ${err.message}` };
  }
  try {
    fs.writeFileSync(TOKEN_FILE, cleaned + '\n', { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch (err) {
    return { ok: false, error: `Could not write token file: ${err.message}` };
  }

  // Differences from cloudflared's stock unit:
  //   - Uses --token-file instead of --token (the whole point of this)
  //   - Restart=always so a crash respawns indefinitely
  //   - Logs to journald — operators can `journalctl -u cloudflared`
  const unit = `[Unit]
Description=Cloudflare Tunnel (managed by ShowPilot-Lite)
After=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=${BINARY_PATH} tunnel --no-autoupdate run --token-file ${TOKEN_FILE}
Restart=always
RestartSec=5
User=root
Group=root
# Don't expose the token via journal logging.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
  try {
    fs.writeFileSync(SERVICE_FILE, unit, { mode: 0o644 });
  } catch (err) {
    return { ok: false, error: `Could not write systemd unit: ${err.message}` };
  }

  const reloadR = await run('systemctl', ['daemon-reload'], { timeout: 10000 });
  if (reloadR.code !== 0) {
    return { ok: false, error: `daemon-reload failed: ${reloadR.stderr.trim() || `exit ${reloadR.code}`}` };
  }
  const enableR = await run('systemctl', ['enable', SERVICE_NAME], { timeout: 10000 });
  if (enableR.code !== 0) {
    // enable failures are unusual; surface but continue to try start
    // because on some systems enable can fail while start works.
  }
  const startR = await run('systemctl', ['restart', SERVICE_NAME], { timeout: 15000 });
  if (startR.code !== 0) {
    return { ok: false, error: `Service start failed: ${startR.stderr.trim() || `exit ${startR.code}`}` };
  }
  return { ok: true };
}

async function start() {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed. Set a token first.' };
  }
  const r = await run('systemctl', ['start', SERVICE_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, error: `systemctl start failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true };
}

async function stop() {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed.' };
  }
  const r = await run('systemctl', ['stop', SERVICE_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, error: `systemctl stop failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true };
}

async function restart() {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed.' };
  }
  const r = await run('systemctl', ['restart', SERVICE_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    return { ok: false, error: `systemctl restart failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true };
}

// uninstall — remove the systemd service AND the cloudflared package.
async function uninstall() {
  if (fs.existsSync(SERVICE_FILE) && fs.existsSync(BINARY_PATH)) {
    await run('systemctl', ['stop', SERVICE_NAME], { timeout: 15000 });
    await run(BINARY_PATH, ['service', 'uninstall'], { timeout: 30000 });
  }
  if (fs.existsSync(SERVICE_FILE)) {
    try { fs.unlinkSync(SERVICE_FILE); } catch {}
    await run('systemctl', ['daemon-reload'], { timeout: 10000 });
  }
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  try { fs.rmdirSync(TOKEN_DIR); } catch {}
  if (fs.existsSync(BINARY_PATH)) {
    const r = await run('apt-get', ['remove', '-y', 'cloudflared'], { timeout: 60000 });
    if (r.code !== 0) {
      return { ok: false, error: `apt-get remove failed: ${r.stderr.trim() || `exit ${r.code}`}` };
    }
  }
  return { ok: true };
}

// recentLogs — return the last N lines from journalctl for the service.
async function recentLogs({ lines } = {}) {
  if (!fs.existsSync(SERVICE_FILE)) {
    return { ok: false, error: 'No tunnel service installed.' };
  }
  const safeN = Math.max(1, Math.min(500, parseInt(lines, 10) || 50));
  const r = await run('journalctl', ['-u', SERVICE_NAME, '-n', String(safeN), '--no-pager', '--output=cat'], { timeout: 10000 });
  if (r.code !== 0) {
    return { ok: false, error: `journalctl failed: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return { ok: true, logs: r.stdout };
}

// ============================================================
// Socket server
// ============================================================

const HANDLERS = { ping, install, setToken, start, stop, restart, uninstall, recentLogs };

async function handleRequest(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { ok: false, error: 'malformed request' };
  }
  const handler = msg && HANDLERS[msg.cmd];
  if (!handler) {
    return { ok: false, error: `unknown command: ${msg && msg.cmd}` };
  }
  try {
    return await handler(msg.args || {});
  } catch (err) {
    return { ok: false, error: err.message || 'internal error' };
  }
}

function startServer() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const server = net.createServer(socket => {
    let buf = '';
    // One command per connection, enforced two ways: the line is removed
    // from `buf` once we've taken it, and `handled` latches so any further
    // data on this socket is ignored outright. Without both, a second
    // `data` event (a chunked write, trailing bytes, a client that doesn't
    // stop at one line) would re-find the same newline and dispatch the
    // same command again — and a double install/uninstall in a root-owned
    // daemon is not a failure mode worth leaving open.
    let handled = false;
    socket.on('data', d => {
      if (handled) return;
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handled = true;
      handleRequest(line).then(resp => {
        try { socket.end(JSON.stringify(resp) + '\n'); } catch {}
      });
    });
    socket.on('error', () => {});
  });

  server.on('error', err => {
    console.error(`[cfhelper] server error: ${err.message}`);
  });

  server.listen(SOCKET_PATH, () => {
    try {
      // Directory perms (RuntimeDirectoryMode=0750, Group=fpp in the unit)
      // already restrict traversal to root + fpp; this restricts the
      // socket file itself the same way so only those two can connect.
      fs.chmodSync(SOCKET_PATH, 0o660);
    } catch (err) {
      console.error(`[cfhelper] could not chmod socket: ${err.message}`);
    }
    console.log(`[cfhelper] listening on ${SOCKET_PATH}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
