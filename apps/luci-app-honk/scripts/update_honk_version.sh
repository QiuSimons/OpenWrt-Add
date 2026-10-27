#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAKEFILE="$REPO_DIR/honk/Makefile"

AGGRESSIVE_MODE="${AGGRESSIVE_MODE:-false}"
PREFERRED_VARIANT="${HONK_PREFERRED_VARIANT:-${PREFERRED_VARIANT:-native-api}}"

while [ $# -gt 0 ]; do
    case "$1" in
        --aggressive|--dev) AGGRESSIVE_MODE="true"; shift ;;
        --stable|--normal)   AGGRESSIVE_MODE="false"; shift ;;
        --upstream)         UPSTREAM_REPO="$2"; shift 2 ;;
        --variant)          PREFERRED_VARIANT="$2"; shift 2 ;;
        --tag)              HONK_RELEASE_TAG="$2"; shift 2 ;;
        *) shift ;;
    esac
done

if [ -z "${UPSTREAM_REPO:-}" ]; then
    if [ "$AGGRESSIVE_MODE" = "true" ] || [ "$AGGRESSIVE_MODE" = "1" ]; then
        UPSTREAM_REPO="Glassyiris/honk"
    else
        UPSTREAM_REPO="daeuniverse/honk"
    fi
fi

TMP_DIR="$(mktemp -d)"
TMP_SHA256SUMS="$TMP_DIR/SHA256SUMS"
trap 'rm -rf "$TMP_DIR"' EXIT

git_ls_remote() {
    for _ in {1..5}; do
        if git ls-remote --tags "https://github.com/${UPSTREAM_REPO}.git" 2>/dev/null; then
            return 0
        fi
        sleep 2
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
        echo "error: sha256sum/shasum not found" >&2
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
        v="0.0.0_${v}"
        has_dev_prefix=1
    fi

    prefix="$(printf '%s' "$v" | sed -E 's/^([0-9]+(\.[0-9]+)*).*/\1/')"
    [ -n "$prefix" ] || prefix="0.0.0"

    rest="${v#"$prefix"}"
    rest="$(printf '%s' "$rest" | sed -E 's/^[-_.]+//')"

    if [ -n "$rest" ]; then
        rest="$(printf '%s' "$rest" | tr '[:upper:]' '[:lower:]')"

        if printf '%s' "$rest" | grep -qE '^(alpha|beta|pre|rc|cvs|git|hg|svn)'; then
            stage="$(printf '%s' "$rest" | sed -E -n 's/^(alpha|beta|pre|rc|cvs|git|hg|svn).*/\1/p')"
            rest="$(printf '%s' "$rest" | sed -E 's/^(alpha|beta|pre|rc|cvs|git|hg|svn)//' | sed -E 's/^[-_.]+//')"

            stage_num="$(printf '%s' "$rest" | sed -E -n 's/^([0-9]+).*/\1/p')"
            if [ -n "$stage_num" ]; then
                rest="${rest#"$stage_num"}"
                rest="$(printf '%s' "$rest" | sed -E 's/^[-_.]+//')"
            fi
        else
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
    printf '%s' "$v" | grep -qE "^[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*$"
}

resolve_tag() {
    if [ -n "${HONK_RELEASE_TAG:-}" ]; then
        printf '%s\n' "$HONK_RELEASE_TAG"
        return 0
    fi

    local releases_html tag
    releases_html="$(curl -fsSL --retry 3 --connect-timeout 10 "https://github.com/${UPSTREAM_REPO}/releases" 2>/dev/null || true)"
    tag="$(echo "$releases_html" | grep -oE "/${UPSTREAM_REPO}/releases/tag/[^\"]+" | head -n 1 | sed "s|/${UPSTREAM_REPO}/releases/tag/||")"

    if [ -n "$tag" ]; then
        printf '%s\n' "$tag"
        return 0
    fi

    git_ls_remote | awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}' | sort -V | tail -n 1
}

