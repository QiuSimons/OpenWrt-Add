#!/usr/bin/env bash

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MAKEFILE="$REPO_ROOT/apps/imm_pkg/sing-box/Makefile"

if [ ! -f "$MAKEFILE" ]; then
    exit 0
fi

# Remove DEFAULT_VARIANT from full variant
sed -i '/define Package\/sing-box$/,/endef/ { /DEFAULT_VARIANT:=1/d }' "$MAKEFILE"

# Add DEFAULT_VARIANT to tiny variant
if ! grep -A 10 'define Package/sing-box-tiny' "$MAKEFILE" | grep -q 'DEFAULT_VARIANT:=1'; then
    sed -i '/define Package\/sing-box-tiny/a \  DEFAULT_VARIANT:=1' "$MAKEFILE"
fi
