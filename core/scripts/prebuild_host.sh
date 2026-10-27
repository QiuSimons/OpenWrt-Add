#!/usr/bin/env bash
# ==============================================================================
# OpenWrt-Add 宿主机预编译器
#
# 在 GitHub Actions runner 上直接交叉编译 Go / Rust 组件，产出与 OpenWrt
# golang-package.mk / rust-package.mk 等价的目标二进制，供 SDK 容器纯打包使用。
#
# 目的：彻底消除 SDK 容器内的 golang/host、rust/host 工具链引导（每次 20~60 分钟）。
#
# 用法:
#   ./core/scripts/prebuild_host.sh <arch> [outdir]
#   arch: x86_64 | aarch64_generic
#
# 版本号/源码地址一律从各包 Makefile 解析，禁止在脚本内硬编码 —— 每日 Update PKG
# 同步上游版本后，本脚本自动跟随，不会出现版本漂移。
# ==============================================================================
set -euo pipefail

ARCH="${1:?usage: prebuild_host.sh <x86_64|aarch64_generic> [outdir]}"
OUT="${2:-prebuilt}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

case "$ARCH" in
  x86_64)          GOARCH=amd64 ; RUST_TARGET=x86_64-unknown-linux-musl ;;
  aarch64_generic) GOARCH=arm64 ; RUST_TARGET=aarch64-unknown-linux-musl ;;
  *) echo "::error::unsupported arch: $ARCH" >&2; exit 1 ;;
esac

export CGO_ENABLED=0
export GOOS=linux
export GOARCH
mkdir -p "$OUT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '[prebuild:%s] %s\n' "$ARCH" "$*"; }
die() { printf '::error::[prebuild:%s] %s\n' "$ARCH" "$*" >&2; exit 1; }

# ------------------------------------------------------------------------------
# 从 Makefile 解析源码信息（PKG_VERSION / PKG_SOURCE_URL / PKG_SOURCE_PROTO）
# 输出: <tar_url> <version>
# ------------------------------------------------------------------------------
resolve_source() {
  local makefile="$1"
  [ -f "$makefile" ] || die "Makefile not found: $makefile"

  python3 - "$makefile" <<'PY'
import re, sys

path = sys.argv[1]
text = open(path, encoding='utf-8').read()

# 收集所有简单变量赋值，用于递归展开 $(NAME)
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

version = var('PKG_VERSION') or var('PKG_UPSTREAM_VERSION')
url     = var('PKG_SOURCE_URL')
proto   = var('PKG_SOURCE_PROTO')
srcrev  = var('PKG_SOURCE_VERSION')

if proto == 'git' and url:
    m = re.match(r'https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$', url)
    if m:
        owner, repo = m.group(1), m.group(2)
        ref = srcrev or ('v' + version)
        url = 'https://codeload.github.com/%s/%s/tar.gz/%s' % (owner, repo, ref)

if not url:
    sys.exit('no usable PKG_SOURCE_URL in ' + path)
if not version:
    sys.exit('no PKG_VERSION in ' + path)

# codeload 末尾的 '?' 是空查询串，去掉以免 curl 记录异常
url = url.rstrip('?')

print(version, url)
PY
}

# ------------------------------------------------------------------------------
# 下载并解压源码到 <work>/<name>
# ------------------------------------------------------------------------------
fetch_source() {
  local name="$1" makefile="$2"
  local parsed version url
  parsed="$(resolve_source "$makefile")" || die "resolve source failed: $name"
  version="$(echo "$parsed" | awk '{print $1}')"
  url="$(echo "$parsed" | awk '{print $2}')"

  log "$name: version=$version"
  mkdir -p "$WORK/$name"
  curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/$name.tar.gz" "$url" \
    || die "download failed: $url"
  tar xzf "$WORK/$name.tar.gz" --strip-components=1 -C "$WORK/$name" \
    || die "extract failed: $name"
  echo "$version"
}

# ------------------------------------------------------------------------------
# Go 交叉编译
#   gobuild <srcdir> <outdir> <pkg-path> [tags] [ldflags]
# ------------------------------------------------------------------------------
gobuild() {
  local srcdir="$1" outdir="$2" pkg="$3" tags="${4:-}" ldflags="${5:-}"
  local args=(build -trimpath -buildvcs=false -o "$outdir/")
  [ -n "$tags" ]    && args+=(-tags "$tags")
  [ -n "$ldflags" ] && args+=(-ldflags "$ldflags")
  args+=("$pkg")

  ( cd "$srcdir" && GOFLAGS="-mod=mod" go "${args[@]}" ) \
    || die "go build failed: $pkg ($srcdir)"
}

