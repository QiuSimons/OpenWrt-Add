# FlowCone

基于 eBPF (TCX) 的 Linux / OpenWrt 双栈 RFC 4787 Full-Cone NAT 实现。

---

## 概述

FlowCone 挂载于网络接口的 TCX（Ingress / Egress）链，通过 eBPF 实现符合 RFC 4787 规范的完全圆锥型 (Full-Cone) NAT。核心数据面基于 `aya-ebpf`，控制面基于 `aya`。

既可在通用 Linux 发行版（Debian、Ubuntu、Arch Linux、Alpine 等）作为独立后台守护进程运行，也提供了 OpenWrt 原生包、procd 托管服务与 LuCI Web 管理界面。

---

## 核心特性

- **RFC 4787 / RFC 5508 (UDP Full-Cone NAT)**：
  - **EIM (Endpoint-Independent Mapping)**：内网特定端点（IP:Port）在有效期内保持固定映射到相同的公网端口。
  - **EIF (Endpoint-Independent Filtering)**：任意外部主机向该映射端口发送 UDP 报文均可直接穿透转发至内网主机。
  - **端口保持与奇偶性保持**：优先保持与内网相同的端口号和奇偶性；空闲端口通过奇偶原子位图 (`BITMAP_EVEN_V4` / `BITMAP_ODD_V4` / `BITMAP_EVEN_V6` / `BITMAP_ODD_V6`) 无锁分配。
  - **ICMP / ICMPv6 错误报文翻译**：按 RFC 5508 反向翻译包含内嵌 UDP 首部的 ICMPv4/ICMPv6 错误报文，使 traceroute 与 PMTUD 正常工作。
- **双栈支持**：
  - IPv4 Full-Cone NAT（默认启用）。
  - IPv6 自适应：未配置 IPv6 masquerade 时仅对 ULA (`fc00::/7`) 执行 NAT66，原生公网 GUA 直通；检测到全局 masquerade 时自动启用全局 NAT66。
- **防火墙与路由协议栈兼容**：
  - **Software Flowtable**：TC Ingress 执行 DNAT、TC Egress 执行 SNAT，出入 Netfilter 协议栈呈现对称五元组，与内核软件流表加速完全兼容。
  - **动态防火墙联动**：OpenWrt 环境自动注入 `table inet fw4` 并在 `/usr/share/nftables.d/chain-pre/` 与 `/etc/nftables.d/flowcone.nft` 持久化；通用 Linux 自动探测注入 `nat` 与 `filter` 链。
  - **失效回退**：防火墙规则引用带超时机制的 liveness 集合（通过 in-process Netfilter Netlink 原子刷新），进程异常终止或退出后自动回退至系统 Masquerade。
- **L2 自适应**：支持裸 Ethernet、802.1Q/802.1ad VLAN、PPPoE 及 RAWIP/TUN/WireGuard 接口。
- **多 BPF 程序与标记共存**：以 `LinkOrder::last()` 挂载于 TCX 链尾，入站报文 mark 写入采用位或运算以保留前序 BPF 过滤器标记；内置链尾巡检与动态自愈机制，并支持通过 `--bypass-mark` 排除指定标记流量。

---

## 数据流向

```text
入站 (WAN Ingress):
  外部报文 (dst: WAN_IP:Port)
    └─► TCX Ingress (EIF 查表 DNAT -> LAN_IP:Port, 标记 mark 0x00800000)
          └─► Netfilter / Software Flowtable / 路由
                └─► 发往 LAN 主机

出站 (WAN Egress):
  LAN 报文 (src: LAN_IP:Port)
    └─► 路由 / Netfilter / Software Flowtable
          └─► TCX Egress (EIM 查表/建表 SNAT -> WAN_IP:Port)
                └─► 物理网卡发往 WAN
```

---

## 系统要求

- **体系结构**：仅支持 64 位架构（如 `x86_64`、`aarch64`、`riscv64`），用于与 eBPF 共享 64 位原子端口位图。
- **内核版本**：Linux Kernel >= 6.6（推荐 6.12+，具备完整 TCX 支持；低于 6.6 且缺失 TCX 时可回退到 netlink clsact，但需确认内核提供 `BPF_PROG_TYPE_SCHED_CLS`）。
- **内核配置**：
  - `CONFIG_BPF=y`
  - `CONFIG_BPF_SYSCALL=y`
  - `CONFIG_NET_CLS_ACT=y`
  - （仅加载 CO-RE 程序时需要）内核 BTF (`CONFIG_DEBUG_INFO_BTF=y`) 或通过 `--btf` 指定外挂 BTF；当前版本数据面无需内核 BTF。
- **系统工具**：`nftables`。

---

## 编译与安装

### 1. 宿主机环境准备 (Ubuntu / Debian)

```bash
# 安装基础编译工具与 musl
sudo apt-get update
sudo apt-get install -y build-essential musl-tools

# 若需交叉编译 aarch64 架构：
sudo apt-get install -y gcc-aarch64-linux-gnu

# 安装 Rust 与目标工具链
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add x86_64-unknown-linux-musl
rustup target add aarch64-unknown-linux-musl

# （可选）若需重新编译 eBPF 数据面：
sudo apt-get install -y llvm
rustup toolchain install nightly
rustup target add bpfel-unknown-none --toolchain nightly
rustup component add rust-src --toolchain nightly
cargo install bpf-linker
```

