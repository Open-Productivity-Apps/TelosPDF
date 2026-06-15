#!/usr/bin/env bash
# Assemble a self-contained Tesseract OCR engine into .ocr/<platform>/ so it
# ships inside the app bundle (zero user install). Run once before building
# a release; the output is git-ignored and re-created per platform.
#
#   .ocr/<platform>/bin/tesseract      relocatable binary
#   .ocr/<platform>/lib/*.dylib|so     its libraries (paths rewritten)
#   .ocr/<platform>/tessdata/*.traineddata
#
# macOS: needs `brew install tesseract dylibbundler`.
# Linux: needs tesseract + patchelf (bundling step below).
set -euo pipefail
cd "$(dirname "$0")/.."

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) PLAT=mac-arm64 ;;
  Darwin/x86_64) PLAT=mac-x64 ;;
  Linux/x86_64) PLAT=linux-x64 ;;
  Linux/aarch64) PLAT=linux-arm64 ;;
  *) echo "unsupported platform $OS/$ARCH"; exit 1 ;;
esac

TESS="$(command -v tesseract || true)"
[ -n "$TESS" ] || { echo "tesseract not found — install it first"; exit 1; }
OUT=".ocr/$PLAT"
rm -rf "$OUT"; mkdir -p "$OUT/bin" "$OUT/lib" "$OUT/tessdata"
cp "$TESS" "$OUT/bin/tesseract"

# English (+ orientation) language data. Debian/Ubuntu nest it under
# /usr/share/tesseract-ocr/<version>/tessdata.
TDATA="$(dirname "$(dirname "$TESS")")/share/tessdata"
if [ ! -d "$TDATA" ] && [ -d /usr/share/tesseract-ocr ]; then
  TDATA="$(find /usr/share/tesseract-ocr -type d -name tessdata 2>/dev/null | head -1)"
fi
[ -d "$TDATA" ] || TDATA="/usr/share/tessdata"
cp "$TDATA/eng.traineddata" "$OUT/tessdata/"
cp "$TDATA/osd.traineddata" "$OUT/tessdata/" 2>/dev/null || true

if [ "$OS" = "Darwin" ]; then
  command -v dylibbundler >/dev/null || { echo "install dylibbundler (brew)"; exit 1; }
  dylibbundler -od -b -x "$OUT/bin/tesseract" -d "$OUT/lib/" -p "@loader_path/../lib/"
else
  # Linux: copy non-system shared libs and set an rpath. On stock distro
  # installs every dependency is a system lib, so an empty grep result is
  # normal — don't let pipefail treat it as failure.
  command -v patchelf >/dev/null || { echo "install patchelf"; exit 1; }
  ldd "$OUT/bin/tesseract" | awk '/=> \//{print $3}' \
    | { grep -Ev '^/(lib|usr/lib)/(x86_64|aarch64)?' || true; } | while read -r lib; do
      cp -n "$lib" "$OUT/lib/" || true
    done
  patchelf --set-rpath '$ORIGIN/../lib' "$OUT/bin/tesseract"
fi

echo "OCR bundle ready at $OUT ($(du -sh "$OUT" | cut -f1))"
TESSDATA_PREFIX="$OUT/tessdata" "$OUT/bin/tesseract" --version | head -1
