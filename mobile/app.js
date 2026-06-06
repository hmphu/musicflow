'use strict';

// ── HuggingFace backend — search + stream ────────────────────────────────────
const HF = 'https://sumit9922-musicflow-backend.hf.space';

// ── State ─────────────────────────────────────────────────────────────────────
let queue = [], currentIndex = -1, isPlaying = false;
let isShuffle = false, isRepeat = false;
let volume = parseInt(localStorage.getItem('mf_vol') || '80');
let sugTimer = null;
const cache = new Map();

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const audio = $('audioEl');

// ── Search ────────────────────────────────────────────────────────────────────
async function search(q) {
  q = q.trim(); if (!q) return;
  hideSug();
  $('spinner').classList.remove('hidden');
  showErr('Searching… (may take 15–30s first time)', '#1db954');
  $('resultsList').innerHTML = '';
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));

  const key = q.toLowerCase();
  if (cache.has(key)) {
    queue = [...cache.get(key)]; renderList();
    $('spinner').classList.add('hidden'); hideErr(); return;
  }

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(`${HF}/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (!d.tracks?.length) { showErr('No results found.'); $('spinner').classList.add('hidden'); return; }
    queue = d.tracks;
    if (cache.size > 30) cache.clear();
    cache.set(key, [...queue]);
    renderList(); hideErr();
  } catch(e) {
    if (e.name === 'AbortError') showErr('Search timed out — server is slow, try again');
    else showErr('Search failed: ' + e.message);
  }
  $('spinner').classList.add('hidden');
}

// ── Get stream URL — tries multiple sources ───────────────────────────────────
async function getStreamUrl(videoId) {
  // Source 1: cobalt.tools API (free, no key, works from browser)
  try {
    const r = await fetch('https://co.wuk.sh/api/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ url: `https://youtu.be/${videoId}`, isAudioOnly: true, aFormat: 'mp3' }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.url) return d.url;
      if (d.status === 'stream' && d.url) return d.url;
    }
  } catch {}

  // Source 2: piped.video proxy stream
  try {
    const r = await fetch(`https://pipedapi.kavin.rocks/streams/${videoId}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const d = await r.json();
      const audio = (d.audioStreams || []).filter(s => s.mimeType?.includes('audio'));
      if (audio.length) return audio[0].url;
    }
  } catch {}

  // Source 3: HF backend (slowest, last resort)
  try {
    const r = await fetch(`${HF}/stream?v=${encodeURIComponent(videoId)}`, {
      signal: AbortSignal.timeout(55000)
    });
    if (r.ok) {
      const d = await r.json();
      if (d.url) return d.url;
    }
  } catch {}

  return null;
}

// ── Play ──────────────────────────────────────────────────────────────────────
async function playTrack(i) {
  if (i < 0 || i >= queue.length) return;
  currentIndex = i;
  const t = queue[i];
  $('trackTitle').textContent  = t.title;
  $('trackArtist').textContent = t.channel || '—';
  $('trackThumb').src = t.thumb || '';
  $('progFill').style.width = '0%';
  $('progRange').value = 0;
  $('curTime').textContent = '0:00';
  $('totTime').textContent = t.dur || '0:00';
  document.querySelectorAll('.result-item').forEach((el,idx) => el.classList.toggle('playing', idx===i));
  setPlayUI(true);
  showErr('Loading…', '#1db954');

  try {
    showErr('Loading…', '#1db954');
    
    // Use YouTube's iframe/embed to get audio — works from any browser
    // We proxy through a CORS-friendly endpoint
    const streamUrl = await getStreamUrl(t.id);
    if (!streamUrl) throw new Error('Could not get audio stream');

    audio.src = streamUrl;
    audio.volume = volume / 100;
    audio.currentTime = 0;
    await audio.play();
    hideErr();
    updateMediaSession(t.title, t.channel, t.thumb);
    localStorage.setItem('mf_np', JSON.stringify(t));
    if (!$('lyricsSheet').classList.contains('hidden')) fetchLyrics(t.title, t.channel);
  } catch(e) { setPlayUI(false); showErr('Playback failed: ' + e.message); }
}

function playNext() {
  if (!queue.length) return;
  if (isShuffle) { let n; do{n=Math.floor(Math.random()*queue.length);}while(queue.length>1&&n===currentIndex); playTrack(n); }
  else playTrack((currentIndex+1)%queue.length);
}
function playPrev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime=0; return; }
  playTrack((currentIndex-1+queue.length)%queue.length);
}
function togglePlay() {
  if (currentIndex===-1&&queue.length) { playTrack(0); return; }
  audio.paused ? audio.play() : audio.pause();
}

// ── Audio events ──────────────────────────────────────────────────────────────
audio.addEventListener('ended', () => { if(isRepeat){audio.currentTime=0;audio.play();}else playNext(); });
audio.addEventListener('playing', () => setPlayUI(true));
audio.addEventListener('pause',   () => setPlayUI(false));
audio.addEventListener('error',   () => { showErr('Playback error.'); setPlayUI(false); });
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime/audio.duration)*100;
  $('progFill').style.width = pct+'%';
  $('progRange').value = pct;
  $('progRange').dataset.dur = audio.duration;
  $('curTime').textContent = fmt(audio.currentTime);
  $('totTime').textContent = fmt(audio.duration);
});

// ── Media Session ─────────────────────────────────────────────────────────────
function updateMediaSession(title, artist, thumb) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist, artwork: thumb?[{src:thumb}]:[] });
  [['play',()=>audio.play()],['pause',()=>audio.pause()],['previoustrack',playPrev],['nexttrack',playNext]]
    .forEach(([a,h]) => { try{navigator.mediaSession.setActionHandler(a,h);}catch{} });
}

// ── Suggestions ───────────────────────────────────────────────────────────────
async function fetchSug(q) {
  if (!q.trim()) { hideSug(); return; }
  try {
    const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const items = (d[1]||[]).slice(0,6);
    if (!items.length) { hideSug(); return; }
    const ul = $('suggestions'); ul.innerHTML = '';
    items.forEach(text => {
      const li = document.createElement('li'); li.className='sug-item';
      li.innerHTML=`<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg><span>${esc(text)}</span>`;
      const pick = () => { $('searchInput').value=text; hideSug(); search(text); };
      li.addEventListener('touchstart',e=>{e.preventDefault();pick();},{passive:false});
      li.addEventListener('mousedown',e=>{e.preventDefault();pick();});
      ul.appendChild(li);
    });
    ul.classList.remove('hidden');
  } catch { hideSug(); }
}
function hideSug() { $('suggestions').classList.add('hidden'); }

// ── Lyrics ────────────────────────────────────────────────────────────────────
async function fetchLyrics(title, artist) {
  $('lyricsTitle').textContent='Lyrics';
  $('lyricsBody').innerHTML='<p class="dim">Fetching lyrics…</p>';
  const t=title.replace(/\(.*?\)|\[.*?\]/g,'').trim();
  const a=(artist||'').replace(/VEVO|Official|Music|Topic/gi,'').trim();
  try {
    const r=await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(a||t)}/${encodeURIComponent(t)}`);
    const d=await r.json();
    if(!d.lyrics) throw new Error();
    $('lyricsTitle').textContent=t; $('lyricsBody').textContent=d.lyrics;
  } catch { $('lyricsBody').innerHTML='<p class="dim">Lyrics not found.</p>'; }
}

