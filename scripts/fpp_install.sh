#!/bin/bash
# ============================================================
# ShowPilot-Lite — FPP plugin install script
# ============================================================
# FPP runs this after `git clone`-ing the plugin into
# /home/fpp/media/plugins/ShowPilot-Lite/. It must:
#   1. Ensure Node 22+ is available (install via NodeSource if not)
#   2. Set up the data directory (under FPP's plugindata, so FPP backups capture it)
#   3. Write a config.js if one doesn't exist
#   4. Compile native deps via `npm install --omit=dev`
#   5. Install + enable the main systemd unit so it starts on boot
#   6. Install + enable the Cloudflare Tunnel privileged helper unit
#   7. Start both services
#
# Idempotent: re-running after a plugin update should be safe. We
# only do destructive steps (overwriting config) when the file is
# missing.
#
# Errors here are visible in FPP's plugin manager output. We `set -e`
# so the install fails loudly rather than silently — better for the
# user to see "Node install failed" than to find ShowPilot-Lite
# silently broken later.
#
# This entire script runs as root (fppd has no User= set, so it and
# everything it shells out to for plugin install/upgrade/uninstall runs
# as root) — every command below runs directly, with no privilege
# escalation, for exactly that reason.
# ============================================================

set -e

PLUGIN_DIR="/home/fpp/media/plugins/ShowPilot-Lite"
DATA_DIR="/home/fpp/media/plugindata/ShowPilot-Lite"
SERVICE_NAME="showpilot-lite"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CFHELPER_SERVICE_NAME="showpilot-lite-cfhelper"
CFHELPER_SERVICE_FILE="/etc/systemd/system/${CFHELPER_SERVICE_NAME}.service"

echo "============================================================"
echo "ShowPilot-Lite install"
echo "============================================================"
echo "Plugin dir:  $PLUGIN_DIR"
echo "Data dir:    $DATA_DIR"
echo

# ---------------------------------------------------------------
# 1. Node 22+ check / install
# ---------------------------------------------------------------
# Node 18 and 20 are both EOL (April 2025 and April 2026 respectively) —
# pin to 22 (Maintenance LTS, supported through April 2027) as the floor.
NEED_NODE_INSTALL=0
if ! command -v node >/dev/null 2>&1; then
    echo "[install] Node not found — will install Node 22 from NodeSource"
    NEED_NODE_INSTALL=1
else
    NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
    if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
        echo "[install] Node $(node -v) is too old (need 22+) — will upgrade"
        NEED_NODE_INSTALL=1
    else
        echo "[install] Node $(node -v) — OK"
    fi
fi

if [ "$NEED_NODE_INSTALL" = "1" ]; then
    # Add the NodeSource apt repo directly (GPG key + sources.list.d entry)
    # instead of piping their setup script into a shell.
    echo "[install] Adding NodeSource apt repo for Node 22.x..."
    apt-get install -y ca-certificates gnupg
    mkdir -p /etc/apt/keyrings
    curl -fsSL --connect-timeout 10 --max-time 30 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    echo "[install] Installing nodejs..."
    apt-get install -y nodejs
    echo "[install] Installed: $(node -v)"
fi

# ---------------------------------------------------------------
# 2. Data directory
# ---------------------------------------------------------------
# Strategy: keep the application's hardcoded ./data/ path, but make
# it a symlink into FPP's plugindata. This way:
#   - cover-art.js (which uses path.join(__dirname,'..','data','covers')) works unchanged
#   - DB, covers, secrets all live under plugindata
#   - FPP backups capture everything (FPP backs up plugindata)
#   - Reinstalling the plugin doesn't wipe the user's data (only the
#     plugin source dir is re-cloned; the symlink target survives)
echo "[install] Ensuring data dir exists: $DATA_DIR"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/covers"
chown -R fpp:fpp "$DATA_DIR"

# If the plugin dir has a real ./data/ directory from a prior non-symlink
# install or a stray git checkout, migrate its contents into plugindata
# before symlinking. Otherwise just create the symlink.
if [ -d "$PLUGIN_DIR/data" ] && [ ! -L "$PLUGIN_DIR/data" ]; then
    echo "[install] Migrating existing $PLUGIN_DIR/data/ contents into $DATA_DIR..."
    # Copy with -a to preserve perms, then drop the original.
    cp -a "$PLUGIN_DIR/data/." "$DATA_DIR/"
    rm -rf "$PLUGIN_DIR/data"
fi

# Create or refresh the symlink. -n stops `ln -sf` from following an
# existing symlink and creating the new link inside the target dir.
ln -snf "$DATA_DIR" "$PLUGIN_DIR/data"
chown -h fpp:fpp "$PLUGIN_DIR/data"

# ---------------------------------------------------------------
# 3. Config file
# ---------------------------------------------------------------
CONFIG_FILE="$PLUGIN_DIR/config.js"
if [ -f "$CONFIG_FILE" ]; then
    echo "[install] config.js already exists — leaving it alone"
else
    echo "[install] Writing initial config.js (dbPath -> ./data via symlink to $DATA_DIR)"
    # The dbPath uses the in-tree ./data/ path, which is now a symlink to
    # the FPP-managed plugindata location. Keeps cover-art.js happy
    # (it joins __dirname to 'data') while putting actual files under
    # plugindata where FPP's backup feature finds them.
    cat > "$CONFIG_FILE" <<EOF
