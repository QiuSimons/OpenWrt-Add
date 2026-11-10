#!/usr/bin/env bash
# ==============================================================================
# 规范化文件与目录权限 (对齐仓库 Git 索引模式 100755)
# ==============================================================================
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

echo "[Permissions] 规范化目录与文件权限..."

# 保持与仓库 Git 树索引模式 (100755) 一致，避免产生文件模式变更 diff
find "$REPO_ROOT" -type d ! -path "*/.*/*" -exec chmod 755 {} +
find "$REPO_ROOT" -type f ! -path "*/.*/*" -exec chmod 755 {} +

echo "[Permissions] 完成。"
exit 0

