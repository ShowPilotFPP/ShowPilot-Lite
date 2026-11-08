# Settings › Public Access

Puts your viewer page on the internet so people can reach it from their phones on mobile data, with no port forwarding and no router changes. It uses a **Cloudflare Tunnel**: you bring your own free Cloudflare account and a domain in it, and ShowPilot-Lite runs the tunnel on your FPP box for you.

The page walks you through it in steps. What you see depends on how far you've got.

## Status and Architecture

The badge at the top right sums up the tunnel:

| Badge | Meaning |
|---|---|
| **Not Installed** | The tunnel program isn't on this box yet. |
| **Needs Token** | Installed, but not connected to your Cloudflare account. |
| **Tunnel Online** | The tunnel is running. Your show is reachable at the address you set up in Cloudflare. |
| **Configured but Stopped** | Set up, but switched off. |

**Status** says the same thing in a sentence. **Architecture** shows the kind of processor your FPP box has. The tunnel can be installed on 64-bit Intel/AMD, 64-bit ARM, and 32-bit ARM (such as older Raspberry Pis). If the processor isn't supported, or can't be detected, the install button is greyed out and the page says why.

## Step 1: install the tunnel runtime

Press **Install Cloudflare Tunnel**. ShowPilot-Lite downloads Cloudflare's tunnel program from Cloudflare's official releases and installs it on the FPP box as a system package. It takes about 30 seconds on most connections.

## Step 2: connect a Cloudflare tunnel

You need a free Cloudflare account with a domain added to it. Press **Show me how →** on the page for the steps. In short:

1. In your Cloudflare dashboard, go to **Networks → Tunnels** and press **Create a tunnel**. Choose the **Cloudflared** connector and give it any name.
2. On the next screen, copy the **token**: the long string after `--token` in the install command. Don't run the command; you only need the token.
3. Press **Next**. On the **Public Hostname** page, pick a subdomain (for example `show`) and your domain, and set **Service** to `HTTP` with the URL `127.0.0.1:3100`. Save.
4. Back in ShowPilot-Lite, paste the token into **Tunnel token** and press **Save Token & Start Tunnel**.

The tunnel starts straight away and the badge should turn to **Tunnel Online**. Your show is then live at the hostname you picked.

> **Careful:** Treat the token like a password. Anyone who has it can connect to your tunnel. ShowPilot-Lite keeps it in a protected file on the FPP box and clears the box on the page once it's saved.

> **Tip:** Cloudflare can also protect the `/admin` part of your address with **Cloudflare Access**, so only you can reach the admin pages. Viewers don't need it. It's free for small numbers of users and well worth setting up.

Once it works, put your new address in **Viewer page URL** under [Settings › General](help:settings-general#viewer-page-url), so the QR code on the Dashboard points to it.

## Controlling the tunnel

Once a token is saved, these buttons appear:

| Button | What it does |
|---|---|
| **Start Tunnel** / **Stop Tunnel** | Turns the tunnel on or off. While it's off, nobody can reach your viewer page from the internet; it still works on your own network. |
| **Restart** | Stops and starts the tunnel. Try this first if it seems stuck. |
| **Replace Token** | Shows the token box again so you can paste a different token, for example after making a new tunnel in Cloudflare. Saving it restarts the tunnel with the new token. |
| **View Logs** | Shows the tunnel's recent messages. Use **Refresh** to update them and **Hide** to close them. |
| **Uninstall** | Stops the tunnel, removes the saved token and removes the tunnel program from the FPP box. Your tunnel in Cloudflare isn't touched, so you can reinstall later and paste the same token. |

The tunnel runs as its own service on the FPP box, separate from ShowPilot-Lite, and starts by itself whenever the box starts.

> **Careful:** **Stop Tunnel** lasts only until the FPP box next restarts, when the tunnel starts again. To keep it off for good, use **Uninstall**.

## Updating the tunnel program

Below the buttons, the page shows the installed version of the tunnel program and whether a newer one is out. Press **Update to …** (or **Reinstall latest** when you're already up to date) to get the latest version. Your token is kept, and a running tunnel is restarted. **Check again** looks for a new version now. If something goes wrong, your existing install is kept.

> **Tip:** If you're using this page through the tunnel itself, it loses connection for a few seconds while the tunnel restarts. Leave it open and it comes back.

## When the tunnel won't connect

If the badge says **Tunnel Online** but your address doesn't open the show, press **View Logs** to see what the tunnel reports. The usual causes:

- The token was copied incompletely. Copy it again and use **Replace Token**. A token with spaces or line breaks in it is refused.
- No public hostname is set for the tunnel in Cloudflare, or its service isn't `HTTP` with `127.0.0.1:3100`.
- The FPP box can't reach the internet.

If a button reports that the tunnel helper service isn't running, restart the ShowPilot-Lite plugin (or the FPP box) and try again.

> **Important:** The tunnel token isn't included in backups. After restoring a backup on a new FPP box, install the tunnel again and paste your token. You can always get it again from your Cloudflare dashboard.
