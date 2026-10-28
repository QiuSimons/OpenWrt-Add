#!/bin/sh
# OpenWrt 路由器清理 /overlay 分区脚本 (切勿在 PC/开发机运行)

if [ -d "/overlay" ]; then
    OVERLAY_DIR="/overlay"
else
    OVERLAY_DIR="/rom/overlay"
fi

if [ ! -d "$OVERLAY_DIR/upper" ]; then
    echo "错误: 未检测到 OpenWrt overlay/upper 目录，终止执行以防止误删！"
    exit 1
fi

cd "$OVERLAY_DIR" || exit 1
rm -rf $(ls | grep -Ev '(upper|.fs_state)')

cd "$OVERLAY_DIR/upper" || exit 1
rm -rf $(ls | grep -Ev '(etc|usr)')

cd "$OVERLAY_DIR/upper/usr" || exit 1
rm -rf $(ls | grep -Ev '(share)')

cd "$OVERLAY_DIR/upper/usr/share" || exit 1
rm -rf $(ls | grep -Ev '(unblockneteasemusic|passwall)')

cd "$OVERLAY_DIR/upper/etc" || exit 1
rm -rf $(ls | grep -Ev '(config|honk|nikki|zerotier|dae|daed|daed-next|smartdns|ssrplus|bench.log|shadow|openclash|fucked|autotimeset)')

cd "$OVERLAY_DIR/upper/etc/config" || exit 1
rm -rf $(ls | grep -Ev '(ap_modem|honk|nikki|homeproxy|dae|daed|daed-next|arpbind|autoreboot|ddns|firewall|jd-dailybonus|network|oled|openclash|passwall|serverchan|shadowsocksr|sqm|unblockneteasemusic|weburl|zerotier|vssr|zero|dhcp|mosdns|appfilter|fstab|watchcat)')

echo "Overlay 已清理完毕，5 秒后重启..."
sleep 5 && touch /etc/banner && reboot
