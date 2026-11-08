# Connecting your show player

ShowPilot-Lite runs on your Falcon Player (FPP) box as an FPP plugin. It doesn't play your show itself: FPP does, and the separate **ShowPilot** plugin in FPP keeps the two talking. This guide covers installing ShowPilot-Lite, opening it, pairing the ShowPilot plugin, syncing your songs and checking that everything is connected.

For what each part of the **Plugin** tab shows, see [Plugin](help:plugin).

## Two plugins, one box

| Plugin | What it is |
|---|---|
| **ShowPilot-Lite** | This app: the admin, the viewer page, voting, the jukebox and the queue. It runs in the background on the FPP box, on port 3100. |
| **ShowPilot** | The connector. It sends ShowPilot-Lite your playlist and what's playing, and hands the songs viewers pick to FPP. |

Both are installed from FPP's **Plugin Manager**. ShowPilot-Lite has no phone audio, so it doesn't store any audio files from the plugin.

## 1. Install ShowPilot-Lite

You need FPP **8.0 or newer**, and the FPP box needs internet access during the install.

1. In FPP, go to **Content Setup › Plugin Manager**.
2. Find **ShowPilot-Lite** in the list, or scroll to the **Manual Add** section and paste ShowPilot-Lite's install address.
3. Click **Install**. FPP shows the install progress. The first install takes a few minutes, because it sets up what ShowPilot-Lite needs to run.
4. When it's done, restart FPPD if FPP asks you to.

ShowPilot-Lite then runs in the background and starts on its own every time the FPP box starts. If the install reports that ShowPilot-Lite didn't start, the message in FPP's install output says where to look.

## 2. Open the admin

Any of these opens the ShowPilot-Lite admin:

- In FPP, choose **Content Setup › ShowPilot-Lite Admin**.
- Press **Open** on ShowPilot-Lite's card in FPP's **Plugin Manager**.
- Go straight to `http://<your FPP address>:3100/admin/` in your browser. Bookmark it, or use it on a tablet.

The first time, sign in with **admin** / **admin** and choose a new password. See [Signing in](help:signing-in).

## 3. Install the ShowPilot plugin

1. In FPP's **Plugin Manager**, install the **ShowPilot Blackbox** plugin (from the list, or with its install address in **Manual Add**).
2. In ShowPilot-Lite, open the **Plugin** tab and press **Copy** next to **Show Token (for ShowPilot Plugin)**.

> **Careful:** Treat the Show Token like a password. Anyone who has it can control your show.

## 4. Pair it with ShowPilot-Lite

Open the ShowPilot plugin's settings in FPP under **Content Setup › ShowPilot** and fill in:

| Plugin setting | What to enter |
|---|---|
| **ShowPilot Server URL** | (Called **Server URL** before plugin 0.14.24.) `http://127.0.0.1:3100`. ShowPilot-Lite runs on the same box, on port 3100. No `/admin` and no slash at the end. |
| **Show Token** | The token you copied from ShowPilot-Lite's **Plugin** tab. |
| **Remote Playlist** | The FPP playlist holding the songs viewers can pick. |
| **Interrupt schedule** | Turn on if viewer picks should play right away instead of after the current song. |

Save the settings.

## 5. Sync your songs

Press **Sync Now** in the ShowPilot plugin. Within a few seconds your songs appear on ShowPilot-Lite's **Sequences** page.

How syncing treats your song list:

- New songs in the playlist are added. Their display names start as the file name with underscores and dashes turned into spaces. You can rename them in ShowPilot-Lite and a later sync won't overwrite your names, artists or covers.
- Songs you remove from the playlist become **Inactive**. They keep everything you set up but disappear from the viewer page, voting and the jukebox, and any pending votes or requests for them are cleared. Add them back to the playlist and the next sync makes them active again. Use the **Inactive** filter or **Delete Inactive** on the Sequences page to review or tidy them.
- A song listed more than once in the playlist still counts as one song. ShowPilot-Lite keeps its first position and shows a note on the Sequences page.
- ShowPilot-Lite looks up cover art for new songs without one, in the background.

> **Tip:** Sync again whenever you change the playlist.

## 6. Check the connection

ShowPilot-Lite shows the connection in several places:

- The admin header reads **plugin online**, **plugin offline** or **plugin never connected**.
- The **Plugin** tab's **Plugin Status** card shows **Connection** (**Online**, **Offline** or **Never seen**), **Last seen**, **Plugin version** and **Last sync** (with how many sequences came across).
- The Cockpit header shows **FPP online** or **FPP offline**.

The plugin checks in regularly. The admin shows **Online** while ShowPilot-Lite has heard from it in the last minute.

If a newer ShowPilot plugin version is available, a banner at the top of the **Dashboard** says so. It turns red when your plugin is too old for this version of ShowPilot-Lite; update it from FPP's **Plugin Manager**, then restart FPPD if FPP asks.

## Updating ShowPilot-Lite

ShowPilot-Lite is updated like any other FPP plugin: from FPP's **Plugin Manager**. Your settings, songs and templates are kept.

## Where your data lives

Your database, cover art and settings are kept in FPP's plugin data folder (`/home/fpp/media/plugindata/ShowPilot-Lite/`), so FPP's own backup includes them. Uninstalling ShowPilot-Lite from the Plugin Manager leaves that folder alone, so reinstalling brings everything back. For a backup you can restore on another install, use [Settings › Backup & Restore](help:settings-backup).

ShowPilot-Lite's log is written to `plugin-ShowPilot-Lite.log` in FPP's logs, which you can open under **Status/Control › Logs**.

## If it won't connect

- **The admin won't open:** check ShowPilot-Lite finished installing without errors in the Plugin Manager, then try `http://<your FPP address>:3100/admin/` directly. Restarting the FPP box starts ShowPilot-Lite again.
- **Never seen** or **Offline**: check the ShowPilot plugin's **ShowPilot Server URL** is `http://127.0.0.1:3100`.
- Check the **Show Token** in the plugin matches the one on ShowPilot-Lite's **Plugin** tab exactly, with no spaces at either end. A wrong token is refused.
- Look at the logs in FPP under **Status/Control › Logs**.
- **Online but no songs**: make sure **Remote Playlist** names the right playlist, then press **Sync Now**. An empty playlist is ignored, so it never wipes your song list.

More fixes are in [Troubleshooting](help:troubleshooting).
