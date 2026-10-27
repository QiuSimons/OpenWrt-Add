#!/usr/bin/env bash
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MAKEFILE="$REPO_ROOT/apps/imm_pkg/sing-box/Makefile"

[ -f "$MAKEFILE" ] || exit 0

# Kconfig 块不识别 DEFAULT_VARIANT，误插入会导致 defconfig 语法错误
sed -i '/^define Package\/sing-box-tiny\/config$/,/^endef$/ { /DEFAULT_VARIANT/d }' "$MAKEFILE"
sed -i '/^define Package\/sing-box\/config$/,/^endef$/ { /DEFAULT_VARIANT/d }' "$MAKEFILE"

# full 变体取消默认
sed -i '/^define Package\/sing-box$/,/^endef$/ { /DEFAULT_VARIANT/d }' "$MAKEFILE"

# tiny 变体设为默认
if ! sed -n '/^define Package\/sing-box-tiny$/,/^endef$/p' "$MAKEFILE" | grep -q 'DEFAULT_VARIANT'; then
    sed -i '/^define Package\/sing-box-tiny$/a\  DEFAULT_VARIANT:=1' "$MAKEFILE"
fi
