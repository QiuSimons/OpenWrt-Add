#!/usr/bin/env bash
# ==============================================================================
# OpenWrt-Add 预编译产物注入器
#
# 在 SDK 容器启动前改写 staging_feed 中的包 Makefile：
#   1. 摘掉 golang/host / rust/host 构建依赖（消除容器内工具链引导）
#   2. 在 BuildPackage 前注入 Build/Compile 覆盖，直接取用宿主机预编译二进制
#   3. 保留原始 Makefile 的包元数据（DEPENDS / conffiles / install / config）
#
# 覆盖块放在 BuildPackage 之前，确保生成规则时绑定覆盖的 Build/Compile，
# 同时禁用 RustBinPackage 避免冲突。
#
# 用法:
#   ./core/scripts/apply_prebuilt.sh <feed_dir> [prebuilt_mount_path] [prebuilt_host_dir]
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROP_CONF="${DROP_CONF:-$SCRIPT_DIR/../assets/drop-packages.conf}"

FEED="${1:?usage: apply_prebuilt.sh <feed_dir> [prebuilt_mount_path] [prebuilt_host_dir]}"
PREBUILT="${2:-/prebuilt}"
PREBUILT_HOST="${3:-}"

MARKER="OpenWrt-Add CI prebuilt override"

log() { printf '[apply-prebuilt] %s\n' "$*"; }
die() { printf '::error::[apply-prebuilt] %s\n' "$*" >&2; exit 1; }

[ -d "$FEED" ] || die "feed dir not found: $FEED"
FEED="$(cd "$FEED" && pwd)"
if [ -n "$PREBUILT_HOST" ]; then
  [ -d "$PREBUILT_HOST" ] || die "prebuilt host dir not found: $PREBUILT_HOST"
  PREBUILT_HOST="$(cd "$PREBUILT_HOST" && pwd)"
fi

# 相对 staging_feed 的包目录 | 类型(go|rust) | 预编译目录名 | 二进制名
PACKAGES=(
  "imm_pkg/frp|go||"
  "luci-app-mosdns/mosdns|go||"
  "OpenWrt-mihomo/mihomo-meta|go||"
  "OpenWrt-mihomo/mihomo-alpha|go||"
  "imm_pkg/sing-box|go||"
  "luci-app-dae/dae|go||"
  "openwrt-einat-ebpf|rust|einat-ebpf|einat"
  "FlowCone/openwrt/flowcone|rust|flowcone|flowcone"
)

# 按 drop-packages.conf 移除互斥变体
drop_packages() {
  local conf="$DROP_CONF" reldir pkg mk
  if [ ! -f "$conf" ]; then
    return 0
  fi
  while read -r reldir pkg _; do
    case "$reldir" in ''|'#'*) continue ;; esac
    [ -n "$pkg" ] || continue
    mk="$FEED/$reldir/Makefile"
    if [ ! -f "$mk" ]; then
      log "SKIP drop $pkg (无 Makefile: $reldir)"
      continue
    fi
    python3 - "$mk" "$pkg" <<'PY' || die "drop failed: $pkg"
import re, sys
path, pkg = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
pat = re.compile(r'^\$\(eval \$\(call (?:BuildPackage|GoBinPackage|RustBinPackage),'
                 + re.escape(pkg) + r'\)\)[ \t]*$', re.M)
m = pat.search(src)
if not m:
    if '# drop-packages.conf: 本 feed 不构建 ' + pkg in src:
        sys.exit(0)  # 已摘除
    sys.exit('package eval not found: ' + pkg)
note = '# drop-packages.conf: 本 feed 不构建 ' + pkg + '\n'
src = src[:m.start()] + note + src[m.end():]
open(path, 'w', encoding='utf-8').write(src)
print('     dropped: ' + pkg + ' (' + path + ')')
PY
  done < "$conf"
}