> [!NOTE]
> 仓库内已内置预编译且剥离 DWARF 调试信息的 eBPF 字节码（`crates/flowcone-daemon/ebpf/flowcone-ebpf.bin`）。若未修改 eBPF 内核代码，直接使用稳定版 Rust 编译守护进程即可。

### 2. 独立编译守护进程与 eBPF 数据面

```bash
# 编译当前主机架构二进制 (x86_64 musl)
cargo build --release --locked -p flowcone-daemon --target x86_64-unknown-linux-musl

# 交叉编译 aarch64 musl
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=aarch64-linux-gnu-gcc \
cargo build --release --locked -p flowcone-daemon --target aarch64-unknown-linux-musl

# （可选）重新编译 eBPF 字节码并剥离 DWARF：
cargo xtask build-ebpf
# 或手动编译并复制：
# (cd crates/flowcone-ebpf && cargo +nightly build --release --target=bpfel-unknown-none -Z build-std=core)
# llvm-objcopy --strip-debug crates/flowcone-ebpf/target/bpfel-unknown-none/release/flowcone-ebpf crates/flowcone-daemon/ebpf/flowcone-ebpf.bin
```

编译产物位于 `target/<target-triple>/release/flowcone`。

### 3. OpenWrt 源码树打包

将源码目录复制到 OpenWrt 包目录（`luci-app-flowcone` 依赖 `flowcone` 与 `nat6`）：

```bash
cp -r openwrt/flowcone package/flowcone
cp -r openwrt/nat6 package/nat6
cp -r openwrt/luci-app-flowcone package/luci-app-flowcone

make menuconfig
# Network -> Routing and Redirection -> <M> flowcone
# Network -> <M> nat6
# LuCI -> Applications -> <M> luci-app-flowcone

make package/flowcone/compile V=s
make package/nat6/compile V=s
make package/luci-app-flowcone/compile V=s
```

*注：OpenWrt 24.x 产物为 `.ipk`（通过 `opkg install` 安装），OpenWrt 25.x 产物为 `.apk`（通过 `apk add --allow-untrusted` 安装）。*

---

## 配置与运行

### 命令行参数

```text
FlowCone — Dual-Stack RFC 4787 Full-Cone NAT for Linux
Usage: flowcone [OPTIONS]

Options:
  -i, --iface <IFACE>        WAN interface (default: wan)
  -b, --btf <PATH>           Path to vmlinux BTF (optional, if CO-RE is used)
      --enable-v4 <1|0>      Enable IPv4 Full-Cone NAT (default: 1)
      --enable-v6 <1|0>      Enable IPv6 Full-Cone NAT (auto-adaptive, default: 0)
      --min-port <PORT>      Port pool start (default: 1024)
      --max-port <PORT>      Port pool end (default: 65535)
      --timeout <SEC>        Binding timeout in seconds (default: 120)
      --interval <SEC>       Expiry scheduler tick in seconds (default: 5)
      --bypass-mark <VAL[/MASK]> Mark filter to bypass FlowCone (e.g. 0x1/0x1)
      --mark <VAL>           Inbound DNAT mark (default: 0x00800000)
      --manage-nft <1|0>     Manage firewall nftables rules automatically (default: 1)
  -v, --verbose              Verbose output
  -V, --version              Show version
  -h, --help                 Show help
```

### OpenWrt 服务配置

配置文件位于 `/etc/config/flowcone`：

```uci
config flowcone 'config'
	option enable_v4 '1'
	option enable_v6 '0'
	option interface 'wan'
	option advanced '0'
	# 当 option advanced '1' 时，以下高级选项生效：
	# option min_port '1024'
	# option max_port '65535'
	# option timeout '120'
	# option interval '5'
	# option manage_nft '1'
	# option bypass_mark '0x1'
	# option mark '0x00800000'
```

服务管理命令：

```bash
/etc/init.d/flowcone start      # 启动服务
/etc/init.d/flowcone stop       # 停止服务并清理规则
/etc/init.d/flowcone restart    # 重启服务
/etc/init.d/flowcone enable     # 设置开机自启
```

安装 `luci-app-flowcone` 后，可在 OpenWrt Web 界面通过 **网络 -> FlowCone** 进行可视化配置与监控。

---

## 注意事项与已知限制

- **协议覆盖范围**：FlowCone 专注于 UDP 报文的 EIM/EIF 状态转换与端口保持（含 RFC 5508 ICMP/ICMPv6 差错报文关联翻译）。常规 TCP 与普通 ICMP 请求报文仍由系统原生 Netfilter/fw4 状态机与 Masquerade 处理。
- **硬件流表卸载 (Hardware Flow Offload)**：硬件加速（PPE / DSA）会直接绕过 CPU 网络层及 TC 钩子，导致 FlowCone 无法截获并翻译报文。使用 FlowCone 时**必须关闭硬件流表卸载**；软件流表（Software Flow Offload）可正常兼容。
- **Hairpin NAT**：当前未在 LAN 侧网络接口配置 TC 入口，未实现 RFC 4787 局域网回流（Hairpin）。从局域网内直接访问本路由器 WAN 口公网 IP 及映射端口不会经过 FlowCone 转换。
- **IP 分片**：支持 IPv4/IPv6 首片建表与后续分片缓存映射（LRU 缓存容量为 4096）。乱序严重的极端网络场景下，若后续分片先于首片到达，依赖上层重传。

---

## 许可证

本项目采用 [GPL-3.0-or-later](LICENSE) 许可证开源。
