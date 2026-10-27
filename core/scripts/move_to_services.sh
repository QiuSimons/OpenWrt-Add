#!/usr/bin/env bash
# ==============================================================================
# 将各类 VPN 菜单项归一化移动至 LuCI 的 "服务 (services)" 菜单栏下
# ==============================================================================

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

echo "[Menu] 正在整理 LuCI 菜单目录 (VPN -> Services)..."

find "$REPO_ROOT" -type f \( -name "*.lua" -o -name "*.htm" -o -name "*.json" \) ! -path "*/.*/*" ! -path "*/core/*" | while read -r f; do
    if grep -qE '"vpn"|"VPN"|\[\[vpn\]\]|admin/vpn' "$f" 2>/dev/null; then
        sed -i 's,"vpn","services",g; s,"VPN","services",g; s,\[\[vpn\]\],\[\[services\]\],g; s,admin/vpn,admin/services,g' "$f"
    fi
done

echo "[Menu] 菜单整理完成。"
exit 0
