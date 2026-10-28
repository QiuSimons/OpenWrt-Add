#!/usr/bin/env bash
set -e

# Install pahole and llvm-objcopy for vmlinux-btf encoding
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

chown -R 1000:1000 /builder /artifacts /cached_apks 2>/dev/null || true

cat > /tmp/inner.sh <<'INNER_EOF'
set -e

# Clear CI environment variables
export CI=""
export GITHUB_ACTIONS=""

[ ! -f setup.sh ] || bash setup.sh

[ -f feeds.conf.default ] || { echo "feeds.conf.default missing"; exit 1; }
cp feeds.conf.default feeds.conf
sed -i -e 's,https://git.openwrt.org/feed/,https://github.com/openwrt/,' -e 's,https://git.openwrt.org/openwrt/,https://github.com/openwrt/,' -e 's,https://git.openwrt.org/project/,https://github.com/openwrt/,' feeds.conf
# custom feed takes highest priority
sed -i '1i src-link custom /feed' feeds.conf

# Update base feed for OpenWrt 25.x SDK core dependencies
./scripts/feeds update custom base packages luci

# Install custom feed first to establish symlinks
./scripts/feeds install -f -a -p custom

# Install remaining feeds for dependencies
./scripts/feeds install -a

# Remove conflicting upstream package directories
rm -rf package/feeds/packages/sing-box package/feeds/packages/frp package/feeds/base/r8168 package/kernel/r8168
if [ -e package/feeds/packages/sing-box ]; then
    echo "::error::upstream sing-box remained in build tree"
    exit 1
fi

# Replace source node with prebuilt node
if [ -d /node_prebuilt ] && [ -f /node_prebuilt/Makefile ]; then
    rm -rf feeds/packages/lang/node
    cp -rf /node_prebuilt feeds/packages/lang/node
fi

[ -f feeds/packages/lang/golang/golang-package.mk ] || {
    echo "feeds/packages missing after feeds update"; exit 1; }

# Collect custom feed package list and populate .config
pkgs=$(./scripts/feeds list -r custom | grep -v '^TARGET:' | awk 'NF {print $1}' | sort -u)
[ -n "$pkgs" ] || { echo "::error::no packages found in custom feed"; exit 1; }
echo "packages in custom feed: $(echo "$pkgs" | wc -l)"
for p in $pkgs; do
    echo "CONFIG_PACKAGE_$p=m" >> .config
done
echo "CONFIG_PACKAGE_node=m" >> .config

# Disable AUTOREMOVE to keep SDK kernel headers and toolchains intact
echo "# CONFIG_AUTOREMOVE is not set" >> .config

# Disable LuCI host tools that lack source in SDK
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

# Record custom packages enabled by defconfig
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
# Verify no sing-box full variant remains in tmp/.packageinfo
if [ ! -f tmp/.packageinfo ]; then
    echo "::error::tmp/.packageinfo missing, unable to verify sing-box variant"
    contract_fail=1
elif grep -q '^Package: sing-box$' tmp/.packageinfo; then
    echo '--- who selects it ---'
    grep -n 'PACKAGE_sing-box' tmp/.config-package.in 2>/dev/null | head -n 20 || true
    echo "::error::sing-box full package still present in build tree"
    contract_fail=1
elif grep -qE '^CONFIG_PACKAGE_sing-box=[ym]$' .config; then
    echo "note: CONFIG_PACKAGE_sing-box provided by tiny PROVIDES, full will not build"
fi
for c in EINAT_EBPF_BACKEND_LIBBPF EINAT_EBPF_BINDGEN EINAT_EBPF_STATIC; do
    if grep -qE "^CONFIG_${c}=y$" .config; then
        echo "::error::${c} enabled but host prebuilt einat lacks this feature"
        contract_fail=1
    fi
done
# Verify enabled sing-box tiny features match prebuilt features.txt
if grep -qE '^CONFIG_PACKAGE_sing-box-tiny=[ym]$' .config; then
    if [ ! -f /prebuilt/sing-box/features.txt ]; then
        echo "::error::sing-box tiny enabled but /prebuilt/sing-box/features.txt missing"
        contract_fail=1
    else
        for c in $(grep -oE '^CONFIG_SING_BOX_TINY_BUILD_[A-Z0-9_]+=y$' .config \
                     | sed 's/^CONFIG_SING_BOX_TINY_BUILD_//; s/=y$//'); do
            grep -qx "$c" /prebuilt/sing-box/features.txt \
                || { echo "::error::sing-box tiny feature $c enabled but not in prebuilt"; contract_fail=1; }
        done
    fi
fi

if [ "$contract_fail" -ne 0 ]; then
    echo "::error::prebuilt contract verification failed, aborting"
    exit 1
fi

# Plan incremental build targets
mkdir -p /artifacts/bin
targets=""

if [ -f /core/scripts/incremental_build.py ] && [ -d /cached_apks ]; then
    echo "=== Running incremental build planner ==="
    python3 /core/scripts/incremental_build.py plan \
        --package-dir package/feeds/custom \
        --packageinfo tmp/.packageinfo \
        --manifest /artifacts/manifest/expected.txt \
        --cache-dir /cached_apks \
        --artifacts-bin /artifacts/bin \
        --output-targets /tmp/targets.txt

    if [ -f /tmp/targets.txt ]; then
        targets=$(cat /tmp/targets.txt)
    fi
else
    for d in package/feeds/custom/*; do
        [ -e "$d" ] || continue
        targets="$targets package/feeds/custom/$(basename "$d")/compile"
    done
fi

mkdir -p /artifacts/logs

if [ -n "$targets" ]; then
    echo "build targets: $(echo $targets | wc -w) package dir(s) need compile"
    # shellcheck disable=SC2086
    IGNORE_ERRORS=1 make -k -j"$(( $(nproc) + 1 ))" $targets 2>&1 | tee /tmp/build.log || true

    # Re-run failed packages individually with verbose logging
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
else
    echo "=== [INCREMENTAL] All packages cached, skip compile ==="
    touch /tmp/build.log
fi

cp /tmp/build.log /artifacts/logs/00-build.log

# Collect built APKs into /artifacts/bin
find bin/packages/ -path '*/custom/*' -name '*.apk' -exec cp {} /artifacts/bin/ \; 2>/dev/null || true
find bin/targets/ -name '*.apk' -exec cp -u {} /artifacts/bin/ \; 2>/dev/null || true
if [ -f /artifacts/manifest/expected.txt ]; then
    while IFS= read -r pkg || [ -n "$pkg" ]; do
        [ -n "$pkg" ] || continue
        find bin/ -type f -name "${pkg}-[0-9]*.apk" -exec cp -u {} /artifacts/bin/ \; 2>/dev/null || true
    done < /artifacts/manifest/expected.txt
fi

# Update incremental build cache
if [ -f /core/scripts/incremental_build.py ] && [ -d /cached_apks ]; then
    echo "=== Updating incremental package cache ==="
    python3 /core/scripts/incremental_build.py save \
        --package-dir package/feeds/custom \
        --packageinfo tmp/.packageinfo \
        --manifest /artifacts/manifest/expected.txt \
        --cache-dir /cached_apks \
        --artifacts-bin /artifacts/bin
fi
INNER_EOF

chmod 755 /tmp/inner.sh
su -s /bin/bash buildbot -c 'bash /tmp/inner.sh'
