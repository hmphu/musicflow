/**
 * MusicFlow — background.js (v6.1)
 * Single onMessage listener — no conflicts.
 * Fetches audio stream URL from local yt-dlp backend, plays via offscreen <audio>.
 */

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const BACKEND_URL   = 'http://127.0.0.1:7842';

// ── Offscreen document ────────────────────────────────────────────────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play audio stream from yt-dlp backend',
  });
}

// ── Send command to offscreen player ─────────────────────────────────────────
async function toPlayer(msg) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }, (r) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(r || { ok: true });
      }
    });
  });
}

// ── Fetch audio stream URL from local backend (with auto-retry) ──────────────
async function getStreamUrl(videoId) {
  const maxAttempts = 5;
  const retryDelay  = 2000; // ms between retries

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/stream?v=${encodeURIComponent(videoId)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { error: err.error || `Server error HTTP ${res.status}` };
      }
      return await res.json(); // { url, title, duration }
    } catch (e) {
      if (attempt < maxAttempts) {
        // Backend may still be starting up — wait and retry
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        return { error: `Backend not reachable after ${maxAttempts} attempts. Try restarting your PC.` };
      }
    }
  }
}

// ── Single unified message listener ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Messages FROM offscreen going TO popup — forward and done
  if (msg.type === 'PLAYER_STATE' || msg.type === 'PLAYER_ERROR' || msg.type === 'MEDIA_KEY') {
    chrome.runtime.sendMessage({ ...msg, target: 'popup' }).catch(() => {});
    return false;
  }

  // Messages FROM popup — handle async
  (async () => {
    try {
      if (msg.cmd === 'PLAY_VIDEO') {
        const data = await getStreamUrl(msg.videoId);
        if (data.error) {
          sendResponse({ ok: false, error: data.error });
          return;
        }
        // Pass title/artist/thumb so offscreen can update the Windows media overlay
        const result = await toPlayer({
          cmd:   'PLAY_URL',
          url:   data.url,
          title: msg.title  || data.title || '',
          artist: msg.artist || '',
          thumb: msg.thumb  || '',
        });
        sendResponse({
          ok: result.ok,
          error: result.error,
          title: data.title,
          duration: data.duration,
        });
        return;
      }

      // PAUSE, RESUME, SET_VOLUME, MUTE, SEEK, GET_STATE → straight to player
      const result = await toPlayer(msg);
      sendResponse(result);

    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // keep message channel open for async response
});

// Pre-warm offscreen on install/startup
chrome.runtime.onInstalled.addListener(() => ensureOffscreen());
chrome.runtime.onStartup.addListener(() => ensureOffscreen());
