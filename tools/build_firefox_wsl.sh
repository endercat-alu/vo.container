#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/violentmonkey/violentmonkey}"
REF="${REF:-v2.31.3}"

# By default we build in a temporary directory to avoid touching a persistent upstream checkout.
BUILD_DIR="${BUILD_DIR:-}"
KEEP_BUILD="${KEEP_BUILD:-0}"
OUT_DIR="${OUT_DIR:-out}"

# Speed knobs
JOBS="${JOBS:-$(nproc)}"
YARN_CACHE_DIR="${YARN_CACHE_DIR:-.cache/yarn}"

say() { printf '\n%s\n' "$*"; }

# Prefer running from repo root so relative paths work
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p "$YARN_CACHE_DIR"

STAMP_DIR="$ROOT_DIR/.cache/vm-patch"
mkdir -p "$STAMP_DIR"

MIRROR_DIR="$ROOT_DIR/.cache/vm-upstream-mirror.git"
NODE_MODULES_DIR="$ROOT_DIR/.cache/vm-node_modules"
mkdir -p "$NODE_MODULES_DIR"

mkdir -p "$OUT_DIR"

say "> preparing upstream mirror"
if [[ ! -d "$MIRROR_DIR" ]]; then
  git clone --filter=blob:none --mirror "$UPSTREAM_URL" "$MIRROR_DIR"
else
  git --git-dir "$MIRROR_DIR" fetch --prune --tags origin
fi

if [[ -z "$BUILD_DIR" ]]; then
  BUILD_DIR="$(mktemp -d -t vm-build-XXXXXX)"
fi

cleanup() {
  if [[ "$KEEP_BUILD" == "1" ]]; then
    return 0
  fi
  if git --git-dir "$MIRROR_DIR" worktree list --porcelain | grep -Fq "worktree $BUILD_DIR"; then
    git --git-dir "$MIRROR_DIR" worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf "$BUILD_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "> checkout worktree ($REF)"
if [[ -d "$BUILD_DIR" ]]; then
  if [[ -n "$(ls -A "$BUILD_DIR" 2>/dev/null || true)" ]]; then
    say "ERROR: BUILD_DIR is not empty: $BUILD_DIR"
    say "Set BUILD_DIR to an empty directory or unset it to use mktemp."
    exit 2
  fi
else
  mkdir -p "$BUILD_DIR"
fi

git --git-dir "$MIRROR_DIR" worktree add --detach "$BUILD_DIR" "$REF" >/dev/null

# Reuse yarn cache and maximize parallelism
export YARN_CACHE_FOLDER="$ROOT_DIR/$YARN_CACHE_DIR"
export npm_config_jobs="$JOBS"
export MAKEFLAGS="-j$JOBS"

say "> install deps (skip if unchanged)"
LOCK_SRC="$BUILD_DIR/yarn.lock"
LOCK_HASH="$(sha256sum "$LOCK_SRC" | awk '{print $1}')"
LOCK_STAMP="$STAMP_DIR/$LOCK_HASH.sha256"
NODE_MODULES_CACHE_ROOT="$NODE_MODULES_DIR/$LOCK_HASH"
NODE_MODULES_CACHE="$NODE_MODULES_CACHE_ROOT/node_modules"
NODE_MODULES="$BUILD_DIR/node_modules"

# Always point build's node_modules to the cached directory to maximize reuse.
if [[ ! -e "$NODE_MODULES" ]]; then
  mkdir -p "$NODE_MODULES_CACHE"
  ln -s "$NODE_MODULES_CACHE" "$NODE_MODULES"
fi

need_install=1
if [[ -e "$NODE_MODULES" && -f "$LOCK_STAMP" ]]; then
  old="$(cat "$LOCK_STAMP" || true)"
  if [[ "$LOCK_HASH" == "$old" ]]; then
    need_install=0
  fi
fi

if [[ "$need_install" == 1 ]]; then
  if ! (cd "$BUILD_DIR" && yarn --frozen-lockfile --prefer-offline); then
    rm -rf "$NODE_MODULES_CACHE_ROOT" >/dev/null 2>&1 || true
    rm -f "$LOCK_STAMP" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "$LOCK_HASH" > "$LOCK_STAMP"
else
  say "- deps unchanged, skip yarn"
fi

say "> apply AST patch"
node tools/patch_firefox_container_ast.mjs "$BUILD_DIR"

say "> build"
(cd "$BUILD_DIR" && yarn build)

say "> pack"
SAFE_REF="$(echo "$REF" | tr '/\\' '__')"
OUT_XPI="$ROOT_DIR/$OUT_DIR/violentmonkey-firefox-$SAFE_REF.xpi"
rm -f "$OUT_XPI" >/dev/null 2>&1 || true
( cd "$BUILD_DIR/dist" && zip -qr "$OUT_XPI" . )

say "Built: $OUT_XPI"
say "Debug (Firefox): about:debugging -> This Firefox -> Load Temporary Add-on -> $OUT_XPI"
if [[ "$KEEP_BUILD" == "1" ]]; then
  say "KEEP_BUILD=1 so workdir preserved: $BUILD_DIR"
  say "(Alternative) Load manifest: $BUILD_DIR/dist/manifest.json"
fi
