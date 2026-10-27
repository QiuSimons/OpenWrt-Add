#!/usr/bin/env bash
set -e

# 1. 宿主编译依赖补齐 (vmlinux-btf / FlowCone 所需工具链)
if command -v apt-get >/dev/null 2>&1; then
    if [ -f /etc/debian_version ] && grep -q "^11" /etc/debian_version; then
        printf "deb [check-valid-until=no trusted=yes] http://archive.debian.org/debian/ bullseye main\ndeb [check-valid-until=no trusted=yes] http://archive.debian.org/debian-security/ bullseye-security main\n" > /etc/apt/sources.list
        rm -rf /etc/apt/sources.list.d/*
    fi
    apt-get update -o Acquire::Check-Valid-Until=false || apt-get update
    apt-get install -y --no-install-recommends dwarves llvm || apt-get install -y dwarves llvm || apt-get install -y pahole
    rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache dwarves
fi

pahole_bin="$(command -v pahole || which pahole || true)"
if [ -n "$pahole_bin" ] && [ -x "$pahole_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$pahole_bin" /builder/staging_dir/host/bin/pahole
fi

llvm_objcopy_bin="$(command -v llvm-objcopy || find /usr/bin -name 'llvm-objcopy*' 2>/dev/null | head -n 1 || true)"
if [ -n "$llvm_objcopy_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$llvm_objcopy_bin" /builder/staging_dir/host/bin/llvm-objcopy
fi

# 2. 以 buildbot 用户运行 SDK 编译
chown -R 1000:1000 /builder /artifacts

cat > /tmp/inner.sh <<'INNER_EOF'
set -e

[ ! -f setup.sh ] || bash setup.sh

# 保留官方 feeds 并追加本地 feed，否则 feeds/packages 下的 lang/golang 等 include 无法解析
[ -f feeds.conf.default ] || { echo "feeds.conf.default missing"; exit 1; }
cp feeds.conf.default feeds.conf
sed -i \
    -e 's,https://git.openwrt.org/feed/,https://github.com/openwrt/,' \
    -e 's,https://git.openwrt.org/openwrt/,https://github.com/openwrt/,' \
    -e 's,https://git.openwrt.org/project/,https://github.com/openwrt/,' \
    feeds.conf
echo "src-link custom /feed" >> feeds.conf

./scripts/feeds update -a
./scripts/feeds install -a -p custom

[ -f feeds/packages/lang/golang/golang-package.mk ] || {
    echo "feeds/packages missing after feeds update"; exit 1; }

pkgs=$(find /feed -type f -name Makefile -exec grep -H '^PKG_NAME:=' {} + | awk -F':=' '{print $2}' | tr -d '[:space:]' | sort -u)
for p in $pkgs; do
    echo "CONFIG_PACKAGE_$p=m" >> .config
done

if ! make defconfig > /tmp/defconfig.log 2>&1; then
    cat /tmp/defconfig.log
    echo "---------- context ----------"
    for n in $(grep -oE '\.config-package\.in:[0-9]+' /tmp/defconfig.log | cut -d: -f2 | sort -un); do
        echo "== around $n =="
        sed -n "$((n - 4)),$((n + 4))p" tmp/.config-package.in 2>/dev/null || true
    done
    exit 1
fi

make package/compile -j$(nproc) IGNORE_ERRORS=1 || make package/compile -j1 IGNORE_ERRORS=1 V=s || true

mkdir -p /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
