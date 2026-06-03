"""
MusicFlow Backend — server.py
Flask server using yt-dlp to:
  1. Extract audio stream URLs  (/stream?v=VIDEO_ID)
  2. Fetch YouTube Radio mix for a song  (/radio?v=VIDEO_ID)
     YouTube auto-generates a ~25 song mix of similar tracks for every video.
     This is what powers "Next song" — always different, always related.
"""

import subprocess
import json
import sys
import re
import urllib.request
import urllib.parse
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["*"])

# ── Cache ─────────────────────────────────────────────────────────────────────
_stream_cache = {}   # videoId → { url, title, duration }
_radio_cache  = {}   # videoId → [ {id, title, channel, thumb}, ... ]


# ── Audio stream extraction ───────────────────────────────────────────────────
def get_audio_url(video_id: str) -> dict:
    if video_id in _stream_cache:
        return _stream_cache[video_id]

    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp",
             "--no-playlist",
             "--format", "bestaudio[ext=m4a]/bestaudio/best",
             "--get-url", "--no-warnings", "--quiet", url],
            capture_output=True, text=True, timeout=20,
        )
        stream_url = result.stdout.strip()
        if not stream_url or result.returncode != 0:
            return {"error": result.stderr.strip() or "yt-dlp returned no URL"}

        info = subprocess.run(
            [sys.executable, "-m", "yt_dlp",
             "--no-playlist", "--print", "%(title)s|||%(duration)s",
             "--no-warnings", "--quiet", url],
            capture_output=True, text=True, timeout=15,
        )
        title, duration = "", 0
        if info.returncode == 0 and "|||" in info.stdout:
            parts = info.stdout.strip().split("|||")
            title = parts[0] or ""
            try: duration = int(parts[1]) if parts[1] else 0
            except: duration = 0

        data = {"url": stream_url, "title": title, "duration": duration}
        _stream_cache[video_id] = data
        return data

    except subprocess.TimeoutExpired:
        return {"error": "yt-dlp timed out"}
    except Exception as e:
        return {"error": str(e)}


# ── YouTube Radio mix fetch ───────────────────────────────────────────────────
def get_radio_mix(video_id: str) -> list:
    """
    Fetch the YouTube auto-generated radio/mix playlist for a video.
    URL pattern: /watch?v=ID&list=RDID&start_radio=1
    Returns list of { id, title, channel, thumb }
    """
    if video_id in _radio_cache:
        return _radio_cache[video_id]

    radio_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}&start_radio=1"

    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp",
             "--flat-playlist",           # don't download, just list
             "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
             "--playlist-end", "25",      # get up to 25 related songs
             "--no-warnings", "--quiet",
             radio_url],
            capture_output=True, text=True, timeout=30,
        )

        tracks = []
        for line in result.stdout.strip().splitlines():
            parts = line.split("|||")
            if len(parts) < 2:
                continue
            vid_id  = parts[0].strip()
            title   = parts[1].strip() if len(parts) > 1 else ""
            channel = parts[2].strip() if len(parts) > 2 else ""
            thumb   = parts[3].strip() if len(parts) > 3 else ""

            # Build a proper thumbnail URL if yt-dlp didn't give one
            if not thumb or thumb == "NA":
                thumb = f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg"

            if vid_id and title:
                tracks.append({
                    "id":      vid_id,
                    "title":   title,
                    "channel": channel,
                    "thumb":   thumb,
                })

        # Skip the first track — it's the song itself, extension already has it
        if tracks and tracks[0]["id"] == video_id:
            tracks = tracks[1:]

        if tracks:
            _radio_cache[video_id] = tracks

        return tracks

    except subprocess.TimeoutExpired:
        return []
    except Exception:
        return []


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/stream")
def stream():
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400
    result = get_audio_url(video_id)
    if "error" in result:
        return jsonify(result), 500
    return jsonify(result)


@app.route("/radio")
def radio():
    """
    GET /radio?v=VIDEO_ID
    Returns: { tracks: [ {id, title, channel, thumb}, ... ] }
    Fetches YouTube's auto-generated radio mix — ~24 similar songs.
    """
    video_id = request.args.get("v", "").strip()
    if not video_id:
        return jsonify({"error": "Missing video ID"}), 400

    tracks = get_radio_mix(video_id)
    return jsonify({"tracks": tracks})