// ── Playlists ─────────────────────────────────────────────────────────────────
const getPL=()=>JSON.parse(localStorage.getItem('mf_pl')||'{}');
const setPL=p=>localStorage.setItem('mf_pl',JSON.stringify(p));

function renderPlaylists() {
  const pl=getPL(), keys=Object.keys(pl), ul=$('playlistList'); ul.innerHTML='';
  if (!keys.length) { ul.innerHTML='<li class="pl-empty">No playlists yet.</li>'; return; }
  keys.forEach(name => {
    const li=document.createElement('li'); li.className='pl-item';
    li.innerHTML=`<div style="flex:1;min-width:0"><div class="pl-name">${esc(name)}</div><div class="pl-count">${pl[name].length} tracks</div></div><button class="pl-del">🗑</button>`;
    li.querySelector('div').addEventListener('click',()=>{queue=[...pl[name]];currentIndex=-1;renderList();$('playlistSheet').classList.add('hidden');playTrack(0);});
    li.querySelector('.pl-del').addEventListener('click',e=>{e.stopPropagation();const p=getPL();delete p[name];setPL(p);renderPlaylists();});
    ul.appendChild(li);
  });
}

// ── Volume ────────────────────────────────────────────────────────────────────
function setVol(v) {
  volume=Math.max(0,Math.min(100,v)); audio.volume=volume/100;
  $('volSlider').value=volume;
  $('volSlider').style.background=`linear-gradient(to right,var(--green) 0%,var(--green) ${volume}%,var(--bg3) ${volume}%,var(--bg3) 100%)`;
  localStorage.setItem('mf_vol',volume);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderList() {
  const ul=$('resultsList'); ul.innerHTML='';
  queue.forEach((t,i)=>{
    const li=document.createElement('li'); li.className='result-item'+(i===currentIndex?' playing':'');
    li.innerHTML=`<img class="r-thumb" src="${esc(t.thumb||'')}" loading="lazy"/><div class="r-meta"><div class="r-title">${esc(t.title)}</div><div class="r-channel">${esc(t.channel||'')}</div></div>${t.dur?`<span class="r-dur">${esc(t.dur)}</span>`:''}`;
    li.addEventListener('click',()=>playTrack(i));
    ul.appendChild(li);
  });
}
function fmt(s){s=Math.floor(s||0);return`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function setPlayUI(v){isPlaying=v;$('playIcon').classList.toggle('hidden',v);$('pauseIcon').classList.toggle('hidden',!v);}
function showErr(m,c){const e=$('errMsg');e.textContent=m;e.style.color=c||'#ff6b6b';e.classList.remove('hidden');}
function hideErr(){$('errMsg').classList.add('hidden');}

// ── Events ────────────────────────────────────────────────────────────────────
$('searchBtn').addEventListener('click',()=>search($('searchInput').value));
$('searchInput').addEventListener('keydown',e=>{if(e.key==='Enter'){hideSug();search($('searchInput').value);}});
$('searchInput').addEventListener('input',()=>{clearTimeout(sugTimer);const q=$('searchInput').value.trim();if(!q){hideSug();return;}sugTimer=setTimeout(()=>fetchSug(q),350);});
$('searchInput').addEventListener('blur',()=>setTimeout(hideSug,180));
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));c.classList.add('active');search(c.dataset.query);}));
$('playBtn').addEventListener('click',togglePlay);
$('prevBtn').addEventListener('click',playPrev);
$('nextBtn').addEventListener('click',playNext);
$('shuffleBtn').addEventListener('click',()=>{isShuffle=!isShuffle;$('shuffleBtn').classList.toggle('active',isShuffle);});
$('repeatBtn').addEventListener('click',()=>{isRepeat=!isRepeat;$('repeatBtn').classList.toggle('active',isRepeat);});
$('volSlider').addEventListener('input',e=>setVol(parseInt(e.target.value)));
$('progRange').addEventListener('input',e=>{const dur=parseFloat($('progRange').dataset.dur||0);if(dur)audio.currentTime=(parseFloat(e.target.value)/100)*dur;});
$('lyricsBtn').addEventListener('click',()=>{$('playlistSheet').classList.add('hidden');$('lyricsSheet').classList.toggle('hidden');if(!$('lyricsSheet').classList.contains('hidden')&&currentIndex>=0)fetchLyrics(queue[currentIndex].title,queue[currentIndex].channel);});
$('closeLyrics').addEventListener('click',()=>$('lyricsSheet').classList.add('hidden'));
$('playlistBtn').addEventListener('click',()=>{$('lyricsSheet').classList.add('hidden');$('playlistSheet').classList.toggle('hidden');if(!$('playlistSheet').classList.contains('hidden'))renderPlaylists();});
$('closePlaylists').addEventListener('click',()=>$('playlistSheet').classList.add('hidden'));
$('saveQueueBtn').addEventListener('click',()=>{if(!queue.length)return;$('plNameInput').value='';$('saveModal').classList.remove('hidden');$('plNameInput').focus();});
$('addToPlBtn').addEventListener('click',()=>{if(currentIndex<0)return;$('plNameInput').value=queue[currentIndex].title.slice(0,30);$('saveModal').classList.remove('hidden');});
$('modalSave').addEventListener('click',()=>{const n=$('plNameInput').value.trim();if(!n||!queue.length)return;const p=getPL();p[n]=[...queue];setPL(p);$('saveModal').classList.add('hidden');});
$('modalCancel').addEventListener('click',()=>$('saveModal').classList.add('hidden'));
$('plNameInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('modalSave').click();});
$('loadUrlToggle').addEventListener('click',()=>$('urlRow').classList.toggle('hidden'));
$('urlLoadBtn').addEventListener('click',()=>{/* playlist load via HF */ loadUrl($('urlInput').value);});
$('urlInput').addEventListener('keydown',e=>{if(e.key==='Enter')loadUrl($('urlInput').value);});

async function loadUrl(url) {
  if(!url.trim())return;
  $('urlLoadBtn').textContent='…';
  try {
    const r=await fetch(`${HF}/playlist?url=${encodeURIComponent(url.trim())}`,{signal:AbortSignal.timeout(40000)});
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error);
    queue=d.tracks;currentIndex=-1;renderList();$('playlistSheet').classList.add('hidden');$('urlInput').value='';playTrack(0);
  } catch(e){showErr('Failed: '+e.message);setTimeout(hideErr,4000);}
  $('urlLoadBtn').textContent='Load';
}

// ── Init ──────────────────────────────────────────────────────────────────────
setVol(volume);
try { const s=JSON.parse(localStorage.getItem('mf_np')||'null'); if(s){$('trackTitle').textContent=s.title||'No track selected';$('trackArtist').textContent=s.channel||'—';if(s.thumb)$('trackThumb').src=s.thumb;} } catch {}
search('top hits 2025');
