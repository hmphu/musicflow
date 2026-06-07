'use strict';

const HF = 'https://sumit9922-musicflow-backend.hf.space';

let queue = [], idx = -1, isShuffle = false, isRepeat = false;
let vol = parseInt(localStorage.getItem('mf_vol') || '80');
let sugTimer = null;
const cache = new Map();

const audio = document.getElementById('audioEl');
const $ = id => document.getElementById(id);

// ── Search ────────────────────────────────────────────────────────────────────
async function search(q) {
  q = q.trim(); if (!q) return;
  hideSug();
  $('spinner').classList.remove('hidden');
  showErr('Searching…', '#1db954');
  $('resultsList').innerHTML = '';
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));

  const key = q.toLowerCase();
  if (cache.has(key)) {
    queue = [...cache.get(key)];
    renderList();
    $('spinner').classList.add('hidden');
    hideErr();
    return;
  }

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(`${HF}/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('Server error ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!d.tracks?.length) { showErr('No results.'); $('spinner').classList.add('hidden'); return; }
    queue = d.tracks;
    if (cache.size > 30) cache.clear();
    cache.set(key, [...queue]);
    renderList();
    hideErr();
  } catch(e) {
    showErr(e.name === 'AbortError' ? 'Search timed out — try again' : 'Search failed: ' + e.message);
  }
  $('spinner').classList.add('hidden');
}

// ── Play ──────────────────────────────────────────────────────────────────────
async function play(i) {
  if (i < 0 || i >= queue.length) return;
  idx = i;
  const t = queue[i];
  $('trackTitle').textContent  = t.title;
  $('trackArtist').textContent = t.channel || '—';
  $('trackThumb').src = t.thumb || '';
  $('totTime').textContent = t.dur || '0:00';
  $('curTime').textContent = '0:00';
  $('progFill').style.width = '0%';
  document.querySelectorAll('.result-item').forEach((el, j) => el.classList.toggle('playing', j === i));
  setUI(true);
  showErr('Loading…', '#1db954');

  try {
    // 1. Get the stream URL from HF backend
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(`${HF}/stream?v=${encodeURIComponent(t.id)}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('Stream server error ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!d.url) throw new Error('No stream URL');

    // 2. Play via HF proxy — avoids CORS on googlevideo.com
    const proxyUrl = `${HF}/proxy?url=${encodeURIComponent(d.url)}`;
    audio.src = proxyUrl;
    audio.volume = vol / 100;
    audio.currentTime = 0;
    await audio.play();
    hideErr();
    mediaSession(t.title, t.channel, t.thumb);
    localStorage.setItem('mf_np', JSON.stringify(t));
    if (!$('lyricsSheet').classList.contains('hidden')) fetchLyrics(t.title, t.channel);
  } catch(e) {
    setUI(false);
    showErr('Failed: ' + e.message);
  }
}

function next() {
  if (!queue.length) return;
  if (isShuffle) { let n; do { n = Math.floor(Math.random()*queue.length); } while(queue.length>1&&n===idx); play(n); }
  else if (idx < queue.length - 1) play(idx + 1);
  else play(0);
}
function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  play(idx > 0 ? idx - 1 : 0);
}
function togglePlay() {
  if (idx === -1 && queue.length) { play(0); return; }
  audio.paused ? audio.play() : audio.pause();
}

// ── Audio events ──────────────────────────────────────────────────────────────
audio.addEventListener('ended',    () => { if (isRepeat) { audio.currentTime=0; audio.play(); } else next(); });
audio.addEventListener('playing',  () => setUI(true));
audio.addEventListener('pause',    () => setUI(false));
audio.addEventListener('error',    () => { showErr('Playback error'); setUI(false); });
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const p = (audio.currentTime / audio.duration) * 100;
  $('progFill').style.width = p + '%';
  $('progRange').value = p;
  $('progRange').dataset.dur = audio.duration;
  $('curTime').textContent = fmt(audio.currentTime);
  $('totTime').textContent = fmt(audio.duration);
});

