"""
MusicFlow Backend v8 — MPV Edition
────────────────────────────────────
Architecture:
  Chrome Extension  →  Flask (port 7842)  →  MPV (IPC socket)  →  Speakers

MPV replaces the offscreen <audio> element entirely.
- Faster stream startup (MPV has built-in yt-dlp support with better YT handling)
- Native audio playback — no browser audio limitations
- JSON IPC socket for real-time playback control (seek, volume, state)
- Radio feature: yt-dlp grabs YouTube auto-generated playlists (no API key)
"""

import subprocess, json, sys, re, os, socket, time, threading, tempfile
import urllib.request, urllib.parse
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["*"])

# ── MPV IPC socket path ────────────────────────────────────────────────────────
if sys.platform == "win32":
    MPV_IPC = r"\\.\pipe\mpvsocket"
else:
    MPV_IPC = "/tmp/mpvsocket"

MPV_PROCESS = None
_mpv_lock = threading.Lock()

# ── Caches ─────────────────────────────────────────────────────────────────────
_search_cache = {}
_radio_cache  = {}

# ── MPV control ───────────────────────────────────────────────────────────────
def find_mpv():
    """Find mpv executable."""
    candidates = [
        r"C:\Program Files\MPV Player\mpv.exe",
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        os.path.join(os.path.dirname(__file__), "mpv.exe"),
        "mpv",
    ]
    for c in candidates:
        try:
            subprocess.run([c, "--version"], capture_output=True, timeout=3)
            return c
        except Exception:
            continue
    return None


