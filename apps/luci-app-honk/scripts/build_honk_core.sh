#!/usr/bin/env bash
# ==============================================================================
# build_honk_core.sh - Single Source of Truth for building honk-core musl binary
#
# Usage:
#   ./scripts/build_honk_core.sh <arch|target_triple> [output_file] [source_dir]
#
# Examples:
#   ./scripts/build_honk_core.sh x86_64
#   ./scripts/build_honk_core.sh aarch64_generic honk/files/honk-core.bin
#   ./scripts/build_honk_core.sh aarch64-unknown-linux-musl /tmp/honk-core /path/to/src
# ==============================================================================
set -euo pipefail

TARGET_IN="${1:?usage: $0 <arch|target_triple> [output_file] [source_dir]}"
OUT_FILE="${2:-}"
SRC_DIR="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. 规范化目标 target triple 与 zig triple
case "$TARGET_IN" in
  x86_64|x86_64-unknown-linux-musl)
    RUST_TARGET="x86_64-unknown-linux-musl"
    ZIG_TARGET="x86_64-linux-musl"
    ;;
  aarch64|aarch64_generic|aarch64-unknown-linux-musl)
    RUST_TARGET="aarch64-unknown-linux-musl"
    ZIG_TARGET="aarch64-linux-musl"
    ;;
  *)
    RUST_TARGET="$TARGET_IN"
    ZIG_TARGET="${TARGET_IN/-unknown/}"
    ;;
esac

if [ -z "$OUT_FILE" ]; then
  OUT_FILE="$REPO_ROOT/honk/files/honk-core.bin"
fi

