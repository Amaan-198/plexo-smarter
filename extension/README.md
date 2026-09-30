# Plexo browser extension

Hands downloads you start in Microsoft Edge or Google Chrome to [Plexo](../README.md)'s queue, with the browser's session, so links that only work in that session (a file host's "secure session link") download over every network Plexo has.

## Install

1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. The settings page opens. With Plexo running, click **Connect to Plexo** and then **Allow** in Plexo's window.

## What it does

- A download starts in the browser. If it's from a site on the list (by default `filekeeper.net`, subdomains included, or a download started from one of its pages), the extension pauses it.
- It sends Plexo the link, the file name, the page it came from (Referer), the browser's User-Agent, and the browser's cookies for the link.
- Plexo queued it: the browser's download is cancelled and taken off its list. Plexo isn't running or said no: the browser's download resumes, as if the extension weren't there.
- Right-click any link → **Download with Plexo** does the same for a link that hasn't started downloading.
- A small card in the page's corner confirms each hand-over ("Sent to Plexo", "New link sent to Plexo", "Already in Plexo's queue"), or says why the browser kept the download ("Plexo isn't running"). Clicking it opens the toolbar popup with Plexo's queue. It leaves by itself after a few seconds; on a page an extension can't touch, a system notification says it instead. It can be turned off in the settings.
- The toolbar popup shows Plexo's queue as it is right now — what's downloading and how fast, what's waiting, what finished or failed — read from Plexo every second while the popup is open.
- Downloads in private windows are never sent.

## Permissions

| Permission              | Why                                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| `downloads`             | See downloads start, pause them while asking Plexo, cancel the browser's copy. |
| `cookies` + host access | Read the browser's cookies for a download's link, to send them with it.        |
| `storage`               | Remember the settings and Plexo's connection token.                            |
| `contextMenus`          | The **Download with Plexo** menu item.                                         |

Nothing is sent anywhere but Plexo on `127.0.0.1`.
