# airconnect-openwrt

适用于 OpenWrt 的 AirConnect 软件包及 LuCI 管理界面，让局域网内的 UPnP/DLNA (Sonos) 和 Chromecast 音响设备无缝支持 Apple AirPlay 音频推送。

本项目包含两个包：
- `airconnect`：核心服务包（包含 `airupnp` 与 `aircast` 两个主程序）
- `luci-app-airconnect`：LuCI 网页配置界面（支持客户端渲染）

---

## 为什么做这个包

很多旧版或第三方移植通常直接打包上游仓库预编译的静态二进制文件，存在以下问题：
1. **体积臃肿**：包含不必要的静态依赖；
2. **libc 兼容性问题**：OpenWrt 标配 musl libc，官方静态预编译包偶发运行异常或架构缺失；
3. **架构覆盖有限**：部分非主流架构无法直接使用。

本项目针对 OpenWrt 进行了原生化适配：
- 基于 CMake 与 musl 兼容补丁从源码构建；
- 动态链接 OpenWrt 系统共享库（`libupnp`、`libflac`、`shine`、`openssl`、`jansson`）；
- 体积小、内存占用低，原生契合 OpenWrt 环境。

---

## 安装方式

### 方式一：直接安装 Release 预编译包

GitHub Actions 会自动为主流架构（如 `x86_64`、`aarch64` 等）构建最新的 ipk 包。前往 [Releases](../../releases) 页面下载对应架构的包后上传至路由器安装。

1. 安装运行时依赖：
   ```sh
   opkg update
   opkg install libupnp libflac shine libopenssl jansson
   ```

2. 安装软件包：
   ```sh
   opkg install airconnect_*.ipk luci-app-airconnect_*.ipk
   ```

---

### 方式二：编译进 OpenWrt 固件

进入 OpenWrt 源码根目录：

```sh
# 克隆仓库到 package 目录
git clone https://github.com/QiuSimons/airconnect-openwrt.git package/airconnect-openwrt

# 更新 feeds 并配置
./scripts/feeds update -a
./scripts/feeds install -a
make menuconfig
```

在 `make menuconfig` 中勾选：
- `Multimedia` ---> `<*> airconnect`
- `LuCI` ---> `3. Applications` ---> `<*> luci-app-airconnect`

保存后照常执行编译即可。

---

## 配置说明

### Web 界面
登录 LuCI 后，进入 **服务** -> **AirConnect**：
- **基本开关**：启用 / 禁用服务；
- **监听网卡**：指定绑定接口（通常为 `br-lan`）；
- **独立开关**：按需单独开启 UPnP/Sonos (`airupnp`) 或 Chromecast (`aircast`) 支持；
- **Sonos 推流模式**：可选 `broadcast` / `track` / `radio`（影响缓冲与控制行为，默认 `broadcast` 即可）。

### 命令行 / UCI 配置
配置文件路径为 `/etc/config/airconnect`：

```uci
config airconnect 'config'
	option enabled '1'
	option interface 'br-lan'
	option airupnp '1'
	option aircast '1'
	option stream_type 'broadcast'
```

服务管理命令：

```sh
# 启动服务
/etc/init.d/airconnect start

# 停止服务
/etc/init.d/airconnect stop

# 查看运行状态
/etc/init.d/airconnect status

# 查看日志
logread -e airconnect
```

---

## 使用提示

1. **设备发现与 mDNS**：
   AirPlay 依赖局域网 Bonjour/mDNS 广播。请确保路由器或局域网交换机未开启组播隔离（IGMP Snooping 异常可能导致广播丢包）。
2. **多 VLAN / 跨网段**：
   若播放终端（如 iPhone）与音箱不在同一 VLAN/子网，需配置 mDNS 中继（如 `avahi-daemon` 或 `umdns`），并将 AirConnect 绑定在音箱所在的网络接口。
3. **防火墙规则**：
   AirConnect 默认运行在 LAN 侧，一般无需额外放行端口；若路由器防火墙策略严格，需确保 LAN 内部 UDP 组播及相关推流端口未被阻断。

---

## 致谢与上游项目

- [philippe44/AirConnect](https://github.com/philippe44/AirConnect) - AirConnect 核心实现
- [OpenWrt](https://openwrt.org/)
