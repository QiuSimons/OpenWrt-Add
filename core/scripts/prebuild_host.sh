#!/usr/bin/env bash
# ==============================================================================
# OpenWrt-Add 宿主机预编译器
#
# 在 runner 上交叉编译 Go / Rust 组件，免去 SDK 容器内工具链引导。
# 用法:
#   ./core/scripts/prebuild_host.sh <arch> [outdir]
#   arch: x86_64 | aarch64_generic
# ==============================================================================
set -euo pipefail

ARCH="${1:?usage: prebuild_host.sh <x86_64|aarch64_generic> [outdir]}"
OUT="${2:-prebuilt}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

case "$ARCH" in
  x86_64)          GOARCH=amd64 ; RUST_TARGET=x86_64-unknown-linux-musl ;;
  aarch64_generic) GOARCH=arm64 ; RUST_TARGET=aarch64-unknown-linux-musl ;;
  *) echo "::error::unsupported arch: $ARCH" >&2; exit 1 ;;
esac

export CGO_ENABLED=0 GOOS=linux GOARCH

# sing-box tiny 编译配置 (对齐 Package/sing-box-tiny/config 默认值)
SINGBOX_TAGS="badlinkname,tfogo_checklinkname0,with_clash_api,with_gvisor,with_quic,with_utls,with_wireguard"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '[prebuild:%s] %s\n' "$ARCH" "$*"; }
die() { printf '::error::[prebuild:%s] %s\n' "$ARCH" "$*" >&2; exit 1; }

# 解析 Makefile 中的源码信息
resolve_source() {
  local makefile="$1" tmp
  [ -f "$makefile" ] || die "Makefile not found: $makefile"

  tmp="$(mktemp)"
  if ! python3 - "$makefile" > "$tmp" <<'PY'
import re, sys

path = sys.argv[1]
text = open(path, encoding='utf-8').read()

VARS = {}
for m in re.finditer(r'^([A-Z0-9_]+)\s*:?=\s*(.*)$', text, re.M):
    VARS.setdefault(m.group(1), m.group(2).strip())

def expand(value, depth=0):
    if depth > 6 or '$(' not in value:
        return value
    def repl(mo):
        name = mo.group(1)
        if name in VARS:
            return expand(VARS[name], depth + 1)
        return mo.group(0)
    return re.sub(r'\$\(([A-Z0-9_]+)\)', repl, value)

def var(name):
    return expand(VARS.get(name, ''))

version  = var('PKG_VERSION') or var('PKG_UPSTREAM_VERSION')
release  = var('PKG_RELEASE') or '1'
buildver = var('PKG_BUILD_VERSION')
url      = var('PKG_SOURCE_URL')
proto    = var('PKG_SOURCE_PROTO')
srcrev   = var('PKG_SOURCE_VERSION')

if proto == 'git' and url:
    m = re.match(r'https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$', url)
    if m:
        owner, repo = m.group(1), m.group(2)
        url = 'https://codeload.github.com/%s/%s/tar.gz/%s' % (
            owner, repo, srcrev or ('v' + version))

if not url:
    sys.exit('no usable PKG_SOURCE_URL in ' + path)
if not version:
    sys.exit('no PKG_VERSION in ' + path)

# 一行一个值，避免分隔符折叠（mapfile 逐行读取，空值保留为空行）
for value in (version, release, buildver, url.rstrip('?')):
    print(value)
PY
  then
    rm -f "$tmp"
    die "resolve source failed: $makefile"
  fi

  local -a fields=()
  mapfile -t fields < "$tmp"
  rm -f "$tmp"
  [ "${#fields[@]}" -ge 4 ] || die "incomplete source metadata: $makefile"

  SRC_VERSION="${fields[0]}"
  SRC_RELEASE="${fields[1]}"
  SRC_BUILDVER="${fields[2]}"
  SRC_URL="${fields[3]}"
  [ -n "$SRC_URL" ] || die "empty PKG_SOURCE_URL: $makefile"
}

# ------------------------------------------------------------------------------
# 下载并解压源码到 <work>/<name>，同时填充 SRC_* 全局变量
# ------------------------------------------------------------------------------
fetch_source() {
  local name="$1" makefile="$2"
  resolve_source "$makefile"
  log "$name: version=$SRC_VERSION"

  mkdir -p "$WORK/$name"
  curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/$name.tar.gz" "$SRC_URL" \
    || die "download failed: $SRC_URL"
  tar xzf "$WORK/$name.tar.gz" --strip-components=1 -C "$WORK/$name" \
    || die "extract failed: $name"
}

# gobuild <srcdir> <outdir> <pkg-path> [tags] [ldflags]
gobuild() {
  local srcdir="$1" outdir="$2" pkg="$3" tags="${4:-}" ldflags="${5:-}"
  local args=(build -trimpath -buildvcs=false -o "$outdir/")
  [ -n "$tags" ] && args+=(-tags "$tags")
  [ -n "$ldflags" ] && args+=(-ldflags "$ldflags")
  args+=("$pkg")

  ( cd "$srcdir" && GOFLAGS="-mod=mod" go "${args[@]}" ) \
    || die "go build failed: $pkg ($srcdir)"
}

