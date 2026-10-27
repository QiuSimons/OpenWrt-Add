#!/usr/bin/env bash
# ==============================================================================
# OpenWrt-Add 预编译产物注入器
#
# 在 SDK 容器启动前改写 staging_feed 中的包 Makefile：
#   1. 摘掉 golang/host / rust/host 构建依赖（消除容器内工具链引导）
#   2. 将 Build/Compile 重定向为“直接取用宿主机预编译二进制”
#   3. 保留原始 Makefile 的包元数据（DEPENDS / conffiles / install / config）
#
# 用法:
#   ./core/scripts/apply_prebuilt.sh <feed_dir> [prebuilt_mount_path]
#   例: ./core/scripts/apply_prebuilt.sh staging_feed /prebuilt
# ==============================================================================
set -euo pipefail

FEED="${1:?usage: apply_prebuilt.sh <feed_dir> [prebuilt_mount_path]}"
PREBUILT="${2:-/prebuilt}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="OpenWrt-Add CI prebuilt override"

log() { printf '[apply-prebuilt] %s\n' "$*"; }
die() { printf '::error::[apply-prebuilt] %s\n' "$*" >&2; exit 1; }

[ -d "$FEED" ] || die "feed dir not found: $FEED"

# 相对 staging_feed 的包目录 | 类型(go|rust)
PACKAGES=(
  "imm_pkg/frp|go"
  "luci-app-mosdns/mosdns|go"
  "OpenWrt-mihomo/mihomo-meta|go"
  "OpenWrt-mihomo/mihomo-alpha|go"
  "imm_pkg/sing-box|go"
  "openwrt-einat-ebpf|rust"
)

patched=0
for entry in "${PACKAGES[@]}"; do
  reldir="${entry%%|*}"
  kind="${entry##*|}"
  mk="$FEED/$reldir/Makefile"

  if [ ! -f "$mk" ]; then
    log "SKIP $reldir (no Makefile, 上游可能已移除该包)"
    continue
  fi

  if grep -q "$MARKER" "$mk" 2>/dev/null; then
    log "SKIP $reldir (已注入)"
    continue
  fi

  python3 - "$mk" "$kind" "$MARKER" "$PREBUILT" <<'PY' || die "patch failed: $mk"
import re, sys

path, kind, marker, prebuilt = sys.argv[1:5]
src = open(path, encoding='utf-8').read()

if kind == 'go':
    anchor_re = r'^include \$\$\{?\}?.*golang-package\.mk\s*$'
    anchor = re.search(r'^include.*golang-package\.mk\s*$', src, re.M)
else:
    anchor = re.search(r'^include.*rust-package\.mk\s*$', src, re.M)

if not anchor:
    sys.exit('anchor include not found in ' + path)

if kind == 'go':
    block = f"""
# --- {marker} ---
# 宿主机已用 Go 交叉编译出目标二进制，容器内不再引导 golang/host 工具链
PKG_BUILD_DEPENDS:=
GO_PKG_PREBUILT_DIR:={prebuilt}/$(PKG_NAME)
GO_PKG_BUILD_BIN_DIR:=$(GO_PKG_PREBUILT_DIR)/bin
define GoPackage/Package/Install/Bin
	$(INSTALL_DIR) $(1)$(GO_PKG_INSTALL_BIN_PATH)
	$(INSTALL_BIN) $(GO_PKG_PREBUILT_DIR)/bin/* $(1)$(GO_PKG_INSTALL_BIN_PATH)/
endef
Build/Compile:=
Build/InstallDev:=
# --- end {marker} ---
"""
else:
    block = f"""
# --- {marker} ---
# 宿主机已用 Rust musl 交叉编译出静态 einat 二进制，容器内不再引导 rust/host
PKG_BUILD_DEPENDS:=
define Build/Compile
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) {prebuilt}/einat-ebpf/bin/einat $(PKG_INSTALL_DIR)/bin/einat
endef
Build/InstallDev:=
# --- end {marker} ---
"""

insert_at = anchor.end()
new = src[:insert_at] + block + src[insert_at:]

# 原始 PKG_BUILD_DEPENDS 行内的宿主工具链词元一并摘除（双保险）
if kind == 'go':
    new = re.sub(r'^(PKG_BUILD_DEPENDS:?=\s*)golang/host\b.*$', r'\1', new, flags=re.M)
else:
    new = re.sub(r'^(PKG_BUILD_DEPENDS:?=\s*)(?:rust/host)\s*', r'\1', new, flags=re.M)

open(path, 'w', encoding='utf-8').write(new)
print('     injected: ' + path)
PY

  patched=$((patched + 1))
done

# ------------------------------------------------------------------------------
# 校验：注入后不允许在生效位置残留宿主编译器依赖
# ------------------------------------------------------------------------------
fail=0
for entry in "${PACKAGES[@]}"; do
  reldir="${entry%%|*}"
  mk="$FEED/$reldir/Makefile"
  [ -f "$mk" ] || continue

  if ! grep -q "$MARKER" "$mk"; then
    log "FAIL $reldir: 未注入预编译覆盖"
    fail=1
    continue
  fi

  # 覆盖块之后不应再有宿主 go/rust 工具链的构建依赖赋值
  tail_block="$(awk -v m="$MARKER" 'index($0, m) {f=1} f' "$mk")"
  if echo "$tail_block" | grep -qE '^PKG_BUILD_DEPENDS:=[^\n]*(golang/host|rust/host)'; then
    log "FAIL $reldir: 覆盖块之后仍存在宿主工具链构建依赖"
    fail=1
  fi
done

[ "$fail" -eq 0 ] || die "预编译注入校验失败"

log "完成：共注入 $patched 个包"
log "覆盖块内容抽查（sing-box）:"
awk -v m="$MARKER" 'index($0, m) {f=1} f' "$FEED/imm_pkg/sing-box/Makefile" 2>/dev/null | head -n 20 || true
