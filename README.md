# 🎵 MusicFlow — Ad-Free Music Player

A Spotify-style Chrome extension that plays music from YouTube — **no ads, no login, no API quota limits**.

![MusicFlow](icons/icon128.png)

---

## ✨ Features

- 🔍 **Search** — powered by yt-dlp, unlimited searches, zero API quota
- 🎵 **Audio only** — no YouTube tab ever opens, pure background audio
- ⏭ **Smart Next/Prev** — moves through search results naturally
- 🔀 **Shuffle** — random pick from current queue
- 🔁 **Repeat** — loop current song
- 💾 **Playlists** — save/load queues, import any YouTube URL or radio mix
- 📋 **Up Next** — see upcoming songs in queue
- 🎤 **Lyrics** — one-click lyrics via lyrics.ovh
- ⌨️ **Hotkeys** — Space (play/pause), ←→ (prev/next), M (mute)
- 🖥️ **Windows Media Controls** — overlay shows song name, overlay buttons work
- 🔁 **Auto-starts** — backend runs silently on Windows login, no setup needed
- 💡 **Search suggestions** — autocomplete as you type (zero API quota)
- 📥 **Load any YouTube URL** — paste a radio mix, playlist, or video link

---

## 🚀 Setup (one time)

### Requirements
- Windows 10/11
- Python 3.8+
- Google Chrome

### Step 1 — Install Python dependencies
```bash
pip install yt-dlp flask flask-cors
```

### Step 2 — Start the backend (first time only)
```bash
python server/server.py
```
Or double-click `server/start_server.bat`

> After this the backend auto-starts on every Windows login silently — you never need to do this again.

### Step 3 — Load the extension in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`music.sortcut`)
5. Click the extension icon — done!

---

## 📁 File Structure

```
music.sortcut/
├── manifest.json        — Extension config (v3)
├── popup.html           — UI layout
├── popup.css            — Spotify-dark styling
├── popup.js             — Player logic, search, playlists, lyrics
├── background.js        — Service worker, offscreen manager
├── offscreen.html       — Hidden audio player page
├── offscreen.js         — <audio> element + Windows Media Session
├── content.js           — (unused, kept for reference)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── server/
    ├── server.py              — Flask backend (search, stream, radio, suggest)
    ├── start_server.bat       — Manual start script
    └── start_server_silent.vbs — Auto-start on Windows login
```

---

## 🏗️ Architecture

```
[Popup] ──search──▶ [Backend /search] ──yt-dlp──▶ YouTube
[Popup] ──play──▶  [Background] ──/stream──▶ [Backend] ──yt-dlp──▶ audio URL
                        │
                        ▼
                  [Offscreen <audio>] ──plays──▶ 🔊 System audio
                        │
                        ▼
                  [Windows Media Session] ──overlay controls──▶ [Popup]
```

**Zero YouTube Data API quota used** — everything goes through yt-dlp.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `→` | Next song |
| `←` | Previous song |
| `M` | Mute / Unmute |

---

## 📝 Notes

- Backend must be running for playback (auto-starts on login after first setup)
- Lyrics powered by [lyrics.ovh](https://lyrics.ovh) — free, no key needed
- Stream URLs cached for 6 hours — replaying same song is instant
- Search results cached for 30 minutes — same query costs nothing
- Works with any YouTube URL: single video, playlist, radio mix