assert_elf() {
  local f="$1" desc
  [ -s "$f" ] || die "empty output: $f"
  desc="$(file -b "$f")"
  case "$desc" in
    *ELF*) log "  -> $(basename "$f"): $(echo "$desc" | cut -d, -f1-2)" ;;
    *) die "not an ELF: $f ($desc)" ;;
  esac
}

# ==============================================================================
# 各包预编译
# ==============================================================================

prebuild_frp() {
  local mk=apps/imm_pkg/frp/Makefile
  [ -f "$mk" ] || { log "SKIP frp (包已移除)"; return 0; }

  local src="$WORK/frp" out="$OUT/frp/bin"
  fetch_source frp "$mk"
  rm -rf "$out"; mkdir -p "$out"

  local ldflags="-s -w -X github.com/fatedier/frp/pkg/util/version.version=$SRC_VERSION"
  # GO_PKG_BUILD_PKG:=github.com/fatedier/frp/cmd/... -> frpc + frps
  gobuild "$src" "$out" ./cmd/frpc noweb "$ldflags"
  gobuild "$src" "$out" ./cmd/frps noweb "$ldflags"
  assert_elf "$out/frpc"; assert_elf "$out/frps"
}

prebuild_mosdns() {
  local mk=apps/luci-app-mosdns/mosdns/Makefile
  [ -f "$mk" ] || { log "SKIP mosdns (包已移除)"; return 0; }

  local src="$WORK/mosdns" out="$OUT/mosdns/bin"
  fetch_source mosdns "$mk"
  rm -rf "$out"; mkdir -p "$out"

  local ldflags="-s -w -X main.version=v$SRC_VERSION-r$SRC_RELEASE"
  # GO_PKG_BUILD_PKG 未设置 -> 构建模块根目录
  gobuild "$src" "$out" . "" "$ldflags"
  assert_elf "$out/mosdns"
}

prebuild_mihomo() {
  local pkg dir src out ldflags
  for pkg in mihomo-meta mihomo-alpha; do
    dir="apps/OpenWrt-mihomo/$pkg"
    [ -f "$dir/Makefile" ] || { log "SKIP $pkg (包已移除)"; continue; }

    src="$WORK/$pkg"
    fetch_source "$pkg" "$dir/Makefile"

    out="$OUT/$pkg/bin"; rm -rf "$OUT/$pkg"; mkdir -p "$out"
    ldflags="-s -w"
    ldflags+=" -X github.com/metacubex/mihomo/constant.Version=$SRC_BUILDVER"
    ldflags+=" -X github.com/metacubex/mihomo/constant.BuildTime=$(date -u -Iseconds)"

    # GO_PKG_TAGS:=with_gvisor
    gobuild "$src" "$out" . with_gvisor "$ldflags"
    assert_elf "$out/mihomo"
  done
}

prebuild_singbox() {
  local mk=apps/imm_pkg/sing-box/Makefile
  [ -f "$mk" ] || { log "SKIP sing-box (包已移除)"; return 0; }

  local src="$WORK/sing-box" out="$OUT/sing-box/bin"
  fetch_source sing-box "$mk"
  rm -rf "$out"; mkdir -p "$out"

  local tags="$SINGBOX_TAGS"
  local ldflags="-s -w -checklinkname=0"
  ldflags+=" -X github.com/sagernet/sing-box/constant.Version=$SRC_VERSION"
  ldflags+=" -X runtime.godebugDefault=multipathtcp=0,tlssha1=1"

  gobuild "$src" "$out" ./cmd/sing-box "$tags" "$ldflags"
  assert_elf "$out/sing-box"

  # 导出特性列表供容器校验
  local features
  features=$(echo "$SINGBOX_TAGS" | tr ',' '\n' | sed -n 's/^with_//p' | tr 'a-z' 'A-Z')
  [ -n "$features" ] || die "sing-box: 未能推导特性名"
  printf '%s\n' $features > "$OUT/sing-box/features.txt"
}

