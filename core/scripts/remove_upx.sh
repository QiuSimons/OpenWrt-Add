#!/usr/bin/env bash
# ==============================================================================
# 清除所有 Makefile 中的 UPX 压缩指令
# ==============================================================================

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

echo "[UPX] 正在检查并清除 Makefile 中的 UPX 指令..."

find "$REPO_ROOT" -type f -name "Makefile" ! -path "*/.*/*" ! -path "*/core/*" | while read -r makefile; do
    if grep -q "upx" "$makefile" 2>/dev/null; then
        sed -i '/upx/d' "$makefile"
        echo "  - 已清除 UPX: $makefile"
    fi
done

echo "[UPX] UPX 清理完成。"
exit 0
