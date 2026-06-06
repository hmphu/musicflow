/**
 * MusicFlow — popup.js v7
 * Features: search suggestions, playlist save/load, lyrics, hotkeys
 */

// API key kept only as fallback reference — not used for search or suggestions
const YT_API_KEY = 'REMOVED';

let queue        = [];
let currentIndex = -1;
let isPlaying    = false;
let isShuffle    = false;
let isRepeat     = false;
let isMuted      = false;
let savedVolume  = 80;
let progressTimer = null;
let suggestTimer  = null;
let activeSuggestion = -1;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const searchInput     = $('searchInput');
const searchBtn       = $('searchBtn');
const suggestions     = $('suggestions');
const resultsList     = $('resultsList');
const loadingSpinner  = $('loadingSpinner');
const errorMsg        = $('errorMsg');
const chips           = document.querySelectorAll('.chip');
const playPauseBtn    = $('playPauseBtn');
const playIcon        = $('playIcon');
const pauseIcon       = $('pauseIcon');
const prevBtn         = $('prevBtn');
const nextBtn         = $('nextBtn');
const shuffleBtn      = $('shuffleBtn');
const repeatBtn       = $('repeatBtn');
const muteBtn         = $('muteBtn');
const trackTitle      = $('trackTitle');
const trackArtist     = $('trackArtist');
const trackThumb      = $('trackThumb');
const progressRange   = $('progressRange');
const progressFill    = $('progressFill');
const currentTimeEl   = $('currentTime');
const totalTimeEl     = $('totalTime');
const volumeSlider    = $('volumeSlider');
const volumeFill      = $('volumeFill');
const volumeLabel     = $('volumeLabel');
const volPresets      = document.querySelectorAll('.vol-preset');
const playlistBtn     = $('playlistBtn');
const playlistPanel   = $('playlistPanel');
const closePanelBtn   = $('closePanelBtn');
const savePlaylistBtn = $('savePlaylistBtn');
const playlistList    = $('playlistList');
const lyricsBtn       = $('lyricsBtn');
const lyricsPanel     = $('lyricsPanel');
const closeLyricsBtn  = $('closeLyricsBtn');
const lyricsContent   = $('lyricsContent');
const lyricsTitle     = $('lyricsTitle');
const addToPlaylistBtn = $('addToPlaylistBtn');
const saveModal       = $('saveModal');
const playlistNameInput = $('playlistNameInput');
const modalSaveBtn    = $('modalSaveBtn');
const modalCancelBtn  = $('modalCancelBtn');
const upnextBtn       = $('upnextBtn');
const upnextPanel     = $('upnextPanel');
const upnextList      = $('upnextList');
const closeUpnextBtn  = $('closeUpnextBtn');
const loadUrlBtn      = $('loadUrlBtn');
const urlLoader       = $('urlLoader');
const urlInput        = $('urlInput');
const urlLoadBtn      = $('urlLoadBtn');

// ── Messaging ─────────────────────────────────────────────────────────────────
function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => {
      resolve(chrome.runtime.lastError ? { ok: false } : (r || { ok: true }));
    });
  });
}

// ── Listen for pushed state from background ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'popup') return;
  if (msg.type === 'PLAYER_STATE') {
    if (msg.state === 'ended' || msg.state === 0) {
      stopProgress(); setPlayUI(false);
      if (isRepeat) playTrack(currentIndex); else playNext();
    } else if (msg.state === 'playing' || msg.state === 1) {
      setPlayUI(true); startProgress();
    } else if (msg.state === 'paused' || msg.state === 2) {
      setPlayUI(false);
    }
  }
  // Windows media overlay prev/next buttons
  if (msg.type === 'MEDIA_KEY') {
    if (msg.key === 'next') playNext();
    if (msg.key === 'prev') playPrev();
  }
});

// ── Progress polling ──────────────────────────────────────────────────────────
function startProgress() {
  stopProgress();
  progressTimer = setInterval(async () => {
    const r = await send({ cmd: 'GET_STATE' });
    if (!r.ok || !r.state) return;
    const { cur, dur } = r.state;
    if (dur > 0) {
      const pct = (cur / dur) * 100;
      progressFill.style.width = pct + '%';
      progressRange.value = pct;
      currentTimeEl.textContent = fmt(cur);
      totalTimeEl.textContent   = fmt(dur);
      progressRange.dataset.dur = dur;
    }
  }, 2000);
}
function stopProgress() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

