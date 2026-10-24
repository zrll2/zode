#!/bin/bash
# Build a self-contained whisper-cli (whisper.cpp, Metal on Apple silicon) for Zode's voice engine.
#   bash scripts/build-whisper.sh        writes mac/vendor/whisper-cli (gitignored)
# Needs cmake (brew install cmake) and the Xcode command line tools. The binary links only system
# frameworks (Metal, Accelerate, Foundation), so it can ship inside the app and be signed with the app.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="v1.9.5"                                   # pinned release
OUT="vendor/whisper-cli"
if [ -x "$OUT" ] && [ "${1:-}" != "--force" ]; then echo "$OUT already built (use --force to rebuild)"; exit 0; fi
command -v cmake >/dev/null || { echo "cmake is required: brew install cmake" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp.git "$WORK/src" 2>/dev/null
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_ACCELERATE=ON -DGGML_BLAS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 >/dev/null
cmake --build "$WORK/build" -j 8 --target whisper-cli >/dev/null
mkdir -p vendor
cp "$WORK/build/bin/whisper-cli" "$OUT"
# Refuse a binary that depends on anything outside the system (a Homebrew dylib would not exist on other Macs).
if otool -L "$OUT" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/System/Library/|/usr/lib/)' ; then echo "whisper-cli links a non-system library" >&2; rm -f "$OUT"; exit 1; fi
echo "Built $OUT ($(du -h "$OUT" | cut -f1)), whisper.cpp $TAG"
