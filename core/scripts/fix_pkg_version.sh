#!/usr/bin/env bash
# ==============================================================================
# OpenWrt/Alpine apk-tools 版本号规范化
# ==============================================================================

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

APK_VALID_REGEX="^[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*$"

echo "[Version] 开始执行 OpenWrt/Alpine 版本号合规修复..."

find "$REPO_ROOT" -type f -name "Makefile" ! -path "*/.*/*" ! -path "*/core/*" | while read -r makefile; do
    raw_val=$(grep "^PKG_VERSION:=" "$makefile" 2>/dev/null | awk -F':=' '{print $2}' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    if [ -n "$raw_val" ]; then
        new_val="$raw_val"

        if echo "$new_val" | grep -q "\$(if.*,.*~"; then
             temp_val=$(echo "$new_val" | sed -E 's/\$\(if[^,]+,[[:space:]]*~.*//')
             [ "$temp_val" != "$new_val" ] && new_val="$temp_val"
        fi

        if [[ "$new_val" == *"~"* ]]; then
             new_val=$(echo "$new_val" | sed 's/~.*//')
        fi

        if [[ "$new_val" != *"\$"* ]]; then
            if ! echo "$new_val" | grep -qE "$APK_VALID_REGEX"; then
                s1=$(echo "$new_val" | sed 's/^[^0-9]*//')
                s2=$(echo "$s1" | sed 's/[^0-9.]/./g')
                final_static=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
                if [ -n "$final_static" ] && [ "$new_val" != "$final_static" ]; then
                    new_val="$final_static"
                fi
            fi
        fi

        if [ "$raw_val" != "$new_val" ]; then
            sed -i -E "s|^PKG_VERSION:=.*|PKG_VERSION:=$new_val|" "$makefile"
            echo "  [修复 Version] $makefile ($raw_val -> $new_val)"
        fi
    fi

    # 任务 2: 修复 PKG_RELEASE (移除 AUTORELEASE)
    if grep -q "^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)" "$makefile" 2>/dev/null; then
        sed -i 's/^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)/PKG_RELEASE:=1/' "$makefile"
        echo "  [修复 Release] $makefile (AUTORELEASE -> 1)"
    fi

    # 任务 3: 修复 PKG_MIRROR_HASH (强制改为 skip)
    if grep -q "^PKG_MIRROR_HASH:=" "$makefile" 2>/dev/null && grep "^PKG_MIRROR_HASH:=" "$makefile" | grep -qv "^PKG_MIRROR_HASH:=skip[[:space:]]*$"; then
        sed -i 's/^PKG_MIRROR_HASH:=.*/PKG_MIRROR_HASH:=skip/' "$makefile"
        echo "  [修复 Mirror Hash] $makefile -> skip"
    fi
done

echo "[Version] 版本号修复完成。"
exit 0
