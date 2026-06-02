# Amazon Music Scrobbler

A Chrome extension that automatically scrobbles your Amazon Music listening history to [Last.fm](https://www.last.fm).

![Amazon Music Scrobbler popup](https://raw.githubusercontent.com/sh1vvy/amazon-music-scrobbler/main/screenshots/connected.png)

## Features

- **Automatic scrobbling** — tracks are scrobbled once you've played 50% of the song (or 4 minutes, whichever comes first), following Last.fm's official rules
- **Now Playing** — updates your Last.fm "Now Scrobbling" status in real time when a track starts
- **Works in the background** — no need to keep the popup open; scrobbling happens via Chrome alarms even when the browser is just sitting in the background
- **Supports all Amazon Music regions** — `.com`, `.co.uk`, `.de`, `.fr`, `.ca`, `.co.jp`, `.com.au`, `.in`

## Installation

> The extension is not on the Chrome Web Store — load it as an unpacked extension.

1. Clone or download this repository
2. Generate the icons (one-time setup):
   ```bash
   node generate-icons.js
   ```
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the project folder

## Setup

### 1. Get a Last.fm API key

1. Go to [last.fm/api/account/create](https://www.last.fm/api/account/create)
2. Fill in the form — use `https://chromiumapp.org/` as the **Callback URL**
3. Submit and copy your **API Key** and **Shared Secret**

### 2. Connect the extension

1. Click the extension icon in Chrome's toolbar
2. Paste your **API Key** and **API Secret**, then click **Save & Continue**
3. Click **Connect to Last.fm** — a Last.fm login window will open
4. Authorise the app and the popup will show **Connected**

You're done. Play something on Amazon Music and it will scrobble automatically.

## How it works

| Mechanism | When it triggers |
|---|---|
| Content script (`play` event) | Immediately when a song starts |
| `tabs.onUpdated` | When the Amazon Music page title or status changes |
| `tabs.onActivated` | When you switch to the Amazon Music tab |
| Popup polling | Every 4 seconds while the popup is open |
| `chrome.alarms` | Fires at the exact scrobble threshold, even with the popup closed |

Track metadata is read from the browser's [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API), which Amazon Music populates with the correct title, artist, and album.

## Project structure

```
├── manifest.json       # Chrome extension manifest (MV3)
├── background.js       # Service worker — Last.fm API, alarms, track state
├── content.js          # Injected into Amazon Music — detects play events
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic
├── popup.css           # Popup styles
├── generate-icons.js   # One-time script to create PNG icons (no dependencies)
└── icons/              # Generated PNG icons (16, 32, 48, 128px)
```

## Permissions used

| Permission | Reason |
|---|---|
| `storage` | Saves API credentials and scrobble state |
| `identity` | Opens the Last.fm OAuth window |
| `tabs` + `scripting` | Reads the active Amazon Music tab to detect the current track |
| `alarms` | Fires the scrobble at the right time without keeping a service worker alive |

## License

MIT
