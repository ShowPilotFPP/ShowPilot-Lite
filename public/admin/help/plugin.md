# Plugin

This tab shows whether the ShowPilot plugin in Falcon Player (FPP) is talking to ShowPilot-Lite, and gives you the token that pairs the two. ShowPilot-Lite and the ShowPilot plugin both run on the same FPP box. For installing the plugin and pairing it step by step, see [Connecting your show player](help:fpp-plugin).

## Plugin Status

| Item | What it tells you |
|---|---|
| **Connection** | **Online** if the plugin has checked in within the last minute, **Offline** if it has been quiet longer, **Never seen** if it has never connected. |
| **Last seen** | How long ago the plugin last checked in. |
| **Plugin version** | The plugin version your show player reported. |
| **Last sync** | When the plugin last sent your playlist, and how many sequences it contained. |

The status refreshes on its own every few seconds. The same online/offline state is shown at the top of every admin page.

> **Tip:** If it says **Offline**, check that FPP is running and that the ShowPilot plugin's **Server URL** is `http://127.0.0.1:3100`. If it says **Never seen**, the plugin hasn't been paired yet: start with the token below. More help in [Troubleshooting](help:troubleshooting).

A sync is what fills your [Sequences](help:sequences) list. If **Last sync** is old or shows the wrong number of sequences, see [Connecting your show player](help:fpp-plugin) for how syncing works.

## Show Token (for ShowPilot Plugin)

The token is the key that lets the plugin control your show. To pair:

1. Click **Copy**. If copying doesn't work in your browser, select the token text and copy it by hand.
2. In FPP, open the ShowPilot plugin's settings under **Content Setup › ShowPilot**.
3. Paste it into the plugin's **Show Token** field and save.

Once the plugin connects, **Connection** here changes to **Online**.

> **Careful:** Treat the token like a password. Anyone who has it can control your show. Don't post it in screenshots or forums.