def start_mpv():
    """Start MPV in idle mode with IPC socket."""
    global MPV_PROCESS
    mpv = find_mpv()
    if not mpv:
        return False, "MPV not found. Install from https://mpv.io/installation/"

    # Kill existing MPV
    stop_mpv()
    time.sleep(0.3)

    try:
        args = [
            mpv,
            "--idle=yes",            # stay running when no file
            "--no-video",            # audio only — no window
            "--no-terminal",         # no console output
            "--really-quiet",
            f"--input-ipc-server={MPV_IPC}",
            "--ytdl=yes",            # enable yt-dlp support
            "--ytdl-format=bestaudio[ext=m4a]/bestaudio/best",
            "--cache=yes",
            "--demuxer-max-bytes=50MiB",
            "--force-seekable=yes",
        ]
        MPV_PROCESS = subprocess.Popen(
            args,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        time.sleep(1.5)  # let MPV start and open socket
        return True, "MPV started"
    except Exception as e:
        return False, str(e)


def stop_mpv():
    global MPV_PROCESS
    if MPV_PROCESS:
        try:
            MPV_PROCESS.terminate()
            MPV_PROCESS.wait(timeout=3)
        except Exception:
            try: MPV_PROCESS.kill()
            except Exception: pass
        MPV_PROCESS = None


def mpv_command(cmd: dict):
    """Send a JSON command to MPV via IPC socket."""
    payload = json.dumps({"command": cmd}) + "\n"

    if sys.platform == "win32":
        # Windows named pipe
        try:
            import ctypes, ctypes.wintypes
            GENERIC_READ_WRITE = 0xC0000000
            OPEN_EXISTING = 3
            handle = ctypes.windll.kernel32.CreateFileW(
                MPV_IPC, GENERIC_READ_WRITE, 0, None, OPEN_EXISTING, 0, None
            )
            if handle == ctypes.wintypes.HANDLE(-1).value:
                return {"error": "MPV not running"}
            data = payload.encode()
            written = ctypes.wintypes.DWORD(0)
            ctypes.windll.kernel32.WriteFile(handle, data, len(data), ctypes.byref(written), None)
            buf = ctypes.create_string_buffer(4096)
            read = ctypes.wintypes.DWORD(0)
            ctypes.windll.kernel32.ReadFile(handle, buf, 4096, ctypes.byref(read), None)
            ctypes.windll.kernel32.CloseHandle(handle)
            response = buf.raw[:read.value].decode(errors="ignore").strip()
            # MPV may return multiple lines — get last JSON line with "data"
            for line in reversed(response.splitlines()):
                try:
                    r = json.loads(line)
                    if "data" in r or "error" in r:
                        return r
                except Exception:
                    continue
            return {"error": "no response"}
        except Exception as e:
            return {"error": str(e)}
    else:
        # Unix socket
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(MPV_IPC)
            s.sendall(payload.encode())
            s.settimeout(3)
            response = b""
            try:
                while True:
                    chunk = s.recv(4096)
                    if not chunk: break
                    response += chunk
            except socket.timeout:
                pass
            s.close()
            for line in reversed(response.decode(errors="ignore").splitlines()):
                try:
                    r = json.loads(line)
                    if "data" in r or "error" in r:
                        return r
                except Exception:
                    continue
            return {"error": "no response"}
        except Exception as e:
            return {"error": str(e)}


def mpv_get(prop: str):
    """Get a property from MPV."""
    return mpv_command(["get_property", prop])


def mpv_set(prop: str, value):
    """Set a property on MPV."""
    return mpv_command(["set_property", prop, value])


def ensure_mpv():
    """Start MPV if not running."""
    global MPV_PROCESS
    if MPV_PROCESS and MPV_PROCESS.poll() is None:
        return True
    ok, _ = start_mpv()
    return ok


# ── yt-dlp helpers ─────────────────────────────────────────────────────────────
def ytdlp(*args, timeout=25):
    r = subprocess.run(
        [
            sys.executable, "-m", "yt_dlp",
            "--no-warnings", "--quiet",
            "--extractor-args", "youtube:player_client=web",
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "--add-header", "Accept-Language:en-US,en;q=0.9",
            *args,
        ],
        capture_output=True, text=True, timeout=timeout,
    )
    return r.stdout.strip(), r.returncode


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/ping")
def ping():
    mpv_ok = MPV_PROCESS is not None and MPV_PROCESS.poll() is None
    return jsonify({"ok": True, "msg": "MusicFlow v8 MPV Edition", "mpv": mpv_ok})


@app.route("/play")
def play():
    """
    GET /play?v=VIDEO_ID&title=...&artist=...
    Tells MPV to start playing a YouTube video as audio.
    MPV uses its built-in yt-dlp to extract the stream — faster than our old approach.
    """
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400

    ensure_mpv()

    url = f"https://www.youtube.com/watch?v={video_id}"

    # loadfile command — MPV handles everything (stream extraction, buffering, playback)
    result = mpv_command(["loadfile", url, "replace"])
    if result.get("error") and result["error"] != "success":
        return jsonify({"error": f"MPV error: {result}"}), 500

    # Brief wait for MPV to start buffering, then get duration
    time.sleep(0.5)
    dur_r = mpv_get("duration")
    duration = dur_r.get("data", 0) or 0

    return jsonify({
        "ok": True,
        "duration": duration,
        "video_id": video_id,
    })


@app.route("/pause")
def pause():
    ensure_mpv()
    mpv_set("pause", True)
    return jsonify({"ok": True})


@app.route("/resume")
def resume():
    ensure_mpv()
    mpv_set("pause", False)
    return jsonify({"ok": True})


@app.route("/seek")
def seek():
    t = float(request.args.get("t", 0))
    ensure_mpv()
    mpv_command(["seek", t, "absolute"])
    return jsonify({"ok": True})


@app.route("/volume")
def volume():
    vol = int(request.args.get("v", 80))
    ensure_mpv()
    mpv_set("volume", vol)
    return jsonify({"ok": True})


@app.route("/mute")
def mute():
    muted = request.args.get("m", "true").lower() == "true"
    ensure_mpv()
    mpv_set("mute", muted)
    return jsonify({"ok": True})


@app.route("/state")
def state():
    """Get current playback state from MPV."""
    ensure_mpv()
    paused   = mpv_get("pause").get("data", True)
    pos      = mpv_get("time-pos").get("data") or 0
    dur      = mpv_get("duration").get("data") or 0
    idle     = mpv_get("idle-active").get("data", True)
    return jsonify({
        "ok":     True,
        "paused": paused,
        "cur":    round(pos, 2),
        "dur":    round(dur, 2) if dur else 0,
        "idle":   idle,
    })


@app.route("/stop")
def stop():
    ensure_mpv()
    mpv_command(["stop"])
    return jsonify({"ok": True})


# ── Search (yt-dlp, unchanged) ─────────────────────────────────────────────────
@app.route("/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Missing query"}), 400

    key = query.lower()
    if key in _search_cache:
        return jsonify({"tracks": _search_cache[key]})

    try:
        out, _ = ytdlp(
            f"ytsearch20:{query}", "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(thumbnails.0.url)s",
            timeout=20,
        )
        tracks = []
        for line in out.splitlines():
            p = line.split("|||")
            if len(p) < 2: continue
            vid, title = p[0].strip(), p[1].strip()
            ch      = p[2].strip() if len(p) > 2 else ""
            dur_s   = p[3].strip() if len(p) > 3 else ""
            thumb   = p[4].strip() if len(p) > 4 else ""
            if not thumb or thumb in ("NA", "None", ""):
                thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
            dur = ""
            try:
                d = int(float(dur_s)); dur = f"{d//60}:{str(d%60).zfill(2)}"
            except: pass
            if vid and title:
                tracks.append({"id": vid, "title": title, "channel": ch, "thumb": thumb, "dur": dur})

        if len(_search_cache) > 100: _search_cache.clear()
        _search_cache[key] = tracks
        return jsonify({"tracks": tracks})

    except subprocess.TimeoutExpired:
        return jsonify({"error": "Search timed out"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Stream URL (kept for compatibility — MPV now handles this directly) ────────
@app.route("/stream")
def stream():
    """Legacy endpoint — extension can still call this. MPV /play is preferred."""
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400
    try:
        out, code = ytdlp(
            "--no-playlist", "--format", "bestaudio[ext=m4a]/bestaudio/best",
            "--get-url", f"https://www.youtube.com/watch?v={video_id}", timeout=20,
        )
        if not out or code != 0:
            return jsonify({"error": "Could not extract URL"}), 500
        return jsonify({"url": out})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "yt-dlp timed out"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Radio (yt-dlp, unchanged) ──────────────────────────────────────────────────
@app.route("/radio")
def radio():
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400

    if video_id in _radio_cache:
        return jsonify({"tracks": _radio_cache[video_id]})

    radio_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}&start_radio=1"
    try:
        out, _ = ytdlp(
            "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
            "--playlist-end", "25", "--no-warnings", "--quiet",
            radio_url, timeout=30,
        )
        tracks = []
        for line in out.splitlines():
            p = line.split("|||")
            if len(p) < 2: continue
            vid, title = p[0].strip(), p[1].strip()
            ch    = p[2].strip() if len(p) > 2 else ""
            thumb = p[3].strip() if len(p) > 3 else ""
            if not thumb or thumb == "NA":
                thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
            if vid and title and vid != video_id:
                tracks.append({"id": vid, "title": title, "channel": ch, "thumb": thumb})
        if tracks:
            _radio_cache[video_id] = tracks
        return jsonify({"tracks": tracks})
    except Exception:
        return jsonify({"tracks": []})


# ── Suggest (unchanged) ────────────────────────────────────────────────────────
@app.route("/suggest")
def suggest():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"suggestions": []})
    try:
        enc = urllib.parse.quote(query + " song")
        url = f"https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q={enc}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8")
        inner = raw[raw.index('[', raw.index('[') + 1):]
        items = re.findall(r'\["([^"]+?)",\s*0', inner)
        return jsonify({"suggestions": [s for s in items if s != query][:8]})
    except Exception as e:
        return jsonify({"suggestions": [], "error": str(e)})


