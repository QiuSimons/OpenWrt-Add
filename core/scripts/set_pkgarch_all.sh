#!/usr/bin/env bash
set -e
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets" && pwd)"
LIST="$LIST_DIR/pkgarch-all.list"
cd "$REPO_ROOT" || exit 1
[ -f "$LIST" ] || exit 0

echo "[PGKARCH] 处理 PKGARCH:=all 清单..."
while IFS= read -r name; do
    case "$name" in ''|'#'*) continue ;; esac
    name="$(echo "$name" | xargs)"
    mf="$(grep -rl --include=Makefile "^PKG_NAME:=[[:space:]]*$name[[:space:]]*$" apps themes legacy invasive 2>/dev/null | head -n 1)"
    [ -n "$mf" ] || { echo "  ! $name: Makefile not found"; continue; }
    if grep -qE "^[[:space:]]*PKGARCH:=" "$mf"; then
        sed -i -E "s|^[[:space:]]*PKGARCH:=.*|  PKGARCH:=all|" "$mf"
    else
        sed -i "0,/^define Package\/$name\$/s//define Package\/$name\n  PKGARCH:=all/" "$mf"
    fi
    echo "  -> $name ($mf)"
done < "$LIST"

echo "[PKGARCH] 完成。"
exit 0
