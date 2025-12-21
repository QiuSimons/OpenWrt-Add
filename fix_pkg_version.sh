#!/bin/bash

DO_EDIT=true

echo "开始执行【智能分级】版本号标准化..."
echo "策略:"
echo "  1. 纯数字/字符版本 -> 强力清洗 (去除v, 替换所有符号)"
echo "  2. 包含变量/函数的版本 -> 保守修复 (只替换 ~ 为 .)"
echo "---------------------------------------------------"

find . -type f -name "Makefile" | while read -r makefile; do
    
    # 提取原始版本号字符串
    raw_val=$(grep "^PKG_VERSION:=" "$makefile" | awk -F':=' '{print $2}' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    if [ -z "$raw_val" ]; then
        continue
    fi

    new_val="$raw_val"
    mode=""

    # --- 判断处理模式 ---
    if [[ "$raw_val" == *"\$"* ]]; then
        # === 模式 A: 动态版本 (包含变量/函数) ===
        # 风险高，必须保守。
        # 1. 只把 ~ (波浪号) 替换为 . (点)
        #    Alpine 不认 ~，且 ~ 在 Makefile 语法中极少作为操作符，替换相对安全。
        #    例如: 1.0~$(VAR) -> 1.0.$(VAR)
        mode="动态(保守)"
        new_val=$(echo "$raw_val" | sed 's/~/./g')
        
        # 注意：这里故意不处理 '-' (连字符)，因为 $(shell date +%F) 或 git --short 包含减号。
        # 如果动态版本中确实包含会导致 Alpine 报错的 '-'，脚本会发出警告供人工审查。
        
        if [[ "$new_val" == *"-"* ]]; then
             # 如果替换后还有减号，且不是在 shell 命令常见标志位(--)
             # 这里很难完美判断，只能提示警告
             echo "[警告] $makefile"
             echo "  检测到动态版本中包含 '-'。如果是 '1.0-\$(VAR)' 格式，Alpine 可能会报错。"
             echo "  如果是 '\$(shell ls -l)' 格式，则是安全的。请人工复核。"
        fi

    else
        # === 模式 B: 静态版本 (纯字符串) ===
        # 风险低，强力清洗。
        mode="静态(强力)"
        
        # 1. 去掉开头非数字 (v1.0 -> 1.0)
        s1=$(echo "$raw_val" | sed 's/^[^0-9]*//')
        # 2. 把所有 非字母/数字/点 的符号替换为 . (包括 -, _, +, ~)
        s2=$(echo "$s1" | sed 's/[^a-zA-Z0-9.]/./g')
        # 3. 合并重复点，去掉末尾点
        new_val=$(echo "$s2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')
    fi

    # --- 执行修改 ---
    if [ "$raw_val" != "$new_val" ]; then
        echo "[修正 - $mode] $makefile"
        echo "  原始: $raw_val"
        echo "  新值: $new_val"

        if [ "$DO_EDIT" = true ]; then
            # 使用 | 作为 sed 分隔符，防止与路径或点号冲突，并转义其中的特殊字符
            # 这里需要小心处理 sed 中的变量替换，特别是包含 $ ( ) / 等字符时
            
            # 使用 perl 替代 sed 进行替换，能更好地处理包含特殊字符的字符串字面量替换
            # 如果没有 perl，再尝试用 sed (风险较大)
            if command -v perl >/dev/null 2>&1; then
                # Perl 方案: 自动转义特殊字符，最安全
                export F_FILE="$makefile"
                export F_OLD="PKG_VERSION:=$raw_val"
                export F_NEW="PKG_VERSION:=$new_val"
                perl -pi -e 's/\Q$ENV{F_OLD}\E/$ENV{F_NEW}/' "$makefile"
            else
                # Sed 方案: 尝试转义 $ 和 /
                safe_old=$(echo "PKG_VERSION:=$raw_val" | sed 's/\[/\\\[/g' | sed 's/\]/\\\]/g' | sed 's/\*/\\*/g' | sed 's/\./\\./g' | sed 's/\$/\\$/g')
                safe_new="PKG_VERSION:=$new_val"
                sed -i "s|^\Q$safe_old\E|$safe_new|" "$makefile" 2>/dev/null || \
                sed -i "s|^PKG_VERSION:=.*|$safe_new|" "$makefile"
            fi
            
            echo "  -> 已保存"
        else
            echo "  -> (预览)"
        fi
        echo ""
    fi

done

echo "处理完成。"