# ── Playlist (unchanged) ───────────────────────────────────────────────────────
@app.route("/playlist")
def playlist():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url"}), 400
    try:
        out, _ = ytdlp(
            "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
            "--playlist-end", "50", url, timeout=40,
        )
        tracks = []
        for line in out.splitlines():
            p = line.split("|||")
            if len(p) < 2: continue
            vid, title = p[0].strip(), p[1].strip()
            ch    = p[2].strip() if len(p) > 2 else ""
            thumb = p[3].strip() if len(p) > 3 else ""
            if not thumb or thumb == "NA":
                thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
            if vid and title:
                tracks.append({"id": vid, "title": title, "channel": ch, "thumb": thumb})
        if not tracks:
            return jsonify({"error": "No tracks found"}), 404
        return jsonify({"tracks": tracks})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timed out"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Startup ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 54)
    print("  MusicFlow v8 — MPV Edition")
    print("  Backend: http://127.0.0.1:7842")
    print("=" * 54)

    # Start MPV on server startup
    ok, msg = start_mpv()
    if ok:
        print(f"  ✅ MPV started — audio plays via system speakers")
    else:
        print(f"  ⚠  MPV: {msg}")
        print(f"  ℹ  Falling back to yt-dlp stream URLs (original mode)")
    print("=" * 54)

    app.run(host="0.0.0.0", port=7842, debug=os.environ.get("DEBUG", "false").lower() == "true")
