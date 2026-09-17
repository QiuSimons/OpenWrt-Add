#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=直接修改, false=预览模式
# ----------------

# [新增] Alpine apk-tools 合法版本号的官方正则 (支持无限极后缀叠加)
APK_VALID_REGEX="^[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*$"

echo "开始执行【OpenWrt/Alpine 深度适配修复】..."
echo "针对：PKG_VERSION 移除 ~ 后缀及智能放行合法版本号"
echo "---------------------------------------------------"

find . -type f -name "Makefile" | while read -r makefile; do
    
    file_changed=0

    # =======================================================
    # 任务 1: 修复 PKG_VERSION (智能截断 + 兜底纯数字模式)
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

        # 步骤 2: 处理 Debian 风格普通后缀 (截断 ~ 及其后所有内容)
        # 注意: ~ 符号在 apk-tools 中绝对非法，必须截掉
        if [[ "$new_val" == *"~"* ]]; then
             new_val=$(echo "$new_val" | sed 's/~.*//')
             mode="${mode:+${mode}+}截断非法波浪号"
        fi

        # 步骤 3: 校验与兜底清洗 (仅处理静态字面量版本号)
        if [[ "$new_val" != *"\$"* ]]; then
            
            # 【核心优化】：如果当前版本号已经符合 Alpine/apk 规范，则直接放行，跳过暴力降噪！
            if ! echo "$new_val" | grep -qE "$APK_VALID_REGEX"; then
                
                # 只有不合法的版本号（如 1.0.5.r20241208 或 v1.2-stable）才会进入兜底的暴力纯数字模式
                
                # 3.1 掐头：去掉最开头的所有非数字字符 (例如 v1.0 -> 1.0)
                s1=$(echo "$new_val" | sed 's/^[^0-9]*//')
                
                # 3.2 强力降噪：将所有【非数字】且【非点号】的字符全替换为点号
                s2=$(echo "$s1" | sed 's/[^0-9.]/./g')
                
                # 3.3 整形：合并连续的多个点号，并去掉行尾可能残留的点号
                final_static=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
                
                # 安全校验：确保清洗后没有变成空值
                if [ -n "$final_static" ] && [ "$new_val" != "$final_static" ]; then
                    new_val="$final_static"
                    mode="${mode:+${mode}+}触发兜底(纯数字格式化)"
                fi
            else
                # 为了日志美观，若被前面步骤截断后变合法，标注一下
                if [ "$raw_val" != "$new_val" ]; then
                     mode="${mode:+${mode}+}匹配合规放行"
                fi
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
                sed -i -E "s|^PKG_VERSION:=.*|PKG_VERSION:=$new_val|" "$makefile"
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
