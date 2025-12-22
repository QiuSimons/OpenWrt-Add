#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=直接修改, false=预览模式
# ----------------

echo "=== OpenWrt APK 兼容性全能修复工具 ==="
echo "目标: 规范语义化版本(Semantic Versioning) + 绕过 Hash 校验"
echo "---------------------------------------------------"

# 使用 find 查找所有 Makefile
find . -type f -name "Makefile" | while read -r makefile; do
    
    file_changed=0
    content_changed=0
    
    # 读取原始 Version
    raw_ver=$(grep "^PKG_VERSION:=" "$makefile" | head -n 1 | cut -d'=' -f2 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    # =======================================================
    # 任务 1: 智能修复 PKG_VERSION (APK 核心修复)
    # =======================================================
    if [ -n "$raw_ver" ]; then
        new_ver="$raw_ver"
        fix_mode=""

        # 排除包含变量 $(...) 的情况，通常动态版本难以通过静态脚本完美修复，选择保守策略
        if [[ "$raw_ver" == *"\$"* ]]; then
            # 如果包含 ~ (Debian/Opkg 习惯)，在 APK 中应改为 _
            if [[ "$raw_ver" == *"~"* ]]; then
                fix_mode="动态(微调)"
                new_ver=$(echo "$raw_ver" | sed 's/~/./g')
            fi
        else
            # 静态版本: APK 强力适配
            # 步骤 1: 预处理，把常见的非版本字符 (- , + , ~) 统一变成下划线 _
            # APK 偏好下划线作为后缀连接符 (如 _git, _rc)
            s1=$(echo "$raw_ver" | sed 's/[^a-zA-Z0-9.]/_/g')

            # 步骤 2: 【关键】解决 "点后接字母" 的非法格式
            # 逻辑: 查找 ".字母" 结构，将 "." 替换为 "_"
            # 例子: 2023.01.d5fa -> 2023.01_d5fa
            s2=$(echo "$s1" | sed -E 's/\.([a-zA-Z])/_/g')

            # 步骤 3: 去除连续的下划线或点，去除末尾标点
            final_ver=$(echo "$s2" | sed 's/__*/_/g' | sed 's/\.\.*/./g' | sed 's/[._]$//')

            if [ "$raw_ver" != "$final_ver" ]; then
                fix_mode="静态(APK适配)"
                new_ver="$final_ver"
            fi
        fi

        if [ -n "$fix_mode" ] && [ "$raw_ver" != "$new_ver" ]; then
            echo "🔧 [$fix_mode] $makefile"
            echo "   🔴 原始: $raw_ver"
            echo "   🟢 新值: $new_ver"
            
            if [ "$DO_EDIT" = true ]; then
                # 使用 Perl 原地替换，避免 sed 的转义地狱
                perl -pi -e "s/^PKG_VERSION:=\Q$raw_ver\E/PKG_VERSION:=$new_ver/" "$makefile"
                file_changed=1
            fi
        fi
    fi

    # =======================================================
    # 任务 2: 移除 AUTORELEASE (APK 不支持)
    # =======================================================
    if grep -q "^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)" "$makefile"; then
        echo "🔧 [Fix Release] $makefile"
        echo "   ℹ️  将 \$(AUTORELEASE) 替换为 1"
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_RELEASE[[:space:]]*:=[[:space:]]*\$(AUTORELEASE)/PKG_RELEASE:=1/' "$makefile"
            file_changed=1
        fi
    fi

    # =======================================================
    # 任务 3: 强制跳过 Hash 校验 (PKG_MIRROR_HASH & PKG_HASH)
    # =======================================================
    # 处理 PKG_MIRROR_HASH
    if grep -q "^PKG_MIRROR_HASH:=" "$makefile" && grep "^PKG_MIRROR_HASH:=" "$makefile" | grep -qv "skip"; then
        echo "🔧 [Skip Mirror Hash] $makefile"
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_MIRROR_HASH:=.*/PKG_MIRROR_HASH:=skip/' "$makefile"
            file_changed=1
        fi
    fi

    # 处理旧版 PKG_HASH (有些包还在用这个)
    if grep -q "^PKG_HASH:=" "$makefile" && grep "^PKG_HASH:=" "$makefile" | grep -qv "skip"; then
        echo "🔧 [Skip Legacy Hash] $makefile"
        if [ "$DO_EDIT" = true ]; then
            sed -i 's/^PKG_HASH:=.*/PKG_HASH:=skip/' "$makefile"
            file_changed=1
        fi
    fi

    if [ "$file_changed" -eq 1 ]; then
        echo "   ✅ 文件已更新"
        echo ""
    fi

done

echo "🎉 处理完成。"
