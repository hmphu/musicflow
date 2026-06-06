'use strict';

const HF = 'https://sumit9922-musicflow-backend.hf.space';

let queue = [], idx = -1, isShuffle = false, isRepeat = false;
let vol = parseInt(localStorage.getItem('mf_vol') || '80');
let sugTimer = null;
const cache = new Map();

// YouTube IFrame API
let YTP = null, ytReady = false;
(function loadYTAPI(){
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();
window.onYouTubeIframeAPIReady = function() {
  YTP = new YT.Player('yt-iframe', {
    height:'1', width:'1',
    playerVars:{autoplay:0,controls:0,rel:0,playsinline:1},
    events:{
      onReady: () => { ytReady=true; YTP.setVolume(vol); },
      onStateChange: e => {
        if(e.data===1){setUI(true);tick();}
        if(e.data===2){setUI(false);}
        if(e.data===0){setUI(false);stopTick();if(isRepeat)YTP.playVideo();else next();}
      },
      onError: e => { showErr('Playback error ('+e.data+')'); setUI(false); }
    }
  });
};

function play(i) {
  if(i<0||i>=queue.length)return;
  idx=i;
  const t=queue[i];
  document.getElementById('trackTitle').textContent=t.title;
  document.getElementById('trackArtist').textContent=t.channel||'—';
  document.getElementById('trackThumb').src=t.thumb||'';
  document.getElementById('totTime').textContent=t.dur||'0:00';
  document.getElementById('curTime').textContent='0:00';
  document.getElementById('progFill').style.width='0%';
  document.querySelectorAll('.result-item').forEach((el,j)=>el.classList.toggle('playing',j===i));
  setUI(true); hideErr();
  if(!ytReady){setTimeout(()=>play(i),300);return;}
  YTP.setVolume(vol);
  YTP.loadVideoById({videoId:t.id,startSeconds:0});
  localStorage.setItem('mf_np',JSON.stringify(t));
  if(!document.getElementById('lyricsSheet').classList.contains('hidden'))fetchLyrics(t.title,t.channel);
}
function next(){if(!queue.length)return;if(isShuffle){let n;do{n=Math.floor(Math.random()*queue.length);}while(queue.length>1&&n===idx);play(n);}else play((idx+1)%queue.length);}
function prev(){if(!queue.length)return;if(ytReady&&YTP.getCurrentTime&&YTP.getCurrentTime()>3){YTP.seekTo(0);return;}play((idx-1+queue.length)%queue.length);}
function togglePlay(){if(idx===-1&&queue.length){play(0);return;}if(!ytReady)return;YTP.getPlayerState()===1?YTP.pauseVideo():YTP.playVideo();}

let tickT=null;
function tick(){stopTick();tickT=setInterval(()=>{if(!ytReady||!YTP.getDuration)return;const c=YTP.getCurrentTime()||0,d=YTP.getDuration()||0;if(d>0){const p=(c/d)*100;document.getElementById('progFill').style.width=p+'%';document.getElementById('progRange').value=p;document.getElementById('progRange').dataset.dur=d;document.getElementById('curTime').textContent=fmt(c);document.getElementById('totTime').textContent=fmt(d);}},1000);}
function stopTick(){if(tickT){clearInterval(tickT);tickT=null;}}

function setVol(v){vol=Math.max(0,Math.min(100,v));if(ytReady)YTP.setVolume(vol);const s=document.getElementById('volSlider');s.value=vol;s.style.background=`linear-gradient(to right,var(--green) 0%,var(--green) ${vol}%,var(--bg3) ${vol}%,var(--bg3) 100%)`;localStorage.setItem('mf_vol',vol);}
function setUI(v){document.getElementById('playIcon').classList.toggle('hidden',v);document.getElementById('pauseIcon').classList.toggle('hidden',!v);}
function showErr(m,c){const e=document.getElementById('errMsg');e.textContent=m;e.style.color=c||'#ff6b6b';e.classList.remove('hidden');}
function hideErr(){document.getElementById('errMsg').classList.add('hidden');}
function fmt(s){s=Math.floor(s||0);return`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function renderList(){const ul=document.getElementById('resultsList');ul.innerHTML='';queue.forEach((t,i)=>{const li=document.createElement('li');li.className='result-item'+(i===idx?' playing':'');li.innerHTML=`<img class="r-thumb" src="${esc(t.thumb||'')}" loading="lazy"/><div class="r-meta"><div class="r-title">${esc(t.title)}</div><div class="r-channel">${esc(t.channel||'')}</div></div>${t.dur?`<span class="r-dur">${esc(t.dur)}</span>`:''}`;li.addEventListener('click',()=>play(i));ul.appendChild(li);});}

async function search(q){
  q=q.trim();if(!q)return;
  hideSug();
  document.getElementById('spinner').classList.remove('hidden');
  showErr('Searching…','#1db954');
  document.getElementById('resultsList').innerHTML='';
  document.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
  const key=q.toLowerCase();
  if(cache.has(key)){queue=[...cache.get(key)];renderList();document.getElementById('spinner').classList.add('hidden');hideErr();return;}
  try{
    const ctrl=new AbortController();
    const tid=setTimeout(()=>ctrl.abort(),90000);
    const r=await fetch(`${HF}/search?q=${encodeURIComponent(q)}`,{signal:ctrl.signal});
    clearTimeout(tid);
    if(!r.ok)throw new Error('Server error '+r.status);
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    if(!d.tracks?.length){showErr('No results.');document.getElementById('spinner').classList.add('hidden');return;}
    queue=d.tracks;if(cache.size>30)cache.clear();cache.set(key,[...queue]);
    renderList();hideErr();
  }catch(e){showErr(e.name==='AbortError'?'Timed out — try again':'Error: '+e.message);}
  document.getElementById('spinner').classList.add('hidden');
}

async function fetchSug(q){if(!q){hideSug();return;}try{const r=await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`,{signal:AbortSignal.timeout(4000)});const d=await r.json();const items=(d[1]||[]).slice(0,6);if(!items.length){hideSug();return;}const ul=document.getElementById('suggestions');ul.innerHTML='';items.forEach(text=>{const li=document.createElement('li');li.className='sug-item';li.innerHTML=`<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg><span>${esc(text)}</span>`;const pick=()=>{document.getElementById('searchInput').value=text;hideSug();search(text);};li.addEventListener('touchstart',e=>{e.preventDefault();pick();},{passive:false});li.addEventListener('mousedown',e=>{e.preventDefault();pick();});ul.appendChild(li);});ul.classList.remove('hidden');}catch{hideSug();}}
function hideSug(){document.getElementById('suggestions').classList.add('hidden');}