resolve_version_from_release() {
    local tag="$1"
    if [ "$tag" != "debug" ]; then
        local v
        v="$(derive_version "$tag")"
        if assert_apk_version "$v" && [ "$v" != "0.0.0" ]; then
            printf '%s\n' "$v"
            return 0
        fi
    fi

    local release_html
    release_html="$(curl -fsSL --retry 3 --connect-timeout 10 "https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}" 2>/dev/null || true)"

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

    local rel_date
    rel_date="$(echo "$release_html" | grep -oE "<relative-time datetime=\"[0-9]{4}-[0-9]{2}-[0-9]{2}" | head -n 1 | sed -E "s/.*\"([0-9]{4})-([0-9]{2})-([0-9]{2})/\1.\2.\3/" | sed -E 's/\.0([0-9])/.\1/g' || true)"
    if [ -n "$rel_date" ]; then
        printf '%s_pre1\n' "$rel_date"
        return 0
    fi

    derive_version "$tag"
}

fetch_release_assets_info() {
    local tag="$1"
    local sums_url="https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/SHA256SUMS"
    local expanded_url="https://github.com/${UPSTREAM_REPO}/releases/expanded_assets/${tag}"
    local tag_url="https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}"

    if curl -fsSL --retry 3 --connect-timeout 10 "$sums_url" -o "$TMP_SHA256SUMS" 2>/dev/null && [ -s "$TMP_SHA256SUMS" ]; then
        if grep -qE '^[0-9a-fA-F]{64}[[:space:]]' "$TMP_SHA256SUMS"; then
            awk '{print $2}' "$TMP_SHA256SUMS" | sed 's|^\*||' | grep -v '^$'
            return 0
        fi
    fi

    local html
    html="$(curl -fsSL --retry 3 --connect-timeout 15 "$expanded_url" 2>/dev/null || true)"
    [ -n "$html" ] || html="$(curl -fsSL --retry 3 --connect-timeout 15 "$tag_url" 2>/dev/null || true)"

    if [ -n "$html" ]; then
        echo "$html" | grep -oE "/${UPSTREAM_REPO}/releases/download/[^\"]*honk-core-[^\"]*\.tar\.gz" | sed 's|.*/||' | sort -u
        return 0
    fi

    return 1
}

match_asset_name() {
    local target="$1" suffix="$2" pref="$3" list="$4" tag="$5"
    local p matched=""

    local patterns=(
        "honk-core-.*-${target}${suffix}-${pref}\.tar\.gz$"
        "honk-core-.*-${target}${suffix}-full\.tar\.gz$"
        "honk-core-.*-${target}${suffix}\.tar\.gz$"
        "honk-core-.*-${target}-${pref}\.tar\.gz$"
        "honk-core-.*-${target}-full\.tar\.gz$"
        "honk-core-.*-${target}\.tar\.gz$"
        "honk-core-.*-${target}.*\.tar\.gz$"
    )

    for p in "${patterns[@]}"; do
        matched="$(printf '%s\n' "$list" | grep -E "$p" | head -n 1 || true)"
        if [ -n "$matched" ]; then
            printf '%s\n' "$matched"
            return 0
        fi
    done

    if [ -n "$pref" ] && [ "$pref" != "none" ]; then
        printf 'honk-core-%s-%s%s-%s.tar.gz\n' "$tag" "$target" "$suffix" "$pref"
    else
        printf 'honk-core-%s-%s%s.tar.gz\n' "$tag" "$target" "$suffix"
    fi
}

resolve_hash() {
    local var_name="$1" tag="$2" asset="$3"

    if [ -n "${!var_name:-}" ]; then
        printf '%s\n' "${!var_name}"
        return 0
    fi

    if [ -s "$TMP_SHA256SUMS" ]; then
        local sum
        sum="$(grep -E "[[:space:]]\*?${asset}$" "$TMP_SHA256SUMS" | awk '{print $1}' | head -n 1 || true)"
        if [[ "$sum" =~ ^[0-9a-fA-F]{64}$ ]]; then
            printf '%s\n' "$sum"
            return 0
        fi
    fi

    local tmp_file="$TMP_DIR/$asset"
    local url="https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/${asset}"
    curl -fsSL --retry 3 --connect-timeout 20 "$url" -o "$tmp_file"
    calc_sha256 "$tmp_file"
}

