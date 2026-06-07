/**
 * MusicFlow — background.js (v8 MPV Edition)
 * Two playback modes:
 *   1. MPV mode  — /play endpoint → MPV handles stream extraction + playback
 *   2. Legacy    — /stream endpoint → yt-dlp URL → offscreen <audio>
 *
 * MPV mode is tried first. If MPV isn't running, falls back to legacy.
 */

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const BACKEND       = 'http://127.0.0.1:7842';

let _useMPV = true;   // detected on first play attempt

// ── Offscreen document (legacy fallback) ──────────────────────────────────────
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

async function toPlayer(msg) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(r || { ok: true });
    });
  });
}

// ── MPV playback ───────────────────────────────────────────────────────────────
async function playViaMPV(videoId, title, artist, thumb) {
  try {
    const res = await fetch(
      `${BACKEND}/play?v=${encodeURIComponent(videoId)}&title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'MPV play failed');
    return { ok: true, duration: data.duration || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Legacy stream URL fetch ────────────────────────────────────────────────────
async function getStreamUrl(videoId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BACKEND}/stream?v=${encodeURIComponent(videoId)}`,
        { signal: AbortSignal.timeout(25000) });
      if (!res.ok) return { error: `Server error ${res.status}` };
      return await res.json();
    } catch (e) {
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
      else return { error: 'Backend not reachable' };
    }
  }
}

// ── MPV state polling (replaces offscreen GET_STATE) ─────────────────────────
async function getMPVState() {
  try {
    const res = await fetch(`${BACKEND}/state`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Message listener ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'PLAYER_STATE' || msg.type === 'PLAYER_ERROR' || msg.type === 'MEDIA_KEY') {
    chrome.runtime.sendMessage({ ...msg, target: 'popup' }).catch(() => {});
    return false;
  }

  (async () => {
    try {

      if (msg.cmd === 'PLAY_VIDEO') {
        // Try MPV first
        if (_useMPV) {
          const mpvResult = await playViaMPV(msg.videoId, msg.title, msg.artist, msg.thumb);
          if (mpvResult.ok) {
            sendResponse({ ok: true, duration: mpvResult.duration });
            // Start MPV state polling to forward events to popup
            startMPVPolling();
            return;
          }
          // MPV failed — fall back to legacy mode
          _useMPV = false;
        }

        // Legacy: yt-dlp URL → offscreen audio
        const data = await getStreamUrl(msg.videoId);
        if (data.error) { sendResponse({ ok: false, error: data.error }); return; }
        const result = await toPlayer({
          cmd: 'PLAY_URL', url: data.url,
          title: msg.title || '', artist: msg.artist || '', thumb: msg.thumb || '',
        });
        sendResponse({ ok: result.ok, error: result.error, duration: data.duration });
        return;
      }

      if (msg.cmd === 'PAUSE') {
        if (_useMPV) await fetch(`${BACKEND}/pause`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        else await toPlayer({ cmd: 'PAUSE' });
        sendResponse({ ok: true });
        return;
      }

      if (msg.cmd === 'RESUME') {
        if (_useMPV) await fetch(`${BACKEND}/resume`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        else await toPlayer({ cmd: 'RESUME' });
        sendResponse({ ok: true });
        return;
      }

      if (msg.cmd === 'SET_VOLUME') {
        if (_useMPV) await fetch(`${BACKEND}/volume?v=${msg.vol}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        else await toPlayer({ cmd: 'SET_VOLUME', vol: msg.vol });
        sendResponse({ ok: true });
        return;
      }

      if (msg.cmd === 'MUTE') {
        if (_useMPV) await fetch(`${BACKEND}/mute?m=${msg.muted}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        else await toPlayer({ cmd: 'MUTE', muted: msg.muted });
        sendResponse({ ok: true });
        return;
      }

      if (msg.cmd === 'SEEK') {
        if (_useMPV) await fetch(`${BACKEND}/seek?t=${msg.time}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
        else await toPlayer({ cmd: 'SEEK', time: msg.time });
        sendResponse({ ok: true });
        return;
      }

      if (msg.cmd === 'GET_STATE') {
        if (_useMPV) {
          const s = await getMPVState();
          if (s) {
            sendResponse({ ok: true, state: { cur: s.cur, dur: s.dur, paused: s.paused } });
            return;
          }
        }
        const result = await toPlayer({ cmd: 'GET_STATE' });
        sendResponse(result);
        return;
      }

      // All other commands → player
      const result = await toPlayer(msg);
      sendResponse(result);

    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});

// ── MPV state polling — forwards ended/playing/paused events to popup ─────────
let _pollTimer = null;
let _lastIdle  = true;

function startMPVPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    const s = await getMPVState();
    if (!s) return;

    // Detect song ended
    if (s.idle && !_lastIdle) {
      chrome.runtime.sendMessage({ type: 'PLAYER_STATE', state: 'ended', target: 'popup' }).catch(() => {});
    }
    _lastIdle = s.idle;

    // Forward play/pause state
    if (!s.idle) {
      const state = s.paused ? 'paused' : 'playing';
      chrome.runtime.sendMessage({ type: 'PLAYER_STATE', state, target: 'popup' }).catch(() => {});
    }
  }, 2000);
}

// ── Check if MPV is available on startup ──────────────────────────────────────
async function detectMPV() {
  try {
    const res = await fetch(`${BACKEND}/ping`, { signal: AbortSignal.timeout(3000) });
    const d = await res.json();
    _useMPV = d.mpv === true;
  } catch {
    _useMPV = false;
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureOffscreen(); detectMPV(); });
chrome.runtime.onStartup.addListener(() => { ensureOffscreen(); detectMPV(); });
