#!/usr/bin/env bash
set -e

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

echo "[Includes] 修复 Makefile 中的相对 include 路径..."

while IFS= read -r -d "" mf; do
    sed -i \
        -e 's|^[[:space:]]*include[[:space:]]\+\.\./\.\./luci\.mk[[:space:]]*$|include $(TOPDIR)/feeds/luci/luci.mk|' \
        -e 's|^[[:space:]]*include[[:space:]]\+\.\./\.\./rules\.mk[[:space:]]*$|include $(TOPDIR)/rules.mk|' \
        "$mf"
done < <(find . -name Makefile -not -path './.git/*' -print0)

echo "[Includes] 完成。"

exit 0