main() {
    echo "==================================="
    echo "Target upstream repository: ${UPSTREAM_REPO} (aggressive_mode=${AGGRESSIVE_MODE}, preferred_variant=${PREFERRED_VARIANT})"

    local tag version suffix
    tag="$(resolve_tag)"
    [ -n "$tag" ] || { echo "error: unable to resolve honk release tag" >&2; exit 1; }
    echo "Resolved release tag: ${tag}"

    version="$(resolve_version_from_release "$tag")"
    if ! assert_apk_version "$version"; then
        version="$(printf '%s' "${tag#[vV]}" | sed -E 's/^([0-9]+(\.[0-9]+)*).*/\1/')"
        assert_apk_version "$version" || { echo "error: invalid PKG_VERSION '${version}'" >&2; exit 1; }
    fi
    echo "Validated PKG_VERSION: ${version}"

    suffix="$(grep '^HONK_SUFFIX:=' "$MAKEFILE" | head -n 1 | cut -d= -f2- || true)"

    local assets_list asset_x86_64 asset_aarch64 asset_tag variant rest
    assets_list="$(fetch_release_assets_info "$tag" || true)"

    asset_x86_64="$(match_asset_name "x86_64-unknown-linux-musl" "$suffix" "$PREFERRED_VARIANT" "$assets_list" "$tag")"
    asset_aarch64="$(match_asset_name "aarch64-unknown-linux-musl" "$suffix" "$PREFERRED_VARIANT" "$assets_list" "$tag")"

    asset_tag="$(echo "$asset_x86_64" | sed -E "s/^honk-core-(.*)-x86_64-unknown-linux-musl.*\.tar\.gz$/\1/")"
    [ -n "$asset_tag" ] && [ "$asset_tag" != "$asset_x86_64" ] || asset_tag="$tag"

    rest="$(echo "$asset_x86_64" | sed -E "s/^honk-core-.*-x86_64-unknown-linux-musl(.*)\.tar\.gz$/\1/")"
    variant="$rest"
    if [ -n "$suffix" ] && [[ "$variant" == "$suffix"* ]]; then
        variant="${variant#"$suffix"}"
    fi

    echo "Resolved asset x86_64: ${asset_x86_64}"
    echo "Resolved asset aarch64: ${asset_aarch64}"
    echo "Resolved asset tag: ${asset_tag}"
    echo "Resolved variant: ${variant}"

    local hash_x86_64 hash_aarch64
    hash_x86_64="$(resolve_hash HONK_HASH_X86_64 "$tag" "$asset_x86_64")"
    hash_aarch64="$(resolve_hash HONK_HASH_AARCH64 "$tag" "$asset_aarch64")"

    local sed_args=(
        -e "s|^PKG_VERSION:=.*|PKG_VERSION:=${version}|"
        -e "s|^HONK_RELEASE_TAG:=.*|HONK_RELEASE_TAG:=${tag}|"
        -e "s|^HONK_HASH_X86_64:=.*|HONK_HASH_X86_64:=${hash_x86_64}|"
        -e "s|^HONK_HASH_AARCH64:=.*|HONK_HASH_AARCH64:=${hash_aarch64}|"
        -e "s|^HONK_ASSET:=.*|HONK_ASSET:=honk-core-\$(HONK_ASSET_TAG)-\$(HONK_TARGET)\$(HONK_SUFFIX)\$(HONK_VARIANT).tar.gz|"
        -e "s|^PKG_SOURCE_URL:=.*|PKG_SOURCE_URL:=https://github.com/${UPSTREAM_REPO}/releases/download/\$(HONK_RELEASE_TAG)/|"
        -e "s|^  URL:=.*|  URL:=https://github.com/${UPSTREAM_REPO}|"
    )
    if grep -q '^HONK_ASSET_TAG:=' "$MAKEFILE"; then
        sed_args+=(-e "s|^HONK_ASSET_TAG:=.*|HONK_ASSET_TAG:=${asset_tag}|")
    else
        sed_args+=(-e "/^HONK_RELEASE_TAG:=/a\\HONK_ASSET_TAG:=${asset_tag}")
    fi

    if grep -q '^HONK_VARIANT:=' "$MAKEFILE"; then
        sed_args+=(-e "s|^HONK_VARIANT:=.*|HONK_VARIANT:=${variant}|")
    else
        sed_args+=(-e "/^HONK_SUFFIX:=/a\\HONK_VARIANT:=${variant}")
    fi

    sed -E "${sed_args[@]}" "$MAKEFILE" > "${MAKEFILE}.tmp"
    mv "${MAKEFILE}.tmp" "$MAKEFILE"

    echo "==================================="
    echo "honk Makefile updated successfully!"
    echo "Tag: ${tag} (PKG_VERSION=${version})"
    echo "HONK_HASH_X86_64=${hash_x86_64}"
    echo "HONK_HASH_AARCH64=${hash_aarch64}"
    echo "==================================="
}

main "$@"
