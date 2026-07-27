#!/bin/bash
# ============================================================
# ShowPilot-Lite — FPP plugin uninstall script
# ============================================================
# FPP runs this when the user removes the plugin via Plugin Manager.
# We stop + disable the systemd services and delete their unit files,
# but we INTENTIONALLY leave /home/fpp/media/plugindata/ShowPilot-Lite
# alone — that's the user's database, sequence configs, custom
# templates, etc. Wiping it would be a footgun if they reinstall.
#
# If the user really wants to start fresh, they can remove that
# directory manually from an SSH session (as root):
#   rm -rf /home/fpp/media/plugindata/ShowPilot-Lite
#
# This entire script runs as root (fppd runs plugin uninstall hooks as
# root, same as install/upgrade) — every command below runs directly,
# with no privilege escalation, for exactly that reason.
# ============================================================

SERVICE_NAME="showpilot-lite"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CFHELPER_SERVICE_NAME="showpilot-lite-cfhelper"
CFHELPER_SERVICE_FILE="/etc/systemd/system/${CFHELPER_SERVICE_NAME}.service"
CLOUDFLARED_SERVICE_FILE="/etc/systemd/system/cloudflared.service"
CLOUDFLARED_BIN="/usr/bin/cloudflared"
CLOUDFLARED_TOKEN_FILE="/etc/cloudflared/token"
CLOUDFLARED_TOKEN_DIR="/etc/cloudflared"

echo "[uninstall] Stopping ShowPilot-Lite..."
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
fi

echo "[uninstall] Disabling on boot..."
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl disable "$SERVICE_NAME"
fi

if [ -f "$SERVICE_FILE" ]; then
    echo "[uninstall] Removing systemd unit: $SERVICE_FILE"
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
fi

# ---------------------------------------------------------------
# Cloudflare Tunnel privileged helper cleanup (v0.5.51+)
# ---------------------------------------------------------------
echo "[uninstall] Stopping Cloudflare Tunnel helper..."
if systemctl is-active --quiet "$CFHELPER_SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$CFHELPER_SERVICE_NAME"
fi
if systemctl is-enabled --quiet "$CFHELPER_SERVICE_NAME" 2>/dev/null; then
    systemctl disable "$CFHELPER_SERVICE_NAME"
fi
if [ -f "$CFHELPER_SERVICE_FILE" ]; then
    echo "[uninstall] Removing systemd unit: $CFHELPER_SERVICE_FILE"
    rm -f "$CFHELPER_SERVICE_FILE"
    systemctl daemon-reload
fi
rm -rf /run/showpilot-lite-cfhelper 2>/dev/null || true

# ---------------------------------------------------------------
# Cloudflare Tunnel cleanup (v0.3.0+)
# ---------------------------------------------------------------
# If the operator set up a tunnel via the Public Access card, the
# cloudflared service is independent of ours but ShowPilot-Lite is
# what put it there. Removing the plugin should clean it up too,
# otherwise the host has an orphaned tunnel pointing at a port that
# nobody's listening on. We DON'T uninstall the cloudflared package
# itself — keeping it costs nothing and avoids re-downloading on a
# reinstall. Just stop + remove the unit.
if [ -f "$CLOUDFLARED_SERVICE_FILE" ] && [ -x "$CLOUDFLARED_BIN" ]; then
    echo "[uninstall] Stopping cloudflared service (Public Access tunnel)..."
    systemctl stop cloudflared 2>/dev/null || true
    # Pre-v0.3.1 installs used `cloudflared service install` so they need
    # `cloudflared service uninstall`. v0.3.1+ wrote our own unit, which
    # cloudflared's uninstall doesn't recognize — covered by the rm below.
    "$CLOUDFLARED_BIN" service uninstall 2>/dev/null || true
    if [ -f "$CLOUDFLARED_SERVICE_FILE" ]; then
        rm -f "$CLOUDFLARED_SERVICE_FILE"
        systemctl daemon-reload
    fi
    echo "[uninstall] Note: cloudflared binary was kept for future reinstalls."
    echo "[uninstall] To fully remove it, from an SSH session (as root):"
    echo "[uninstall]   apt-get remove -y cloudflared"
fi

# Remove the tunnel token file (v0.3.1+). We always try this even if the
# service wasn't running — better to leave no creds behind. -f makes rm
# silent on missing files.
if [ -f "$CLOUDFLARED_TOKEN_FILE" ]; then
    echo "[uninstall] Removing tunnel token file..."
    rm -f "$CLOUDFLARED_TOKEN_FILE"
fi
# Remove dir if empty (best-effort).
rmdir "$CLOUDFLARED_TOKEN_DIR" 2>/dev/null || true

echo "[uninstall] Done. Note: data is preserved at"
echo "  /home/fpp/media/plugindata/ShowPilot-Lite/"
echo "Delete that directory manually if you want a clean wipe."
