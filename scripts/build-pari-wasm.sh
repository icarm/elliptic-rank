#!/usr/bin/env bash
# Builds src/gp-sta.js + src/gp-sta.wasm — the PARI/GP module the Worker
# embeds — from upstream PARI sources with Emscripten.
#
# The previous module came from the npm package @sagemath/pari (PARI 2.13.2,
# last published 2021, hardcoded 2GB linear memory that had to be binary-
# patched down for the Worker's 128MB cap). This build replaces it with
# current upstream PARI — 2.15+ is required for ellrank (Allombert's
# 2-descent) — and fixes the linear memory at link time instead of patching.
#
# Requirements: bash (emsdk_env.sh cannot be sourced from dash/sh), node, perl,
# git, curl (emsdk is fetched below).
# Usage: scripts/build-pari-wasm.sh   (from the repo root; ~10 min cold)

set -eu

PARI_VERSION=2.17.2
# emsdk release providing emcc 6.0.9, the toolchain this was last tested with.
EMSDK_VERSION=6.0.9

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${PARI_WASM_BUILD_DIR:-"${TMPDIR:-/tmp}/pari-wasm-build"}
mkdir -p "$WORK"
cd "$WORK"

# --- toolchain ---------------------------------------------------------------
if [ ! -d emsdk ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
fi
./emsdk/emsdk install "$EMSDK_VERSION"
./emsdk/emsdk activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
. ./emsdk/emsdk_env.sh

# --- PARI sources ------------------------------------------------------------
if [ ! -d "pari-$PARI_VERSION" ]; then
  curl -fsSL "https://pari.math.u-bordeaux.fr/pub/pari/unix/pari-$PARI_VERSION.tar.gz" | tar xz
fi
cd "pari-$PARI_VERSION"

# Configure for the portable C kernel under emscripten. RUNTEST=node lets
# Configure execute its compiled-to-.js test programs.
env CC=emcc RUNTEST=node ./Configure \
  --host=wasm32-emscripten --without-gmp --without-readline --graphic=none

cd Oemscripten-wasm32
make -j"$(nproc)" lib-sta

# --- link the embedded module ------------------------------------------------
# Only gp_embedded_init/gp_embedded are exported; the GP interpreter reached
# through them pulls in the whole library. Linear memory is FIXED at 64MB
# (min=max, no growth): a Worker isolate is capped at 128MB and an oversized
# memory section gets it killed at instantiation. gp_embedded_init's stack
# must stay well under 32MB (src/pari.ts uses 16MB). STACK_SIZE=8MB covers
# PARI's C recursion depth.
emcc -O3 -o gp-sta.js libpari.a \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createPariModule \
  -sEXPORTED_FUNCTIONS=_gp_embedded,_gp_embedded_init,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap \
  -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=67108864 \
  -sSTACK_SIZE=8388608 \
  -sENVIRONMENT=node,web,worker

cp gp-sta.js gp-sta.wasm "$REPO_ROOT/src/"
echo "Installed $(wc -c < gp-sta.wasm) byte wasm + glue into $REPO_ROOT/src/"
echo "Now run: node test-verify.mjs && node test-canonical.mjs"
