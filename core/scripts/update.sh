#!/usr/bin/env bash
# ==============================================================================
# OpenWrt-Add 插件同步主控脚本
#
# 用法:
#   全量同步:  ./core/scripts/update.sh
#   单包测试:  ./core/scripts/update.sh --only <插件名>
#   查看帮助:  ./core/scripts/update.sh --help
# ==============================================================================

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

CLR_RESET="\033[0m"
CLR_RED="\033[31m"
CLR_GREEN="\033[32m"
CLR_YELLOW="\033[33m"
CLR_BOLD="\033[1m"

log_info() { echo -e "${CLR_GREEN}[INFO]${CLR_RESET} $*"; }
log_warn() { echo -e "${CLR_YELLOW}[WARN]${CLR_RESET} $*"; }
log_err()  { echo -e "${CLR_RED}[ERROR]${CLR_RESET} $*"; }

START_TIME=$(date +%s)
SUCCESS_COUNT=0
FAIL_COUNT=0
declare -a SUCCESS_PKGS=()
declare -a FAILED_PKGS=()

# 带重试的 git clone
clone_repo() {
    local url="$1"
    local dest="$2"
    local branch="${3:-}"
    local max_retries=3
    local retry_count=0
    local success=0

    rm -rf "$dest"

    while [ $retry_count -lt $max_retries ]; do
        retry_count=$((retry_count + 1))
        local clone_cmd=(git clone --depth 1 --no-tags --single-branch -q)
        [ -n "$branch" ] && clone_cmd+=(-b "$branch")
        clone_cmd+=("$url" "$dest")

        if "${clone_cmd[@]}" 2>/dev/null; then
            success=1
            break
        fi

        log_warn "拉取 $url 失败 (第 $retry_count 次尝试)，等待重试..."
        rm -rf "$dest"
        sleep $((retry_count * 2))
    done

    if [ $success -eq 1 ]; then
        rm -rf "$dest/.git"
        return 0
    else
        log_err "拉取 $url 最终失败 (已重试 $max_retries 次)"
        return 1
    fi
}

# 带重试的稀疏 clone
sparse_clone() {
    local url="$1"
    local dest="$2"
    shift 2
    local subpaths=("$@")

    local max_retries=3
    local retry_count=0
    local success=0

    rm -rf "$dest"

    while [ $retry_count -lt $max_retries ]; do
        retry_count=$((retry_count + 1))

        if git clone --depth 1 --no-tags --single-branch --filter=blob:none --sparse -q "$url" "$dest" 2>/dev/null; then
            if (cd "$dest" && git sparse-checkout set "${subpaths[@]}" 2>/dev/null); then
                success=1
                break
            fi
        fi

        log_warn "稀疏拉取 $url 失败 (第 $retry_count 次)，等待重试..."
        rm -rf "$dest"
        sleep $((retry_count * 2))
    done

    if [ $success -eq 1 ]; then
        rm -rf "$dest/.git"
        return 0
    else
        log_err "稀疏拉取 $url 最终失败"
        return 1
    fi
}

# 部署目录 (拉取失败保留原目录)
deploy_dir() {
    local src="$1"
    local dest="$2"
    local pkg_name
    pkg_name="$(basename "$dest")"
    local parent_dir
    parent_dir="$(dirname "$dest")"

    mkdir -p "$parent_dir"

    if [ -d "$src" ]; then
        rm -rf "$dest"
        mv "$src" "$dest"
        SUCCESS_PKGS+=("$pkg_name")
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        log_info "  -> 成功就绪: $dest"
        return 0
    else
        if [ -d "$dest" ]; then
            log_warn "  ! $dest 拉取失败，已安全保留旧版本"
        else
            log_err "  x $dest 拉取失败且无旧版本可用"
        fi
        FAILED_PKGS+=("$pkg_name")
        FAIL_COUNT=$((FAIL_COUNT + 1))
        return 1
    fi
}

export -f clone_repo sparse_clone deploy_dir log_info log_warn log_err

source "$SCRIPT_DIR/custom.sh"

sync_declared_pkg() {
    local rel_path="$1"
    local url="$2"
    local branch="${3:-}"
    local pkg_name
    pkg_name="$(basename "$rel_path")"

    log_info "正在同步: $rel_path ($url)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "$url" "$tmp_dir/$pkg_name" "$branch"; then
        deploy_dir "$tmp_dir/$pkg_name" "$REPO_ROOT/$rel_path"
        rm -rf "$tmp_dir"
        return 0
    else
        deploy_dir "$tmp_dir/$pkg_name" "$REPO_ROOT/$rel_path" || true
        rm -rf "$tmp_dir"
        return 1
    fi
}

sync_all_declared() {
    local conf_file="$SCRIPT_DIR/packages.conf"
    if [ ! -f "$conf_file" ]; then
        log_warn "未找到配置文件: $conf_file"
        return 0
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue

        local rel_path url branch
        rel_path="$(echo "$line" | awk -F'|' '{print $1}' | tr -d '[:space:]')"
        url="$(echo "$line" | awk -F'|' '{print $2}' | tr -d '[:space:]')"
        branch="$(echo "$line" | awk -F'|' '{print $3}' | tr -d '[:space:]')"

        [ -z "$rel_path" ] || [ -z "$url" ] && continue

        sync_declared_pkg "$rel_path" "$url" "$branch"
    done < "$conf_file"
}

