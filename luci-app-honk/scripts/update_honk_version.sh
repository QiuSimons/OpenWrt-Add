#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKEFILE="$REPO_DIR/honk/Makefile"

# 激进模式开关：支持环境变量 AGGRESSIVE_MODE (true/false) 或命令行参数 (--aggressive / --stable)
AGGRESSIVE_MODE="${AGGRESSIVE_MODE:-false}"

while [ $# -gt 0 ]; do
    case "$1" in
        --aggressive|--dev)
            AGGRESSIVE_MODE="true"
            shift
            ;;
        --stable|--normal)
            AGGRESSIVE_MODE="false"
            shift
            ;;
        --upstream)
            UPSTREAM_REPO="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# 根据模式确定上游仓库（若未通过环境变量或参数显式指定）
if [ -z "${UPSTREAM_REPO:-}" ]; then
    if [ "$AGGRESSIVE_MODE" = "true" ] || [ "$AGGRESSIVE_MODE" = "1" ]; then
        UPSTREAM_REPO="Glassyiris/honk"
    else
        UPSTREAM_REPO="daeuniverse/honk"
    fi
fi

git_ls_remote() {
    local attempt
    for attempt in 1 2 3 4 5; do
        if git ls-remote --tags "https://github.com/${UPSTREAM_REPO}.git" 2>/dev/null; then
            return 0
        fi
        sleep 3
    done
    return 1
}

calc_sha256() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        echo "error: neither sha256sum nor shasum is installed" >&2
        return 1
    fi
}

