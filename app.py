"""
MusicFlow Backend — HuggingFace Spaces (MPV-style extraction)
Uses yt-dlp with the same flags MPV uses internally:
  - extractor-args youtube:player_client=web
  - proper user-agent
  - best audio format selection
"""
import subprocess, json, sys, re, os
import urllib.request, urllib.parse
from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["*"])

_stream_cache = {}
_search_cache = {}

# ── yt-dlp with MPV-style flags ────────────────────────────────────────────────
def ytdlp(*args, timeout=55):
    """Run yt-dlp with browser-mimicking flags to bypass YouTube rate limits."""
    base_args = [
        sys.executable, "-m", "yt_dlp",
        "--no-warnings", "--quiet",
        # Mimic a real browser client — same approach MPV uses internally
        "--extractor-args", "youtube:player_client=web",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "--add-header", "Accept-Language:en-US,en;q=0.9",
    ]
    r = subprocess.run(
        base_args + list(args),
        capture_output=True, text=True, timeout=timeout,
    )
    return r.stdout.strip(), r.returncode


@app.route("/ping")
def ping():
    return jsonify({"ok": True, "msg": "MusicFlow v8 MPV-style backend", "ready": True})


@app.route("/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Missing query"}), 400

    key = query.lower()
    if key in _search_cache:
        return jsonify({"tracks": _search_cache[key]})

    try:
        out, code = ytdlp(
            f"ytsearch15:{query}", "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(thumbnails.0.url)s",
            timeout=50,
        )
        tracks = []
        for line in out.splitlines():
            p = line.split("|||")
            if len(p) < 2: continue
            vid, title = p[0].strip(), p[1].strip()
            ch    = p[2].strip() if len(p) > 2 else ""
            dur_s = p[3].strip() if len(p) > 3 else ""
            thumb = p[4].strip() if len(p) > 4 else ""
            if not thumb or thumb in ("NA", "None", ""):
                thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
            dur = ""
            try:
                d = int(float(dur_s)); dur = f"{d//60}:{str(d%60).zfill(2)}"
            except: pass
            if vid and title:
                tracks.append({"id": vid, "title": title, "channel": ch, "thumb": thumb, "dur": dur})

        if not tracks:
            return jsonify({"error": "No results"}), 404

        if len(_search_cache) > 100: _search_cache.clear()
        _search_cache[key] = tracks
        return jsonify({"tracks": tracks})

    except subprocess.TimeoutExpired:
        return jsonify({"error": "Search timed out"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/stream")
def stream():
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400
    if video_id in _stream_cache:
        return jsonify(_stream_cache[video_id])
    try:
        out, code = ytdlp(
            "--no-playlist",
            "--format", "bestaudio[ext=m4a]/bestaudio/best",
            "--get-url",
            f"https://www.youtube.com/watch?v={video_id}",
            timeout=50,
        )
        if not out or code != 0:
            return jsonify({"error": "Could not extract URL"}), 500
        data = {"url": out}
        if len(_stream_cache) > 50: _stream_cache.clear()
        _stream_cache[video_id] = data
        return jsonify(data)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Stream timed out"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/proxy")
def proxy():
    """Proxy audio bytes through HF so phone can play without CORS issues."""
    import urllib.request as ur
    audio_url = request.args.get("url", "").strip()
    if not audio_url:
        return jsonify({"error": "Missing url"}), 400
    try:
        headers = {
            "User-Agent": "Mozilla/5.0",
            "Range": request.headers.get("Range", "bytes=0-"),
        }
        req = ur.Request(audio_url, headers=headers)
        resp = ur.urlopen(req, timeout=15)
        def generate():
            while True:
                chunk = resp.read(65536)
                if not chunk: break
                yield chunk
        status = 206 if request.headers.get("Range") else 200
        out_headers = {
            "Content-Type": resp.headers.get("Content-Type", "audio/mp4"),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        }
        if resp.headers.get("Content-Length"):
            out_headers["Content-Length"] = resp.headers["Content-Length"]
        if resp.headers.get("Content-Range"):
            out_headers["Content-Range"] = resp.headers["Content-Range"]
        return Response(stream_with_context(generate()), status=status, headers=out_headers)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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


@app.route("/radio")
def radio():
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400
    radio_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}&start_radio=1"
    try:
        out, _ = ytdlp(
            "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
            "--playlist-end", "25", radio_url, timeout=35,
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
        return jsonify({"tracks": tracks})
    except Exception as e:
        return jsonify({"tracks": [], "error": str(e)})


@app.route("/playlist")
def playlist():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url"}), 400
    try:
        out, _ = ytdlp(
            "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
            "--playlist-end", "30", url, timeout=50,
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
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    app.run(host="0.0.0.0", port=port, debug=False)
