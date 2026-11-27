#!/usr/bin/env bash
# ==============================================================================
# 同名包 release 对齐：上游 feed 存在同名包且 PKG_VERSION 相同时，
# PKG_RELEASE 取上游最大值 + 1，否则 apk 按版本号会选上游那份。
# ==============================================================================
# 用法: REPO_ROOT=staging_feed OPENWRT_VERSION=25.12.6 ARCH=x86_64 \
#         bash core/scripts/fix_colliding_release.sh [--check]
#   OPENWRT_VERSIONS  空格分隔的多个 release，优先于 OPENWRT_VERSION
#   --check           只检查，存在待提升项时退出码 1
# ==============================================================================
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-staging_feed}"
ARCH="${ARCH:-x86_64}"          # PKG_RELEASE 与架构无关，任一架构可作参照
VERSIONS="${OPENWRT_VERSIONS:-${OPENWRT_VERSION:-}}"
UPSTREAM_URL="${UPSTREAM_URL:-https://downloads.openwrt.org}"

MODE=apply
[ "${1:-}" = "--check" ] && MODE=check

log()  { printf '[release-align] %s\n' "$*"; }
warn() { printf '[release-align] WARN: %s\n' "$*" >&2; }

[ -n "$VERSIONS" ] || { warn "OPENWRT_VERSION(S) 未设置"; exit 2; }
[ -d "$REPO_ROOT" ] || { warn "REPO_ROOT 不存在: $REPO_ROOT"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
INDEX="$WORK/index.html"
: > "$INDEX"

# 子 feed 从上游目录读取，不写死清单
feeds_of() {
    curl -fsSL --retry 3 --retry-delay 2 -m 60 \
        "${UPSTREAM_URL%/}/releases/$1/packages/$ARCH/" 2>/dev/null \
        | grep -oE 'href="[a-z0-9_]+/"' | sed 's/href="//; s#/"##' | sort -u || true
}

fetched=0
for version in $VERSIONS; do
    for feed in $(feeds_of "$version"); do
        if curl -fsSL --retry 3 --retry-delay 2 -m 120 \
            "${UPSTREAM_URL%/}/releases/$version/packages/$ARCH/$feed/" -o "$WORK/feed.html"; then
            cat "$WORK/feed.html" >> "$INDEX"
            fetched=$((fetched + 1))
        else
            warn "拉取失败: $version/$feed"
        fi
    done
done

[ "$fetched" -gt 0 ] || { warn "未取到上游索引，不做改动"; exit 0; }
log "上游索引: ${fetched} 个 feed（${VERSIONS// /, } / ${ARCH}）"

escape_re() { printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g'; }

# 同 PKG_VERSION 命中的最大 release；apk 名缺 -rN 时按 0 计
max_release() {
    local en eb
    en="$(escape_re "$1")"
    eb="$(escape_re "$2")"
    grep -oE "(^|[^A-Za-z0-9+._-])${en}-${eb}(-r[0-9]+)?\.apk" "$INDEX" 2>/dev/null \
        | sed -E 's/\.apk$//' \
        | sed -E 's/^.*-r([0-9]+)$/\1/; t; s/.*/0/' \
        | sort -n | tail -n 1 || true
}

# 该包名在上游出现过的最高 PKG_VERSION，仅用于提示版本落后
highest_version() {
    local en
    en="$(escape_re "$1")"
    grep -oE "(^|[^A-Za-z0-9+._-])${en}-[0-9][A-Za-z0-9._~+-]*\.apk" "$INDEX" 2>/dev/null \
        | sed -E 's/\.apk$//' \
        | sed -E "s/^.*[^A-Za-z0-9+._-]${en}-//" \
        | sed -E 's/-r[0-9]+$//' \
        | sort -V | tail -n 1 || true
}

# 精确版本未命中但忽略大小写命中时，提示版本串写法不一致
case_mismatch() {
    local en eb
    en="$(escape_re "$1")"
    eb="$(escape_re "$2")"
    grep -oiE "(^|[^A-Za-z0-9+._-])${en}-${eb}(-r[0-9]+)?\.apk" "$INDEX" 2>/dev/null \
        | sed -E "s/^.*[^A-Za-z0-9+._-]${en}-/${en}-/" | head -n 1 || true
}

bumped=0
scanned=0
collided=0

while IFS= read -r mk; do
    scanned=$((scanned + 1))

    version="$(sed -nE 's/^PKG_VERSION[[:space:]]*:=[[:space:]]*(.*)$/\1/p' "$mk" | head -n 1 | tr -d '[:space:]')"
    release="$(sed -nE 's/^PKG_RELEASE[[:space:]]*:=[[:space:]]*(.*)$/\1/p' "$mk" | head -n 1 | tr -d '[:space:]')"

    case "$version" in ''|*'$'*) continue ;; esac
    [ "$release" = '$(AUTORELEASE)' ] && release=1
    case "$release" in ''|*'$'*|*[!0-9]*) continue ;; esac

    names="$(
        {
            sed -nE 's/^[[:space:]]*define[[:space:]]+Package\/([A-Za-z0-9._+-]+)(\/.*)?[[:space:]]*$/\1/p' "$mk"
            grep -oE 'BuildPackage,[A-Za-z0-9._+-]+' "$mk" | sed 's/^BuildPackage,//' || true
        } | sort -u
    )"
    [ -n "$names" ] || continue

    desired=0
    for name in $names; do
        highest="$(highest_version "$name")"
        [ -n "$highest" ] || continue
        collided=$((collided + 1))

        upstream_release="$(max_release "$name" "$version")"
        if [ -z "$upstream_release" ]; then
            hit="$(case_mismatch "$name" "$version")"
            [ -n "$hit" ] && warn "$name: 上游版本写法不同（$hit），无法按 release 对齐"
            [ "$(printf '%s\n%s\n' "$version" "$highest" | sort -V | tail -n 1)" != "$version" ] \
                && warn "$name: 本地 PKG_VERSION=$version 低于上游 $highest"
            continue
        fi

        candidate=$((upstream_release + 1))
        [ "$candidate" -gt "$desired" ] && desired="$candidate"
    done

    [ "$desired" -gt "$release" ] || continue

    log "$(basename "$(dirname "$mk")"): PKG_VERSION=$version  PKG_RELEASE $release -> $desired"
    bumped=$((bumped + 1))

    [ "$MODE" = apply ] || continue
    sed -i -E "0,/^PKG_RELEASE[[:space:]]*:=.*/s|^PKG_RELEASE[[:space:]]*:=.*|PKG_RELEASE:=${desired}|" "$mk"
done < <(find "$REPO_ROOT" -name Makefile -not -path '*/src/*' -not -path '*/.git/*' | sort)

log "扫描 ${scanned} 个 Makefile；同名 ${collided} 处；需提升 ${bumped} 个"

if [ "$bumped" -gt 0 ] && [ "$MODE" = check ]; then
    warn "--check: ${bumped} 个包 release 不高于上游"
    exit 1
fi
