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
# 互斥变体（如 sing-box full）已在 apply_prebuilt.sh 中按 drop-packages.conf 摘除，
# 不会出现在这个列表里。
pkgs=$(./scripts/feeds list -s custom | awk '{print $1}')
for p in $pkgs; do
    echo "CONFIG_PACKAGE_$p=m" >> .config
done
echo "CONFIG_PACKAGE_node=m" >> .config

# 记录计划编译的包清单，供宿主机侧 manifest 闸门比对
mkdir -p /artifacts/manifest
printf '%s\n' $pkgs | sort -u > /artifacts/manifest/expected.txt

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
    echo '--- who selects it ---'
    grep -n 'PACKAGE_sing-box' tmp/.config-package.in 2>/dev/null | head -n 20 || true
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

# ---------------------------------------------------------------------------
# 逐包编译，不用 make package/compile
#
# package/Makefile 里有 "package-y += kernel/linux"，所以 make package/compile
# 一定会把 package/kernel/linux、package/toolchain 一起处理；CONFIG_AUTOREMOVE
# 判定脏了会先 clean-build，把 SDK 预置的内核头清掉，依赖 $(LINUX_DIR) 的
# vmlinux-btf 必挂。改为只构建本 feed 装出来的包目录。
# ---------------------------------------------------------------------------
targets=""
for d in package/feeds/custom/*; do
    [ -e "$d" ] || continue
    targets="$targets package/feeds/custom/$(basename "$d")/compile"
done
[ -n "$targets" ] || { echo "::error::no build targets (feeds install 失败?)"; exit 1; }
echo "build targets:$targets"

# shellcheck disable=SC2086
IGNORE_ERRORS=1 make -j"$(( $(nproc) + 1 ))" $targets 2>&1 | tee /tmp/build.log || true

mkdir -p /artifacts/logs
cp /tmp/build.log /artifacts/logs/00-build.log

# 失败的包单独复跑一次带 V=s，日志留档，避免下次还要靠猜
grep -oE 'ERROR: package/[^ ]+ .*failed to build' /tmp/build.log 2>/dev/null \
    | awk '{print $2}' | sort -u > /tmp/failed.txt || true
if [ -s /tmp/failed.txt ]; then
    echo "failed packages:"
    sed 's/^/  /' /tmp/failed.txt
    while IFS= read -r tgt; do
        [ -n "$tgt" ] || continue
        out="/artifacts/logs/$(echo "$tgt" | sed 's|^package/||; s|/|_|g').log"
        echo "=== re-running $tgt/compile V=s -> $out ==="
        make "$tgt/compile" V=s > "$out" 2>&1 || true
    done < /tmp/failed.txt
fi

mkdir -p /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
