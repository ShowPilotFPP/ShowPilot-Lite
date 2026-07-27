// ============================================================
// ShowPilot-Lite — Cloudflare Tunnel helper: shared constants
// ============================================================
// Used by both sides of the privileged-helper split:
//   - lib/cloudflared.js      (unprivileged client, runs inside the main app)
//   - lib/cfhelper-daemon.js  (root-owned server, its own systemd unit)
// Kept in one file so the socket path and cloudflared-related filesystem
// constants can't drift between the two processes.
// ============================================================

const SOCKET_PATH = '/run/showpilot-lite-cfhelper/cfhelper.sock';

const SERVICE_NAME = 'cloudflared';
const SERVICE_FILE = '/etc/systemd/system/cloudflared.service';
const BINARY_PATH = '/usr/bin/cloudflared';
// Token file path (v0.3.1+). Stored at /etc/cloudflared/token, mode 0600,
// owned by root. Used as the argument to cloudflared --token-file. Living
// at /etc/cloudflared keeps it next to where cloudflared writes its own
// state and avoids putting tokens under /home/fpp/ where someone might
// accidentally tar them up. Created by setToken; removed by uninstall.
const TOKEN_DIR = '/etc/cloudflared';
const TOKEN_FILE = '/etc/cloudflared/token';

// Cloudflare publishes per-arch .deb packages at:
//   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-<arch>.deb
// where <arch> is one of: amd64, arm64, armhf, 386. dpkg --print-architecture
// on Debian/Raspberry Pi OS returns these same strings, so we can pass
// it through directly. We don't support 386 here (no FPP target uses it)
// but it'd just work if someone did.
const SUPPORTED_ARCHES = ['amd64', 'arm64', 'armhf'];

module.exports = {
  SOCKET_PATH,
  SERVICE_NAME,
  SERVICE_FILE,
  BINARY_PATH,
  TOKEN_DIR,
  TOKEN_FILE,
  SUPPORTED_ARCHES,
};
