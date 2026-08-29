#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$project_root/fixtures/private"
output="$fixture_root/authorized-sermon-ru-45s.wav"
url="https://www.youtube.com/watch?v=rULLyk5e8Yg"
ytdlp_bin="${YTDLP_BIN:-yt-dlp}"

command -v "$ytdlp_bin" >/dev/null || { echo "yt-dlp is required" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
mkdir -p "$fixture_root"
"$ytdlp_bin" \
  --no-playlist \
  --download-sections "*00:08:00-00:08:45" \
  --force-keyframes-at-cuts \
  -x \
  --audio-format wav \
  --audio-quality 0 \
  -o "$fixture_root/source.%(ext)s" \
  "$url"
ffmpeg -hide_banner -loglevel error -y -i "$fixture_root/source.wav" -ar 48000 -ac 1 -c:a pcm_s16le "$output"
rm "$fixture_root/source.wav"
shasum -a 256 "$output"