derive_version() {
    local tag="$1"
    local v="${tag#[vV]}"
    local prefix rest stage stage_num patch_num
    stage=""
    stage_num=""
    patch_num=""

    local has_dev_prefix=0
    if [[ "$v" =~ ^[^0-9]+([0-9].*) ]]; then
        v="${BASH_REMATCH[1]}"
        has_dev_prefix=1
    elif ! [[ "$v" =~ ^[0-9] ]]; then
        # 纯字符标签如 "debug"
        v="0.0.0_${v}"
        has_dev_prefix=1
    fi

    # 提取主版本号 (如 0.0.1 或 2026.10.3)
    prefix="$(printf '%s' "$v" | sed -E 's/^([0-9]+(\.[0-9]+)*).*/\1/')"
    [ -n "$prefix" ] || prefix="0.0.0"

    # 提取剩余修饰后缀
    rest="${v#"$prefix"}"
    rest="$(printf '%s' "$rest" | sed -E 's/^[-_.]+//')"

    if [ -n "$rest" ]; then
        rest="$(printf '%s' "$rest" | tr '[:upper:]' '[:lower:]')"

        # 提取阶段标签 (alpha/beta/pre/rc/cvs/git/hg/svn)
        if printf '%s' "$rest" | grep -qE '^(alpha|beta|pre|rc|cvs|git|hg|svn)'; then
            stage="$(printf '%s' "$rest" | sed -E -n 's/^(alpha|beta|pre|rc|cvs|git|hg|svn).*/\1/p')"
            rest="$(printf '%s' "$rest" | sed -E 's/^(alpha|beta|pre|rc|cvs|git|hg|svn)//' | sed -E 's/^[-_.]+//')"

            stage_num="$(printf '%s' "$rest" | sed -E -n 's/^([0-9]+).*/\1/p')"
            if [ -n "$stage_num" ]; then
                rest="${rest#"$stage_num"}"
                rest="$(printf '%s' "$rest" | sed -E 's/^[-_.]+//')"
            fi
        else
            # 其它分支或预发布标签 (如 native-api.2 / score.1)
            local num
            num="$(printf '%s' "$rest" | grep -oE '[0-9]+$' || true)"
            if [ -n "$num" ]; then
                stage="pre"
                stage_num="$num"
                rest=""
            elif [ "$has_dev_prefix" -eq 1 ]; then
                stage="pre"
                stage_num="1"
                rest=""
            fi
        fi

        # 提取补丁标签 (如 fix/patch)
        if [ -n "$rest" ]; then
            rest="$(printf '%s' "$rest" | sed -E 's/[-_.]//g')"
            if printf '%s' "$rest" | grep -qE '^(fix)+$'; then
                local orig_len="${#rest}"
                local stripped_rest="${rest//fix/}"
                patch_num=$(( (orig_len - ${#stripped_rest}) / 3 ))
            elif printf '%s' "$rest" | grep -qE '^(fix|patch|hotfix|p)[0-9]+'; then
                patch_num="$(printf '%s' "$rest" | sed -E -n 's/^(fix|patch|hotfix|p)([0-9]+).*/\2/p')"
            elif printf '%s' "$rest" | grep -qE '^(fix|patch|hotfix|p)$'; then
                patch_num="1"
            fi
        fi
    elif [ "$has_dev_prefix" -eq 1 ]; then
        stage="pre"
        stage_num="1"
    fi

    # 组装版本号
    local result="$prefix"
    [ -z "$stage" ] || result="${result}_${stage}${stage_num}"
    [ -z "$patch_num" ] || result="${result}_p${patch_num}"
    
    printf '%s\n' "$result"
}

assert_apk_version() {
    local v="$1"

    if command -v apk >/dev/null 2>&1; then
        apk version -c "$v" >/dev/null 2>&1 && return 0 || return 1
    fi

    local apk_regex="^[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*$"
    printf '%s' "$v" | grep -qE "$apk_regex"
}

resolve_tag() {
    if [ -n "${HONK_RELEASE_TAG:-}" ]; then
        printf '%s\n' "$HONK_RELEASE_TAG"
        return 0
    fi

    # 不使用 GitHub API，避免限流；通过页面 HTML 解析获取 Releases 页面排在最顶部的最新发布（按发布时间排序，含 prerelease）
    local releases_html tag
    releases_html="$(curl -fsSL --retry 3 --connect-timeout 10 "https://github.com/${UPSTREAM_REPO}/releases" 2>/dev/null || true)"
    tag="$(echo "$releases_html" | grep -oE "/${UPSTREAM_REPO}/releases/tag/[^\"]+" | head -n 1 | sed "s|/${UPSTREAM_REPO}/releases/tag/||")"

    if [ -n "$tag" ]; then
        printf '%s\n' "$tag"
        return 0
    fi

    # 降级方案：git ls-remote 获取最新 tag
    git_ls_remote | awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}' | sort -V | tail -n 1
}

resolve_version_from_release() {
    local tag="$1"

    # 若 tag 本身包含具体版本信息（非纯 debug），先尝试直接 derive_version
    if [ "$tag" != "debug" ]; then
        local v
        v="$(derive_version "$tag")"
        if assert_apk_version "$v" && [ "$v" != "0.0.0" ]; then
            printf '%s\n' "$v"
            return 0
        fi
    fi

    # 若 Tag 为 debug（开发者滚动更新未打新 tag），从 Release 页面说明中解析真实 Source tag、commit 或发布日期
    local release_html
    release_html="$(curl -fsSL --retry 3 --connect-timeout 10 "https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}" 2>/dev/null || true)"

    # 1. 尝试从正文的 Source tag 中解析，如 Source tag: debug.2026.10.3.native-api.1
    local source_tag
    source_tag="$(echo "$release_html" | grep -oE "Source tag:[^<]*<code>[^<]+" | sed -E "s/.*<code>//" | head -n 1 || true)"
    if [ -n "$source_tag" ]; then
        local v
        v="$(derive_version "$source_tag")"
        if assert_apk_version "$v" && [ "$v" != "0.0.0" ]; then
            printf '%s\n' "$v"
            return 0
        fi
    fi

    # 2. 尝试从发布日期解析，如 2026-10-02 -> 2026.10.2_pre1
    local rel_date
    rel_date="$(echo "$release_html" | grep -oE "<relative-time datetime=\"[0-9]{4}-[0-9]{2}-[0-9]{2}" | head -n 1 | sed -E "s/.*\"([0-9]{4})-([0-9]{2})-([0-9]{2})/\1.\2.\3/" | sed -E 's/\.0([0-9])/.\1/g' || true)"
    if [ -n "$rel_date" ]; then
        printf '%s_pre1\n' "$rel_date"
        return 0
    fi

    derive_version "$tag"
}

resolve_asset_name() {
    local target="$1"
    local suffix="$2"
    local tag="$3"

    # 不使用 GitHub API，通过 expanded_assets 解析真实文件名
    local assets_html asset_path
    assets_html="$(curl -fsSL --retry 3 --connect-timeout 15 "https://github.com/${UPSTREAM_REPO}/releases/expanded_assets/${tag}" 2>/dev/null || true)"
    asset_path="$(echo "$assets_html" | grep -oE "/${UPSTREAM_REPO}/releases/download/[^\"]*honk-core-[^\"]*${target}${suffix}\.tar\.gz" | head -n 1 || true)"

    if [ -n "$asset_path" ]; then
        basename "$asset_path"
    else
        printf 'honk-core-%s-%s%s.tar.gz\n' "$tag" "$target" "$suffix"
    fi
}

download_file() {
    local url="$1"
    local dest="$2"

    if command -v aria2c >/dev/null 2>&1; then
        local dir file
        dir="$(dirname "$dest")"
        file="$(basename "$dest")"
        if aria2c -q -x 4 -s 4 --connect-timeout=20 --timeout=30 -d "$dir" -o "$file" "$url" 2>/dev/null && [ -s "$dest" ]; then
            return 0
        fi
    fi

    curl -fsSL --retry 3 --connect-timeout 20 "$url" -o "$dest"
}

resolve_hash() {
    local var_name="$1"
    local target="$2"
    local suffix="$3"
    local tag="$4"
    local asset="$5"

    if [ -n "${!var_name:-}" ]; then
        printf '%s\n' "${!var_name}"
        return 0
    fi

    local tmp_dir tmp_file hash
    tmp_dir="$(mktemp -d)"
    tmp_file="$tmp_dir/$asset"
    local download_url="https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/${asset}"

    if ! download_file "$download_url" "$tmp_file"; then
        rm -rf "$tmp_dir"
        echo "error: unable to download ${asset} from ${download_url}" >&2
        return 1
    fi

    if ! hash="$(calc_sha256 "$tmp_file")"; then
        rm -rf "$tmp_dir"
        echo "error: unable to hash ${asset}" >&2
        return 1
    fi
    rm -rf "$tmp_dir"

    printf '%s\n' "$hash"
}

main() {
    echo "==================================="
    echo "Target upstream repository: ${UPSTREAM_REPO} (aggressive_mode=${AGGRESSIVE_MODE})"

    local tag version suffix asset_x86_64 asset_aarch64 asset_tag hash_x86_64 hash_aarch64
    tag="$(resolve_tag)"
    [ -n "$tag" ] || { echo "error: unable to resolve honk release tag" >&2; exit 1; }
    echo "Resolved release tag: ${tag}"

    version="$(resolve_version_from_release "$tag")"

    if ! assert_apk_version "$version"; then
        echo "WARNING: Parsed version '${version}' is invalid for apk-tools!" >&2
        version="$(printf '%s' "${tag#[vV]}" | sed -E 's/^([0-9]+(\.[0-9]+)*).*/\1/')"
        [ -n "$version" ] || version="0.0.0"
        echo "INFO: Falling back to strict safe PKG_VERSION='${version}'" >&2
    else
        echo "INFO: Validated PKG_VERSION='${version}'" >&2
    fi

    suffix="$(grep '^HONK_SUFFIX:=' "$MAKEFILE" | head -n 1 | cut -d= -f2- || true)"

    asset_x86_64="$(resolve_asset_name "x86_64-unknown-linux-musl" "$suffix" "$tag")"
    asset_aarch64="$(resolve_asset_name "aarch64-unknown-linux-musl" "$suffix" "$tag")"

    # 提取构建资产 tag 标识（部分测试构建如 debug.xxx 对应的资产名称为 honk-core-debug-...）
    asset_tag="$(echo "$asset_x86_64" | sed -E "s/^honk-core-(.*)-x86_64-unknown-linux-musl${suffix}\.tar\.gz$/\1/")"
    if [ -z "$asset_tag" ] || [ "$asset_tag" = "$asset_x86_64" ]; then
        asset_tag="$tag"
    fi

    echo "Resolved asset x86_64: ${asset_x86_64}"
    echo "Resolved asset aarch64: ${asset_aarch64}"
    echo "Resolved asset tag: ${asset_tag}"

    hash_x86_64="$(resolve_hash HONK_HASH_X86_64 "x86_64-unknown-linux-musl" "$suffix" "$tag" "$asset_x86_64")"
    hash_aarch64="$(resolve_hash HONK_HASH_AARCH64 "aarch64-unknown-linux-musl" "$suffix" "$tag" "$asset_aarch64")"

    # 单次 sed 完成所有 Makefile 变更（含首次插入 HONK_ASSET_TAG）
    local sed_args=(
        -e "s|^PKG_VERSION:=.*|PKG_VERSION:=${version}|"
        -e "s|^HONK_RELEASE_TAG:=.*|HONK_RELEASE_TAG:=${tag}|"
        -e "s|^HONK_HASH_X86_64:=.*|HONK_HASH_X86_64:=${hash_x86_64}|"
        -e "s|^HONK_HASH_AARCH64:=.*|HONK_HASH_AARCH64:=${hash_aarch64}|"
        -e "s|^HONK_ASSET:=.*|HONK_ASSET:=honk-core-\$(HONK_ASSET_TAG)-\$(HONK_TARGET)\$(HONK_SUFFIX).tar.gz|"
        -e "s|^PKG_SOURCE_URL:=.*|PKG_SOURCE_URL:=https://github.com/${UPSTREAM_REPO}/releases/download/\$(HONK_RELEASE_TAG)/|"
        -e "s|^  URL:=.*|  URL:=https://github.com/${UPSTREAM_REPO}|"
    )
    if grep -q '^HONK_ASSET_TAG:=' "$MAKEFILE"; then
        sed_args+=(-e "s|^HONK_ASSET_TAG:=.*|HONK_ASSET_TAG:=${asset_tag}|")
    else
        sed_args+=(-e "/^HONK_RELEASE_TAG:=/a\\HONK_ASSET_TAG:=${asset_tag}")
    fi

    sed -E "${sed_args[@]}" "$MAKEFILE" > "${MAKEFILE}.tmp"
    mv "${MAKEFILE}.tmp" "$MAKEFILE"

    echo "==================================="
    echo "honk Makefile updated successfully!"
    echo "Repo: https://github.com/${UPSTREAM_REPO}"
    echo "Tag: ${tag} (PKG_VERSION=${version})"
    echo "Asset Tag: ${asset_tag}"
    echo "HONK_HASH_X86_64=${hash_x86_64}"
    echo "HONK_HASH_AARCH64=${hash_aarch64}"
    echo "==================================="
}

main "$@"
