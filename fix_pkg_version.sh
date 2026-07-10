#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=直接修改, false=预览模式
# ----------------

echo "开始执行【OpenWrt/Alpine 深度适配修复】..."
echo "针对：PKG_VERSION 移除 ~ 后缀及非法字母清理"
echo "---------------------------------------------------"

find . -type f -name "Makefile" | while read -r makefile; do
    
    file_changed=0

    # =======================================================
    # 任务 1: 修复 PKG_VERSION (智能截断 + 强力纯数字模式)
    # =======================================================
    
    # 提取原始版本号字符串
    raw_val=$(grep "^PKG_VERSION:=" "$makefile" | awk -F':=' '{print $2}' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    if [ -n "$raw_val" ]; then
        new_val="$raw_val"
        mode=""

        # --- 智能清洗逻辑 ---
        
        # 步骤 1: 处理 Makefile 条件逻辑 $(if ...,~...)
        if echo "$new_val" | grep -q "\$(if.*,.*~"; then
             temp_val=$(echo "$new_val" | sed -E 's/\$\(if[^,]+,[[:space:]]*~.*//')
             if [ "$temp_val" != "$new_val" ]; then
                 new_val="$temp_val"
                 mode="移除逻辑块"
             fi
        fi

        # 步骤 2: 处理普通后缀 (截断 ~ 及其后所有内容)
        if [[ "$new_val" == *"~"* ]]; then
             new_val=$(echo "$new_val" | sed 's/~.*//')
             mode="${mode:+${mode}+}截断后缀"
        fi

        # 步骤 3: 静态版本号强力清洗 (纯数字规范化)
        # 针对 apk 规范增强：将 1.0.5.r20241208 强洗为 1.0.5.20241208
        if [[ "$new_val" != *"\$"* ]]; then
             # 3.1 掐头：去掉最开头的所有非数字字符 (例如 v1.0 -> 1.0)
             s1=$(echo "$new_val" | sed 's/^[^0-9]*//')
             
             # 3.2 强力降噪：将所有【非数字】且【非点号】的字符全替换为点号
             # 这里的巧妙之处在于：.r2024 会变成 ..2024，-git5 会变成 ..5
             s2=$(echo "$s1" | sed 's/[^0-9.]/./g')
             
             # 3.3 整形：合并连续的多个点号，并去掉行尾可能残留的点号
             final_static=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
             
             # 安全校验：确保清洗后没有变成空值（防止原版本号全是字母的极端错误情况）
             if [ -n "$final_static" ] && [ "$new_val" != "$final_static" ]; then
                 new_val="$final_static"
                 mode="${mode:+${mode}+}纯数字格式化"
             fi
        fi

        # --- 执行修改 ---
        if [ "$raw_val" != "$new_val" ]; then
            echo "[修复 Version] $makefile"
            echo "  原始: $raw_val"
            echo "  新值: $new_val"
            echo "  操作: $mode"
            
            if [ "$DO_EDIT" = true ]; then
                # 针对含有 $() 的复杂字符串，最稳妥的是直接匹配行首 PKG_VERSION:=
                sed -i "s|^PKG_VERSION:=.*|PKG_VERSION:=$new_val|" "$makefile"
                echo "  -> 已修正"
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
        echo "[修复 Release] $makefile"
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)/PKG_RELEASE:=1/' "$makefile"
            echo "  -> 已替换为 1"
            file_changed=1
        fi
        echo ""
    fi

    # =======================================================
    # 任务 3: 修复 PKG_MIRROR_HASH (强制改为 skip)
    # =======================================================
    if grep -q "^PKG_MIRROR_HASH:=" "$makefile" && grep "^PKG_MIRROR_HASH:=" "$makefile" | grep -qv "^PKG_MIRROR_HASH:=skip[[:space:]]*$"; then
        echo "[修复 Mirror Hash] $makefile"
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_MIRROR_HASH:=.*/PKG_MIRROR_HASH:=skip/' "$makefile"
            echo "  -> 已修改为 skip"
            file_changed=1
        fi
        echo ""
    fi

done

echo "处理完成。"
