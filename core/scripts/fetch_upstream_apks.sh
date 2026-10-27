#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:?usage: fetch_upstream_apks.sh <out_dir>}"
CONF="${UPSTREAM_CONF:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)/upstream-releases.conf}"

mkdir -p "$OUT_DIR"
[ -f "$CONF" ] || { echo "[upstream] no config, skip"; exit 0; }

total=0
while IFS='|' read -r name repo pattern _dir; do
    name="$(echo "$name" | xargs)"
    repo="$(echo "$repo" | xargs)"
    pattern="$(echo "$pattern" | xargs)"
    case "$name" in ''|'#'*) continue ;; esac
    [ -n "$repo" ] && [ -n "$pattern" ] || continue

    tag="$(curl -sI "https://github.com/$repo/releases/latest" | tr -d '\r' | sed -n 's|.*/tag/||p' | head -n 1)"
    if [ -z "$tag" ]; then echo "[upstream] $repo: no release tag, skip"; continue; fi

    assets="$(curl -fsSL "https://github.com/$repo/releases/expanded_assets/$tag" 2>/dev/null | grep -oE "/$repo/releases/download/[^\"]+" | sed 's|.*/download/||' | sort -u || true)"
    if [ -z "$assets" ]; then echo "[upstream] $repo@$tag: no assets, skip"; continue; fi

    got=0
    for rel in $assets; do
        file="${rel##*/}"
        echo "$file" | grep -qE "$pattern" || continue
        if curl -fsSL --retry 3 -o "$OUT_DIR/$file" "https://github.com/$repo/releases/download/$rel"; then
            got=$((got + 1))
        else
            echo "[upstream] $repo: download failed $file"
        fi
    done
    echo "[upstream] $repo@$tag: $got apk(s)"
    total=$((total + got))
done < "$CONF"

echo "[upstream] total downloaded: $total"