run_post_processing() {
    echo ""
    log_info "${CLR_BOLD}>>> 开始执行全局规则修复与环境标准化...${CLR_RESET}"

    find "$REPO_ROOT" -mindepth 2 -name ".git" -type d ! -path "$REPO_ROOT/.git*" -exec rm -rf {} + 2>/dev/null || true
    bash "$SCRIPT_DIR/remove_upx.sh"
    bash "$SCRIPT_DIR/create_acl.sh"
    bash "$SCRIPT_DIR/move_to_services.sh"
    bash "$SCRIPT_DIR/apply_whitelist.sh"
    bash "$SCRIPT_DIR/fix_relative_includes.sh"
    bash "$SCRIPT_DIR/patch_singbox_tiny.sh"
    bash "$SCRIPT_DIR/fix_pkg_version.sh"
    bash "$SCRIPT_DIR/fix_permissions.sh"

    log_info "${CLR_BOLD}>>> 全局规则修复与环境标准化完成！${CLR_RESET}"
}

print_summary() {
    local end_time=$(date +%s)
    local elapsed=$((end_time - START_TIME))
    local total=$((SUCCESS_COUNT + FAIL_COUNT))

    echo ""
    echo "=================================================================="
    echo -e "${CLR_BOLD}             OpenWrt-Add 插件同步报告汇总              ${CLR_RESET}"
    echo "=================================================================="
    echo "  总计同步任务: $total"
    echo -e "  同步成功:     ${CLR_GREEN}$SUCCESS_COUNT${CLR_RESET}"
    if [ $FAIL_COUNT -gt 0 ]; then
        echo -e "  同步失败(保留旧版): ${CLR_YELLOW}$FAIL_COUNT${CLR_RESET} (${FAILED_PKGS[*]})"
    else
        echo -e "  同步失败:     0"
    fi
    echo "  总计耗时:     $((elapsed / 60)) 分 $((elapsed % 60)) 秒"
    echo "=================================================================="

    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        {
            echo "## OpenWrt-Add 同步结果报告"
            echo ""
            echo "| 统计项 | 结果 |"
            echo "| :--- | :--- |"
            echo "| **总计任务** | $total |"
            echo "| **成功更新** | $SUCCESS_COUNT |"
            echo "| **异常/保留旧版** | $FAIL_COUNT |"
            echo "| **运行耗时** | $((elapsed / 60))m $((elapsed % 60))s |"
            echo ""
            if [ $FAIL_COUNT -gt 0 ]; then
                echo "### 存在异常的插件列表"
                for p in "${FAILED_PKGS[@]}"; do
                    echo "- \`$p\` (已自动保留上一版本，不影响编译)"
                done
            fi
        } >> "$GITHUB_STEP_SUMMARY"
    fi
}

TARGET_ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --only)
            TARGET_ONLY="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --only <pkg_name>   仅同步指定的单个插件 (支持相对路径或包名)"
            echo "  -h, --help          显示此帮助信息"
            exit 0
            ;;
        *)
            log_err "未知选项: $1"
            exit 1
            ;;
    esac
done

if [ -n "$TARGET_ONLY" ]; then
    log_info "【单包模式】仅处理: $TARGET_ONLY"

    pkg_base="$(basename "$TARGET_ONLY")"
    target_clean="${pkg_base,,}"
    target_clean="${target_clean//-/_}"
    local_func="sync_${target_clean}"

    if type "$local_func" >/dev/null 2>&1; then
        $local_func
    elif type "sync_${pkg_base//-/_}" >/dev/null 2>&1; then
        "sync_${pkg_base//-/_}"
    else
        line="$(grep -E "^[[:space:]]*([a-zA-Z0-9_-]+/)?$pkg_base[[:space:]]*\|" "$SCRIPT_DIR/packages.conf" | head -n 1)"
        if [ -n "$line" ]; then
            rel_path="$(echo "$line" | awk -F'|' '{print $1}' | tr -d '[:space:]')"
            url="$(echo "$line" | awk -F'|' '{print $2}' | tr -d '[:space:]')"
            branch="$(echo "$line" | awk -F'|' '{print $3}' | tr -d '[:space:]')"
            sync_declared_pkg "$rel_path" "$url" "$branch"
        else
            log_err "未在 packages.conf 或 custom.sh 中找到对应插件: $TARGET_ONLY"
            exit 1
        fi
    fi
    run_post_processing
    print_summary
    exit 0
fi

log_info "${CLR_BOLD}>>> 开始同步基础插件清单 (packages.conf)...${CLR_RESET}"
sync_all_declared

echo ""
log_info "${CLR_BOLD}>>> 开始同步定制插件与大仓子包 (custom.sh)...${CLR_RESET}"
run_all_custom_sync

run_post_processing
print_summary
exit 0
