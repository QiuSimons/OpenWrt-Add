#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=直接修改, false=预览模式
# ----------------

echo "开始执行【OpenWrt/Alpine 深度适配修复】..."
echo "针对：PKG_VERSION 移除 ~ 后缀及相关 Makefile 逻辑"
echo "---------------------------------------------------"

find . -type f -name "Makefile" | while read -r makefile; do
    
    file_changed=0

    # =======================================================
    # 任务 1: 修复 PKG_VERSION (智能截断模式)
    # =======================================================
    
    # 提取原始版本号字符串
    raw_val=$(grep "^PKG_VERSION:=" "$makefile" | awk -F':=' '{print $2}' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    if [ -n "$raw_val" ]; then
        new_val="$raw_val"
        mode=""

        # --- 智能清洗逻辑 ---
        
        # 步骤 1: 处理 Makefile 条件逻辑 $(if ...,~...)
        # 你的案例中有：$(if $(PKG_UPSTREAM_GITHASH),~$(call ...))
        # 逻辑：如果这一行包含 "$(if" 且紧接着的逻辑里有 "~"，则认为这是一个追加版本号的逻辑块，直接删掉。
        # 使用 sed -E (扩展正则) 匹配 $(if ... , ~ ... 
        if echo "$new_val" | grep -q "\$(if.*,.*~"; then
             # 解释：匹配 $(if ... , (任意空格) ~ (后面所有内容) 并替换为空
             temp_val=$(echo "$new_val" | sed -E 's/\$\(if[^,]+,[[:space:]]*~.*//')
             if [ "$temp_val" != "$new_val" ]; then
                 new_val="$temp_val"
                 mode="移除逻辑块"
             fi
        fi

        # 步骤 2: 处理普通后缀 (截断 ~ 及其后所有内容)
        # 你的案例中有：0.9.0~$(call ...) 或 1.2.17~git...
        # 逻辑：只要还剩有 ~，就从 ~ 处一刀切，丢弃后面所有东西
        if [[ "$new_val" == *"~"* ]]; then
             new_val=$(echo "$new_val" | sed 's/~.*//')
             mode="${mode:+${mode}+}截断后缀"
        fi

        # 步骤 3: 静态版本号常规清洗 (去v，非法字符转点)
        # 只有当剩下的字符串里没有 $ (不是变量) 时才执行，防止把变量名给洗坏了
        if [[ "$new_val" != *"\$"* ]]; then
             # 掐头 (去掉非数字开头)
             s1=$(echo "$new_val" | sed 's/^[^0-9]*//')
             # 清洗 (非字母数字点 -> .)
             s2=$(echo "$s1" | sed 's/[^a-zA-Z0-9.]/./g')
             # 整形 (合并点)
             final_static=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
             
             if [ "$new_val" != "$final_static" ]; then
                 new_val="$final_static"
                 mode="${mode:+${mode}+}格式化"
             fi
        fi

        # --- 执行修改 ---
        if [ "$raw_val" != "$new_val" ]; then
            echo "[修复 Version] $makefile"
            echo "  原始: $raw_val"
            echo "  新值: $new_val"
            echo "  操作: $mode"
            
            if [ "$DO_EDIT" = true ]; then
                # 安全替换：使用 | 作为分隔符，且不对变量再次进行正则转义，直接字面匹配行首
                # 先转义 new_val 中的特殊字符以防破坏 sed 语法 (主要是 & 和 /)
                safe_raw=$(echo "$raw_val" | sed 's/\[/\\\[/g' | sed 's/\]/\\\]/g' | sed 's/\*/\\*/g' | sed 's/\./\\./g' | sed 's/\$/\\$/g')
                
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