assert_elf() {
  local f="$1"
  [ -s "$f" ] || die "empty output: $f"
  file "$f" | grep -q 'ELF' || die "not an ELF: $f"
  log "  -> $(basename "$f"): $(file -b "$f" | cut -c1-70)"
}

# ==============================================================================
# 各包预编译
# ==============================================================================

prebuild_frp() {
  [ -f apps/imm_pkg/frp/Makefile ] || { log "SKIP frp (包已移除)"; return 0; }
  local src="$WORK/frp" out="$OUT/frp/bin"
  fetch_source frp apps/imm_pkg/frp/Makefile >/dev/null
  rm -rf "$out"; mkdir -p "$out"

  local ver ldflags
  ver="$(resolve_source apps/imm_pkg/frp/Makefile | awk '{print $1}')"
  ldflags="-s -w -X github.com/fatedier/frp/pkg/util/version.version=${ver}"

  # GO_PKG_BUILD_PKG:=github.com/fatedier/frp/cmd/... -> frpc + frps
  gobuild "$src" "$out" ./cmd/frpc noweb "$ldflags"
  gobuild "$src" "$out" ./cmd/frps noweb "$ldflags"
  assert_elf "$out/frpc"; assert_elf "$out/frps"
}

prebuild_mosdns() {
  [ -f apps/luci-app-mosdns/mosdns/Makefile ] || { log "SKIP mosdns (包已移除)"; return 0; }
  local src="$WORK/mosdns" out="$OUT/mosdns/bin"
  fetch_source mosdns apps/luci-app-mosdns/mosdns/Makefile >/dev/null
  rm -rf "$out"; mkdir -p "$out"

  local ver rel ldflags
  ver="$(resolve_source apps/luci-app-mosdns/mosdns/Makefile | awk '{print $1}')"
  rel="$(grep '^PKG_RELEASE:=' apps/luci-app-mosdns/mosdns/Makefile | head -n1 | cut -d= -f2)"
  ldflags="-s -w -X main.version=v${ver}-r${rel}"

  # GO_PKG_BUILD_PKG 未设置 -> 构建模块根目录
  gobuild "$src" "$out" . "" "$ldflags"
  assert_elf "$out/mosdns"
}

prebuild_mihomo() {
  [ -f apps/OpenWrt-mihomo/mihomo-meta/Makefile ] || { log "SKIP mihomo (包已移除)"; return 0; }
  # mihomo-meta / mihomo-alpha 两个包，源码分别是 tag 与 commit
  local pkg dir src out ver bt ldflags buildver
  for pkg in mihomo-meta mihomo-alpha; do
    dir="apps/OpenWrt-mihomo/$pkg"
    src="$WORK/$pkg"
    fetch_source "$pkg" "$dir/Makefile" >/dev/null
    out="$OUT/$pkg/bin"; rm -rf "$OUT/$pkg"; mkdir -p "$out"

    buildver="$(grep '^PKG_BUILD_VERSION:=' "$dir/Makefile" | head -n1 | cut -d= -f2)"
    bt="$(date -u -Iseconds)"
    ldflags="-s -w -X github.com/metacubex/mihomo/constant.Version=${buildver} -X github.com/metacubex/mihomo/constant.BuildTime=${bt}"

    # GO_PKG_TAGS:=with_gvisor
    gobuild "$src" "$out" . with_gvisor "$ldflags"
    assert_elf "$out/mihomo"
  done
}

prebuild_singbox() {
  [ -f apps/imm_pkg/sing-box/Makefile ] || { log "SKIP sing-box (包已移除)"; return 0; }
  local src="$WORK/sing-box" out="$OUT/sing-box/bin"
  fetch_source sing-box apps/imm_pkg/sing-box/Makefile >/dev/null
  rm -rf "$out"; mkdir -p "$out"

  local ver ldflags tags
  ver="$(resolve_source apps/imm_pkg/sing-box/Makefile | awk '{print $1}')"

  # 取自 Makefile 中 Package/sing-box-tiny/config 的 Kconfig 默认值:
  #   CLASH_API=y GVISOR=y(64位) QUIC=y UTLS=y WIREGUARD=y(64位)，其余默认 n
  tags="badlinkname,tfogo_checklinkname0,with_clash_api,with_gvisor,with_quic,with_utls,with_wireguard"
  ldflags="-s -w -checklinkname=0"
  ldflags+=" -X github.com/sagernet/sing-box/constant.Version=${ver}"
  ldflags+=" -X runtime.godebugDefault=multipathtcp=0,tlssha1=1"

  gobuild "$src" "$out" ./cmd/sing-box "$tags" "$ldflags"
  assert_elf "$out/sing-box"
}

