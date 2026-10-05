#!/usr/bin/env bash
# Builds the promotional video from nothing: the tools it needs, the grain,
# the soundtrack, the picture, and the two put together.
#
#   promo/build.sh [OUTPUT.mp4]
#
# Needs node, npm, python3, curl, and on Linux xvfb-run. Everything it
# downloads or makes on the way goes in $ARBOR_PROMO_CACHE, by default
# ~/.cache/arbor-promo, and nothing outside that folder is changed.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cache="${ARBOR_PROMO_CACHE:-$HOME/.cache/arbor-promo}"
out="${1:-$cache/out/arbor-promo.mp4}"
mkdir -p "$cache"/{tools,fonts,work/tmp,out} "$(dirname "$out")"
export TMPDIR="$cache/work/tmp"

# A Python with the arithmetic the soundtrack is made of.
if [ ! -x "$cache/venv/bin/python" ]; then
  python3 -m venv "$cache/venv"
  "$cache/venv/bin/pip" install --quiet --disable-pip-version-check numpy scipy pillow
fi

# An ffmpeg that can write H.264; the one a distribution ships often cannot.
if [ ! -e "$cache/tools/node_modules/ffmpeg-static/ffmpeg" ]; then
  (cd "$cache/tools" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --silent ffmpeg-static)
fi
ffmpeg="$cache/tools/node_modules/ffmpeg-static/ffmpeg"

# The typefaces, both under the SIL Open Font License, made known to this
# build alone rather than installed for the user.
if [ ! -f "$cache/fonts/InterVariable.ttf" ]; then
  curl -sSL -o "$cache/fonts/inter.zip" https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
  (cd "$cache/fonts" && python3 -c "
import zipfile
z = zipfile.ZipFile('inter.zip')
for n in z.namelist():
    if n.endswith(('InterVariable.ttf', 'InterVariable-Italic.ttf')):
        open(n.split('/')[-1], 'wb').write(z.read(n))
" && rm inter.zip)
fi
if [ ! -f "$cache/fonts/JetBrainsMono-Variable.ttf" ]; then
  curl -sSL -o "$cache/fonts/mono.zip" https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
  (cd "$cache/fonts" && python3 -c "
import zipfile
z = zipfile.ZipFile('mono.zip')
open('JetBrainsMono-Variable.ttf', 'wb').write(z.read('fonts/variable/JetBrainsMono[wght].ttf'))
" && rm mono.zip)
fi
cat > "$cache/fonts/fonts.conf" <<CONF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>$cache/fonts</dir>
  <cachedir>$cache/fonts/cache</cachedir>
</fontconfig>
CONF
export FONTCONFIG_FILE="$cache/fonts/fonts.conf"

# A tile of film grain, the same every time.
"$cache/venv/bin/python" - "$repo/promo/composition/grain.png" <<'PY'
import sys
import numpy as np
from PIL import Image

noise = np.random.default_rng(7).normal(0, 1, (512, 512))
soft = (noise + np.roll(noise, 1, 0) * 0.35 + np.roll(noise, 1, 1) * 0.35) / 1.4
Image.fromarray(np.clip(128 + soft * 46, 0, 255).astype(np.uint8), "L").save(sys.argv[1], optimize=True)
PY

echo "soundtrack…"
"$cache/venv/bin/python" "$repo/promo/score.py" "$cache/work/score.wav"

echo "picture…"
electron="$repo/node_modules/.bin/electron"
[ -x "$electron" ] || (cd "$repo" && npm ci)
frame=()
[ "$(uname)" = Linux ] && frame=(xvfb-run -a -s "-screen 0 4000x2300x24")
(cd "$repo" && FFMPEG="$ffmpeg" "${frame[@]}" "$electron" promo/render.cjs --no-sandbox --video "$cache/work/picture.mp4" --scale 2)

# The soundtrack is brought to the loudness video sites play at, -14 LUFS,
# and joined to the picture without touching the picture again.
loudness="$("$ffmpeg" -hide_banner -nostats -i "$cache/work/score.wav" -af ebur128 -f null - 2>&1 | awk '/I:/ {value=$2} END {print value}')"
gain="$(python3 -c "print(round(-14.0 - ($loudness), 2))")"
echo "sound: $loudness LUFS as made, $gain dB to bring it to -14"
"$ffmpeg" -y -hide_banner -loglevel error -i "$cache/work/picture.mp4" -i "$cache/work/score.wav" \
  -map 0:v -map 1:a -c:v copy -af "volume=${gain}dB,alimiter=limit=0.89:level=false" -c:a aac -b:a 256k -ar 48000 \
  -shortest -movflags +faststart \
  -metadata title="Arbor" -metadata comment="Every worktree, sound and picture here is invented or synthesized." \
  "$out"
echo "wrote $out"
