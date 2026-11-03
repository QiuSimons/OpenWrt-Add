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

# 2. 准备源码目录
if [ -z "$SRC_DIR" ]; then
  if [ -d "$REPO_ROOT/honk-src/crates/honk-core" ]; then
    SRC_DIR="$REPO_ROOT/honk-src"
  else
    MAKEFILE="$REPO_ROOT/honk/Makefile"
    [ -f "$MAKEFILE" ] || { echo "ERROR: Makefile not found at $MAKEFILE" >&2; exit 1; }
    URL=$(grep -E '^[[:space:]]*PKG_SOURCE_URL:=' "$MAKEFILE" | head -n 1 | cut -d= -f2 | tr -d '[:space:]')
    REV=$(grep -E '^[[:space:]]*PKG_SOURCE_VERSION:=' "$MAKEFILE" | head -n 1 | cut -d= -f2 | tr -d '[:space:]')
    SRC_DIR="$REPO_ROOT/honk-src"
    echo "==> Fetching honk source (${URL} @ ${REV})..."
    rm -rf "$SRC_DIR"
    git clone --depth 1 "$URL" "$SRC_DIR"
    ( cd "$SRC_DIR" && git fetch --depth 1 origin "$REV" && git checkout "$REV" ) 2>/dev/null || ( cd "$SRC_DIR" && git checkout "$REV" )
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

  EBPF_CHANNEL=$(grep -oP '^channel\s*=\s*"\K[^"]+' crates/honk-ebpf/rust-toolchain.toml 2>/dev/null || echo "nightly")
  echo "==> Ensuring eBPF toolchain ($EBPF_CHANNEL) has rust-src & llvm-tools..."
  rustup toolchain install "$EBPF_CHANNEL" --component rust-src,llvm-tools 2>/dev/null || true
fi

# 5. 编译 eBPF 对象
echo "==> Building honk-ebpf object..."
(
  cd crates/honk-ebpf
  EBPF_CHANNEL=$(grep -oP '^channel\s*=\s*"\K[^"]+' rust-toolchain.toml 2>/dev/null || echo "nightly")
  cargo "+${EBPF_CHANNEL}" build --release -Zbuild-std=core --target bpfel-unknown-none
)

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

mkdir -p "$(dirname "$OUT_FILE")"
cp -f "$BUILT_BIN" "$OUT_FILE"
chmod +x "$OUT_FILE"

echo "==> Build succeeded: $OUT_FILE"
file "$OUT_FILE"
ls -lh "$OUT_FILE"
