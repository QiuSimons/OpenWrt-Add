#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=直接修改, false=预览模式
# ----------------

echo "开始执行【全能修复】(版本号规范 + 移除 AUTORELEASE + Hash Skip + APK兼容)..."
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
            # 动态版本: 只把 ~ 换成 . (保守策略)
            if [[ "$raw_val" == *"~"* ]]; then
                mode="动态(保守)"
                new_val=$(echo "$raw_val" | sed 's/~/./g')
            fi
        else
            # 静态版本: 强力清洗 (去掉v, 非法字符变点, 合并点)
            # 1. 掐头 (去掉非数字开头)
            s1=$(echo "$raw_val" | sed 's/^[^0-9]*//')
            # 2. 清洗 (非字母数字点 -> .)
            s2=$(echo "$s1" | sed 's/[^a-zA-Z0-9.]/./g')
            # 3. 整形 (合并点)
            final_static=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
            
            if [ "$raw_val" != "$final_static" ]; then
                mode="静态(强力)"
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
                    safe_old=$(echo "PKG_VERSION:=$raw_val" | sed 's/\[/\\\[/g' | sed 's/\]/\\\]/g' | sed 's/\*/\\*/g' | sed 's/\./\\./g' | sed 's/\$/\\$/g')
                    safe_new="PKG_VERSION:=$new_val"
                    sed -i "s|^\Q$safe_old\E|$safe_new|" "$makefile" 2>/dev/null || \
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
    # 这里使用 grep -v 排除掉已经是 skip 的行
    if grep -q "^PKG_MIRROR_HASH:=" "$makefile" && grep "^PKG_MIRROR_HASH:=" "$makefile" | grep -qv "^PKG_MIRROR_HASH:=skip[[:space:]]*$"; then
        
        #以此获取旧值用于显示
        old_hash=$(grep "^PKG_MIRROR_HASH:=" "$makefile")
        
        echo "[修复 Mirror Hash] $makefile"
        echo "  原始: $old_hash"
        echo "  目标: PKG_MIRROR_HASH:=skip"
        
        if [ "$DO_EDIT" = true ]; then
            # 替换整行
            sed -i 's/^PKG_MIRROR_HASH:=.*/PKG_MIRROR_HASH:=skip/' "$makefile"
            echo "  -> 已修改为 skip"
            file_changed=1
        else
            echo "  -> (预览)"
        fi
        echo ""
    fi

    # =======================================================
    # 任务 4: 修复 APK 兼容性 (IPKG_INSTROOT -> APK_ROOT)
    # =======================================================
    
    # 检测 postinst/prerm/postrm 等脚本中是否只使用了 IPKG_INSTROOT
    # 匹配模式: 单独使用 IPKG_INSTROOT 但没有 APK_ROOT 的情况
    if grep -q 'IPKG_INSTROOT' "$makefile" && ! grep -q 'APK_ROOT' "$makefile"; then
        
        echo "[修复 APK 兼容性] $makefile"
        echo "  发现仅使用 IPKG_INSTROOT (OPKG专用变量)"
        echo "  将修改为兼容 APK + OPKG 的写法"
        
        if [ "$DO_EDIT" = true ]; then
            # 创建临时文件
            tmp_file=$(mktemp)
            
            # 使用 awk 处理多行 define 块
            awk '
            BEGIN { in_define = 0; found_ipkg = 0; }
            
            # 检测进入 define Package/.../postinst|prerm|postrm
            /^define Package\/.*\/(postinst|prerm|postrm)/ {
                in_define = 1
                found_ipkg = 0
                print
                next
            }
            
            # 检测退出 define
            /^endef/ {
                if (in_define) {
                    in_define = 0
                }
                print
                next
            }
            
            # 在 define 块内处理
            in_define {
                # 检测是否包含 IPKG_INSTROOT
                if ($0 ~ /IPKG_INSTROOT/ && !found_ipkg) {
                    found_ipkg = 1
                }
                
                # 替换模式 1: [ -n "${IPKG_INSTROOT}" ]
                if ($0 ~ /\[\s*-n\s+["\$\{\}]*IPKG_INSTROOT["\$\{\}]*\s*\]/) {
                    gsub(/\[\s*-n\s+"?\$\{?IPKG_INSTROOT\}?"?\s*\]/, "[ -n \"${APK_ROOT}${IPKG_INSTROOT}\" ]")
                    print "# Compatible with both APK (APK_ROOT) and OPKG (IPKG_INSTROOT)"
                    print
                    next
                }
                
                # 替换模式 2: [ -z "${IPKG_INSTROOT}" ]
                if ($0 ~ /\[\s*-z\s+["\$\{\}]*IPKG_INSTROOT["\$\{\}]*\s*\]/) {
                    gsub(/\[\s*-z\s+"?\$\{?IPKG_INSTROOT\}?"?\s*\]/, "[ -z \"${APK_ROOT}${IPKG_INSTROOT}\" ]")
                    print "# Compatible with both APK (APK_ROOT) and OPKG (IPKG_INSTROOT)"
                    print
                    next
                }
                
                # 替换模式 3: if [ -n "$IPKG_INSTROOT" ]
                if ($0 ~ /if\s*\[\s*-n\s+["\$\{\}]*IPKG_INSTROOT["\$\{\}]*\s*\]/) {
                    gsub(/if\s*\[\s*-n\s+"?\$\{?IPKG_INSTROOT\}?"?\s*\]/, "if [ -n \"${APK_ROOT}${IPKG_INSTROOT}\" ]")
                    print "# Compatible with both APK (APK_ROOT) and OPKG (IPKG_INSTROOT)"
                    print
                    next
                }
                
                # 替换模式 4: if [ -z "$IPKG_INSTROOT" ]
                if ($0 ~ /if\s*\[\s*-z\s+["\$\{\}]*IPKG_INSTROOT["\$\{\}]*\s*\]/) {
                    gsub(/if\s*\[\s*-z\s+"?\$\{?IPKG_INSTROOT\}?"?\s*\]/, "if [ -z \"${APK_ROOT}${IPKG_INSTROOT}\" ]")
                    print "# Compatible with both APK (APK_ROOT) and OPKG (IPKG_INSTROOT)"
                    print
                    next
                }
                
                print
                next
            }
            
            # 其他行直接输出
            { print }
            ' "$makefile" > "$tmp_file"
            
            # 检查是否有实际修改
            if ! diff -q "$makefile" "$tmp_file" > /dev/null 2>&1; then
                mv "$tmp_file" "$makefile"
                echo "  -> 已添加 APK_ROOT 兼容性"
                file_changed=1
            else
                rm "$tmp_file"
                echo "  -> 未检测到需要修改的模式"
            fi
        else
            echo "  -> (预览)"
        fi
        echo ""
    fi

done

echo "全部扫描处理完成。"
echo ""
echo "修复内容汇总:"
echo "  1. PKG_VERSION 版本号规范化 (移除非法字符)"
echo "  2. PKG_RELEASE 移除已废弃的 AUTORELEASE"
echo "  3. PKG_MIRROR_HASH 统一设为 skip"
echo "  4. postinst/prerm/postrm 脚本 APK 兼容性修复"
echo ""
echo "提示: 修改后请测试编译确保无误！"
