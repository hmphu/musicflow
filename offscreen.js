/**
 * MusicFlow — offscreen.js
 * Plays audio via a plain <audio> element.
 * Stream URLs come from the local Python backend (yt-dlp).
 * Media Session API controls the Windows overlay (title, artwork, prev/next buttons).
 */

const audio = document.getElementById('player');
let currentVolume = 80;

// ── Media Session — controls Windows/OS media overlay ────────────────────────
// Sets up action handlers so the overlay's prev/next/play/pause buttons work
function setupMediaSession(title, artist, thumb) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  title  || 'MusicFlow',
    artist: artist || '',
    artwork: thumb ? [{ src: thumb, sizes: '96x96', type: 'image/jpeg' }] : [],
  });

  // Wire overlay buttons → forward commands to background → popup handles them
  navigator.mediaSession.setActionHandler('play',           () => audio.play());
  navigator.mediaSession.setActionHandler('pause',          () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack',  () => {
    chrome.runtime.sendMessage({ type: 'MEDIA_KEY', key: 'prev' }).catch(() => {});
  });
  navigator.mediaSession.setActionHandler('nexttrack',      () => {
    chrome.runtime.sendMessage({ type: 'MEDIA_KEY', key: 'next' }).catch(() => {});
  });
  navigator.mediaSession.setActionHandler('seekbackward',   () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  navigator.mediaSession.setActionHandler('seekforward',    () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
}

// ── Audio element events → forward to popup via background ───────────────────
audio.addEventListener('ended', () => {
  chrome.runtime.sendMessage({ type: 'PLAYER_STATE', state: 'ended' }).catch(() => {});
});
audio.addEventListener('playing', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  chrome.runtime.sendMessage({ type: 'PLAYER_STATE', state: 'playing' }).catch(() => {});
});
audio.addEventListener('pause', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  chrome.runtime.sendMessage({ type: 'PLAYER_STATE', state: 'paused' }).catch(() => {});
});
audio.addEventListener('error', () => {
  chrome.runtime.sendMessage({ type: 'PLAYER_ERROR', code: audio.error?.code }).catch(() => {});
});
audio.addEventListener('waiting', () => {
  chrome.runtime.sendMessage({ type: 'PLAYER_STATE', state: 'buffering' }).catch(() => {});
});

// ── Message handler from background.js ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  switch (msg.cmd) {

    case 'PLAY_URL':
      audio.src = msg.url;
      audio.volume = currentVolume / 100;
      audio.currentTime = 0;
      // Update Windows media overlay with song info
      setupMediaSession(msg.title, msg.artist, msg.thumb);
      audio.play()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'PAUSE':
      audio.pause();
      sendResponse({ ok: true });
      break;

    case 'RESUME':
      audio.play()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SET_VOLUME':
      currentVolume = Math.max(0, Math.min(100, msg.vol));
      audio.volume = currentVolume / 100;
      sendResponse({ ok: true });
      break;

    case 'MUTE':
      audio.muted = msg.muted;
      sendResponse({ ok: true });
      break;

    case 'SEEK':
      audio.currentTime = msg.time;
      sendResponse({ ok: true });
      break;

    case 'GET_STATE':
      sendResponse({
        ok: true,
        state: {
          cur:    audio.currentTime,
          dur:    isFinite(audio.duration) ? audio.duration : 0,
          paused: audio.paused,
          ended:  audio.ended,
          vol:    currentVolume,
        },
      });
      break;

    default:
      sendResponse({ ok: false, reason: 'unknown cmd' });
  }

  return true;
});
