# ShowPilot-Lite

**FPP-resident build of [ShowPilot](https://github.com/ShowPilotFPP/ShowPilot).** Runs on the same host as Falcon Player and provides voting, jukebox, and a now-playing display for visitors. **Audio streaming is removed** — this is the right pick for shows delivering audio externally (PulseMesh, FM transmitter, Icecast, etc.) where ShowPilot doesn't need to host audio bytes.

## What's different from ShowPilot main

| | ShowPilot | ShowPilot-Lite |
|---|---|---|
| Where it runs | LXC / Docker / VM / bare metal | On FPP itself (same Pi/BBB as the player) |
| Audio streaming to viewers | ✅ HTTP audio + cache + sync | ❌ Removed — pair with PulseMesh / FM / Icecast |
| Voting / Jukebox | ✅ | ✅ |
| Now-playing display | ✅ (with optional player controls) | ✅ (display-only bar, auto-shows when playing) |
| Backup / restore | ✅ | ✅ |
| Plugin sync (sequences, status) | ✅ | ✅ |
| Cover art (Spotify) | ✅ | ✅ |
| Footprint on FPP's SD card | n/a (runs elsewhere) | Tiny — no audio cache, no audio bytes |

If you need HTTP audio for viewers (cars without FM, etc.), use the full [ShowPilot](https://github.com/ShowPilotFPP/ShowPilot) on a separate host. If your audio reaches viewers another way, Lite gives you everything else without putting audio I/O on FPP's SD card.

## Install

ShowPilot-Lite installs as an FPP plugin. From FPP's web UI:

1. Open **Content Setup → Plugin Manager**
2. Either find **ShowPilot-Lite** in the list (once published to the FPP plugin registry), or scroll to the **Manual Add** section and paste:
   ```
   https://raw.githubusercontent.com/ShowPilotFPP/ShowPilot-Lite/main/pluginInfo.json
   ```
3. Click **Install**. FPP will clone the repo and run the install script, which:
   - Installs Node 18 from NodeSource if not already present
   - Compiles native dependencies (`better-sqlite3`)
   - Sets up a data directory at `/home/fpp/media/plugindata/ShowPilot-Lite/` (backed up by FPP's own backup feature)
   - Drops a `systemd` unit and starts the service on port 3100
4. After install completes, click **Restart FPPD** when prompted, then look for the **ShowPilot-Lite** entry under FPP's **Content Setup** menu — it opens the admin UI in a new tab.
5. First login: `admin` / `admin`. You'll be prompted to set a password immediately.

### Manual install (for development / non-plugin-manager use)

If you want to run Lite outside FPP's plugin manager:

```bash
# 1. Install Node 18 if not present
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone and install
git clone https://github.com/ShowPilotFPP/ShowPilot-Lite.git
cd ShowPilot-Lite
npm install --omit=dev

# 3. Copy config template, edit if needed
cp config.example.js config.js

# 4. Run
node server.js
```

## Pairing with PulseMesh

ShowPilot-Lite assumes audio reaches viewers via something other than itself. PulseMesh is the obvious pick — it handles RF audio distribution at a quality and scale this software can't. Configure PulseMesh per its own docs; ShowPilot-Lite handles the voting / jukebox / display side.

## Configuration

Edit `config.js`. Defaults are sensible for FPP-on-LAN deployments. Notable settings:

- `port` — defaults to 3100
- `dbPath` — defaults to `./data/showpilot-lite.db`
- `jwtSecret` and `showToken` — leave `null` to auto-generate; persisted to `data/secrets.json` after first boot
- `trustProxy` — `false` if you expose port 3100 directly, `1` if you put nginx/Caddy in front

## License

MIT. See LICENSE.