// ============================================================
// ShowPilot-Lite — host-specific configuration
// Generated by FPP plugin installer.
//
// dbPath is './data/showpilot-lite.db' but ./data is a symlink to
// /home/fpp/media/plugindata/ShowPilot-Lite — see fpp_install.sh.
// ============================================================
module.exports = {
  port: 3100,
  host: '0.0.0.0',
  trustProxy: false,

  dbPath: './data/showpilot-lite.db',

  // Secrets auto-generate on first boot, persisted to data/secrets.json
  jwtSecret: null,
  sessionCookieName: 'showpilot_lite_session',
  sessionDurationHours: 24 * 30,
  showToken: null,

  viewer: {
    activeWindowSeconds: 30,
    pollIntervalMs: 5000,
    maxJukeboxRequestsPerViewer: 1,
    maxVotesPerRound: 1,
  },
  voting: {
    resetAfterWinnerPlays: true,
  },
  logLevel: 'info',
};
EOF
    chown fpp:fpp "$CONFIG_FILE"
fi

# ---------------------------------------------------------------
# 4. npm install (compiles better-sqlite3 against host Node)
# ---------------------------------------------------------------
# If npm was previously run as root (e.g. during an earlier FPP plugin
# install attempt), it leaves root-owned files in /home/fpp/.npm which
# cause EACCES when npm later runs as the fpp user. Fix ownership before
# running so a clean install always succeeds.
if [ -d "/home/fpp/.npm" ]; then
    echo "[install] Fixing npm cache ownership (root-owned files cause EACCES)..."
    chown -R fpp:fpp /home/fpp/.npm
fi
echo "[install] Running npm install --omit=dev (this may take a minute)..."
# Deliberately dropping from root down to fpp for this step (not just
# running it as root, which would leave root-owned files under
# node_modules/ and /home/fpp/.npm): runuser, not su, since it doesn't
# need a password prompt or a full login shell, just a different uid.
# Wrapped in `bash -c 'cd ... && ...'` rather than relying on runuser to
# inherit our cwd, since that's not guaranteed across implementations.
runuser -u fpp -- bash -c "cd '$PLUGIN_DIR' && npm install --omit=dev --no-audit --no-fund"

# ---------------------------------------------------------------
# 5. Main systemd unit
# ---------------------------------------------------------------
echo "[install] Writing systemd unit: $SERVICE_FILE"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ShowPilot-Lite (FPP-resident voting / jukebox / now-playing display)
After=network.target fppd.service
Wants=network.target

[Service]
Type=simple
User=fpp
Group=fpp
WorkingDirectory=${PLUGIN_DIR}
ExecStart=/usr/bin/node ${PLUGIN_DIR}/server.js
# Restart=always (not on-failure) is required because the backup-restore
# flow exits cleanly (process.exit(0)) to pick up new secrets — that's a
# successful exit, which on-failure wouldn't restart. always covers both
# the crash case and the intentional-restart case.
Restart=always
RestartSec=5
StandardOutput=append:/home/fpp/media/logs/plugin-ShowPilot-Lite.log
StandardError=append:/home/fpp/media/logs/plugin-ShowPilot-Lite.log

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------
# 6. Cloudflare Tunnel privileged helper unit
# ---------------------------------------------------------------
# Runs as root so the main app (User=fpp, above) never has to escalate
# privilege itself to install/manage cloudflared — it just asks this
# small, single-purpose daemon over a local Unix socket. See
# lib/cfhelper-daemon.js for the protocol and full rationale.
#
# RuntimeDirectory=showpilot-lite-cfhelper creates /run/showpilot-lite-cfhelper
# (mode 0750) before the daemon starts; Group=fpp means both that directory
# and the socket file the daemon creates inside it are group-owned by fpp,
# so the main app (also running as fpp) can reach the socket and no one
# else can. NoNewPrivileges=true is safe here (the daemon already has every
# privilege it needs as root, uid 0) and blocks it from gaining any more.
echo "[install] Writing systemd unit: $CFHELPER_SERVICE_FILE"
cat > "$CFHELPER_SERVICE_FILE" <<EOF
[Unit]
Description=ShowPilot-Lite Cloudflare Tunnel privileged helper
After=network.target

[Service]
Type=simple
User=root
Group=fpp
RuntimeDirectory=showpilot-lite-cfhelper
RuntimeDirectoryMode=0750
NoNewPrivileges=true
ExecStart=/usr/bin/node ${PLUGIN_DIR}/lib/cfhelper-daemon.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "[install] Reloading systemd, enabling + starting services..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl enable "$CFHELPER_SERVICE_NAME"
systemctl restart "$CFHELPER_SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Give it a beat to come up, then check status
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo
    echo "============================================================"
    echo "ShowPilot-Lite is running."
    echo "============================================================"
    echo "Open from FPP's Content Setup menu, or directly at:"
    echo "    http://$(hostname -I | awk '{print $1}'):3100/"
    echo
    echo "Default login: admin / admin (you'll be prompted to change)"
    echo "Logs:    /home/fpp/media/logs/plugin-ShowPilot-Lite.log"
    echo "Service: systemctl status $SERVICE_NAME"
    echo "============================================================"
else
    echo
    echo "[install] WARNING: $SERVICE_NAME did not start cleanly."
    echo "[install] Check logs: journalctl -u $SERVICE_NAME -n 50"
    exit 1
fi
