#!/usr/bin/env bash
set -e

# 1. 宿主编译依赖补齐 (vmlinux-btf 所需 pahole/llvm，以及预编译 rustc/cargo 避免从源码重编译 Rust 工具链)
if command -v apt-get >/dev/null 2>&1; then
    if [ -f /etc/debian_version ] && grep -q "^11" /etc/debian_version; then
        printf "deb [check-valid-until=no trusted=yes] http://archive.debian.org/debian/ bullseye main\ndeb [check-valid-until=no trusted=yes] http://archive.debian.org/debian-security/ bullseye-security main\n" > /etc/apt/sources.list
        rm -rf /etc/apt/sources.list.d/*
    fi
    apt-get update -o Acquire::Check-Valid-Until=false || apt-get update
    apt-get install -y --no-install-recommends dwarves llvm cargo rustc || apt-get install -y dwarves llvm || apt-get install -y pahole
    rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache dwarves cargo rust
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

# 软链接预编译的 cargo/rustc，避免 OpenWrt 重复编译耗时数十倍的 rust/host
cargo_bin="$(command -v cargo || which cargo || true)"
rustc_bin="$(command -v rustc || which rustc || true)"
if [ -n "$cargo_bin" ] && [ -n "$rustc_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$cargo_bin" /builder/staging_dir/host/bin/cargo
    ln -sf "$rustc_bin" /builder/staging_dir/host/bin/rustc
fi

# 2. 授权并启动编译
chown -R 1000:1000 /builder /artifacts

cat > /tmp/inner.sh <<'INNER_EOF'
set -e

# 清除 CI 环境变量，防止某些依赖触发额外严格检查或受限单线程模式
export CI=""
export GITHUB_ACTIONS=""

[ ! -f setup.sh ] || bash setup.sh

# 保留官方 feeds 并追加本地 custom feed
[ -f feeds.conf.default ] || { echo "feeds.conf.default missing"; exit 1; }
cp feeds.conf.default feeds.conf
sed -i     -e 's,https://git.openwrt.org/feed/,https://github.com/openwrt/,'     -e 's,https://git.openwrt.org/openwrt/,https://github.com/openwrt/,'     -e 's,https://git.openwrt.org/project/,https://github.com/openwrt/,'     feeds.conf
echo "src-link custom /feed" >> feeds.conf

# 仅拉取编译所需的核心 feeds (packages, luci, custom)，跳过无关的巨型仓库
./scripts/feeds update packages luci custom
./scripts/feeds install -a -p custom

# 用预编译 node 替换 SDK 内置的源码编译版
if [ -d /node_prebuilt ] && [ -f /node_prebuilt/Makefile ]; then
    rm -rf feeds/packages/lang/node
    cp -rf /node_prebuilt feeds/packages/lang/node
    node_ver=$(curl -fsSL --retry 3 https://api.github.com/repos/sbwml/node_workflow/tags 2>/dev/null | grep '"name"' | head -n 1 | sed -E 's/.*"name": "v([^"]+)".*/\1/')
    if [ -n "$node_ver" ]; then
        sed -i "s|^PKG_VERSION:=.*|PKG_VERSION:=$node_ver|" feeds/packages/lang/node/Makefile
    fi
fi

[ -f feeds/packages/lang/golang/golang-package.mk ] || {
    echo "feeds/packages missing after feeds update"; exit 1; }

# 精确获取 custom feed 下所有有效包名并启用编译
pkgs=$(./scripts/feeds list -s custom | awk '{print $1}')
for p in $pkgs; do
    echo "CONFIG_PACKAGE_$p=m" >> .config
done
echo "CONFIG_PACKAGE_node=m" >> .config

if ! make defconfig > /tmp/defconfig.log 2>&1; then
    cat /tmp/defconfig.log
    echo "---------- context ----------"
    for n in $(grep -oE '.config-package.in:[0-9]+' /tmp/defconfig.log | cut -d: -f2 | sort -un); do
        echo "== around $n =="
        sed -n "$((n - 4)),$((n + 4))p" tmp/.config-package.in 2>/dev/null || true
    done
    exit 1
fi

# 全核心高并发编译，彻底移除 -j1 单线程串行回退，个别包异常毫秒级隔离
IGNORE_ERRORS=1 make package/compile -j$(($(nproc) + 1)) || true

mkdir -p /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