// ── Playback ──────────────────────────────────────────────────────────────────
async function playTrack(index) {
  if (index < 0 || index >= queue.length) return;
  currentIndex = index;
  const t = queue[index];

  trackTitle.textContent  = t.title;
  trackArtist.textContent = t.channel;
  trackThumb.src = t.thumb;
  trackThumb.onerror = () => { trackThumb.src = ''; };
  progressFill.style.width = '0%';
  progressRange.value = 0;
  currentTimeEl.textContent = '0:00';
  totalTimeEl.textContent   = '0:00';
  document.querySelectorAll('.result-item')
    .forEach((el, i) => el.classList.toggle('playing', i === index));

  setPlayUI(true);
  showError('Connecting...', '#1db954');

  const res = await send({ cmd: 'PLAY_VIDEO', videoId: t.id, title: t.title, artist: t.channel, thumb: t.thumb });
  if (!res.ok) {
    setPlayUI(false);
    showError(res.error || 'Playback failed.');
    return;
  }
  if (res.duration && res.duration > 0) {
    progressRange.dataset.dur = res.duration;
    totalTimeEl.textContent = fmt(res.duration);
  }
  await send({ cmd: 'SET_VOLUME', vol: savedVolume });
  if (isMuted) await send({ cmd: 'MUTE', muted: true });
  clearError();
  startProgress();

  // Save current track state so we can restore on popup reopen
  chrome.storage.local.set({
    mf_nowplaying: { title: t.title, channel: t.channel, thumb: t.thumb, id: t.id }
  });

  // Pre-load radio queue in background so Next is instant (uses yt-dlp, no API quota)
  if (!radioQueue.length) loadRadioQueue(t.id);

  // Auto-fetch lyrics if lyrics panel is open
  if (!lyricsPanel.classList.contains('hidden')) fetchLyrics(t.title, t.channel);
}

// ── Smart Shuffle handled inline in playNext() ────────────────────────────────
// ── Played history — never repeat ────────────────────────────────────────────
const playedIds = new Set();

// ── Radio queue — pre-loaded related songs from yt-dlp (zero API quota) ──────
let radioQueue = [];

async function loadRadioQueue(videoId) {
  radioQueue = [];
  try {
    const res = await fetch(`http://127.0.0.1:7842/radio?v=${encodeURIComponent(videoId)}`);
    if (!res.ok) return;
    const data = await res.json();
    // Filter out anything already played
    radioQueue = (data.tracks || []).filter(t => !playedIds.has(t.id));
  } catch {}
}

// ── Next / Prev — simple, instant, always works ──────────────────────────────
function playNext() {
  if (isShuffle) {
    if (queue.length <= 1) return;
    let n;
    do { n = Math.floor(Math.random() * queue.length); } while (n === currentIndex);
    playTrack(n);
    return;
  }

  // If there's a next item in queue, play it
  if (currentIndex < queue.length - 1) {
    playTrack(currentIndex + 1);
    return;
  }

  // Queue exhausted — pull from radioQueue
  if (radioQueue.length) {
    const next = radioQueue.shift();
    queue.push(next);
    renderList();
    playTrack(queue.length - 1);
    return;
  }

  // Nothing left — wrap back to start
  if (queue.length) playTrack(0);
}

function playPrev() {
  if (!queue.length) return;
  const dur = parseFloat(progressRange.dataset.dur || 0);
  const cur = dur * parseFloat(progressRange.value) / 100;
  // If more than 3s into song, restart it; otherwise go back
  if (cur > 3) { send({ cmd: 'SEEK', time: 0 }); return; }
  const prevIdx = currentIndex - 1;
  if (prevIdx >= 0) playTrack(prevIdx);
  else playTrack(0); // already at first, restart it
}

async function togglePlay() {
  if (currentIndex === -1) { if (queue.length) playTrack(0); return; }
  if (isPlaying) {
    await send({ cmd: 'PAUSE' });
    setPlayUI(false); stopProgress();
  } else {
    await send({ cmd: 'RESUME' });
    setPlayUI(true); startProgress();
  }
}

