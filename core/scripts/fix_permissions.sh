#!/usr/bin/env bash
# ==============================================================================
# 规范化文件与目录权限 (保持与仓库 Git 索引及 OpenWrt 编译树一致)
# ==============================================================================

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

echo "[Permissions] 正在规范化目录与文件权限..."

# 保持文件权限与仓库索引 (100755) 一致
find "$REPO_ROOT" -type d ! -path "*/.*/*" -exec chmod 755 {} +
find "$REPO_ROOT" -type f ! -path "*/.*/*" -exec chmod 755 {} +

echo "[Permissions] 权限规范化完成。"
exit 0
