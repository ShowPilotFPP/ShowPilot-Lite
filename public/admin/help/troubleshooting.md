# Troubleshooting

Common problems and what to check, quickest fixes first. Each section links to the page with the full details.

## Viewers can't vote or request

Viewers usually see a message saying why. Match it to the list below.

- **Viewer control is off, or in the wrong mode.** Votes only work in **Voting** mode, requests only in **Jukebox** mode, and race taps only in **Race** mode. In **Listen only**, viewers see "Requests and voting are closed for now". Check **Viewer Control** and **Mode** on the [Dashboard](help:dashboard).
- **"Location required…" or "You must be within … miles of the show".** **Require viewers be within radius of show location** is on in [Interaction Safeguards](help:settings-safeguards). The viewer must allow location and be inside the radius.
  - If viewers see "Show location not configured on server", the location check is on but your show's latitude and longitude are empty. Set them, or turn the check off.
  - Browsers only share location on an `https://` page. If your viewer page is plain `http://`, the location check can't work. See [Public Access](help:settings-public-access).
  - Pages opened inside apps such as Facebook or Instagram often can't share location. Viewers should open the page in Safari or Chrome.
- **"Invalid or missing access code."** **Require viewers to enter a code to interact** is on. Make sure the code you post at the show matches the one in Interaction Safeguards.
- **"The queue is full."** The jukebox queue has reached its depth. Raise **Jukebox queue depth** in [Jukebox](help:settings-jukebox) or wait for songs to play.
- **"You already have … in the queue."** The per-viewer request limit is working as intended.
- **"That sequence has been requested the maximum number of times."** **Max copies of the same song in queue** has been reached for that song.
- **"That song is playing right now" or "That song is already up next".** The repeat blockers are on.
- **"That sequence was recently played"** or a cooldown message. The song is resting after it played. See [Sequences](help:sequences).
- **A song is missing from the list.** Check its **Visible**, **Vote** and **Jukebox** switches on [Sequences](help:sequences), whether its category is switched off, and whether it's **Inactive** (no longer in your FPP playlist).
- **One viewer is refused everywhere** with "Your IP has been blocked": their address is in **Blocked IPs** in Interaction Safeguards.

## The admin won't open

- Check ShowPilot-Lite finished installing without errors in FPP's **Plugin Manager**.
- Open it from FPP's **Content Setup › ShowPilot-Lite Admin**, or go to `http://<your FPP address>:3100/admin/` directly.
- ShowPilot-Lite starts on its own with the FPP box. If it has stopped, restart the FPP box.
- Its log is `plugin-ShowPilot-Lite.log`, under **Status/Control › Logs** in FPP.

## The show player isn't connected

The admin header says **plugin offline** or **plugin never connected**, and the **Plugin** tab shows **Offline** or **Never seen**. ShowPilot-Lite counts the ShowPilot plugin as online while it has checked in during the last minute.

1. Make sure FPP is running and the **ShowPilot** plugin is installed alongside ShowPilot-Lite.
2. Check the ShowPilot plugin's **Server URL** is `http://127.0.0.1:3100`, since ShowPilot-Lite runs on the same box.
3. Check the plugin's **Show Token** matches the one on ShowPilot-Lite's **Plugin** tab exactly. A wrong token is refused.
4. Look at the logs in FPP under **Status/Control › Logs**.
5. If the Dashboard shows a red banner saying the plugin needs updating, update it in FPP's **Plugin Manager**.

Full steps: [Connecting your show player](help:fpp-plugin).

## Songs are missing or out of date

- **No songs at all:** the plugin hasn't synced yet. Check its **Remote Playlist** setting, then press **Sync Now** in the plugin. The **Plugin** tab's **Last sync** shows when it last synced and how many songs came across.
- **A song you added in FPP isn't there:** it must be in the playlist the plugin syncs. Add it, then sync.
- **A song you removed still shows in the admin:** it's now **Inactive**. It's hidden from viewers but kept with its details. Use **Delete Inactive** on [Sequences](help:sequences) if you want it gone.
- **A song appears once even though it's in the playlist twice:** that's expected. ShowPilot keeps its first position and notes the duplicate on the Sequences page.
- **Wrong or missing cover art:** use **Fetch Covers** on Sequences, or click a cover to pick another.
- **Your own display names were replaced:** they aren't. Syncing only fills in names, artists and covers that are still empty or unchanged.

## You can't sign in

- **"Invalid credentials":** the username or password is wrong, or the account has been disabled. Another admin can re-enable it or set a new password with **Reset PW** on [Users](help:users).
- **"Too many login attempts. Please wait a few minutes and try again.":** after 8 failed attempts in 15 minutes from the same place, sign-in pauses. Wait, then try again carefully.
- **Signed out every time you close the browser:** tick **Remember me on this device (30 days)** when you sign in.
- **Asked to change your password:** this happens the first time you sign in with the default password, or when another admin set your password and asked for it to be changed. Choose your own to continue.

More in [Signing in](help:signing-in).

## The Audio Normalizer can't find your songs

ShowPilot-Lite runs on the FPP box, so the [Audio Normalizer](help:tools-normalizer) reads the songs straight from FPP. If it says **ffmpeg is needed**, follow the install hint it shows, then restart ShowPilot-Lite (or the FPP box). You can still use **Files from this computer** in the meantime.