prebuild_einat() {
  local mk=apps/openwrt-einat-ebpf/Makefile
  [ -f "$mk" ] || { log "SKIP einat-ebpf (包已移除)"; return 0; }

  local src="$WORK/einat-ebpf" out="$OUT/einat-ebpf/bin"
  fetch_source einat-ebpf "$mk"
  rm -rf "$out"; mkdir -p "$out"

  # 获取 libbpf 头文件供 build.rs 编译 BPF
  local inc="$WORK/libbpf-inc"
  curl -fsSL --retry 3 -o "$WORK/libbpf.tar.gz" \
    "https://github.com/libbpf/libbpf/archive/refs/tags/v1.7.0.tar.gz" \
    || die "download libbpf headers failed"
  tar xzf "$WORK/libbpf.tar.gz" -C "$WORK"
  mkdir -p "$inc/bpf"
  cp -f "$WORK"/libbpf-1.7.0/src/*.h "$inc/bpf/"

  command -v clang >/dev/null || die "clang is required for einat-ebpf bpf build"
  command -v llvm-strip >/dev/null || die "llvm-strip is required for einat-ebpf bpf build"

  ( cd "$src" && EINAT_BPF_CFLAGS="-I$inc" \
      cargo build --release --locked --target "$RUST_TARGET" \
        --no-default-features --features aya,ipv6 ) \
    || die "cargo build failed: einat-ebpf"

  cp "$src/target/$RUST_TARGET/release/einat" "$out/einat"
  assert_elf "$out/einat"
}

prebuild_flowcone() {
  local dir="$REPO_ROOT/apps/FlowCone" out="$OUT/flowcone/bin"
  [ -d "$dir/crates/flowcone-daemon" ] || { log "SKIP flowcone (包已移除)"; return 0; }
  rm -rf "$OUT/flowcone"; mkdir -p "$out"

  # 使用 flowcone 已签入的 ebpf 产物
  ( cd "$dir" && cargo build --release --locked -p flowcone-daemon --target "$RUST_TARGET" ) \
    || die "cargo build failed: flowcone"

  cp "$dir/target/$RUST_TARGET/release/flowcone" "$out/flowcone"
  assert_elf "$out/flowcone"
}

prebuild_dae() {
  local mk=apps/luci-app-dae/dae/Makefile
  [ -f "$mk" ] || { log "SKIP dae (包已移除)"; return 0; }

  local src="$WORK/dae" out="$OUT/dae/bin"
  fetch_source dae "$mk"
  rm -rf "$out"; mkdir -p "$out"

  local bpf_headers="$WORK/dae_bpf_headers"
  git clone --depth 1 https://github.com/daeuniverse/dae_bpf_headers "$bpf_headers" \
    || die "download dae_bpf_headers failed"
  mkdir -p "$src/control/kern/headers" "$src/trace/kern/headers"
  cp -rf "$bpf_headers"/* "$src/control/kern/headers/"
  cp -rf "$bpf_headers"/* "$src/trace/kern/headers/"

  command -v clang >/dev/null || die "clang is required for dae bpf build"
  command -v llvm-strip >/dev/null || die "llvm-strip is required for dae bpf build"

  (
    cd "$src"
    local target_goarch="$GOARCH"
    unset GOARCH
    BPF_CLANG=clang \
    BPF_STRIP_FLAG="-strip=llvm-strip" \
    BPF_CFLAGS="-O2 -Wall -DMAX_MATCH_SET_LEN=1024" \
    BPF_TARGET="bpfel,bpfeb" \
    BPF_TRACE_TARGET="$target_goarch" \
    go generate ./control/control.go
    BPF_CLANG=clang \
    BPF_STRIP_FLAG="-strip=llvm-strip" \
    BPF_CFLAGS="-O2 -Wall -DMAX_MATCH_SET_LEN=1024" \
    BPF_TARGET="bpfel,bpfeb" \
    BPF_TRACE_TARGET="$target_goarch" \
    go generate ./trace/trace.go
  ) || die "dae: bpf generate failed"

  local pgo_args=()
  local pgo_file="$REPO_ROOT/apps/luci-app-dae/dae/pprof/default.pgo"
  [ -f "$pgo_file" ] && pgo_args+=("-pgo=$pgo_file")

  local ldflags="-s -w"
  ldflags+=" -X github.com/daeuniverse/dae/cmd.Version=$SRC_VERSION"
  ldflags+=" -X github.com/daeuniverse/dae/common/consts.MaxMatchSetLen_=1024"

  (
    cd "$src"
    GOFLAGS="-mod=mod" GOEXPERIMENT=newinliner,simd \
      go build -trimpath "${pgo_args[@]}" -ldflags "$ldflags" -tags trace -o "$out/dae" .
  ) || die "go build failed: dae"

  assert_elf "$out/dae"
}

# ==============================================================================
ONLY=",${PREBUILD_ONLY:-},"
want() {
  [ "$ONLY" = ",," ] && return 0
  case "$ONLY" in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

main() {
  log "repo=$REPO_ROOT out=$OUT goarch=$GOARCH rust_target=$RUST_TARGET"

  want frp      && prebuild_frp
  want mosdns   && prebuild_mosdns
  want mihomo   && prebuild_mihomo
  want sing-box && prebuild_singbox
  want einat    && prebuild_einat
  want flowcone && prebuild_flowcone
  want dae      && prebuild_dae
  true

  ( cd "$OUT" && find . -type f ! -name 'manifest.txt' | sed 's|^\./||' | sort ) > "$OUT/manifest.txt"
  log "产物清单:"
  sed 's/^/    /' "$OUT/manifest.txt"

  log "全部预编译完成"
}

main "$@"