// ── Volume ────────────────────────────────────────────────────────────────────
function setVol(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  savedVolume = v;
  volumeSlider.value = v;
  volumeFill.style.width = v + '%';
  volumeLabel.textContent = v;
  isMuted = (v === 0);
  send({ cmd: 'SET_VOLUME', vol: v });
  send({ cmd: 'MUTE', muted: isMuted });
  updateVolIcon(isMuted);
  localStorage.setItem('mf_vol', v);
}
function toggleMute() {
  isMuted = !isMuted;
  send({ cmd: 'MUTE', muted: isMuted });
  updateVolIcon(isMuted);
  if (!isMuted) send({ cmd: 'SET_VOLUME', vol: savedVolume });
}

// ── Search — via backend yt-dlp (ZERO API quota) ─────────────────────────────
const searchCache = new Map();
const CACHE_TTL   = 30 * 60 * 1000; // 30 min

async function search(query) {
  if (!query.trim()) return;
  hideSuggestions();
  showLoading(true); clearError(); resultsList.innerHTML = '';
  chips.forEach(x => x.classList.remove('active'));
  playedIds.clear();
  radioQueue = [];

  // Return cached result if fresh
  const cached = searchCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    queue = [...cached.queue];
    renderList();
    showLoading(false);
    return;
  }

  try {
    // Use backend — no YouTube API key needed, no quota
    const res = await fetch(
      `http://127.0.0.1:7842/search?q=${encodeURIComponent(query)}`
    );
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.tracks?.length) { showError('No results found.'); showLoading(false); return; }

    queue = data.tracks;
    searchCache.set(query.toLowerCase(), { queue: [...queue], timestamp: Date.now() });
    renderList();
    showLoading(false);

    // Pre-warm the first result's stream URL in the background (makes first click instant)
    if (queue.length > 0) {
      fetch(`http://127.0.0.1:7842/stream?v=${encodeURIComponent(queue[0].id)}`).catch(() => {});
    }
  } catch(err) {
    showLoading(false);
    showError(`Error: ${err.message}`);
  }
}

// ── Search Suggestions — via backend (zero API quota) ────────────────────────
const NON_MUSIC_WORDS = /\b(tutorial|lesson|how to|reaction|review|podcast|interview|trailer|gameplay|unboxing|vlog|comedy|news|documentary|lecture|workout|meditation|asmr|cover by|covered by|tribute|karaoke version)\b/i;

function cleanSongTitle(raw) {
  return raw
    .replace(/\(Official.*?\)/gi, '').replace(/\[Official.*?\]/gi, '')
    .replace(/\(.*?Video.*?\)/gi, '').replace(/\[.*?Video.*?\]/gi, '')
    .replace(/\(.*?Audio.*?\)/gi, '').replace(/\[.*?Audio.*?\]/gi, '')
    .replace(/\(.*?Lyric.*?\)/gi, '').replace(/\[.*?Lyric.*?\]/gi, '')
    .replace(/\(.*?HD.*?\)/gi,   '').replace(/\[.*?HD.*?\]/gi,   '')
    .replace(/\(.*?4K.*?\)/gi,   '').replace(/VEVO$/i, '')
    .replace(/\s{2,}/g, ' ').trim();
}

async function fetchSuggestions(query) {
  if (!query.trim()) { hideSuggestions(); return; }
  try {
    // Use backend yt-dlp search — costs ZERO API quota
    const res = await fetch(
      `http://127.0.0.1:7842/suggest?q=${encodeURIComponent(query)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const seen = new Set();
    const items = (data.suggestions || [])
      .filter(t => t && !NON_MUSIC_WORDS.test(t))
      .map(t => cleanSongTitle(t))
      .filter(t => { if (!t || seen.has(t.toLowerCase())) return false; seen.add(t.toLowerCase()); return true; })
      .slice(0, 6);
    showSuggestions(items, query);
  } catch {
    // Backend not reachable — show nothing, don't fall back to API
    hideSuggestions();
  }
}

function showSuggestions(items, query) {
  if (!items.length) { hideSuggestions(); return; }
  suggestions.innerHTML = '';
  activeSuggestion = -1;
  items.forEach(text => {
    const li = document.createElement('li');
    li.className = 'suggestion-item';
    li.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
      </svg>
      <span>${esc(text)}</span>`;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur before click
      searchInput.value = text;
      hideSuggestions();
      search(text);
    });
    suggestions.appendChild(li);
  });
  suggestions.classList.remove('hidden');
}

function hideSuggestions() {
  suggestions.classList.add('hidden');
  activeSuggestion = -1;
}

