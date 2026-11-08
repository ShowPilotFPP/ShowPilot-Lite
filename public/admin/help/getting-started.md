# Getting started

This page takes you from installing ShowPilot-Lite to a live viewer page that people can vote or request songs on. Each step is short and links to the page with the details. For how the pieces fit together, see [How ShowPilot works](help:how-it-works).

ShowPilot-Lite runs on your Falcon Player (FPP) box itself, as an FPP plugin. It has no phone audio: use it when your audio reaches visitors some other way, such as an FM transmitter.

> **Tip:** Press **F1** (or the **?** button) on any admin page to open help for that page.

## 1. Install ShowPilot-Lite in FPP

ShowPilot-Lite needs FPP 8.0 or newer, and the FPP box needs internet access while it installs.

1. In FPP, open **Content Setup › Plugin Manager**.
2. Find **ShowPilot-Lite** in the list, or add it by its install address in the **Manual Add** section.
3. Click **Install**. The install takes a few minutes. When it finishes, ShowPilot-Lite runs in the background and starts on its own whenever the FPP box starts.
4. If FPP asks you to restart FPPD, do so.

Full details are in [Connecting your show player](help:fpp-plugin).

## 2. Open the admin and sign in

In FPP, choose **Content Setup › ShowPilot-Lite Admin** (or press **Open** on ShowPilot-Lite's card in the Plugin Manager). The admin opens on port 3100 of your FPP box, so you can also bookmark `http://<your FPP address>:3100/admin/`.

A brand-new install has one account: username **admin**, password **admin**. Right after you sign in, a **Change Password Required** box asks you to pick a new password before you can carry on.

Moving from another ShowPilot? On a brand-new install the sign-in page also offers to restore a previous backup, so you don't have to set everything up again. See [Signing in](help:signing-in).

## 3. Name your show

Go to **Settings › General** and fill in **Show name**. It becomes the browser tab title on your viewer page (unless your template sets its own) and is used as a friendly name in a few other places.

## 4. Connect the ShowPilot plugin

ShowPilot-Lite doesn't play anything itself. FPP runs the show, and the separate **ShowPilot** plugin in FPP tells ShowPilot-Lite what's playing and plays what viewers pick.

1. In ShowPilot-Lite, open **Plugin** and click **Copy** next to the **Show Token**.
2. Install the ShowPilot plugin from FPP's **Plugin Manager**, open its settings under **Content Setup › ShowPilot**, and fill in the **Server URL** (`http://127.0.0.1:3100`, because ShowPilot-Lite is on the same box) and the **Show Token**.
3. Back in ShowPilot-Lite, the plugin status changes to **plugin online**.

Treat the show token like a password: anyone who has it can control your show. Full steps are in [Connecting your show player](help:fpp-plugin).

## 5. Check your sequences

Once connected, the plugin sends ShowPilot-Lite the songs in your FPP playlist, and they appear on the **Sequences** page. Songs that drop out of the playlist later are kept but marked inactive and hidden from viewers.

On the Sequences page you can:

- give each song a friendly **Display Name** and **Artist** (or try **Auto-Fill Song Info**),
- add cover art with **Fetch Covers**,
- choose which songs viewers see and can pick with the **Visible**, **Vote** and **Jukebox** switches,
- mark announcements as **PSA**, so they play between songs and never appear in the list.

You can also add a song by hand under **Add Sequence**, using the name exactly as it appears in FPP. See [Sequences](help:sequences).

## 6. Pick a viewer page template

The viewer page is what your audience sees on their phones. Its look comes from a template.

1. Open **Viewer Page › Template Editor**.
2. Choose a template from the **Templates** list.
3. Click **Set Active**.

Click **Show** in the top bar to open your viewer page in a new tab and check it. You can edit any template or start one with **+ New**. See [Viewer page templates](help:templates) and [Template Editor](help:viewer-editor).

## 7. Choose how viewers take part

ShowPilot has four ways for viewers to interact, called modes:

| Mode | What viewers do |
| --- | --- |
| **Voting** | Vote for the next song; the most votes wins. |
| **Jukebox** | Request songs, which play in order. |
| **Race** | Tap their favorite song as fast as they can; the leader wins. |
| **Listen only** | See what's playing, but not vote or request. |

Pick one with **Mode** in the top bar or on the [Dashboard](help:dashboard). Fine-tune each mode under [Settings › Voting](help:settings-voting), [Settings › Jukebox](help:settings-jukebox) or [Settings › Race](help:settings-race).

> **Tip:** If your page is reachable from the internet, set up [Interaction Safeguards](help:settings-safeguards) so only people near your show can vote or request.

## 8. Turn viewers on

Flip the **Viewer control** switch in the top bar (or on the Dashboard) to on. Your viewer page now accepts votes, requests or taps, and ShowPilot-Lite starts telling FPP what to play next. Turn it off at the end of the night; your show keeps running on its own schedule.

## 9. Tell people where to find you

- Visitors on your home network can open the viewer page at `http://<your FPP address>:3100/`. To let people reach it from their mobile data, set up [Public Access](help:settings-public-access).
- Enter that address as **Viewer page URL** in [Settings › General](help:settings-general). The Dashboard then shows a **Viewer QR Code** for visitors to scan.

If something isn't working, see [Troubleshooting](help:troubleshooting).
