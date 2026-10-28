#!/usr/bin/env bash
set -e

# 安装 pahole 和 llvm-objcopy 供 vmlinux-btf 编码
if command -v apt-get >/dev/null 2>&1; then
    if [ -f /etc/debian_version ] && grep -q "^11" /etc/debian_version; then
        printf "deb [check-valid-until=no trusted=yes] http://archive.debian.org/debian/ bullseye main\ndeb [check-valid-until=no trusted=yes] http://archive.debian.org/debian-security/ bullseye-security main\n" > /etc/apt/sources.list
        rm -rf /etc/apt/sources.list.d/*
    fi
    apt-get update -o Acquire::Check-Valid-Until=false || apt-get update
    apt-get install -y --no-install-recommends dwarves llvm || apt-get install -y dwarves llvm || apt-get install -y pahole
    rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache dwarves llvm
fi

pahole_bin="$(command -v pahole || which pahole || true)"
if [ -n "$pahole_bin" ] && [ -x "$pahole_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$pahole_bin" /builder/staging_dir/host/bin/pahole
    echo "Using pahole binary: $pahole_bin ($("$pahole_bin" --version 2>/dev/null || true))"
fi

llvm_objcopy_bin="$(command -v llvm-objcopy || find /usr/bin -name 'llvm-objcopy*' 2>/dev/null | head -n 1 || true)"
if [ -n "$llvm_objcopy_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$llvm_objcopy_bin" /builder/staging_dir/host/bin/llvm-objcopy
    echo "Using llvm-objcopy: $llvm_objcopy_bin"
fi

chown -R 1000:1000 /builder /artifacts

cat > /tmp/inner.sh <<'INNER_EOF'
set -e

# 清除 CI 环境变量
export CI=""
export GITHUB_ACTIONS=""

[ ! -f setup.sh ] || bash setup.sh

[ -f feeds.conf.default ] || { echo "feeds.conf.default missing"; exit 1; }
cp feeds.conf.default feeds.conf
sed -i -e 's,https://git.openwrt.org/feed/,https://github.com/openwrt/,' -e 's,https://git.openwrt.org/openwrt/,https://github.com/openwrt/,' -e 's,https://git.openwrt.org/project/,https://github.com/openwrt/,' feeds.conf
echo "src-link custom /feed" >> feeds.conf

# OpenWrt 25.x SDK 中 base 为独立 feed，需更新以提供基础库依赖
./scripts/feeds update base packages luci custom

# 安装全部 feed 包，并用 custom feed 覆盖同名包
./scripts/feeds install -a
./scripts/feeds install -f -a -p custom

# 移除上游 packages feed 中的 sing-box full 变体，避免与 custom feed 的 tiny 变体冲突
./scripts/feeds uninstall sing-box 2>/dev/null || true
if [ -e package/feeds/packages/sing-box ]; then
    echo "::error::上游 sing-box 仍留在构建树中"
    exit 1
fi

# 使用预编译 node 替换源码版
if [ -d /node_prebuilt ] && [ -f /node_prebuilt/Makefile ]; then
    rm -rf feeds/packages/lang/node
    cp -rf /node_prebuilt feeds/packages/lang/node
fi

[ -f feeds/packages/lang/golang/golang-package.mk ] || {
    echo "feeds/packages missing after feeds update"; exit 1; }

# 获取 custom feed 包列表并写入 .config
pkgs=$(./scripts/feeds list -r custom | grep -v '^TARGET:' | awk 'NF {print $1}' | sort -u)
[ -n "$pkgs" ] || { echo "::error::custom feed 里没有解析到任何包"; exit 1; }
echo "packages in custom feed: $(echo "$pkgs" | wc -l)"
for p in $pkgs; do
    echo "CONFIG_PACKAGE_$p=m" >> .config
done
echo "CONFIG_PACKAGE_node=m" >> .config

# 禁用 AUTOREMOVE，防止 clean-build 清理 SDK 预置内核头与工具链
echo "# CONFIG_AUTOREMOVE is not set" >> .config

# 禁用 SDK 中无源码的 LuCI host 工具
for opt in LUCI_CSSTIDY LUCI_UTMIN LUCI_SRCDIET; do
    echo "# CONFIG_$opt is not set" >> .config
done

mkdir -p /artifacts/manifest

if ! make defconfig > /tmp/defconfig.log 2>&1; then
    cat /tmp/defconfig.log
    echo "---------- context ----------"
    for n in $(grep -oE '.config-package.in:[0-9]+' /tmp/defconfig.log | cut -d: -f2 | sort -un); do
        echo "== around $n =="
        sed -n "$((n - 4)),$((n + 4))p" tmp/.config-package.in 2>/dev/null || true
    done
    exit 1
fi

# 记录 defconfig 实际启用的 custom 包列表
: > /artifacts/manifest/expected.txt
for p in $pkgs; do
    if grep -qxE "CONFIG_PACKAGE_$p=[ym]" .config; then
        echo "$p" >> /artifacts/manifest/expected.txt
    else
        echo "not enabled by defconfig (skipped): $p"
    fi
done
echo "manifest expects $(wc -l < /artifacts/manifest/expected.txt) package(s)"

contract_fail=0
# 校验 tmp/.packageinfo 中是否残留 sing-box full 变体
if [ ! -f tmp/.packageinfo ]; then
    echo "::error::tmp/.packageinfo 缺失，无法校验 sing-box 变体"
    contract_fail=1
elif grep -q '^Package: sing-box$' tmp/.packageinfo; then
    echo '--- who selects it ---'
    grep -n 'PACKAGE_sing-box' tmp/.config-package.in 2>/dev/null | head -n 20 || true
    echo "::error::sing-box(full) 的真实包仍在构建系统中，drop-packages.conf 未生效"
    contract_fail=1
elif grep -qE '^CONFIG_PACKAGE_sing-box=[ym]$' .config; then
    echo "note: CONFIG_PACKAGE_sing-box 仅由 tiny 的 PROVIDES 提供（虚拟符号），full 不会被构建"
fi
for c in EINAT_EBPF_BACKEND_LIBBPF EINAT_EBPF_BINDGEN EINAT_EBPF_STATIC; do
    if grep -qE "^CONFIG_${c}=y$" .config; then
        echo "::error::${c} 已启用，宿主机预编译的 einat 不含该特性"
        contract_fail=1
    fi
done
# 校验 sing-box tiny 实际启用的特性与预编译 features.txt 一致
if grep -qE '^CONFIG_PACKAGE_sing-box-tiny=[ym]$' .config; then
    if [ ! -f /prebuilt/sing-box/features.txt ]; then
        echo "::error::sing-box tiny 已启用，但 /prebuilt/sing-box/features.txt 不存在"
        contract_fail=1
    else
        for c in $(grep -oE '^CONFIG_SING_BOX_TINY_BUILD_[A-Z0-9_]+=y$' .config \
                     | sed 's/^CONFIG_SING_BOX_TINY_BUILD_//; s/=y$//'); do
            grep -qx "$c" /prebuilt/sing-box/features.txt \
                || { echo "::error::sing-box tiny 特性 $c 已启用，但预编译未包含"; contract_fail=1; }
        done
    fi
fi

if [ "$contract_fail" -ne 0 ]; then
    echo "::error::预编译契约校验失败，终止以避免发布与目标不一致的二进制"
    exit 1
fi

# 针对 custom feed 逐包构建，避免触发全量内核编译
targets=""
for d in package/feeds/custom/*; do
    [ -e "$d" ] || continue
    targets="$targets package/feeds/custom/$(basename "$d")/compile"
done
[ -n "$targets" ] || { echo "::error::no build targets (feeds install 失败?)"; exit 1; }
echo "build targets: $(echo $targets | wc -w) package dir(s)"

# shellcheck disable=SC2086
IGNORE_ERRORS=1 make -k -j"$(( $(nproc) + 1 ))" $targets 2>&1 | tee /tmp/build.log || true

mkdir -p /artifacts/logs
cp /tmp/build.log /artifacts/logs/00-build.log

# 失败的包单独重跑一次并留档日志
grep -oE 'ERROR: package/[^ ]+ .*failed to build' /tmp/build.log 2>/dev/null \
    | awk '{print $2}' | sort -u > /tmp/failed.txt || true
if [ -s /tmp/failed.txt ]; then
    echo "failed packages:"
    sed 's/^/  /' /tmp/failed.txt
    while IFS= read -r tgt; do
        [ -n "$tgt" ] || continue
        out="/artifacts/logs/$(echo "$tgt" | sed 's|^package/||; s|/|_|g').log"
        echo "=== re-running $tgt/compile V=s -> $out ==="
        make "$tgt/compile" V=s 2>&1 | tee "$out" || true
    done < /tmp/failed.txt

fi

mkdir -p /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
find bin/targets/ -name '*.apk' -exec cp -u {} /artifacts/bin/ \; 2>/dev/null || true
if [ -f /artifacts/manifest/expected.txt ]; then
    while IFS= read -r pkg || [ -n "$pkg" ]; do
        [ -n "$pkg" ] || continue
        find bin/ -type f -name "${pkg}-[0-9]*.apk" -exec cp -u {} /artifacts/bin/ \; 2>/dev/null || true
    done < /artifacts/manifest/expected.txt
fi
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