function navigateSuggestions(dir) {
  const items = suggestions.querySelectorAll('.suggestion-item');
  if (!items.length) return;
  items[activeSuggestion]?.classList.remove('active');
  activeSuggestion = (activeSuggestion + dir + items.length) % items.length;
  items[activeSuggestion]?.classList.add('active');
  searchInput.value = items[activeSuggestion]?.querySelector('span')?.textContent || searchInput.value;
}

// ── Lyrics ────────────────────────────────────────────────────────────────────
async function fetchLyrics(title, artist) {
  lyricsTitle.textContent = 'Lyrics';
  lyricsContent.innerHTML = '<div class="lyrics-loading">Fetching lyrics...</div>';

  // Clean up title — strip "(Official Video)", "[HD]", etc.
  const cleanTitle  = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  const cleanArtist = artist.replace(/VEVO|Official|Music/gi, '').trim();

  try {
    const res = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(cleanArtist)}/${encodeURIComponent(cleanTitle)}`
    );
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    if (!data.lyrics) throw new Error('No lyrics');
    lyricsTitle.textContent = cleanTitle;
    lyricsContent.innerHTML = `<div class="lyrics-text">${esc(data.lyrics)}</div>`;
  } catch {
    lyricsContent.innerHTML = '<div class="lyrics-error">Lyrics not found for this track.</div>';
  }
}

// ── Playlists ─────────────────────────────────────────────────────────────────
async function loadPlaylists() {
  const { mf_playlists = {} } = await chrome.storage.local.get('mf_playlists');
  return mf_playlists;
}
async function savePlaylists(playlists) {
  await chrome.storage.local.set({ mf_playlists: playlists });
}

async function renderPlaylists() {
  const playlists = await loadPlaylists();
  const keys = Object.keys(playlists);
  playlistList.innerHTML = '';

  if (!keys.length) {
    playlistList.innerHTML = '<div class="playlist-empty">No playlists yet. Search for songs and save a queue!</div>';
    return;
  }

  keys.forEach(name => {
    const tracks = playlists[name];
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.innerHTML = `
      <div class="playlist-item-info">
        <div class="playlist-item-name">${esc(name)}</div>
        <div class="playlist-item-count">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="playlist-item-actions">
        <button class="btn-del" title="Delete">🗑</button>
      </div>`;
    // Load playlist on click (not on delete)
    li.querySelector('.playlist-item-info').addEventListener('click', () => {
      queue = [...tracks];
      currentIndex = -1;
      renderList();
      playlistPanel.classList.add('hidden');
      playTrack(0);
    });
    li.querySelector('.btn-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const pl = await loadPlaylists();
      delete pl[name];
      await savePlaylists(pl);
      renderPlaylists();
    });
    playlistList.appendChild(li);
  });
}

function openSaveModal() {
  if (!queue.length) return;
  playlistNameInput.value = '';
  saveModal.classList.remove('hidden');
  playlistNameInput.focus();
}

async function confirmSavePlaylist() {
  const name = playlistNameInput.value.trim();
  if (!name || !queue.length) return;
  const pl = await loadPlaylists();
  pl[name] = [...queue];
  await savePlaylists(pl);
  saveModal.classList.add('hidden');
  renderPlaylists();
}

// Add currently playing track to a playlist
async function addCurrentToPlaylist() {
  if (currentIndex === -1) return;
  const t = queue[currentIndex];
  openSaveModal();
  // prefill with track name
  playlistNameInput.value = t.title.slice(0, 30);
}

// ── Load from YouTube URL (radio mix, playlist, single video) ────────────────
async function loadFromUrl(url) {
  if (!url.trim()) return;
  urlLoadBtn.textContent = 'Loading...';
  urlLoadBtn.disabled = true;

  try {
    const res = await fetch(
      `http://127.0.0.1:7842/playlist?url=${encodeURIComponent(url.trim())}`
    );
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed to load');

    if (!data.tracks?.length) throw new Error('No tracks found');

    // Replace queue with loaded tracks
    queue = data.tracks;
    currentIndex = -1;
    playedIds.clear();
    radioQueue = [];
    renderList();
    playlistPanel.classList.add('hidden');
    urlInput.value = '';
    urlLoader.classList.add('hidden');
    playTrack(0);  // auto-play first track

  } catch (err) {
    showError(`Failed: ${err.message}`, '#ff6b6b');
    setTimeout(clearError, 3000);
  } finally {
    urlLoadBtn.textContent = 'Load';
    urlLoadBtn.disabled = false;
  }
}
function renderUpNext() {
  upnextList.innerHTML = '';

  // Currently playing
  if (currentIndex >= 0 && queue[currentIndex]) {
    const cur = queue[currentIndex];
    const nowLi = document.createElement('li');
    nowLi.className = 'playlist-item upnext-now';
    nowLi.innerHTML = `
      <div class="upnext-label">NOW PLAYING</div>
      <div class="playlist-item-info">
        <div class="playlist-item-name">${esc(cur.title)}</div>
        <div class="playlist-item-count">${esc(cur.channel)}</div>
      </div>`;
    upnextList.appendChild(nowLi);
  }

  // Show remaining items from search queue first
  const queueUpcoming = queue.slice(currentIndex + 1);
  // Then radio queue
  const radioUpcoming = radioQueue.slice(0, Math.max(0, 15 - queueUpcoming.length));
  const upcoming = [...queueUpcoming, ...radioUpcoming];

  if (!upcoming.length) {
    const empty = document.createElement('li');
    empty.className = 'playlist-empty';
    empty.textContent = 'No more tracks queued.';
    upnextList.appendChild(empty);
    return;
  }

  upcoming.forEach((t, i) => {
    const isFromQueue = i < queueUpcoming.length;
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.innerHTML = `
      <div class="upnext-num">${i + 1}</div>
      <img class="upnext-thumb" src="${esc(t.thumb)}" alt="" />
      <div class="playlist-item-info">
        <div class="playlist-item-name">${esc(t.title)}</div>
        <div class="playlist-item-count">${esc(t.channel)}</div>
      </div>`;
    li.addEventListener('click', () => {
      if (isFromQueue) {
        const qIdx = currentIndex + 1 + i;
        upnextPanel.classList.add('hidden');
        playTrack(qIdx);
      } else {
        const radioIdx = i - queueUpcoming.length;
        const track = radioQueue.splice(radioIdx, 1)[0];
        queue.push(track);
        renderList();
        upnextPanel.classList.add('hidden');
        playTrack(queue.length - 1);
      }
    });
    upnextList.appendChild(li);
  });
}
function parseDur(iso) {
  if (!iso) return '';
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h=parseInt(m[1]||0), mn=parseInt(m[2]||0), s=parseInt(m[3]||0);
  return h>0 ? `${h}:${String(mn).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${mn}:${String(s).padStart(2,'0')}`;
}
function renderList() {
  resultsList.innerHTML = '';
  queue.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'result-item' + (i === currentIndex ? ' playing' : '');
    li.innerHTML = `
      <img class="result-thumb" src="${esc(t.thumb)}" alt="" loading="lazy"/>
      <div class="result-meta">
        <div class="result-title">${esc(t.title)}</div>
        <div class="result-channel">${esc(t.channel)}</div>
      </div>
      ${t.dur ? `<span class="result-duration">${t.dur}</span>` : ''}
      <span class="play-indicator">▶</span>`;
    li.addEventListener('click', () => playTrack(i));
    resultsList.appendChild(li);
  });
}
function fmt(s) { s=Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showLoading(v) { loadingSpinner.classList.toggle('hidden', !v); }
function showError(msg, color) { errorMsg.textContent=msg; errorMsg.style.color=color||'#ff6b6b'; errorMsg.classList.remove('hidden'); }
function clearError() { errorMsg.textContent=''; errorMsg.classList.add('hidden'); }
function setPlayUI(v) { isPlaying=v; playIcon.classList.toggle('hidden',v); pauseIcon.classList.toggle('hidden',!v); }
function updateVolIcon(muted) {
  $('volIcon').innerHTML = muted
    ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
}

// ── Keyboard Hotkeys ──────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't fire hotkeys when typing in inputs
  if (e.target.tagName === 'INPUT') {
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateSuggestions(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); navigateSuggestions(-1); }
    if (e.key === 'Escape')    { hideSuggestions(); }
    return;
  }
  switch (e.code) {
    case 'Space':     e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': e.preventDefault(); playNext(); break;
    case 'ArrowLeft':  e.preventDefault(); playPrev(); break;
    case 'KeyM':      toggleMute(); break;
  }
});