prebuild_einat() {
  [ -f apps/openwrt-einat-ebpf/Makefile ] || { log "SKIP einat-ebpf (包已移除)"; return 0; }
  local dir="apps/openwrt-einat-ebpf" out="$OUT/einat-ebpf/bin"
  local src="$WORK/einat-ebpf"
  fetch_source einat-ebpf "$dir/Makefile" >/dev/null || die "fetch einat failed"
  [ -d "$src" ] || src="$WORK/openwrt-einat-ebpf"
  rm -rf "$out"; mkdir -p "$out"

  # einat 的 build.rs 用 clang 编译 BPF，并需要 libbpf 头文件（<bpf/bpf_helpers.h>）。
  # 容器内由 bpf-headers 提供；宿主机上直接取 libbpf 官方头文件即可。
  local inc="$WORK/libbpf-inc"
  if [ ! -f "$inc/bpf/bpf_helpers.h" ]; then
    mkdir -p "$inc/bpf"
    curl -fsSL --retry 3 -o "$WORK/libbpf.tar.gz" \
      "https://github.com/libbpf/libbpf/archive/refs/tags/v1.7.0.tar.gz" \
      || die "download libbpf headers failed"
    tar xzf "$WORK/libbpf.tar.gz" -C "$WORK"
    cp -f "$WORK"/libbpf-1.7.0/src/*.h "$inc/bpf/"
  fi

  command -v clang >/dev/null || die "clang is required for einat-ebpf bpf build"
  command -v llvm-strip >/dev/null || die "llvm-strip is required for einat-ebpf bpf build"

  # 与 OpenWrt 默认特性保持一致: ipv6=y, libbpf=n, bindgen=n, static=n
  (
    cd "$src"
    EINAT_BPF_CFLAGS="-I$inc" \
    cargo build --release --locked --target "$RUST_TARGET" \
      --no-default-features --features aya,ipv6
  ) || die "cargo build failed: einat-ebpf"

  cp "$src/target/$RUST_TARGET/release/einat" "$out/einat"
  assert_elf "$out/einat"
}

prebuild_flowcone() {
  local dir="apps/FlowCone" out="$OUT/flowcone/bin"
  [ -d "$dir/crates/flowcone-daemon" ] || { log "SKIP flowcone (包已移除)"; return 0; }
  rm -rf "$OUT/flowcone"; mkdir -p "$out"

  # 仓库内已提交 crates/flowcone-daemon/ebpf/flowcone-ebpf.bin，
  # build.rs 直接拷贝该 eBPF 产物，因此宿主机构建不需要 clang / nightly。
  ( cd "$dir" && cargo build --release --locked -p flowcone-daemon --target "$RUST_TARGET" ) \
    || die "cargo build failed: flowcone"

  cp "$dir/target/$RUST_TARGET/release/flowcone" "$out/flowcone"
  assert_elf "$out/flowcone"
}

# ==============================================================================
main() {
  log "repo=$REPO_ROOT out=$OUT goarch=$GOARCH rust_target=$RUST_TARGET"

  # PREBUILD_ONLY=frp,mosdns 可只构建部分包（本地调试用）
  local only=",${PREBUILD_ONLY:-},"
  want() { [ "$only" = ",," ] || case "$only" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

  want frp      && prebuild_frp
  want mosdns   && prebuild_mosdns
  want mihomo   && prebuild_mihomo
  want sing-box && prebuild_singbox
  want einat    && prebuild_einat
  want flowcone  && prebuild_flowcone
  true

  # 清单：容器内据此校验"该包确实走了预编译路径"
  ( cd "$OUT" && find . -type f ! -name 'manifest.txt' | sed 's|^\./||' | sort ) > "$OUT/manifest.txt"
  log "产物清单:"
  sed 's/^/    /' "$OUT/manifest.txt"

  log "全部预编译完成"
}

main "$@"
