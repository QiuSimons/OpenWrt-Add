#!/usr/bin/env bash
set -e

# 1. 宿主编译依赖补齐 (vmlinux-btf 需要 pahole 和 llvm-objcopy 对 shadow BTF 编码)
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
    echo "Using pahole binary: $pahole_bin ($("$pahole_bin" --version 2>/dev/null || true))"
fi

llvm_objcopy_bin="$(command -v llvm-objcopy || find /usr/bin -name 'llvm-objcopy*' 2>/dev/null | head -n 1 || true)"
if [ -n "$llvm_objcopy_bin" ]; then
    mkdir -p /builder/staging_dir/host/bin
    ln -sf "$llvm_objcopy_bin" /builder/staging_dir/host/bin/llvm-objcopy
    echo "Using llvm-objcopy: $llvm_objcopy_bin"
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
sed -i -e 's,https://git.openwrt.org/feed/,https://github.com/openwrt/,' -e 's,https://git.openwrt.org/openwrt/,https://github.com/openwrt/,' -e 's,https://git.openwrt.org/project/,https://github.com/openwrt/,' feeds.conf
echo "src-link custom /feed" >> feeds.conf

# base 在这个版本里是一个 feed（feeds.conf.default 里就列着），而 SDK 自带的
# package/ 只有 kernel 与 toolchain。不装 base 的话，libopenssl / pcre2 /
# argp-standalone / lua / json-c / ucode / libbpf 这些依赖在构建系统里
# "does not exist"，头文件也进不了 staging，所有相关包连锁编译失败。
./scripts/feeds update base packages luci custom

# 先按 feeds.conf 顺序装全部包（让 base 的依赖可解析），再用 custom 覆盖同名包，
# 保证我们这些定制过的 luci-app-* 不被上游版本顶掉。
./scripts/feeds install -a
./scripts/feeds install -a -p custom

# 上游 packages feed 自带一个 full 变体的 sing-box（net/sing-box），而本 feed
# 只发布 tiny 版本，且包名不同（sing-box-tiny，靠 PROVIDES 提供 sing-box 这个名字），
# 因此 -p custom 覆盖不到它。把它从构建树里移除，否则 full 会被真的构建并发布。
./scripts/feeds uninstall sing-box 2>/dev/null || true
if [ -e package/feeds/packages/sing-box ]; then
    echo "::error::上游 sing-box 仍留在构建树中"
    exit 1
fi

# 用预编译 node 替换 SDK 内置的源码编译版。版本跟随仓库同步的 feed，
# 不再在构建时访问 GitHub API（无认证会被限流，失败时还会静默降级）。
if [ -d /node_prebuilt ] && [ -f /node_prebuilt/Makefile ]; then
    rm -rf feeds/packages/lang/node
    cp -rf /node_prebuilt feeds/packages/lang/node
fi

[ -f feeds/packages/lang/golang/golang-package.mk ] || {
    echo "feeds/packages missing after feeds update"; exit 1; }

# 精确获取 custom feed 下所有有效包名并启用编译
# 互斥变体（如 sing-box full）已在 apply_prebuilt.sh 中按 drop-packages.conf 摘除，
# 不会出现在这个列表里。
# -r <feed> 列该 feed 的包；-s 列的是 feed 名与 URL。list_feed 还会输出 TARGET: 行。
pkgs=$(./scripts/feeds list -r custom | grep -v '^TARGET:' | awk 'NF {print $1}' | sort -u)
[ -n "$pkgs" ] || { echo "::error::custom feed 里没有解析到任何包"; exit 1; }
echo "packages in custom feed: $(echo "$pkgs" | wc -l)"
for p in $pkgs; do
    echo "CONFIG_PACKAGE_$p=m" >> .config
done
echo "CONFIG_PACKAGE_node=m" >> .config

# 关掉 AUTOREMOVE：开启时每个构建目录先跑 check-depends，判定脏就 clean-build，
# 会把 SDK 预置的内核头/工具链目录清掉，导致 vmlinux-btf 与 luci 模块连锁失败
echo "# CONFIG_AUTOREMOVE is not set" >> .config

# luci.mk 会按这些开关拉 host 工具（csstidy/host、ucode/host、luasrcdiet/host），
# 而 SDK 里没有对应源码（package/ 只有 kernel 与 toolchain），全关掉
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

# ---------------------------------------------------------------------------
# 预编译契约校验：宿主机预编译的二进制必须与 defconfig 实际选择一致。
# 一旦上游 Makefile 变更默认特性，这里会立刻失败，而不是静默发布功能缺失的包。
# ---------------------------------------------------------------------------
# manifest 闸门只针对"本 feed 的包"（feeds 列出的）中 kconfig 真正启用的那些。
# defconfig 会因为架构/内核符号不满足而丢掉个别包，那些是结构性不可构建，
# 单列出来供排查，不作为失败条件。
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
# sing-box 只发 tiny：full 的 BuildPackage 已被 apply_prebuilt 按 drop-packages.conf 摘除。
# 注意 .config 里的 CONFIG_PACKAGE_sing-box 可能只是 tiny 的 PROVIDES 产生的虚拟符号
# （homeproxy 的 +sing-box 依赖会 select 它），不代表 full 的真实包被构建。
# 因此判定依据是"真实包是否仍在构建系统里"，而不是这个符号。
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
# sing-box tiny 的标签集合必须与预编译时使用的完全一致：
# 以产物里的 tags.txt 为准，容器侧不再另存一份清单
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

# ---------------------------------------------------------------------------
# 逐包编译，不用 make package/compile
#
# package/Makefile 里有 "package-y += kernel/linux"，make package/compile 会把
# package/kernel/linux、package/toolchain 一起卷进来（配上前面的 AUTOREMOVE
# 关闭仍然没必要），因此只构建本 feed 装出来的包目录。
# ---------------------------------------------------------------------------
targets=""
for d in package/feeds/custom/*; do
    [ -e "$d" ] || continue
    targets="$targets package/feeds/custom/$(basename "$d")/compile"
done
[ -n "$targets" ] || { echo "::error::no build targets (feeds install 失败?)"; exit 1; }
echo "build targets: $(echo $targets | wc -w) package dir(s)"

# -k: 前置依赖失败不中止整轮，由 manifest 闸门判定哪些包真的缺了
# shellcheck disable=SC2086
IGNORE_ERRORS=1 make -k -j"$(( $(nproc) + 1 ))" $targets 2>&1 | tee /tmp/build.log || true

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
        make "$tgt/compile" V=s 2>&1 | tee "$out" || true
    done < /tmp/failed.txt

fi

mkdir -p /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
