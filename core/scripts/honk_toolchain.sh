#!/usr/bin/env bash
# ==============================================================================
# honk_toolchain.sh - Resolve the toolchain pins for the honk commit we build
#
# Reads HONK_SRC_URL / HONK_SRC_VERSION from apps/luci-app-honk/honk/Makefile
# and prints the versions upstream pins for that exact commit:
#   .github/ci/pins.env          -> BPF_LINKER_VERSION / BPF_LINKER_SHA256
#   .github/workflows/release.yml -> the setup-zig version
#
# Usage:
#   eval "$(./core/scripts/honk_toolchain.sh)"
#   ./core/scripts/honk_toolchain.sh /path/to/honk/Makefile
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MAKEFILE="${1:-${HONK_MAKEFILE:-$REPO_ROOT/apps/luci-app-honk/honk/Makefile}}"

[ -f "$MAKEFILE" ] || {
  echo "ERROR: Makefile not found: $MAKEFILE" >&2
  exit 1
}

URL=$(grep -E '^[[:space:]]*(HONK_SRC_URL|PKG_SOURCE_URL):=' "$MAKEFILE" | head -n 1 | cut -d= -f2 | tr -d '[:space:]')
REV=$(grep -E '^[[:space:]]*(HONK_SRC_VERSION|PKG_SOURCE_VERSION):=' "$MAKEFILE" | head -n 1 | cut -d= -f2 | tr -d '[:space:]')
[ -n "$URL" ] && [ -n "$REV" ] || {
  echo "ERROR: HONK_SRC_URL / HONK_SRC_VERSION missing in $MAKEFILE" >&2
  exit 1
}

REPO_PATH="${URL#https://github.com/}"
REPO_PATH="${REPO_PATH%.git}"
RAW="https://raw.githubusercontent.com/${REPO_PATH}/${REV}"

fetch() {
  curl -fsSL --retry 3 "$1" || {
    echo "ERROR: failed to fetch $1" >&2
    exit 1
  }
}

PINS="$(fetch "${RAW}/.github/ci/pins.env")"
BPF_LINKER_VERSION=$(printf '%s\n' "$PINS" | sed -n 's/^BPF_LINKER_VERSION=//p' | head -n 1)
BPF_LINKER_SHA256=$(printf '%s\n' "$PINS" | sed -n 's/^BPF_LINKER_SHA256=//p' | head -n 1)
[ -n "$BPF_LINKER_VERSION" ] && [ -n "$BPF_LINKER_SHA256" ] || {
  echo "ERROR: BPF_LINKER_VERSION / BPF_LINKER_SHA256 missing in ${RAW}/.github/ci/pins.env" >&2
  exit 1
}

RELEASE_YML="$(fetch "${RAW}/.github/workflows/release.yml")"
ZIG_VERSION=$(printf '%s\n' "$RELEASE_YML" | awk '
  /setup-zig/ { seen = 1; next }
  seen && /^[[:space:]]*version:[[:space:]]*/ {
    sub(/^[[:space:]]*version:[[:space:]]*/, "")
    gsub(/[[:space:]"]/, "")
    print
    exit
  }
')
[ -n "$ZIG_VERSION" ] || {
  echo "ERROR: could not resolve the zig version from ${RAW}/.github/workflows/release.yml" >&2
  exit 1
}

printf 'BPF_LINKER_VERSION=%s\nBPF_LINKER_SHA256=%s\nZIG_VERSION=%s\n' \
  "$BPF_LINKER_VERSION" "$BPF_LINKER_SHA256" "$ZIG_VERSION"
