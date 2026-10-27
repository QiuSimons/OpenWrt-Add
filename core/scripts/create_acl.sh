#!/usr/bin/env bash
# ==============================================================================
# 自动为缺少 rpcd ACL 权限配置的 LuCI APP 生成基础 ACL 规则
# ==============================================================================

set -o pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT" || exit 1

check_if_acl_exist() {
    ls "$1"/root/usr/share/rpcd/acl.d/*.json >/dev/null 2>&1 && return 0 || return 1
}

check_config_files() {
    local count
    count="$(ls "$1"/root/etc/config/* 2>/dev/null | wc -l)"
    [ "$count" -eq 1 ] && return 0 || return 1
}

get_config_name() {
    ls "$1"/root/etc/config/* 2>/dev/null | awk -F '/' '{print $NF}' | head -n 1
}

create_acl_file() {
    local acl_dir="$1"
    local app_name="$2"
    local conf_name="$3"
    mkdir -p "$acl_dir"
    cat <<EOF >"$acl_dir/$app_name.json"
{
	"$app_name": {
		"description": "Grant UCI access for $app_name",
		"read": {
			"uci": [ "$conf_name" ]
		},
		"write": {
			"uci": [ "$conf_name" ]
		}
	}
}
EOF
}

auto_create_acl() {
    echo "[ACL] 开始检测并生成缺少的 LuCI APP ACL 文件..."

    find "$REPO_ROOT" -maxdepth 4 -type d -name "luci-app-*" ! -path "*/.*/*" ! -path "*/core/*" | sort -u | while read -r app_path; do
        local app_name
        app_name="$(basename "$app_path")"

        if check_if_acl_exist "$app_path"; then
            continue
        fi

        if check_config_files "$app_path"; then
            local conf_name
            conf_name="$(get_config_name "$app_path")"
            if [ -n "$conf_name" ]; then
                create_acl_file "$app_path/root/usr/share/rpcd/acl.d" "$app_name" "$conf_name"
                echo "  + 生成 ACL: $app_name -> $conf_name"
            fi
        fi
    done

    echo "[ACL] ACL 生成检测完成。"
}

auto_create_acl
exit 0
