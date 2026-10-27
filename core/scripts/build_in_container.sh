#!/usr/bin/env bash
set -e

# 1. 宿主编译依赖补齐 (vmlinux-btf 需要 pahole 对 shadow BTF 编码)
if command -v apt-get >/dev/null 2>&1; then
    if [ -f /etc/debian_version ] && grep -q "^11" /etc/debian_version; then
        printf "deb [check-valid-until=no trusted=yes] http://archive.debian.org/debian/ bullseye main\ndeb [check-valid-until=no trusted=yes] http://archive.debian.org/debian-security/ bullseye-security main\n" > /etc/apt/sources.list
        rm -rf /etc/apt/sources.list.d/*
    fi
    apt-get update -o Acquire::Check-Valid-Until=false || apt-get update
    apt-get install -y --no-install-recommends dwarves || apt-get install -y pahole
    rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache dwarves
fi

pahole_bin="$(command -v pahole || which pahole || true)"
if [ -n "$pahole_bin" ] && [ -x "$pahole_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$pahole_bin" /builder/staging_dir/host/bin/pahole
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

# 只发布其中一个互斥变体的包：sing-box 发 tiny（custom.sh 的
# patch_singbox_tiny.sh 已把它设为默认，宿主机的 prebuild_host.sh 也只编 tiny）。
# 必须同时从 expected 清单排除，否则 manifest 闸门会向它要 apk。
SKIP_PKGS="sing-box"

mkdir -p /artifacts/manifest
: > /artifacts/manifest/expected.txt
for p in $pkgs; do
    case " $SKIP_PKGS " in
        *" $p "*) echo "skip package (not published here): $p"; continue ;;
    esac
    echo "CONFIG_PACKAGE_$p=m" >> .config
    echo "$p" >> /artifacts/manifest/expected.txt
done
sort -u -o /artifacts/manifest/expected.txt /artifacts/manifest/expected.txt
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

# ---------------------------------------------------------------------------
# 预编译契约校验：宿主机预编译的二进制必须与 defconfig 实际选择一致。
# 一旦上游 Makefile 变更默认特性，这里会立刻失败，而不是静默发布功能缺失的包。
# ---------------------------------------------------------------------------
grep -E '^CONFIG_PACKAGE_[A-Za-z0-9_.+-]+=[ym]$' .config \
    | sed 's/^CONFIG_PACKAGE_//; s/=[ym]$//' | sort -u > /artifacts/manifest/enabled.txt

contract_fail=0
if grep -qE '^CONFIG_PACKAGE_sing-box=[ym]$' .config; then
    echo "::error::sing-box(full 变体) 被启用，但 core/scripts/prebuild_host.sh 只预编译了 tiny 变体"
    contract_fail=1
fi
for c in EINAT_EBPF_BACKEND_LIBBPF EINAT_EBPF_BINDGEN EINAT_EBPF_STATIC; do
    if grep -qE "^CONFIG_${c}=y$" .config; then
        echo "::error::${c} 已启用，宿主机预编译的 einat 不含该特性"
        contract_fail=1
    fi
done
# sing-box tiny 的标签集合必须与预编译时使用的完全一致
built_tags=" CLASH_API GVISOR QUIC UTLS WIREGUARD "
for c in $(grep -oE '^CONFIG_SING_BOX_TINY_BUILD_[A-Z0-9_]+=y$' .config \
             | sed 's/^CONFIG_SING_BOX_TINY_BUILD_//; s/=y$//'); do
    case "$built_tags" in
        *" $c "*) ;;
        *) echo "::error::sing-box tiny 特性 ${c} 已启用，但预编译未包含（更新 prebuild_host.sh 的 tags）"
           contract_fail=1 ;;
    esac
done
if [ "$contract_fail" -ne 0 ]; then
    echo "::error::预编译契约校验失败，终止以避免发布与目标不一致的二进制"
    exit 1
fi

# 全核心高并发编译，彻底移除 -j1 单线程串行回退，个别包异常毫秒级隔离
IGNORE_ERRORS=1 make package/compile -j$(($(nproc) + 1)) || true

mkdir -p /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
