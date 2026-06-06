"""
MusicFlow Backend — HuggingFace Spaces
Search + Stream via yt-dlp
"""
import subprocess, json, sys, re, os
import urllib.request, urllib.parse
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["*"])

_stream_cache = {}
_search_cache = {}

def ytdlp(*args, timeout=55):
    r = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--no-warnings", "--quiet", *args],
        capture_output=True, text=True, timeout=timeout,
    )
    return r.stdout.strip(), r.returncode


@app.route("/ping")
def ping():
    return jsonify({"ok": True, "msg": "MusicFlow running on HF Spaces"})


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
            f"ytsearch10:{query}", "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(thumbnails.0.url)s",
            timeout=55,
        )
        tracks = []
        for line in out.splitlines():
            p = line.split("|||")
            if len(p) < 2: continue
            vid, title = p[0].strip(), p[1].strip()
            ch = p[2].strip() if len(p) > 2 else ""
            dur_s = p[3].strip() if len(p) > 3 else ""
            thumb = p[4].strip() if len(p) > 4 else ""
            if not thumb or thumb in ("NA","None",""):
                thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
            dur = ""
            try:
                d = int(float(dur_s)); dur = f"{d//60}:{str(d%60).zfill(2)}"
            except: pass
            if vid and title:
                tracks.append({"id":vid,"title":title,"channel":ch,"thumb":thumb,"dur":dur})

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
            "--no-playlist", "--format", "bestaudio[ext=m4a]/bestaudio/best",
            "--get-url", f"https://www.youtube.com/watch?v={video_id}", timeout=55,
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


@app.route("/playlist")
def playlist():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url"}), 400
    try:
        out, _ = ytdlp(
            "--flat-playlist",
            "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
            "--playlist-end", "30", url, timeout=55,
        )
        tracks = []
        for line in out.splitlines():
            p = line.split("|||")
            if len(p) < 2: continue
            vid, title = p[0].strip(), p[1].strip()
            ch = p[2].strip() if len(p) > 2 else ""
            thumb = p[3].strip() if len(p) > 3 else ""
            if not thumb or thumb == "NA":
                thumb = f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
            if vid and title:
                tracks.append({"id":vid,"title":title,"channel":ch,"thumb":thumb})
        if not tracks:
            return jsonify({"error": "No tracks found"}), 404
        return jsonify({"tracks": tracks})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))
    app.run(host="0.0.0.0", port=port, debug=False)
