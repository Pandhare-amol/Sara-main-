#!/usr/bin/env bash
# Regenerate Android launcher icons and splash screens from build/icon.png.
# Requires ImageMagick (`convert`) on PATH. Run once after changing the art:
#   bash scripts/android-assets.sh
# The generated files are committed so CI does not need ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="build/icon.png"
RES="android/app/src/main/res"
BG="#03040a"

[ -f "$SRC" ] || { echo "Missing $SRC"; exit 1; }
command -v convert >/dev/null || { echo "ImageMagick (convert) is required"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Face-only crop: the source art carries the old wordmark on the left, which
# Android's circular mask would cut off anyway.
convert "$SRC" -crop 560x560+480+40 +repage -resize 1024x1024 "$TMP/face.png"
# Full artwork, used for legacy square icons so the existing identity is kept.
convert "$SRC" -resize 1024x1024 "$TMP/full.png"
# Circular mask for the round icon.
convert "$TMP/full.png" -alpha set \
  \( +clone -threshold 101% -fill white -draw "circle 512,512 512,4" \) \
  -compose CopyOpacity -composite "$TMP/round.png"

declare -A DENSITY=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
declare -A FOREGROUND=( [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )

for density in "${!DENSITY[@]}"; do
  size=${DENSITY[$density]}
  fg=${FOREGROUND[$density]}
  dir="$RES/mipmap-$density"
  mkdir -p "$dir"
  convert "$TMP/full.png" -resize "${size}x${size}" "$dir/ic_launcher.png"
  convert "$TMP/round.png" -resize "${size}x${size}" "$dir/ic_launcher_round.png"
  # Adaptive icons keep the face inside the 66% safe zone.
  inner=$(( fg * 66 / 100 ))
  convert "$TMP/face.png" -resize "${inner}x${inner}" \
    -background none -gravity center -extent "${fg}x${fg}" \
    "$dir/ic_launcher_foreground.png"
done

# Splash screens (portrait and landscape), dark with the face centred.
mkdir -p "$RES/drawable"
convert -size 1024x1024 "xc:$BG" \
  \( "$TMP/face.png" -resize 360x360 -alpha set \
     \( +clone -threshold 101% -fill white -draw "circle 180,180 180,2" \) \
     -compose CopyOpacity -composite \) \
  -gravity center -composite "$TMP/splash-square.png"

gen_splash() { # width height output
  convert -size "$1x$2" "xc:$BG" \
    \( "$TMP/splash-square.png" -resize "$3x$3" \) \
    -gravity center -composite "$4"
}
gen_splash 320 480 200 "$RES/drawable-port-mdpi/splash.png"
gen_splash 480 800 300 "$RES/drawable-port-hdpi/splash.png"
gen_splash 720 1280 420 "$RES/drawable-port-xhdpi/splash.png"
gen_splash 960 1600 560 "$RES/drawable-port-xxhdpi/splash.png"
gen_splash 1280 1920 720 "$RES/drawable-port-xxxhdpi/splash.png"
gen_splash 480 320 200 "$RES/drawable-land-mdpi/splash.png"
gen_splash 800 480 300 "$RES/drawable-land-hdpi/splash.png"
gen_splash 1280 720 420 "$RES/drawable-land-xhdpi/splash.png"
gen_splash 1600 960 560 "$RES/drawable-land-xxhdpi/splash.png"
gen_splash 1920 1280 720 "$RES/drawable-land-xxxhdpi/splash.png"

# Web/PWA icons as well, so the browser app matches the APK.
mkdir -p public/icons
convert "$TMP/full.png" -resize 192x192 public/icons/icon-192.png
convert "$TMP/full.png" -resize 512x512 public/icons/icon-512.png
convert "$TMP/full.png" -resize 180x180 public/icons/apple-touch-icon.png
convert "$TMP/face.png" -resize 410x410 -background "$BG" -gravity center -extent 512x512 public/icons/maskable-512.png

echo "Android icons and splash screens regenerated."