async function fetchLyrics(title,artist){document.getElementById('lyricsTitle').textContent='Lyrics';document.getElementById('lyricsBody').innerHTML='<p class="dim">Fetching lyrics…</p>';const t=title.replace(/\(.*?\)|\[.*?\]/g,'').trim();const a=(artist||'').replace(/VEVO|Official|Music|Topic/gi,'').trim();try{const r=await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(a||t)}/${encodeURIComponent(t)}`);const d=await r.json();if(!d.lyrics)throw new Error();document.getElementById('lyricsTitle').textContent=t;document.getElementById('lyricsBody').textContent=d.lyrics;}catch{document.getElementById('lyricsBody').innerHTML='<p class="dim">Lyrics not found.</p>';}}

const getPL=()=>JSON.parse(localStorage.getItem('mf_pl')||'{}');
const setPL=p=>localStorage.setItem('mf_pl',JSON.stringify(p));
function renderPL(){const pl=getPL(),keys=Object.keys(pl),ul=document.getElementById('playlistList');ul.innerHTML='';if(!keys.length){ul.innerHTML='<li class="pl-empty">No playlists yet.</li>';return;}keys.forEach(name=>{const li=document.createElement('li');li.className='pl-item';li.innerHTML=`<div style="flex:1;min-width:0"><div class="pl-name">${esc(name)}</div><div class="pl-count">${pl[name].length} tracks</div></div><button class="pl-del">🗑</button>`;li.querySelector('div').addEventListener('click',()=>{queue=[...pl[name]];idx=-1;renderList();document.getElementById('playlistSheet').classList.add('hidden');play(0);});li.querySelector('.pl-del').addEventListener('click',e=>{e.stopPropagation();const p=getPL();delete p[name];setPL(p);renderPL();});ul.appendChild(li);});}

function mediaSession(title,artist,thumb){if(!('mediaSession'in navigator))return;navigator.mediaSession.metadata=new MediaMetadata({title,artist,artwork:thumb?[{src:thumb}]:[]});[['play',()=>YTP?.playVideo()],['pause',()=>YTP?.pauseVideo()],['previoustrack',prev],['nexttrack',next]].forEach(([a,h])=>{try{navigator.mediaSession.setActionHandler(a,h);}catch{}});}

// Events
document.getElementById('searchBtn').addEventListener('click',()=>search(document.getElementById('searchInput').value));
document.getElementById('searchInput').addEventListener('keydown',e=>{if(e.key==='Enter'){hideSug();search(document.getElementById('searchInput').value);}});
document.getElementById('searchInput').addEventListener('input',()=>{clearTimeout(sugTimer);const q=document.getElementById('searchInput').value.trim();if(!q){hideSug();return;}sugTimer=setTimeout(()=>fetchSug(q),350);});
document.getElementById('searchInput').addEventListener('blur',()=>setTimeout(hideSug,180));
document.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));c.classList.add('active');search(c.dataset.query);}));
document.getElementById('playBtn').addEventListener('click',togglePlay);
document.getElementById('prevBtn').addEventListener('click',prev);
document.getElementById('nextBtn').addEventListener('click',next);
document.getElementById('shuffleBtn').addEventListener('click',()=>{isShuffle=!isShuffle;document.getElementById('shuffleBtn').classList.toggle('active',isShuffle);});
document.getElementById('repeatBtn').addEventListener('click',()=>{isRepeat=!isRepeat;document.getElementById('repeatBtn').classList.toggle('active',isRepeat);});
document.getElementById('volSlider').addEventListener('input',e=>setVol(parseInt(e.target.value)));
document.getElementById('progRange').addEventListener('input',e=>{const d=parseFloat(document.getElementById('progRange').dataset.dur||0);if(d&&ytReady)YTP.seekTo((parseFloat(e.target.value)/100)*d,true);});
document.getElementById('lyricsBtn').addEventListener('click',()=>{document.getElementById('playlistSheet').classList.add('hidden');document.getElementById('lyricsSheet').classList.toggle('hidden');if(!document.getElementById('lyricsSheet').classList.contains('hidden')&&idx>=0)fetchLyrics(queue[idx].title,queue[idx].channel);});
document.getElementById('closeLyrics').addEventListener('click',()=>document.getElementById('lyricsSheet').classList.add('hidden'));
document.getElementById('playlistBtn').addEventListener('click',()=>{document.getElementById('lyricsSheet').classList.add('hidden');document.getElementById('playlistSheet').classList.toggle('hidden');if(!document.getElementById('playlistSheet').classList.contains('hidden'))renderPL();});
document.getElementById('closePlaylists').addEventListener('click',()=>document.getElementById('playlistSheet').classList.add('hidden'));
document.getElementById('saveQueueBtn').addEventListener('click',()=>{if(!queue.length)return;document.getElementById('plNameInput').value='';document.getElementById('saveModal').classList.remove('hidden');document.getElementById('plNameInput').focus();});
document.getElementById('addToPlBtn').addEventListener('click',()=>{if(idx<0)return;document.getElementById('plNameInput').value=queue[idx].title.slice(0,30);document.getElementById('saveModal').classList.remove('hidden');});
document.getElementById('modalSave').addEventListener('click',()=>{const n=document.getElementById('plNameInput').value.trim();if(!n||!queue.length)return;const p=getPL();p[n]=[...queue];setPL(p);document.getElementById('saveModal').classList.add('hidden');});
document.getElementById('modalCancel').addEventListener('click',()=>document.getElementById('saveModal').classList.add('hidden'));
document.getElementById('plNameInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('modalSave').click();});
document.getElementById('loadUrlToggle').addEventListener('click',()=>document.getElementById('urlRow').classList.toggle('hidden'));
document.getElementById('urlLoadBtn').addEventListener('click',async()=>{const url=document.getElementById('urlInput').value.trim();if(!url)return;document.getElementById('urlLoadBtn').textContent='…';try{const r=await fetch(`${HF}/playlist?url=${encodeURIComponent(url)}`,{signal:AbortSignal.timeout(40000)});const d=await r.json();if(!r.ok||d.error)throw new Error(d.error);queue=d.tracks;idx=-1;renderList();document.getElementById('playlistSheet').classList.add('hidden');document.getElementById('urlInput').value='';play(0);}catch(e){showErr('Failed: '+e.message);setTimeout(hideErr,4000);}document.getElementById('urlLoadBtn').textContent='Load';});

// Init
setVol(vol);
try{const s=JSON.parse(localStorage.getItem('mf_np')||'null');if(s){document.getElementById('trackTitle').textContent=s.title||'No track selected';document.getElementById('trackArtist').textContent=s.channel||'—';if(s.thumb)document.getElementById('trackThumb').src=s.thumb;}}catch{}
search('top hits 2025');