// ── Media Session ─────────────────────────────────────────────────────────────
function mediaSession(title, artist, thumb) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist, artwork: thumb ? [{ src: thumb }] : [] });
  [['play', ()=>audio.play()], ['pause', ()=>audio.pause()], ['previoustrack', prev], ['nexttrack', next]]
    .forEach(([a,h]) => { try { navigator.mediaSession.setActionHandler(a, h); } catch {} });
}

// ── Suggestions ───────────────────────────────────────────────────────────────
async function fetchSug(q) {
  if (!q) { hideSug(); return; }
  try {
    const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const items = (d[1] || []).slice(0, 6);
    if (!items.length) { hideSug(); return; }
    const ul = $('suggestions');
    ul.innerHTML = '';
    items.forEach(text => {
      const li = document.createElement('li');
      li.className = 'sug-item';
      li.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg><span>${esc(text)}</span>`;
      const pick = () => { $('searchInput').value = text; hideSug(); search(text); };
      li.addEventListener('touchstart', e => { e.preventDefault(); pick(); }, { passive: false });
      li.addEventListener('mousedown',  e => { e.preventDefault(); pick(); });
      ul.appendChild(li);
    });
    ul.classList.remove('hidden');
  } catch { hideSug(); }
}
function hideSug() { $('suggestions').classList.add('hidden'); }

// ── Lyrics ────────────────────────────────────────────────────────────────────
async function fetchLyrics(title, artist) {
  $('lyricsTitle').textContent = 'Lyrics';
  $('lyricsBody').innerHTML = '<p class="dim">Fetching…</p>';
  const t = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  const a = (artist || '').replace(/VEVO|Official|Music|Topic/gi, '').trim();
  try {
    const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(a || t)}/${encodeURIComponent(t)}`);
    const d = await r.json();
    if (!d.lyrics) throw new Error();
    $('lyricsTitle').textContent = t;
    $('lyricsBody').textContent = d.lyrics;
  } catch { $('lyricsBody').innerHTML = '<p class="dim">Lyrics not found.</p>'; }
}

// ── Playlists ─────────────────────────────────────────────────────────────────
const getPL = () => JSON.parse(localStorage.getItem('mf_pl') || '{}');
const setPL = p => localStorage.setItem('mf_pl', JSON.stringify(p));

function renderPL() {
  const pl = getPL(), keys = Object.keys(pl), ul = $('playlistList');
  ul.innerHTML = '';
  if (!keys.length) { ul.innerHTML = '<li class="pl-empty">No playlists yet.</li>'; return; }
  keys.forEach(name => {
    const li = document.createElement('li');
    li.className = 'pl-item';
    li.innerHTML = `<div style="flex:1;min-width:0"><div class="pl-name">${esc(name)}</div><div class="pl-count">${pl[name].length} tracks</div></div><button class="pl-del">🗑</button>`;
    li.querySelector('div').addEventListener('click', () => { queue=[...pl[name]]; idx=-1; renderList(); $('playlistSheet').classList.add('hidden'); play(0); });
    li.querySelector('.pl-del').addEventListener('click', e => { e.stopPropagation(); const p=getPL(); delete p[name]; setPL(p); renderPL(); });
    ul.appendChild(li);
  });
}

// ── Volume ────────────────────────────────────────────────────────────────────
function setVol(v) {
  vol = Math.max(0, Math.min(100, v));
  audio.volume = vol / 100;
  $('volSlider').value = vol;
  $('volSlider').style.background = `linear-gradient(to right,var(--green) 0%,var(--green) ${vol}%,var(--bg3) ${vol}%,var(--bg3) 100%)`;
  localStorage.setItem('mf_vol', vol);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderList() {
  const ul = $('resultsList'); ul.innerHTML = '';
  queue.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'result-item' + (i === idx ? ' playing' : '');
    li.innerHTML = `<img class="r-thumb" src="${esc(t.thumb||'')}" loading="lazy"/><div class="r-meta"><div class="r-title">${esc(t.title)}</div><div class="r-channel">${esc(t.channel||'')}</div></div>${t.dur?`<span class="r-dur">${esc(t.dur)}</span>`:''}`;
    li.addEventListener('click', () => play(i));
    ul.appendChild(li);
  });
}
function fmt(s) { s=Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function setUI(v) { document.getElementById('playIcon').classList.toggle('hidden',v); document.getElementById('pauseIcon').classList.toggle('hidden',!v); }
function showErr(m, c) { const e=$('errMsg'); e.textContent=m; e.style.color=c||'#ff6b6b'; e.classList.remove('hidden'); }
function hideErr() { $('errMsg').classList.add('hidden'); }

// ── Events ────────────────────────────────────────────────────────────────────
$('searchBtn').addEventListener('click', () => search($('searchInput').value));
$('searchInput').addEventListener('keydown', e => { if (e.key==='Enter') { hideSug(); search($('searchInput').value); } });
$('searchInput').addEventListener('input', () => { clearTimeout(sugTimer); const q=$('searchInput').value.trim(); if(!q){hideSug();return;} sugTimer=setTimeout(()=>fetchSug(q),350); });
$('searchInput').addEventListener('blur', () => setTimeout(hideSug, 180));
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); search(c.dataset.query); }));
$('playBtn').addEventListener('click', togglePlay);
$('prevBtn').addEventListener('click', prev);
$('nextBtn').addEventListener('click', next);
$('shuffleBtn').addEventListener('click', () => { isShuffle=!isShuffle; $('shuffleBtn').classList.toggle('active',isShuffle); });
$('repeatBtn').addEventListener('click', () => { isRepeat=!isRepeat; $('repeatBtn').classList.toggle('active',isRepeat); });
$('volSlider').addEventListener('input', e => setVol(parseInt(e.target.value)));
$('progRange').addEventListener('input', e => { const d=parseFloat($('progRange').dataset.dur||0); if(d) audio.currentTime=(parseFloat(e.target.value)/100)*d; });
$('lyricsBtn').addEventListener('click', () => { $('playlistSheet').classList.add('hidden'); $('lyricsSheet').classList.toggle('hidden'); if(!$('lyricsSheet').classList.contains('hidden')&&idx>=0) fetchLyrics(queue[idx].title, queue[idx].channel); });
$('closeLyrics').addEventListener('click', () => $('lyricsSheet').classList.add('hidden'));
$('playlistBtn').addEventListener('click', () => { $('lyricsSheet').classList.add('hidden'); $('playlistSheet').classList.toggle('hidden'); if(!$('playlistSheet').classList.contains('hidden')) renderPL(); });
$('closePlaylists').addEventListener('click', () => $('playlistSheet').classList.add('hidden'));
$('saveQueueBtn').addEventListener('click', () => { if(!queue.length)return; $('plNameInput').value=''; $('saveModal').classList.remove('hidden'); $('plNameInput').focus(); });
$('addToPlBtn').addEventListener('click', () => { if(idx<0)return; $('plNameInput').value=queue[idx].title.slice(0,30); $('saveModal').classList.remove('hidden'); });
$('modalSave').addEventListener('click', () => { const n=$('plNameInput').value.trim(); if(!n||!queue.length)return; const p=getPL(); p[n]=[...queue]; setPL(p); $('saveModal').classList.add('hidden'); });
$('modalCancel').addEventListener('click', () => $('saveModal').classList.add('hidden'));
$('plNameInput').addEventListener('keydown', e => { if(e.key==='Enter') $('modalSave').click(); });
$('loadUrlToggle').addEventListener('click', () => $('urlRow').classList.toggle('hidden'));
$('urlLoadBtn').addEventListener('click', async () => {
  const url = $('urlInput').value.trim(); if (!url) return;
  $('urlLoadBtn').textContent = '…';
  try {
    const r = await fetch(`${HF}/playlist?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(40000) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error);
    queue = d.tracks; idx = -1; renderList();
    $('playlistSheet').classList.add('hidden'); $('urlInput').value = ''; play(0);
  } catch(e) { showErr('Failed: '+e.message); setTimeout(hideErr, 4000); }
  $('urlLoadBtn').textContent = 'Load';
});

// ── Init ──────────────────────────────────────────────────────────────────────
setVol(vol);
try { const s=JSON.parse(localStorage.getItem('mf_np')||'null'); if(s){$('trackTitle').textContent=s.title||'No track selected';$('trackArtist').textContent=s.channel||'—';if(s.thumb)$('trackThumb').src=s.thumb;} } catch {}
search('top hits 2025');