drop_packages

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

  if [ -n "$PREBUILT_HOST" ]; then
    dir="${pname:-$(basename "$reldir")}"
    pdir="$PREBUILT_HOST/$dir/bin"
    [ -d "$pdir" ] || die "缺少预编译产物: $pdir（prebuild 与 apply 的包清单不同步）"
    if [ "$kind" = rust ]; then
      [ -f "$pdir/$binname" ] || die "缺少预编译二进制: $pdir/$binname"
    else
      compgen -G "$pdir/*" >/dev/null || die "预编译目录为空: $pdir"
    fi
  fi

  python3 - "$mk" "$kind" "$MARKER" "$PREBUILT" "$pname" "$binname" <<'PY' || die "patch failed: $mk"
import re, sys

path, kind, marker, prebuilt, pname, binname = sys.argv[1:7]
src = open(path, encoding='utf-8').read()

# 摘除宿主工具链构建依赖
if kind == 'go':
    src = re.sub(r'^(PKG_BUILD_DEPENDS:?=[^\n]*?)\bgolang/host\b[ \t]*', r'\1', src, flags=re.M)
    src = re.sub(r'^(PKG_BUILD_DEPENDS:?=[^\n]*?)\bbpf-headers\b[ \t]*', r'\1', src, flags=re.M)
else:
    src = re.sub(r'^(PKG_BUILD_DEPENDS:?=[^\n]*?)\brust/host\b[ \t]*', r'\1', src, flags=re.M)
    src = re.sub(r'(\$\(eval\s+\$\(call\s+RustBinPackage[^\)]*\)\))', r'# \1 (disabled for prebuilt)', src)

if kind == 'go':
    pdir_name = pname if pname else '$(PKG_NAME)'
    block = f"""
# --- {marker} ---
PKG_BUILD_DEPENDS:=
GO_PKG_PREBUILT_DIR:={prebuilt}/{pdir_name}
GO_PKG_BUILD_BIN_DIR?=$(PKG_BUILD_DIR)/.go_work/build/bin
define Build/Compile
	$(INSTALL_DIR) $(GO_PKG_BUILD_BIN_DIR)
	$(CP) $(GO_PKG_PREBUILT_DIR)/bin/* $(GO_PKG_BUILD_BIN_DIR)/
endef
define GoPackage/Package/Install/Bin
	$(INSTALL_DIR) $(1)$(GO_PKG_INSTALL_BIN_PATH)
	$(INSTALL_BIN) $(GO_PKG_BUILD_BIN_DIR)/* $(1)$(GO_PKG_INSTALL_BIN_PATH)/
endef
Build/InstallDev:=
# --- end {marker} ---
"""
else:
    block = f"""
# --- {marker} ---
PKG_BUILD_DEPENDS:=
define Build/Compile
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) {prebuilt}/{pname}/bin/{binname} $(PKG_INSTALL_DIR)/bin/{binname}
endef
Build/InstallDev:=
# --- end {marker} ---
"""

# 在 BuildPackage 前注入覆盖块
m = re.search(r'^[ \t]*\$\(eval\s+\$\(call\s+BuildPackage', src, flags=re.M)
if m:
    src = src[:m.start()] + block + '\n' + src[m.start():]
else:
    if not src.endswith('\n'):
        src += '\n'
    src += block
open(path, 'w', encoding='utf-8').write(src)
print('     injected: ' + path)
PY

  patched=$((patched + 1))
done

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

  if grep -qE '^PKG_BUILD_DEPENDS:?=.*(golang/host|rust/host)' "$mk"; then
    log "FAIL $reldir: 仍存在宿主工具链构建依赖"
    grep -nE '^PKG_BUILD_DEPENDS:?=.*(golang/host|rust/host)' "$mk" | sed 's/^/  /'
    fail=1
  fi
done

[ "$fail" -eq 0 ] || die "预编译注入校验失败"

log "完成：共注入 $patched 个包"