// ── Events ────────────────────────────────────────────────────────────────────
searchBtn.addEventListener('click', () => { hideSuggestions(); search(searchInput.value); });

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { hideSuggestions(); search(searchInput.value); }
});

searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (!q) { hideSuggestions(); return; }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 350); // debounce 350ms
});

searchInput.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 150); // slight delay so mousedown fires first
});

chips.forEach(c => c.addEventListener('click', () => {
  chips.forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  search(c.dataset.query);
}));

playPauseBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrev);
nextBtn.addEventListener('click', playNext);
shuffleBtn.addEventListener('click', () => { isShuffle=!isShuffle; shuffleBtn.classList.toggle('active',isShuffle); });
repeatBtn.addEventListener('click',  () => { isRepeat=!isRepeat;   repeatBtn.classList.toggle('active',isRepeat); });
muteBtn.addEventListener('click', toggleMute);
volumeSlider.addEventListener('input', e => setVol(parseInt(e.target.value)));
volPresets.forEach(b => b.addEventListener('click', () => setVol(parseInt(b.dataset.vol))));
progressRange.addEventListener('input', e => {
  const dur = parseFloat(progressRange.dataset.dur || 0);
  if (dur) send({ cmd: 'SEEK', time: (parseFloat(e.target.value)/100)*dur });
});

