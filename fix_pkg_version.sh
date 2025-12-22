#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=直接修改, false=预览模式
# ----------------

echo "开始执行【全能修复】(版本号规范 + 移除 AUTORELEASE + Hash Skip)..."
echo "---------------------------------------------------"

find . -type f -name "Makefile" | while read -r makefile; do
    
    file_changed=0

    # =======================================================
    # 任务 1: 修复 PKG_VERSION (解决 Alpine/apk 报错)
    # =======================================================
    
    # 提取原始版本号
    raw_val=$(grep "^PKG_VERSION:=" "$makefile" | awk -F':=' '{print $2}' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    if [ -n "$raw_val" ]; then
        new_val="$raw_val"
        mode=""

        # --- 判断处理模式 ---
        if [[ "$raw_val" == *"\$"* ]]; then
            # 动态版本: 仍然保持保守策略，只换 ~ 为 .
            if [[ "$raw_val" == *"~"* ]]; then
                mode="动态(保守)"
                new_val=$(echo "$raw_val" | sed 's/~/./g')
            fi
        else
            # 静态版本: 强力清洗
            # 【修复点 1】: 优先截断 ~ 及后面的内容 (针对 2023.01.25~xxxx -> 2023.01.25)
            s_cut=$(echo "$raw_val" | sed 's/~.*//')

            # 1. 掐头 (去掉非数字开头，例如 v1.0 -> 1.0)
            s1=$(echo "$s_cut" | sed 's/^[^0-9]*//')
            
            # 2. 清洗 (非字母数字点 -> .)
            s2=$(echo "$s1" | sed 's/[^a-zA-Z0-9.]/./g')
            
            # 3. 整形 (合并多余的点，去掉末尾的点)
            final_static=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
            
            if [ "$raw_val" != "$final_static" ]; then
                mode="静态(强力截断)"
                new_val="$final_static"
            fi
        fi

        # 执行 Version 修改
        if [ -n "$mode" ] && [ "$raw_val" != "$new_val" ]; then
            echo "[修复 Version - $mode] $makefile"
            echo "  原始: $raw_val"
            echo "  新值: $new_val"
            
            if [ "$DO_EDIT" = true ]; then
                # 使用 Perl 进行安全替换 (处理特殊字符)
                if command -v perl >/dev/null 2>&1; then
                    export F_FILE="$makefile"
                    export F_OLD="PKG_VERSION:=$raw_val"
                    export F_NEW="PKG_VERSION:=$new_val"
                    perl -pi -e 's/\Q$ENV{F_OLD}\E/$ENV{F_NEW}/' "$makefile"
                else
                    # Sed 降级方案
                    # 【修复点 2】: 你的 safe_old 已经转义了特殊字符，不需要也不应该在 sed 中再加 \Q \E (这是 Perl 语法)
                    safe_old=$(echo "PKG_VERSION:=$raw_val" | sed 's/\[/\\\[/g' | sed 's/\]/\\\]/g' | sed 's/\*/\\*/g' | sed 's/\./\\./g' | sed 's/\$/\\$/g')
                    safe_new="PKG_VERSION:=$new_val"
                    
                    # 尝试精确匹配行首
                    sed -i "s|^$safe_old|$safe_new|" "$makefile" 2>/dev/null || \
                    sed -i "s|^PKG_VERSION:=.*|$safe_new|" "$makefile"
                fi
                echo "  -> 已修正版本号"
                file_changed=1
            else
                echo "  -> (预览)"
            fi
            echo ""
        fi
    fi

    # =======================================================
    # 任务 2: 修复 PKG_RELEASE (移除 AUTORELEASE)
    # =======================================================
    
    if grep -q "^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)" "$makefile"; then
        echo "[修复 Release - Deprecated] $makefile"
        echo "  发现: PKG_RELEASE := \$(AUTORELEASE)"
        echo "  目标: PKG_RELEASE := 1"
        
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)/PKG_RELEASE:=1/' "$makefile"
            echo "  -> 已替换为 1"
            file_changed=1
        else
            echo "  -> (预览)"
        fi
        echo ""
    fi

    # =======================================================
    # 任务 3: 修复 PKG_MIRROR_HASH (强制改为 skip)
    # =======================================================
    
    # 检查是否有 PKG_MIRROR_HASH 且当前值不完全等于 skip
    if grep -q "^PKG_MIRROR_HASH:=" "$makefile" && grep "^PKG_MIRROR_HASH:=" "$makefile" | grep -qv "^PKG_MIRROR_HASH:=skip[[:space:]]*$"; then
        
        old_hash=$(grep "^PKG_MIRROR_HASH:=" "$makefile")
        
        echo "[修复 Mirror Hash] $makefile"
        echo "  原始: $old_hash"
        echo "  目标: PKG_MIRROR_HASH:=skip"
        
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_MIRROR_HASH:=.*/PKG_MIRROR_HASH:=skip/' "$makefile"
            echo "  -> 已修改为 skip"
            file_changed=1
        else
            echo "  -> (预览)"
        fi
        echo ""
    fi

done

echo "全部扫描处理完成。"
