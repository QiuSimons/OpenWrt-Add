#!/usr/bin/env bash
# ==============================================================================
# 特殊插件同步与补丁处理模块
# ==============================================================================

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PATCH_DIR="$REPO_ROOT/core/patches"
ASSET_DIR="$REPO_ROOT/core/assets"

if ! type log_info >/dev/null 2>&1; then
    log_info() { echo -e "\033[32m[INFO]\033[0m $*"; }
    log_warn() { echo -e "\033[33m[WARN]\033[0m $*"; }
    log_err()  { echo -e "\033[31m[ERROR]\033[0m $*"; }
fi

# ------------------------------------------------------------------------------
# OpenAppFilter
# ------------------------------------------------------------------------------
sync_openappfilter() {
    local target="legacy/OpenAppFilter"
    log_info "正在同步: $target (sbwml/OpenAppFilter:v6)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/sbwml/OpenAppFilter" "$tmp_dir/OpenAppFilter" "v6"; then
        sed -i 's/\r$//' "$tmp_dir/OpenAppFilter/open-app-filter/src/appfilter_ubus.c" 2>/dev/null || true
        if [ -f "$PATCH_DIR/OpenAppFilter-disable-auto-load-engine.patch" ]; then
            (cd "$tmp_dir" && patch -l -p0 < "$PATCH_DIR/OpenAppFilter-disable-auto-load-engine.patch" 2>/dev/null) || log_warn "OpenAppFilter patch 跳过或已包含"
        fi
        deploy_dir "$tmp_dir/OpenAppFilter" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# openwrt_helloworld
# ------------------------------------------------------------------------------
sync_helloworld() {
    local target="legacy/openwrt_helloworld"
    log_info "正在同步: $target (聚合插件)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/sbwml/openwrt_helloworld" "$tmp_dir/openwrt_helloworld"; then
        if [ -f "$PATCH_DIR/dns2socks-Makefile" ]; then
            mkdir -p "$tmp_dir/openwrt_helloworld/dns2socks"
            cp -f "$PATCH_DIR/dns2socks-Makefile" "$tmp_dir/openwrt_helloworld/dns2socks/Makefile"
        fi

        rm -rf "$tmp_dir/openwrt_helloworld"/{luci-app-ssr-plus,luci-app-passwall,simple-obfs,lua-neturl,sing-box,luci-app-mihomo,mihomo,luci-app-nikki,nikki,luci-app-homeproxy,luci-app-openclash,luci-app-daed,daed,luci-app-dae,dae,v2ray-geodata}

        if clone_repo "https://github.com/fw876/helloworld" "$tmp_dir/fw_helloworld"; then
            cp -rf "$tmp_dir/fw_helloworld/lua-neturl" "$tmp_dir/openwrt_helloworld/"
            cp -rf "$tmp_dir/fw_helloworld/simple-obfs" "$tmp_dir/openwrt_helloworld/"
            cp -rf "$tmp_dir/fw_helloworld/luci-app-ssr-plus" "$tmp_dir/openwrt_helloworld/"
            sed -i 's/result.insecure = "0"/result.insecure = "1"/g' "$tmp_dir/openwrt_helloworld/luci-app-ssr-plus/root/usr/share/shadowsocksr/subscribe.lua" 2>/dev/null || true
        fi

        if clone_repo "https://github.com/Openwrt-Passwall/openwrt-passwall" "$tmp_dir/passwall"; then
            cp -rf "$tmp_dir/passwall/luci-app-passwall" "$tmp_dir/openwrt_helloworld/"
            sed -i '/select PACKAGE_trojan-plus/{N;s/default y/default n/;}' "$tmp_dir/openwrt_helloworld/luci-app-passwall/Makefile" 2>/dev/null || true
        fi

        deploy_dir "$tmp_dir/openwrt_helloworld" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# openwrt_pkgs
# ------------------------------------------------------------------------------
sync_openwrt_pkgs() {
    local target="legacy/openwrt_pkgs"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/sbwml/openwrt_pkgs" "$tmp_dir/openwrt_pkgs"; then
        rm -rf "$tmp_dir/openwrt_pkgs/luci-app-ramfree" "$tmp_dir/openwrt_pkgs/luci-app-zerotier"
        deploy_dir "$tmp_dir/openwrt_pkgs" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# OpenClash
# ------------------------------------------------------------------------------
sync_openclash() {
    local target="legacy/OpenClash"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/vernesong/OpenClash" "$tmp_dir/OpenClash"; then
        rm -rf "$tmp_dir/OpenClash/luci-app-openclash/root/etc/openclash/GeoSite.dat"
        deploy_dir "$tmp_dir/OpenClash" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# autocore-arm
# ------------------------------------------------------------------------------
sync_autocore_arm() {
    local target="apps/autocore-arm"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/sbwml/autocore-arm" "$tmp_dir/autocore-arm"; then
        local makefile="$tmp_dir/autocore-arm/Makefile"
        sed -i '/init/d' "$makefile" 2>/dev/null || true
        sed -i '/autocore.json/a\\	$(INSTALL_BIN) ./files/x86/autocore $(1)/etc/init.d/' "$makefile" 2>/dev/null || true
        sed -i '/autocore.json/a\\	$(INSTALL_DIR) $(1)/etc/init.d' "$makefile" 2>/dev/null || true

        mkdir -p "$tmp_dir/autocore-arm/files/x86"
        if [ -f "$ASSET_DIR/autocore" ]; then
            cp -f "$ASSET_DIR/autocore" "$tmp_dir/autocore-arm/files/x86/autocore"
        fi

        sed -i 's/png/svg/g' "$tmp_dir/autocore-arm/files/generic/29_ports.js" 2>/dev/null || true
        sed -i "s|/sys/module/shortcut_fe/refcnt|/etc/init.d/shortcut-fe|" "$tmp_dir/autocore-arm/files/generic/luci" 2>/dev/null || true

        deploy_dir "$tmp_dir/autocore-arm" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# MentoHUST-OpenWrt-ipk (打补丁修复 GCC 14 类型错误)
# ------------------------------------------------------------------------------
sync_mentohust_openwrt_ipk() {
    local target="apps/MentoHUST-OpenWrt-ipk"
    log_info "正在同步: $target (KyleRicardo/MentoHUST-OpenWrt-ipk + gcc14 patch)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/KyleRicardo/MentoHUST-OpenWrt-ipk" "$tmp_dir/MentoHUST-OpenWrt-ipk"; then
        if [ -f "$PATCH_DIR/mentohust-gcc14-size_t.patch" ]; then
            (cd "$tmp_dir/MentoHUST-OpenWrt-ipk" && \
             patch -p1 -N < "$PATCH_DIR/mentohust-gcc14-size_t.patch" 2>/dev/null) || \
             log_warn "mentohust-gcc14-size_t.patch 跳过或已包含"
        fi

        deploy_dir "$tmp_dir/MentoHUST-OpenWrt-ipk" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# openwrt-einat-ebpf
# ------------------------------------------------------------------------------
sync_einat_ebpf() {
    local target="apps/openwrt-einat-ebpf"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/muink/openwrt-einat-ebpf" "$tmp_dir/openwrt-einat-ebpf"; then
        (
            cd "$tmp_dir/openwrt-einat-ebpf" || exit 1
            [ -f "$PATCH_DIR/einat-ebpf-nat66-1.patch" ] && patch -p1 -N < "$PATCH_DIR/einat-ebpf-nat66-1.patch" 2>/dev/null || true
            [ -f "$PATCH_DIR/einat-ebpf-nat66-2.patch" ] && patch -p1 -N < "$PATCH_DIR/einat-ebpf-nat66-2.patch" 2>/dev/null || true
            sed -i 's/=60/=99/g' ./files/einat.init 2>/dev/null || true
        )
        deploy_dir "$tmp_dir/openwrt-einat-ebpf" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# luci-app-einat
# ------------------------------------------------------------------------------
sync_luci_einat() {
    local target="apps/luci-app-einat"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/muink/luci-app-einat" "$tmp_dir/luci-app-einat"; then
        if [ -f "$PATCH_DIR/luci-app-einat-nat66.patch" ]; then
            (cd "$tmp_dir/luci-app-einat" && patch -p1 -N < "$PATCH_DIR/luci-app-einat-nat66.patch" 2>/dev/null) || true
        fi
        deploy_dir "$tmp_dir/luci-app-einat" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# openwrt-bandix
# ------------------------------------------------------------------------------
sync_openwrt_bandix() {
    local target="apps/openwrt-bandix"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/timsaya/openwrt-bandix" "$tmp_dir/openwrt-bandix"; then
        sed -i 's/PKG_HASH:=.*/PKG_HASH:=skip/g' "$tmp_dir/openwrt-bandix/openwrt-bandix/Makefile" 2>/dev/null || true
        deploy_dir "$tmp_dir/openwrt-bandix" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# luci-theme-argon
# ------------------------------------------------------------------------------
sync_argon_theme() {
    local target="themes/luci-theme-argon"
    log_info "正在同步: $target (master)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/jerrykuku/luci-theme-argon" "$tmp_dir/luci-theme-argon" "master"; then
        local css="$tmp_dir/luci-theme-argon/htdocs/luci-static/argon/css/cascade.css"
        if [ -f "$css" ]; then
            sed -i 's/26rem/30rem/g' "$css" 2>/dev/null || true
            sed -i 's/\.login-page \.login-container{margin-left:0rem !important;width:100%}/.login-page .login-container{margin-left:0rem !important;width:100%;height:auto!important;position:fixed;top:0;bottom:0;overflow-y:auto}/' "$css" 2>/dev/null || true
        fi
        deploy_dir "$tmp_dir/luci-theme-argon" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# luci-app-unblockneteasemusic
# ------------------------------------------------------------------------------
sync_unblockmusic() {
    local target="apps/luci-app-unblockneteasemusic"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/UnblockNeteaseMusic/luci-app-unblockneteasemusic" "$tmp_dir/luci-app-unblockneteasemusic"; then
        sed -i 's, +node,,g' "$tmp_dir/luci-app-unblockneteasemusic/Makefile" 2>/dev/null || true
        if [ -f "$PATCH_DIR/luci-app-unblockneteasemusic-node.patch" ]; then
            (cd "$tmp_dir/luci-app-unblockneteasemusic" && patch -p1 -N < "$PATCH_DIR/luci-app-unblockneteasemusic-node.patch" 2>/dev/null) || true
        fi
        deploy_dir "$tmp_dir/luci-app-unblockneteasemusic" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# luci-app-taskplan
# ------------------------------------------------------------------------------
sync_taskplan() {
    local target="apps/luci-app-taskplan"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if clone_repo "https://github.com/sirpdboy/luci-app-taskplan" "$tmp_dir/luci-app-taskplan"; then
        local menu_file="$tmp_dir/luci-app-taskplan/luci-app-taskplan/root/usr/share/luci/menu.d/luci-app-taskplan.json"
        if [ -f "$menu_file" ]; then
            sed -i 's/admin\/control\/taskplan/admin\/system\/taskplan/g' "$menu_file" 2>/dev/null || true
        fi
        deploy_dir "$tmp_dir/luci-app-taskplan" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# uugamebooster
# ------------------------------------------------------------------------------
sync_uugamebooster() {
    log_info "正在同步: uugamebooster 与 luci-app-uugamebooster (按需提取)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if sparse_clone "https://github.com/coolsnowwolf/luci" "$tmp_dir/luci" "applications/luci-app-uugamebooster"; then
        if [ -d "$tmp_dir/luci/applications/luci-app-uugamebooster" ]; then
            mkdir -p "$tmp_dir/luci-app-uugamebooster"
            cp -rf "$tmp_dir/luci/applications/luci-app-uugamebooster/"* "$tmp_dir/luci-app-uugamebooster/"
            sed -i 's|\.\./\.\.|$(TOPDIR)/feeds/luci|g' "$tmp_dir/luci-app-uugamebooster/Makefile" 2>/dev/null || true
            deploy_dir "$tmp_dir/luci-app-uugamebooster" "$REPO_ROOT/apps/luci-app-uugamebooster"
        fi
    fi

    if sparse_clone "https://github.com/coolsnowwolf/packages" "$tmp_dir/packages" "net/uugamebooster"; then
        if [ -d "$tmp_dir/packages/net/uugamebooster" ]; then
            mkdir -p "$tmp_dir/uugamebooster"
            cp -rf "$tmp_dir/packages/net/uugamebooster/"* "$tmp_dir/uugamebooster/"
            deploy_dir "$tmp_dir/uugamebooster" "$REPO_ROOT/apps/uugamebooster"
        fi
    fi

    rm -rf "$tmp_dir"
    return 0
}

# ------------------------------------------------------------------------------
# luci-app-ap-modem
# ------------------------------------------------------------------------------
sync_ap_modem() {
    local target="apps/luci-app-ap-modem"
    log_info "正在同步: $target..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    if sparse_clone "https://github.com/linkease/openwrt-app-actions" "$tmp_dir/upstream" "applications/luci-app-ap-modem"; then
        if [ -d "$tmp_dir/upstream/applications/luci-app-ap-modem" ]; then
            deploy_dir "$tmp_dir/upstream/applications/luci-app-ap-modem" "$REPO_ROOT/$target"
            rm -rf "$tmp_dir"
            return 0
        fi
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# immortalwrt/luci (ramfree, arpbind, zerotier, 3cat)
# ------------------------------------------------------------------------------
sync_immortalwrt_luci() {
    log_info "正在同步: immortalwrt LuCI 模块 (ramfree, arpbind, zerotier, 3cat)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    local subpaths=(
        "applications/luci-app-ramfree"
        "applications/luci-app-arpbind"
        "applications/luci-app-zerotier"
        "applications/luci-app-3cat"
    )

    if sparse_clone "https://github.com/immortalwrt/luci" "$tmp_dir/upstream" "${subpaths[@]}"; then
        for path in "${subpaths[@]}"; do
            local app_name="$(basename "$path")"
            if [ -d "$tmp_dir/upstream/$path" ]; then
                local makefile="$tmp_dir/upstream/$path/Makefile"
                [ -f "$makefile" ] && sed -i 's|\.\./\.\.|$(TOPDIR)/feeds/luci|g' "$makefile" 2>/dev/null || true
                deploy_dir "$tmp_dir/upstream/$path" "$REPO_ROOT/apps/$app_name"
            fi
        done
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# lede_pkg (fullconenat-nft, r8168)
# ------------------------------------------------------------------------------
sync_lede_pkg() {
    log_info "正在同步: lede_pkg (r8168, fullconenat-nft)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    local subpaths=(
        "package/network/services/fullconenat-nft"
        "package/kernel/r8168"
    )

    if sparse_clone "https://github.com/coolsnowwolf/lede" "$tmp_dir/upstream" "${subpaths[@]}"; then
        mkdir -p "$tmp_dir/invasive_fullcone"
        cp -rf "$tmp_dir/upstream/package/network/services/fullconenat-nft" "$tmp_dir/invasive_fullcone/"
        deploy_dir "$tmp_dir/invasive_fullcone/fullconenat-nft" "$REPO_ROOT/invasive/fullconenat-nft"

        mkdir -p "$tmp_dir/apps_lede/r8168"
        cp -rf "$tmp_dir/upstream/package/kernel/r8168" "$tmp_dir/apps_lede/"
        deploy_dir "$tmp_dir/apps_lede/r8168" "$REPO_ROOT/apps/lede_pkg/r8168"

        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# imm_pkg (sing-box, frp, cpulimit 等)
# ------------------------------------------------------------------------------
sync_imm_pkg() {
    local target="apps/imm_pkg"
    log_info "正在同步: $target (sing-box, frp, cpulimit 及核心依赖)..."
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    local subpaths=(
        "utils/cpulimit"
        "net/3proxy"
        "net/subconverter"
        "net/zerotier"
        "libs/jpcre2"
        "libs/rapidjson"
        "libs/libcron"
        "libs/quickjspp"
        "libs/toml11"
        "net/sing-box"
        "net/frp"
    )

    if sparse_clone "https://github.com/immortalwrt/packages" "$tmp_dir/upstream" "${subpaths[@]}"; then
        mkdir -p "$tmp_dir/$target"
        for sub in "${subpaths[@]}"; do
            local dir_name="$(basename "$sub")"
            if [ -d "$tmp_dir/upstream/$sub" ]; then
                cp -rf "$tmp_dir/upstream/$sub" "$tmp_dir/$target/$dir_name"
            fi
        done

        local sing_mk="$tmp_dir/$target/sing-box/Makefile"
        if [ -f "$sing_mk" ]; then
            sed -i 's|\.\./\.\./|$(TOPDIR)/feeds/packages/|' "$sing_mk" 2>/dev/null || true
        fi

        local frp_mk="$tmp_dir/$target/frp/Makefile"
        if [ -f "$frp_mk" ]; then
            sed -i '/etc/d' "$frp_mk" 2>/dev/null || true
            sed -i '/defaults/{N;d;}' "$frp_mk" 2>/dev/null || true
            sed -i 's|\.\./\.\.|$(TOPDIR)/feeds/packages|g' "$frp_mk" 2>/dev/null || true
            sed -i 's/ node\/host//;/Build\/Compile/,/endef/d' "$frp_mk" 2>/dev/null || true
            sed -i '/golang-package.mk/i GO_PKG_TAGS:=noweb' "$frp_mk" 2>/dev/null || true
        fi

        deploy_dir "$tmp_dir/$target" "$REPO_ROOT/$target"
        rm -rf "$tmp_dir"
        return 0
    fi
    rm -rf "$tmp_dir"
    return 1
}

# ------------------------------------------------------------------------------
# 批量执行定制同步
# ------------------------------------------------------------------------------
run_all_custom_sync() {
    local -a handlers=(
        sync_openappfilter
        sync_helloworld
        sync_openwrt_pkgs
        sync_openclash
        sync_autocore_arm
        sync_mentohust_openwrt_ipk
        sync_einat_ebpf
        sync_luci_einat
        sync_openwrt_bandix
        sync_argon_theme
        sync_unblockmusic
        sync_taskplan
        sync_uugamebooster
        sync_ap_modem
        sync_immortalwrt_luci
        sync_lede_pkg
        sync_imm_pkg
    )

    for handler in "${handlers[@]}"; do
        $handler || log_warn "$handler 执行遇到警告/错误，已保留安全旧版"
    done
}
