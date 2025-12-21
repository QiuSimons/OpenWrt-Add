#!/bin/bash

# --- 配置区域 ---
DO_EDIT=true  # true=修改文件, false=仅预览
# ----------------

echo "开始执行【强力模式】版本号标准化..."
echo "策略: 1. 去除首个数字前的字符"
echo "      2. 将所有非[数字/字母/点]的符号替换为点(.)"
echo "      3. 合并重复的点号"
echo "---------------------------------------------------"

find . -type f -name "Makefile" | while read -r makefile; do
    
    # 提取原始版本号
    raw_ver=$(grep "^PKG_VERSION:=" "$makefile" | awk -F':=' '{print $2}' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

    if [ -z "$raw_ver" ]; then
        continue
    fi

    # --- 核心转换逻辑 (三步走) ---
    
    # 1. 【掐头】：去掉开头所有非数字字符 (处理 v1.0, release-2.0 等)
    step1=$(echo "$raw_ver" | sed 's/^[^0-9]*//')
    
    # 2. 【清洗】：将所有 "非字母、非数字、非点号" 的字符替换为 "."
    #    这里 [^a-zA-Z0-9.] 表示匹配除了字母数字点以外的所有字符
    #    这意味着 +, ~, -, _, /,空格 都会变成点
    step2=$(echo "$step1" | sed 's/[^a-zA-Z0-9.]/./g')

    # 3. 【整形】：将连续的重复点号合并为一个 (1.0..5 -> 1.0.5)，并去掉末尾可能的点
    new_ver=$(echo "$step2" | sed 's/\.\{2,\}/./g' | sed 's/\.$//')

    # 如果版本号发生了变化
    if [ "$raw_ver" != "$new_ver" ]; then
        echo "[发现不规范] $makefile"
        echo "  原始: $raw_ver"
        echo "  修正: $new_ver"

        if [ "$DO_EDIT" = true ]; then
            # 使用 # 作为分隔符，避免与版本号里的 . 冲突
            sed -i "s/^PKG_VERSION:=${raw_ver}/PKG_VERSION:=${new_ver}/" "$makefile"
            echo "  -> 已修正"
        else
            echo "  -> (预览模式)"
        fi
        echo ""
    fi
done

echo "处理完成。"