// Playlists
playlistBtn.addEventListener('click', () => {
  lyricsPanel.classList.add('hidden');
  upnextPanel.classList.add('hidden');
  playlistPanel.classList.toggle('hidden');
  if (!playlistPanel.classList.contains('hidden')) renderPlaylists();
});
closePanelBtn.addEventListener('click', () => playlistPanel.classList.add('hidden'));
savePlaylistBtn.addEventListener('click', openSaveModal);
addToPlaylistBtn.addEventListener('click', addCurrentToPlaylist);
modalSaveBtn.addEventListener('click', confirmSavePlaylist);
modalCancelBtn.addEventListener('click', () => saveModal.classList.add('hidden'));
playlistNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmSavePlaylist(); });

// Load from URL
loadUrlBtn.addEventListener('click', () => urlLoader.classList.toggle('hidden'));
urlLoadBtn.addEventListener('click', () => loadFromUrl(urlInput.value));
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadFromUrl(urlInput.value); });

// Lyrics
lyricsBtn.addEventListener('click', () => {
  playlistPanel.classList.add('hidden');
  upnextPanel.classList.add('hidden');
  lyricsPanel.classList.toggle('hidden');
  if (!lyricsPanel.classList.contains('hidden') && currentIndex >= 0) {
    const t = queue[currentIndex];
    fetchLyrics(t.title, t.channel);
  }
});
closeLyricsBtn.addEventListener('click', () => lyricsPanel.classList.add('hidden'));

// Up Next
upnextBtn.addEventListener('click', () => {
  playlistPanel.classList.add('hidden');
  lyricsPanel.classList.add('hidden');
  upnextPanel.classList.toggle('hidden');
  if (!upnextPanel.classList.contains('hidden')) renderUpNext();
});
closeUpnextBtn.addEventListener('click', () => upnextPanel.classList.add('hidden'));

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Restore volume
  const vol = parseInt(localStorage.getItem('mf_vol') || '80');
  savedVolume = vol;
  volumeSlider.value = vol;
  volumeFill.style.width = vol + '%';
  volumeLabel.textContent = vol;

  // Restore now-playing display from storage (survives popup close/reopen)
  const { mf_nowplaying } = await chrome.storage.local.get('mf_nowplaying');
  if (mf_nowplaying) {
    trackTitle.textContent  = mf_nowplaying.title   || 'No track selected';
    trackArtist.textContent = mf_nowplaying.channel || '—';
    if (mf_nowplaying.thumb) trackThumb.src = mf_nowplaying.thumb;

    // Fetch current playback position from the offscreen player
    const state = await send({ cmd: 'GET_STATE' });
    if (state.ok && state.state) {
      const { cur, dur, paused } = state.state;
      if (dur > 0) {
        const pct = (cur / dur) * 100;
        progressFill.style.width = pct + '%';
        progressRange.value = pct;
        progressRange.dataset.dur = dur;
        currentTimeEl.textContent = fmt(cur);
        totalTimeEl.textContent   = fmt(dur);
      }
      // If it was playing, resume progress polling and update play button
      if (!paused) {
        setPlayUI(true);
        startProgress();
      } else {
        setPlayUI(false);
      }
    }
  }

  search('top hits 2025');
})();
