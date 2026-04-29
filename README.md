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

ShowPilot-Lite installs as an FPP plugin. *(Plugin packaging — `pluginInfo.json`, `fpp_install.sh`, systemd unit — is forthcoming in v0.2.0. v0.1.0 is the stripped Node app; install manually as below until then.)*

### Manual install (v0.1.0)

On the FPP host, as root or via `sudo`:

```bash
# 1. Install Node 18 if not present
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 2. Fetch ShowPilot-Lite
mkdir -p /home/fpp/media/plugins
cd /home/fpp/media/plugins
git clone https://github.com/ShowPilotFPP/ShowPilot-Lite.git
cd ShowPilot-Lite

# 3. Install Node deps (compiles better-sqlite3 against host Node)
npm install --omit=dev

# 4. Copy config template
cp config.example.js config.js

# 5. Run it
node server.js
```

Visit `http://<fpp-ip>:3100` — log in with `admin` / `admin` and you'll be prompted to set a password.

For background-on-boot, drop a systemd unit (forthcoming as part of v0.2.0 plugin packaging).

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
