#!/usr/bin/env bash
# ==============================================================================
# 自动标准化 LuCI APP 的语言包目录 (zh-cn/zh-tw -> zh_Hans/zh_Hant)
# 适配现代 OpenWrt (21.02/23.05/24.10/25.12+) 的 luci.mk 语言标准
# ==============================================================================

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1
REPO_ROOT="$PWD"

echo "[i18n] 正在检查并标准化 LuCI 语言包目录..."

find "$REPO_ROOT" -type d -name "po" ! -path "*/.*/*" ! -path "*/core/*" | while read -r po_dir; do
    # zh-cn -> zh_Hans
    if [ -d "$po_dir/zh-cn" ] && [ ! -e "$po_dir/zh_Hans" ]; then
        ln -sf "zh-cn" "$po_dir/zh_Hans"
        echo "  + 补齐语言映射: $(realpath --relative-to="$REPO_ROOT" "$po_dir")/zh_Hans -> zh-cn"
    fi

    # zh-tw -> zh_Hant
    if [ -d "$po_dir/zh-tw" ] && [ ! -e "$po_dir/zh_Hant" ]; then
        ln -sf "zh-tw" "$po_dir/zh_Hant"
        echo "  + 补齐语言映射: $(realpath --relative-to="$REPO_ROOT" "$po_dir")/zh_Hant -> zh-tw"
    fi
done

echo "[i18n] 语言包目录标准化完成。"
exit 0

