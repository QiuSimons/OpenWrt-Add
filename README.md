# OpenWrt-Add

自用的 OpenWrt 第三方软件包与 LuCI 插件源，每天通过 GitHub Actions 自动从各上游拉取最新源码，统一处理依赖冲突、菜单层级、ACL 权限及版本号规范。

## 添加到固件编译

### 方法一：作为 Feed 源（推荐）

在 OpenWrt 源码根目录的 `feeds.conf.default` 中加入：

```text
src-git custom https://github.com/QiuSimons/OpenWrt-Add.git
```

更新并安装：

```bash
./scripts/feeds update custom
./scripts/feeds install -a -p custom
```

### 方法二：直接克隆到 package 目录

```bash
git clone https://github.com/QiuSimons/OpenWrt-Add.git package/custom
```

---

## 目录结构

```text
OpenWrt-Add/
├── .github/workflows/
│   ├── Update_PKG.yml        # 定时同步上游源码 (每天 04:23 UTC+8 / 20:23 UTC)
│   └── build-feed.yml        # 编译 APK 软件源与 ImageBuilder 离线包
├── core/                     # 管理总目录 (构建脚本、离线补丁、规则与工具)
│   ├── scripts/              # 自动化同步主控及后处理脚本
│   │   ├── update.sh         # 主同步脚本 (支持全量与单包同步)
│   │   ├── packages.conf     # 普通插件清单 (按分类填写)
│   │   ├── custom.sh         # 需打补丁或从大仓提取子目录的特殊包
│   │   ├── fix_pkg_version.sh# Makefile 版本号规范化 (兼容 Alpine/apk 规范)
│   │   ├── move_to_services.sh # 统一将 VPN 菜单归入 Services
│   │   ├── create_acl.sh     # 自动补全缺少的 LuCI rpcd ACL 配置
│   │   ├── remove_upx.sh     # 清除 Makefile 中的 upx 指令
│   │   ├── apply_whitelist.sh# MosDNS / Passwall 直连白名单追加
│   │   ├── fix_relative_includes.sh # 修复 Makefile 相对 include 路径
│   │   ├── patch_singbox_tiny.sh # 配置 sing-box 默认编译变体为 tiny
│   │   ├── fix_permissions.sh# 权限规范化
│   │   ├── build_in_container.sh # SDK 容器内: feeds、defconfig 与 package/compile
│   │   ├── prebuild_host.sh  # runner 上交叉编译 Go/Rust 组件，免容器工具链引导
│   │   ├── apply_prebuilt.sh # 把预编译二进制注入 feed 的包 Makefile
│   │   ├── smart_fanout.py   # 产物按架构分发
│   │   └── verify_manifest.py# 包清单闸门，防止静默产出残缺 feed
│   ├── patches/              # 离线补丁文件
│   ├── assets/               # 静态文件 (autocore 启动脚本、直连域名、闸门 allowlist、变体摘除清单)
│   └── tools/                # 路由器端独立运维工具 (clean-overlay.sh 等)
├── themes/                   # 主题与外观配置
├── apps/                     # 独立应用、驱动与后台服务
├── legacy/                   # 基于 luasrc/cbi 的旧版应用
└── invasive/                 # 需修改 OpenWrt 源码或内核的组件
```

---

## 日常维护

### 1. 新增普通插件
打开 `core/scripts/packages.conf`，在对应分类下添加一行：
```text
分类/目录名 | Git仓库地址 | 分支名(可选，默认留空)
```
例如：
```text
apps/luci-app-demo | https://github.com/example/luci-app-demo
```

### 2. 删除/禁用插件
在 `core/scripts/packages.conf` 中找到对应插件行，行首加 `#` 注释掉即可。

### 3. 需要定制的插件
需要打 patch、改 Makefile、或者只从上游大仓库提取指定子目录的包（如 `imm_pkg`、`lede_pkg`、`OpenAppFilter`、`openwrt_helloworld` 等），处理函数写在 `core/scripts/custom.sh` 中。补丁文件统一放在 `core/patches/` 目录。

### 4. 本地测试

测试单个插件同步（几秒完成，支持输入包名或相对路径）：
```bash
./core/scripts/update.sh --only luci-app-mosdns
```

运行完整同步：
```bash
./core/scripts/update.sh
```

---

## 运维脚本

- `core/tools/clean-overlay.sh`：原根目录清理脚本。用于在 **OpenWrt 路由器** 上清理 `/overlay` 分区空间并保留关键配置。**切勿在电脑或开发环境上运行。**

---

## 二进制 APK 软件源与 ImageBuilder 使用

本仓库提供 GitHub Actions 工作流（`.github/workflows/build-feed.yml`），可将 `apps/` 目录下的软件包编译为 `.apk`，并按架构生成各分支软件源及 ImageBuilder 离线包。

构建管线要点：

- Go / Rust 组件（sing-box、mihomo-meta、mihomo-alpha、frp、mosdns、einat-ebpf、flowcone）在 runner 上交叉编译，
  apply_prebuilt.sh 只改写对应 Makefile 的 Build/Compile，DEPENDS、conffiles、install 等元数据仍以仓库内 Makefile 为准。
- 其余包（含依赖目标内核 BTF 的 vmlinux-btf）在 OpenWrt SDK 容器内正常编译。
- 每个计划编译的包都必须产出 apk；缺失且不在 core/assets/build-allow-missing.conf 中，工作流直接失败。
- prebuild_host.sh 的版本号与源码地址从各包 Makefile 解析，跟随每日同步自动更新。

### 1. 路由器在线安装

在运行新版 OpenWrt（使用 apk 包管理器）的路由器上执行：

```bash
# 导入源公钥
wget -qO /etc/apk/keys/custom-feed.rsa.pub https://qiusimons.github.io/OpenWrt-Add/keys/custom-feed.rsa.pub

# 添加源配置 (自动匹配当前硬件架构目录)
echo "https://qiusimons.github.io/OpenWrt-Add/$(apk --print-arch)" > /etc/apk/repositories.d/custom-feed.list

# aarch64 cortex 设备启用通用源（一次性）
grep -qx aarch64_generic /etc/apk/arch 2>/dev/null || echo aarch64_generic >> /etc/apk/arch
echo "https://qiusimons.github.io/OpenWrt-Add/aarch64_generic" >> /etc/apk/repositories.d/custom-feed.list

# 更新并安装
apk update
apk add <包名>
```

> [!TIP]
> - 若全新路由器提示 SSL/TLS 证书错误，可先安装基础证书库：`apk add --allow-untrusted ca-bundle`，或使用 `wget --no-check-certificate`。
> - 浏览器亦可直接访问 [https://qiusimons.github.io/OpenWrt-Add/](https://qiusimons.github.io/OpenWrt-Add/) 查看各架构包清单及索引状态。

### 2. ImageBuilder 离线打包

前往 [Releases 页面](https://github.com/QiuSimons/OpenWrt-Add/releases/tag/latest-packages) 下载 [`openwrt-add-apks-bundle.tar.gz`](https://github.com/QiuSimons/OpenWrt-Add/releases/download/latest-packages/openwrt-add-apks-bundle.tar.gz)：

```bash
# 解压至 ImageBuilder 的 packages 目录
tar -xzf openwrt-add-apks-bundle.tar.gz -C packages/

# 打包固件时直接在 PACKAGES 参数中填入包名
make image PROFILE="<目标设备Profile>" PACKAGES="<插件名1> <插件名2>"
```

