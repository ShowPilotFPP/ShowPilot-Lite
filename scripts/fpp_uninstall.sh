#!/bin/bash
# ============================================================
# ShowPilot-Lite — FPP plugin uninstall script
# ============================================================
# FPP runs this when the user removes the plugin via Plugin Manager.
# We stop + disable the systemd service and delete the unit file,
# but we INTENTIONALLY leave /home/fpp/media/plugindata/ShowPilot-Lite
# alone — that's the user's database, sequence configs, custom
# templates, etc. Wiping it would be a footgun if they reinstall.
#
# If the user really wants to start fresh, they can:
#   sudo rm -rf /home/fpp/media/plugindata/ShowPilot-Lite
# ============================================================

SERVICE_NAME="showpilot-lite"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "[uninstall] Stopping ShowPilot-Lite..."
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    sudo systemctl stop "$SERVICE_NAME"
fi

echo "[uninstall] Disabling on boot..."
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    sudo systemctl disable "$SERVICE_NAME"
fi

if [ -f "$SERVICE_FILE" ]; then
    echo "[uninstall] Removing systemd unit: $SERVICE_FILE"
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
fi

echo "[uninstall] Done. Note: data is preserved at"
echo "  /home/fpp/media/plugindata/ShowPilot-Lite/"
echo "Delete that directory manually if you want a clean wipe."
