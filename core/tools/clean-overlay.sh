#!/bin/sh
# OpenWrt 路由器清理 /overlay 分区脚本 (切勿在 PC/开发机运行)
set -e

if [ -d "/overlay" ]; then
    OVERLAY_DIR="/overlay"
elif [ -d "/rom/overlay" ]; then
    OVERLAY_DIR="/rom/overlay"
else
    echo "错误: 未检测到 /overlay 分区，终止执行！"
    exit 1
fi

if [ ! -d "$OVERLAY_DIR/upper" ]; then
    echo "错误: 未检测到 OpenWrt overlay/upper 目录，终止执行以防止误删！"
    exit 1
fi

clean_except() {
    local dir="$1"
    local keep_pattern="$2"
    [ -d "$dir" ] || return 0
    (
        cd "$dir" 2>/dev/null || return 0
        for item in * .*; do
            [ -e "$item" ] || continue
            case "$item" in .|..) continue ;; esac
            if ! echo "$item" | grep -qE "^($keep_pattern)$"; then
                rm -rf "$item"
            fi
        done
    )
}

clean_except "$OVERLAY_DIR" 'upper|\.fs_state'
clean_except "$OVERLAY_DIR/upper" 'etc|usr'
clean_except "$OVERLAY_DIR/upper/usr" 'share'
clean_except "$OVERLAY_DIR/upper/usr/share" 'unblockneteasemusic|passwall'
clean_except "$OVERLAY_DIR/upper/etc" 'config|honk|nikki|zerotier|dae|daed|daed-next|smartdns|ssrplus|bench\.log|shadow|openclash|fucked|autotimeset'
clean_except "$OVERLAY_DIR/upper/etc/config" 'ap_modem|honk|nikki|homeproxy|dae|daed|daed-next|arpbind|autoreboot|ddns|firewall|jd-dailybonus|network|oled|openclash|passwall|serverchan|shadowsocksr|sqm|unblockneteasemusic|weburl|zerotier|vssr|zero|dhcp|mosdns|appfilter|fstab|watchcat'

echo "Overlay 已清理完毕，5 秒后重启..."
sleep 5 && touch /etc/banner && reboot