# 相对输出路径必须在进入源码目录之前固化为绝对路径，否则会被解析到 $SRC_DIR 下，
# 造成"脚本报成功、仓库里却没有产物"的假闭环。
case "$OUT_FILE" in
  /*) ;;
  *) OUT_FILE="$PWD/$OUT_FILE" ;;
esac

# 2. 准备源码目录
fetch_pinned_source() {
  rm -rf "$3"
  echo "==> Fetching honk source ($1 @ $2)..."
  git init -q "$3"
  git -C "$3" remote add origin "$1"
  git -C "$3" fetch --depth 1 origin "$2"
  git -C "$3" checkout -q --detach FETCH_HEAD
}

if [ -z "$SRC_DIR" ]; then
  MAKEFILE="$REPO_ROOT/honk/Makefile"
  [ -f "$MAKEFILE" ] || { echo "ERROR: Makefile not found at $MAKEFILE" >&2; exit 1; }
  URL=$(grep -E '^[[:space:]]*(HONK_SRC_URL|PKG_SOURCE_URL):=' "$MAKEFILE" | head -n 1 | cut -d= -f2 | tr -d '[:space:]')
  REV=$(grep -E '^[[:space:]]*(HONK_SRC_VERSION|PKG_SOURCE_VERSION):=' "$MAKEFILE" | head -n 1 | cut -d= -f2 | tr -d '[:space:]')
  [ -n "$URL" ] && [ -n "$REV" ] || {
    echo "ERROR: HONK_SRC_URL / HONK_SRC_VERSION missing in $MAKEFILE" >&2
    exit 1
  }

  SRC_DIR="$REPO_ROOT/honk-src"
  CACHED_REV=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)
  if [ -d "$SRC_DIR/crates/honk-core" ] && [ "$CACHED_REV" = "$REV" ]; then
    echo "==> Reusing $SRC_DIR at ${REV}"
  else
    if [ -n "$CACHED_REV" ]; then
      echo "==> honk-src is at ${CACHED_REV}, expected ${REV}; refetching..."
    fi
    fetch_pinned_source "$URL" "$REV" "$SRC_DIR"
  fi
fi

SRC_DIR="$(cd "$SRC_DIR" && pwd)"
echo "==> Source directory: $SRC_DIR"
echo "==> Target triple: $RUST_TARGET (zig: $ZIG_TARGET)"

# 3. 检查基础环境依赖
command -v zig >/dev/null 2>&1 || {
  echo "ERROR: 'zig' not found in PATH! Required for BoringSSL musl cross-compilation." >&2
  exit 1
}
command -v bpf-linker >/dev/null 2>&1 || {
  echo "ERROR: 'bpf-linker' not found in PATH! Required for honk-ebpf compilation." >&2
  exit 1
}
command -v cargo >/dev/null 2>&1 || {
  echo "ERROR: 'cargo' not found in PATH! Required for Rust workspace build." >&2
  exit 1
}

# 4. 精准配置 Rust 工具链与目标标准库
cd "$SRC_DIR"
if command -v rustup >/dev/null 2>&1; then
  echo "==> Ensuring target $RUST_TARGET is installed for workspace toolchain..."
  rustup target add "$RUST_TARGET"

  EBPF_CHANNEL=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' crates/honk-ebpf/rust-toolchain.toml 2>/dev/null | head -n 1)
  EBPF_CHANNEL="${EBPF_CHANNEL:-nightly}"
  echo "==> Ensuring eBPF toolchain ($EBPF_CHANNEL) has rust-src & llvm-tools..."
  rustup toolchain install "$EBPF_CHANNEL" --component rust-src,llvm-tools
fi

# 5. 编译 eBPF 对象
echo "==> Building honk-ebpf object..."
(
  cd crates/honk-ebpf
  EBPF_CHANNEL=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' rust-toolchain.toml 2>/dev/null | head -n 1)
  EBPF_CHANNEL="${EBPF_CHANNEL:-nightly}"
  cargo "+${EBPF_CHANNEL}" build --release -Zbuild-std=core --target bpfel-unknown-none
)

# aya 拒绝没有 BTF 的 eBPF 对象（运行时才报 "no BTF parsed for object"），在构建期就卡死
EBPF_OBJ="crates/honk-ebpf/target/bpfel-unknown-none/release/honk-ebpf"
[ -f "$EBPF_OBJ" ] || { echo "ERROR: eBPF object not found at $EBPF_OBJ" >&2; exit 1; }
if command -v readelf >/dev/null 2>&1; then
  readelf -S "$EBPF_OBJ" | grep -q '\.BTF' || {
    echo "ERROR: $EBPF_OBJ has no .BTF section; aya will reject it at runtime" >&2
    exit 1
  }
fi

# 6. 配置 Zig 跨平台链接包装器与 bindgen 头文件
export ZIGCC_TARGET="$ZIG_TARGET"
L=$(printf '%s' "$RUST_TARGET" | tr '-' '_')
U=$(printf '%s' "$RUST_TARGET" | tr 'a-z-' 'A-Z_')
export "CC_${L}=$SRC_DIR/ci/zigcc"
export "CXX_${L}=$SRC_DIR/ci/zigcxx"
export "CARGO_TARGET_${U}_LINKER=$SRC_DIR/ci/zigcc"
if [[ "$RUST_TARGET" == *-musl ]]; then
  export "CARGO_TARGET_${U}_RUSTFLAGS=-C link-self-contained=no"
fi

# 关键：通过 zig-bindgen-env 注入 target musl 头文件，避免 bindgen 探测宿主 /usr/include
export BINDGEN_EXTRA_CLANG_ARGS="$("$SRC_DIR/ci/zig-bindgen-env" "$ZIGCC_TARGET")"

# 7. 编译 honk-core（全特性开启，排除 native-ui）
echo "==> Building honk-core for $RUST_TARGET..."
cargo build --release --locked \
  -p honk-core \
  --no-default-features \
  --features ebpf,rprx,clash-api,native-api,mimalloc \
  --target "$RUST_TARGET"

# 8. 产物校验并输出
BUILT_BIN="$SRC_DIR/target/$RUST_TARGET/release/honk-core"
if [ ! -f "$BUILT_BIN" ]; then
  echo "ERROR: Expected output not found at $BUILT_BIN" >&2
  exit 1
fi

# 产物必须是目标架构的 ELF；musl 目标必须静态链接，否则 OpenWrt 打包会以
# "missing dependencies for the following libraries: libc.so.6" 失败。
# 先校验再落盘，避免把坏产物留在目标路径上。
FILE_DESC=$(file -b "$BUILT_BIN")
case "$FILE_DESC" in
  ELF*) ;;
  *) echo "ERROR: output is not an ELF binary: $FILE_DESC" >&2; exit 1 ;;
esac
if [[ "$RUST_TARGET" == *-musl ]] && [[ "$FILE_DESC" != *"statically linked"* ]]; then
  echo "ERROR: $RUST_TARGET binary is not statically linked: $FILE_DESC" >&2
  echo "       OpenWrt would reject it as depending on libc.so.6" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_FILE")"
cp -f "$BUILT_BIN" "$OUT_FILE"
chmod +x "$OUT_FILE"

echo "==> Build succeeded: $OUT_FILE"
echo "==> $FILE_DESC"
ls -lh "$OUT_FILE"
