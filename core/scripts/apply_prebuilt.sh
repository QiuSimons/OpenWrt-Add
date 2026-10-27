#!/usr/bin/env bash
# ==============================================================================
# OpenWrt-Add 预编译产物注入器
#
# 在 SDK 容器启动前改写 staging_feed 中的包 Makefile：
#   1. 摘掉 golang/host / rust/host 构建依赖（消除容器内工具链引导）
#   2. 在文件末尾追加 Build/Compile 覆盖，直接取用宿主机预编译二进制
#   3. 保留原始 Makefile 的包元数据（DEPENDS / conffiles / install / config）
#
# 覆盖块放在文件末尾而不是 include 之后，是为了压过上游在 include 之后对
# Build/Compile 的再赋值（例如 flowcone 的 RustBinPackage 分支）。
#
# 用法:
#   ./core/scripts/apply_prebuilt.sh <feed_dir> [prebuilt_mount_path]
# ==============================================================================
set -euo pipefail

FEED="${1:?usage: apply_prebuilt.sh <feed_dir> [prebuilt_mount_path]}"
PREBUILT="${2:-/prebuilt}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="OpenWrt-Add CI prebuilt override"

log() { printf '[apply-prebuilt] %s\n' "$*"; }
die() { printf '::error::[apply-prebuilt] %s\n' "$*" >&2; exit 1; }

[ -d "$FEED" ] || die "feed dir not found: $FEED"

# 相对 staging_feed 的包目录 | 类型(go|rust) | 预编译目录名 | 二进制名
PACKAGES=(
  "imm_pkg/frp|go||"
  "luci-app-mosdns/mosdns|go||"
  "OpenWrt-mihomo/mihomo-meta|go||"
  "OpenWrt-mihomo/mihomo-alpha|go||"
  "imm_pkg/sing-box|go||"
  "openwrt-einat-ebpf|rust|einat-ebpf|einat"
  "FlowCone/openwrt/flowcone|rust|flowcone|flowcone"
)

patched=0
for entry in "${PACKAGES[@]}"; do
  IFS='|' read -r reldir kind pname binname <<< "$entry"
  mk="$FEED/$reldir/Makefile"

  if [ ! -f "$mk" ]; then
    log "SKIP $reldir (无 Makefile，上游可能已移除该包)"
    continue
  fi

  if grep -q "$MARKER" "$mk" 2>/dev/null; then
    log "SKIP $reldir (已注入)"
    continue
  fi

  python3 - "$mk" "$kind" "$MARKER" "$PREBUILT" "$pname" "$binname" <<'PY' || die "patch failed: $mk"
import re, sys

path, kind, marker, prebuilt, pname, binname = sys.argv[1:7]
src = open(path, encoding='utf-8').read()

# 1) 就地摘除宿主工具链依赖（必须在 include package.mk 之前生效）
if kind == 'go':
    src = re.sub(r'^(PKG_BUILD_DEPENDS:?=[^\n]*?)\bgolang/host\b[ \t]*', r'\1', src, flags=re.M)
else:
    src = re.sub(r'^(PKG_BUILD_DEPENDS:?=[^\n]*?)\brust/host\b[ \t]*', r'\1', src, flags=re.M)
src = re.sub(r'^(PKG_BUILD_DEPENDS:?=)[ \t]+$', r'\1', src, flags=re.M)

# 2) 末尾追加覆盖块（压过上游在 include 之后的再赋值）
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
# 宿主机已用 Rust musl 交叉编译出静态二进制，容器内不再引导 rust/host 工具链
PKG_BUILD_DEPENDS:=
define Build/Compile
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) {prebuilt}/{pname}/bin/{binname} $(PKG_INSTALL_DIR)/bin/{binname}
endef
Build/InstallDev:=
# --- end {marker} ---
"""

if not src.endswith('\n'):
    src += '\n'
src += block
open(path, 'w', encoding='utf-8').write(src)
print('     injected: ' + path)
PY

  patched=$((patched + 1))
done

# ------------------------------------------------------------------------------
# 校验：注入后不允许在生效位置残留宿主编译器依赖
# ------------------------------------------------------------------------------
fail=0
for entry in "${PACKAGES[@]}"; do
  IFS='|' read -r reldir kind pname binname <<< "$entry"
  mk="$FEED/$reldir/Makefile"
  [ -f "$mk" ] || continue

  if ! grep -q "$MARKER" "$mk"; then
    log "FAIL $reldir: 未注入预编译覆盖"
    fail=1
    continue
  fi

  # 所有 PKG_BUILD_DEPENDS 赋值行都不应再含宿主工具链（含 include 之前的原行）
  if grep -nE '^PKG_BUILD_DEPENDS:?=.*(golang/host|rust/host)' "$mk"; then
    log "FAIL $reldir: 仍存在宿主工具链构建依赖"
    fail=1
  fi
done

[ "$fail" -eq 0 ] || die "预编译注入校验失败"

log "完成：共注入 $patched 个包"