@app.route("/playlist")
def playlist():
    """
    GET /playlist?url=YOUTUBE_URL
    Accepts any YouTube URL — video, playlist, radio mix, etc.
    Returns: { tracks: [ {id, title, channel, thumb}, ... ] }
    """
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url"}), 400

    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp",
             "--flat-playlist",
             "--print", "%(id)s|||%(title)s|||%(channel)s|||%(thumbnails.0.url)s",
             "--playlist-end", "50",
             "--no-warnings", "--quiet",
             url],
            capture_output=True, text=True, timeout=40,
        )

        tracks = []
        for line in result.stdout.strip().splitlines():
            parts = line.split("|||")
            if len(parts) < 2:
                continue
            vid_id  = parts[0].strip()
            title   = parts[1].strip() if len(parts) > 1 else ""
            channel = parts[2].strip() if len(parts) > 2 else ""
            thumb   = parts[3].strip() if len(parts) > 3 else ""
            if not thumb or thumb == "NA":
                thumb = f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg"
            if vid_id and title:
                tracks.append({"id": vid_id, "title": title, "channel": channel, "thumb": thumb})

        if not tracks:
            return jsonify({"error": "No tracks found in this URL"}), 404

        return jsonify({"tracks": tracks})

    except subprocess.TimeoutExpired:
        return jsonify({"error": "Timed out fetching playlist"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/search")
def search():
    """
    GET /search?q=QUERY
    Search YouTube for music using yt-dlp — NO API key, NO quota cost.
    Returns: { tracks: [ {id, title, channel, thumb, dur}, ... ] }
    """
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Missing query"}), 400

    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp",
             f"ytsearch20:{query}",          # top 20 results
             "--flat-playlist",
             "--print", "%(id)s|||%(title)s|||%(channel)s|||%(duration)s|||%(thumbnails.0.url)s",
             "--no-warnings", "--quiet"],
            capture_output=True, text=True, timeout=20,
        )

        tracks = []
        for line in result.stdout.strip().splitlines():
            parts = line.split("|||")
            if len(parts) < 2: continue
            vid_id   = parts[0].strip()
            title    = parts[1].strip()
            channel  = parts[2].strip() if len(parts) > 2 else ""
            dur_secs = parts[3].strip() if len(parts) > 3 else ""
            thumb    = parts[4].strip() if len(parts) > 4 else ""
            if not thumb or thumb in ("NA", "None", ""):
                thumb = f"https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg"
            # Format duration
            dur = ""
            try:
                d = int(float(dur_secs))
                dur = f"{d//60}:{str(d%60).zfill(2)}"
            except: pass
            if vid_id and title:
                tracks.append({"id": vid_id, "title": title, "channel": channel, "thumb": thumb, "dur": dur})

        return jsonify({"tracks": tracks})

    except subprocess.TimeoutExpired:
        return jsonify({"error": "Search timed out"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/suggest")
def suggest():
    """
    GET /suggest?q=QUERY
    Uses YouTube's public autocomplete endpoint — NO API key, NO quota cost.
    Returns: { suggestions: ["title1", "title2", ...] }
    """
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"suggestions": []})

    try:
        encoded = urllib.parse.quote(query + " song")
        url = f"https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q={encoded}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8")

        inner = raw[raw.index('[', raw.index('[') + 1):]
        items_match = re.findall(r'\["([^"]+?)",\s*0', inner)
        suggestions = [s for s in items_match if s and s != query][:8]
        return jsonify({"suggestions": suggestions})

    except Exception as e:
        return jsonify({"suggestions": [], "error": str(e)})


@app.route("/ping")
def ping():
    return jsonify({"ok": True, "msg": "MusicFlow server running"})


if __name__ == "__main__":
    print("=" * 50)
    print("  MusicFlow Backend")
    print("  Running on http://localhost:7842")
    print("=" * 50)
    app.run(host="127.0.0.1", port=7842, debug=False)
