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
// Token file path (v0.3.1+). Stored at /etc/cloudflared/token, mode 0600,
// owned by root. Used as the argument to cloudflared --token-file. Living
// at /etc/cloudflared keeps it next to where cloudflared writes its own
// state and avoids putting tokens under /home/fpp/ where someone might
// accidentally tar them up. Created by setToken; removed by uninstall.
const TOKEN_DIR  = '/etc/cloudflared';
const TOKEN_FILE = '/etc/cloudflared/token';

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
//
// cloudflared has supported --token-file since v2023.7.0; we require a
// recent-enough binary. Anyone who installed cloudflared via Lite is
// fine because we always download the latest.
async function setToken(token) {
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

  // Tear down any existing service first. This handles three cases:
  //   1. Pre-v0.3.1 install: uses cloudflared's `service install`-generated
  //      unit (with --token in argv). We replace it with our own.
  //   2. v0.3.1+ install with old token: same unit, just replace the
  //      token file content (atomic) and restart.
  //   3. Stale unit from a manual install we don't recognize: replace it.
  if (fs.existsSync(SERVICE_FILE)) {
    // Try `cloudflared service uninstall` first — handles case 1 cleanly.
    // Best-effort; if it fails, our daemon-reload + overwrite below will
    // still produce a consistent result.
    await run('sudo', [BINARY_PATH, 'service', 'uninstall'], { timeout: 30000 });
    // Force-stop in case the unit survived (e.g. it was manually written
    // with a name cloudflared's uninstall doesn't recognize).
    await run('sudo', ['systemctl', 'stop', SERVICE_NAME], { timeout: 15000 });
  }

  // Write the token to /etc/cloudflared/token (mode 0600, root:root).
  // Done as a heredoc piped to `sudo tee` because Lite runs as the `fpp`
  // user and can't write directly to /etc/.
  const mkdirR = await run('sudo', ['mkdir', '-p', TOKEN_DIR], { timeout: 5000 });
  if (mkdirR.code !== 0) {
    return { ok: false, error: `Could not create ${TOKEN_DIR}: ${mkdirR.stderr.trim() || 'unknown error'}` };
  }
  const chmodDir = await run('sudo', ['chmod', '700', TOKEN_DIR], { timeout: 5000 });
  if (chmodDir.code !== 0) {
    // Non-fatal — directory perms aren't the protection, the file's are.
  }
  // Write via a temp file + atomic rename so a partial write never leaves
  // us with a half-written token. We use a small helper that pipes content
  // into `sudo tee` (because we can't write to /etc/ directly as fpp user).
  const tokenWriteR = await writeRootFile(TOKEN_FILE, cleaned + '\n', '0600');
  if (!tokenWriteR.ok) {
    return { ok: false, error: `Could not write token file: ${tokenWriteR.error}` };
  }

  // Write our systemd unit. Differences from cloudflared's stock unit:
  //   - Uses --token-file instead of --token (the whole point of v0.3.1)
  //   - Restart=always so a crash respawns indefinitely (matches Lite's
  //     own showpilot-lite.service convention)
  //   - Logs to journald (default) — operators can `journalctl -u cloudflared`
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
  const unitWriteR = await writeRootFile(SERVICE_FILE, unit, '0644');
  if (!unitWriteR.ok) {
    return { ok: false, error: `Could not write systemd unit: ${unitWriteR.error}` };
  }

  // Reload systemd, enable, start.
  const reloadR = await run('sudo', ['systemctl', 'daemon-reload'], { timeout: 10000 });
  if (reloadR.code !== 0) {
    return { ok: false, error: `daemon-reload failed: ${reloadR.stderr.trim() || `exit ${reloadR.code}`}` };
  }
  const enableR = await run('sudo', ['systemctl', 'enable', SERVICE_NAME], { timeout: 10000 });
  if (enableR.code !== 0) {
    // enable failures are unusual; surface but continue to try start
    // because on some systems enable can fail while start works.
  }
  const startR = await run('sudo', ['systemctl', 'restart', SERVICE_NAME], { timeout: 15000 });
  if (startR.code !== 0) {
    return { ok: false, error: `Service start failed: ${startR.stderr.trim() || `exit ${startR.code}`}` };
  }
  return { ok: true };
}

// writeRootFile — write content to a path that requires root, via
// `sudo tee` (since Lite runs as fpp, not root). Atomicity is via tee
// to a tmp path then sudo mv. We use sudo for chmod too so the final
// file ends up with the exact mode we asked for.
async function writeRootFile(destPath, content, modeStr) {
  // Stage to /tmp first (writable by fpp) so we can do an atomic mv.
  const tmpPath = `/tmp/.sp-cf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // Move into place with sudo. mv preserves the file but we set the
  // final mode + ownership explicitly afterward in case mv copied
  // attributes from /tmp.
  const mvR = await run('sudo', ['mv', tmpPath, destPath], { timeout: 5000 });
  if (mvR.code !== 0) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return { ok: false, error: mvR.stderr.trim() || `exit ${mvR.code}` };
  }
  await run('sudo', ['chown', 'root:root', destPath], { timeout: 5000 });
  await run('sudo', ['chmod', modeStr, destPath], { timeout: 5000 });
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
    // Stop the service via systemd; older v0.3.0 installs created their
    // unit via `cloudflared service uninstall` so we try that path too,
    // but the systemctl stop covers both ways the unit could exist.
    await run('sudo', ['systemctl', 'stop', SERVICE_NAME], { timeout: 15000 });
    await run('sudo', [BINARY_PATH, 'service', 'uninstall'], { timeout: 30000 });
  }
  // Force-remove the unit file in case `service uninstall` left it
  // (or it was our own v0.3.1+ unit, which `cloudflared service
  // uninstall` doesn't recognize).
  if (fs.existsSync(SERVICE_FILE)) {
    await run('sudo', ['rm', '-f', SERVICE_FILE], { timeout: 5000 });
    await run('sudo', ['systemctl', 'daemon-reload'], { timeout: 10000 });
  }
  // Remove our token file (v0.3.1+). Always attempt this even if file
  // doesn't seem to exist — `rm -f` is harmless and we shouldn't leave
  // a token sitting around if anything went weird.
  await run('sudo', ['rm', '-f', TOKEN_FILE], { timeout: 5000 });
  // Remove the directory if empty (best-effort; harmless if not empty
  // because some other tool put files there).
  await run('sudo', ['rmdir', TOKEN_DIR], { timeout: 5000 });
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
