#!/usr/bin/env bash
# ==============================================================================
# 将预置直连域名白名单合并进 Passwall 与 MosDNS 规则中
# ==============================================================================
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WHITELIST_FILE="$REPO_ROOT/core/assets/whitelist-domains.txt"

if [ ! -f "$WHITELIST_FILE" ]; then
    exit 0
fi

append_domains() {
    local target_file="$1"
    if [ ! -f "$target_file" ]; then
        return 0
    fi

    # 确保目标文件末尾有换行符，防止首个追加域名与原末尾域名粘连
    if [ -s "$target_file" ] && [ "$(tail -c 1 "$target_file" | wc -l)" -eq 0 ]; then
        printf '\n' >> "$target_file"
    fi

    local added=0
    while IFS= read -r domain || [ -n "$domain" ]; do
        [[ "$domain" =~ ^[[:space:]]*# ]] && continue
        domain="$(echo "$domain" | tr -d '[:space:]')"
        [ -z "$domain" ] && continue

        if ! grep -qxF "$domain" "$target_file" 2>/dev/null; then
            echo "$domain" >> "$target_file"
            added=$((added + 1))
        fi
    done < "$WHITELIST_FILE"

    if [ "$added" -gt 0 ]; then
        echo "  + 已向 $(basename "$target_file") 增补 $added 个白名单域名"
    fi
}

echo "[Whitelist] 正在合并直连域名白名单..."

# Passwall
append_domains "$REPO_ROOT/legacy/openwrt_helloworld/luci-app-passwall/root/usr/share/passwall/rules/direct_host"

# MosDNS
append_domains "$REPO_ROOT/apps/luci-app-mosdns/luci-app-mosdns/root/etc/mosdns/rule/whitelist.txt"

echo "[Whitelist] 直连域名白名单处理完毕。"
exit 0
