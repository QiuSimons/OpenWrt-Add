# FlowCone

基于 eBPF (TCX) 的 Linux 双栈 RFC 4787 Full-Cone NAT 实现，支持通用 Linux 与 OpenWrt。

---

## 概述

FlowCone 运行在网络接口的 TCX（Ingress / Egress）钩子上，实现符合 RFC 4787 规范的完全圆锥型 (Full-Cone) NAT。核心数据面基于 `aya-ebpf`，控制面基于 `aya`。

既可在通用 Linux 发行版（Debian、Ubuntu、Arch Linux、Alpine 等）上作为独立后台守护进程运行，也提供了 OpenWrt 原生包、procd 脚本与 LuCI Web 管理界面。

---

## 功能特性

- **RFC 4787 规范 (UDP)**：
  - **EIM (Endpoint-Independent Mapping)**：同一内网地址与端口在有效期内映射到固定的公网端口。
  - **EIF (Endpoint-Independent Filtering)**：外部主机向已建立映射的公网端口发送报文均可穿透转发至内网主机。
  - **端口保持与奇偶性保持**：空闲端口按奇偶分队列，优先复用原始内网端口；端口唯一性由 BPF_NOEXIST 映射插入原子保证，不做全端口位图扫描。端口分配上，用户态只负责过期会话回收和端口归还。
- **L2 自适应**：Ethernet、802.1Q/802.1ad VLAN、PPPoE session、PPP（含 1 字节协议压缩）和 RAWIP/TUN/WireGuard 均可解析。
- **防火墙失效回退（有界窗口）**：fw4 规则引用带 timeout 的 liveness set；守护进程崩溃/被 SIGKILL/禁用/卸载后 TCX 链接随进程退出，set 元素在 15 秒内过期，fw4 masquerade 接管出站；入站 fullcone 在进程退出后不可用。崩溃后最长 15 秒内 UDP 豁免仍可能存在，这是有界的回退窗口，不是零泄漏；procd 的 respawn 会缩短它。
- **TCX 挂载**：
  - 以 `LinkOrder::last()` 挂载于 TCX Ingress 和 Egress 链尾，不影响前序 BPF 过滤器及策略路由匹配。
  - 支持 `--bypass-mark` 配合 fwmark 规则放行特定流量。
- **内核 Software Flowtable 兼容**：
  - TC Ingress 执行 DNAT，TC Egress 执行 SNAT，进出 Netfilter 协议栈的报文呈现对称五元组，可被内核软件流表正常加速。
  - *注意*：硬件流表卸载 (Hardware Flow Offload / PPE / DSA) 会绕过 CPU TC 钩子，使用 FlowCone 时需保持硬件卸载关闭。
- **IPv4 / IPv6 双栈支持**：
  - 默认启用 IPv4 Full-Cone NAT。
  - IPv6 支持自适应模式：未开启 IPv6 masquerade 时仅对 ULA (`fc00::/7`) 进行 NAT66，原生 GUA 流量直通；检测到全局 masquerade 时自动启用全局 NAT66。
- **防火墙规则管理**：
  - OpenWrt 环境自动注入 `table inet fw4` 并在 `/usr/share/nftables.d/chain-pre/` 注册规则文件，兼顾 `fw4 reload` 防火墙重载。
  - 通用 Linux 环境自动探测并注入系统现有的 `postrouting` (nat) 和 `forward` (filter) 链。
  - 退出时根据 rule handle 自动清理注入的防火墙规则。
- **私网 IP 泄漏防护**：
  - DHCP 客户端/中继、链路本地和广播/组播 UDP 不进入 FlowCone SNAT，交给系统防火墙处理。
- **OpenWrt 支持**：
  - 提供 procd 托管服务、UCI 配置文件（`/etc/config/flowcone`）和 LuCI Web 管理界面（`luci-app-flowcone`）。
  - 支持外挂 BTF（如 `vmlinux-btf` 提供的 `/usr/lib/debug/boot/vmlinux`），可在未开启 `CONFIG_DEBUG_INFO_BTF=y` 的内核上运行。

---

## 数据流向

```text
入站 (WAN Ingress):
  外部报文 (dst: WAN_IP:Port)
    └─► TCX Ingress (EIF 查表 DNAT -> LAN_IP:Port, 标记 mark 0x40000000)
          └─► Netfilter / Software Flowtable / 路由
                └─► 发往 LAN 主机

出站 (WAN Egress):
  LAN 报文 (src: LAN_IP:Port)
    └─► 路由 / Netfilter / Software Flowtable
          └─► TCX Egress (EIM 查表/建表 SNAT -> WAN_IP:Port)
                └─► 物理网卡发往 WAN
```

---

## 目录结构

```text
FlowCone/
├── Cargo.toml                  # Cargo Workspace 配置
├── crates/
│   ├── flowcone-common/        # 共享数据结构与 RFC 4787 算法 (#![no_std])
│   ├── flowcone-daemon/        # 用户态控制面守护进程 (BTF 加载, Netlink, GC, nftables)
│   └── flowcone-ebpf/          # 内核态 eBPF 数据面 (#![no_std], aya-ebpf)
└── openwrt/
    ├── flowcone/               # OpenWrt 主程序包与 procd 启动脚本
    ├── luci-app-flowcone/      # OpenWrt LuCI Web 管理界面
    └── nat6/                   # 可选的 IPv6 NAT6/RA 辅助包
```

---

## 系统要求

- **操作系统**：Linux Kernel >= 6.6（推荐 6.12+，具备完整 TCX 支持）。
- **内核配置**：
  - `CONFIG_BPF=y`
  - `CONFIG_BPF_SYSCALL=y`
  - `CONFIG_NET_CLS_ACT=y`
  - 内核内置 BTF (`CONFIG_DEBUG_INFO_BTF=y`) 或存在外挂 BTF 文件（如 `/usr/lib/debug/boot/vmlinux`）。
- **防火墙工具**：`nftables`。

---

## 编译

### 1. 宿主机构建依赖 (以 Ubuntu 为例)

编译 FlowCone 守护进程需在宿主机配置 Rust (>= 1.98.0) 及目标架构的 musl 工具链：

```bash
# 基础构建与 musl 工具链
sudo apt-get update
sudo apt-get install -y musl-tools

# 若需交叉编译 aarch64 架构：
sudo apt-get install -y gcc-aarch64-linux-gnu

# 安装 Rust 工具链及 musl 目标架构
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add x86_64-unknown-linux-musl
rustup target add aarch64-unknown-linux-musl

# （可选）若需重新编译 crates/flowcone-ebpf 数据面字节码：
rustup toolchain install nightly
rustup target add bpfel-unknown-none --toolchain nightly
rustup component add rust-src --toolchain nightly
```

> [!NOTE]
> 仓库内已内置预编译好的 eBPF 字节码（`crates/flowcone-daemon/ebpf/flowcone-ebpf.bin`）。若未修改 eBPF 内核代码，直接使用稳定版 Rust 编译守护进程即可。

### 2. 本地独立编译

```bash
# 编译当前主机架构二进制 (x86_64 musl)
cargo build --release --locked -p flowcone-daemon --target x86_64-unknown-linux-musl

# 或交叉编译 aarch64 musl
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=aarch64-linux-gnu-gcc \
cargo build --release --locked -p flowcone-daemon --target aarch64-unknown-linux-musl

# 若修改了 eBPF 内核代码需重新生成字节码：
cargo +nightly build --release \
  --target=bpfel-unknown-none \
  -Z build-std=core \
  --manifest-path crates/flowcone-ebpf/Cargo.toml
cp target/bpfel-unknown-none/release/flowcone-ebpf crates/flowcone-daemon/ebpf/flowcone-ebpf.bin

# 产物位于 target/<target-triple>/release/flowcone
# 若 eBPF 源码更新，先重跑上面的 eBPF 构建并覆盖 embedded bin，再重编 daemon；
# build.rs 检测到 embedded bin 落后时会打印 cargo warning。
# 也可用 FLOWCONE_EBPF_PATH=<path> 显式指定刚构建的 eBPF 对象。
# eBPF 对象现在携带 BTF：bpf_loop 回调需要 func_info，目标内核必须有
# vmlinux BTF（CONFIG_DEBUG_INFO_BTF 或外挂 vmlinux-btf）；bpf_loop 还需要
# CAP_BPF，当前以 root 运行。
#
# 诊断单程序 verifier 时设置 FLOWCONE_VERIFIER_LOG=1，会切到 DEBUG 日志；
# 正常启动不要开，日志可能很大。
```

### 3. OpenWrt 源码树编译

在 OpenWrt 编译环境中，可将已生成的 `flowcone` 二进制置于 `openwrt/flowcone/files/flowcone.bin`（免宿主机重复编译），或由 Makefile 调用宿主机 Rust 构建：

```bash
# 拷贝至 OpenWrt package 目录
cp -r openwrt/flowcone package/flowcone
cp -r openwrt/luci-app-flowcone package/luci-app-flowcone

make menuconfig
# Network -> Routing and Redirection -> 选择 flowcone
# LuCI -> Applications -> 选择 luci-app-flowcone

make package/flowcone/compile V=s
make package/luci-app-flowcone/compile V=s
```

---

## 配置与运行

### 命令行参数

```text
FlowCone — Dual-Stack RFC 4787 Full-Cone NAT for Linux
Usage: flowcone [OPTIONS]

Options:
  -i, --iface <IFACE>        WAN interface (default: wan)
  -b, --btf <PATH>           Path to vmlinux BTF (optional, auto-detected)
      --enable-v4 <1|0>      Enable IPv4 Full-Cone NAT (default: 1)
      --enable-v6 <1|0>      Enable IPv6 Full-Cone NAT (auto-adaptive, default: 0)
      --min-port <PORT>      Port pool start (default: 1024)
      --max-port <PORT>      Port pool end (default: 65535)
      --timeout <SEC>        Binding timeout in seconds (default: 120, minimum 120)
      --interval <SEC>       Expiry scheduler tick in seconds (default: 5)
      --bypass-mark <VAL[/MASK]> Mark filter to bypass FlowCone (e.g. 0x1/0x1)
      --mark <VAL>           Inbound DNAT mark bit (default: 0x40000000)
      --manage-nft <1|0>     Manage firewall nftables rules automatically (default: 1)
  -v, --verbose              Verbose output
  -h, --help                 Show help
```

### OpenWrt 服务配置

配置文件位于 `/etc/config/flowcone`：

```uci
config flowcone 'config'
	option enable_v4 '1'
	option enable_v6 '0'
	option interface 'wan'
	option min_port '1024'
	option max_port '65535'
	option timeout '120'
	option interval '5'
	option manage_nft '1'
	# option bypass_mark '0x1'
```

服务管理：

```bash
/etc/init.d/flowcone start      # 启动服务
/etc/init.d/flowcone stop       # 停止服务并清理规则
/etc/init.d/flowcone restart    # 重启服务
/etc/init.d/flowcone enable     # 开启开机自启
```

### Web 界面 (LuCI)

安装 `luci-app-flowcone` 后，登录 OpenWrt Web 界面进入 **网络 -> FlowCone**，即可查看运行状态并修改参数。

---

## 实现边界与兼容性

> 仓库内没有自动化网络回归。本次交付在 A/B 双路由验证了 IPv4 eBPF verifier 加载；在 B 上验证了 STUN 映射与外部主动 UDP 的 fullcone 收包；同源端口 40000 的两个 LAN 客户端，第二个由 `bpf_loop` 回调分配到 1024 并完成外部主动 UDP 收包。IPv6/frag fullcone 仍需独立的 IPv6 WAN 实验室复测；不要用 verifier 通过冒充数据面通过。以下为代码实现边界。

- UDP 数据面：FlowCone 负责 UDP EIM/EIF 和端口保持；TCP/ICMP 仍由系统 NAT/fw4 处理。standalone 表会为 TCP/ICMP 提供 masquerade 回退。
- IPv4 分片：出站/入站分片通过独立 fragment target 做首片建映射、后续片查缓存。分片缓存为 1024 条/方向/族（LRU，30 秒超时）；首片晚于后续片到达时，后续片可能被丢弃并依赖上层重传。
- IPv6 分片：分片头前允许 Hop-by-Hop / Destination Options；Routing Header、AH、ESP 及超长扩展头链不参与 NAT，按未识别流量透传。分片缓存同样为 1024 条/方向/族。
- Hairpin：当前没有 LAN 侧 TC 入口，未实现 RFC 4787 REQ-9 的 hairpin；从 LAN 访问“自己的 WAN 地址:映射端口”不会经过本程序的 TC 钩子。
- IPv6 ULA NAT66：未检测到 IPv6 masquerade 时只对 ULA (fc00::/7) 做 NAT66，GUA 直通；检测到全局 masquerade 时对所有可路由内部地址做 NAT66。WAN 地址变化会清空对应族的会话、映射、端口和分片缓存。
- IPv6 WAN 地址选择：永久地址优先，其次非临时动态地址，最后隐私/临时地址；只有临时地址时仍可工作。
- ICMP 错误：IPv4 Destination Unreachable/Time Exceeded/Parameter Problem 会翻译外层目的地址和嵌入 UDP 源，并重算外层 ICMP/内层 IP/UDP 校验和；IPv4 支持非空 UDP 载荷触发的可变长度错误。ICMPv6 错误翻译已实现，需在目标内核上做抓包回归。
- 软件 flow offload：forward accept 规则带 ct state new；chain-pre 持久化规则位于 fw4 flow add @ft 之后，已建立流继续走 flowtable，不阻断软件 offload。硬件 flow offload 会绕过 CPU TC 钩子，必须关闭；程序只能告警，无法从 eBPF 内关闭 fw4 的 flowtable 规则。
- honk / daed 等 TC eBPF 透明代理：FlowCone 保持 TCX LinkOrder::last，只 OR 自己的 mark 位，不清除其他程序的 mark；DNAT mark 位可通过 --mark 配置以避免冲突。代理流量可用 --bypass-mark 让出，nft 豁免规则也会排除该 mark。OpenWrt init 的 START 从 95 调到 99，确保 honk(96)/dae(96)/daed(99) 先挂载、FlowCone 后挂载。运行期每 30 秒用进程内 query_tcx 检查一次；只有发现 FlowCone 不再是 TCX 尾部时才切换。切换使用两个 56 字节级的 tail-call dispatcher（A/B），它们指向同一份 FlowCone 主程序：先把未激活的 dispatcher 挂到链尾，再摘旧 dispatcher；主程序幂等，因此切换期间无 WAN 空窗、无双 NAT。检查不 fork tc/bpftool；正常场景不产生链路抖动。若之后单独重启代理，最多 30 秒后 FlowCone 会重新挂到最后；无法阻止其他程序在任意时刻再抢 last。
- fw4 规则生命周期：规则引用 /etc/nftables.d/flowcone.nft 中的 timeout set；chain-pre 只保存规则，不保存活跃状态。fw4 reload 后由 SIGHUP/周期刷新重新填充 set，最坏 15 秒内回退到系统 masquerade。
- generic 非 fw4 路径：仍使用内联前缀规则，liveness 保障只覆盖 fw4 与 standalone 表；通用 Linux 建议使用 fw4/nftables。
- 自定义 mark：--mark 同时写入 eBPF 配置和 fw4/standalone/generic 防火墙规则；修改后需重启守护进程。
- L2/PPPoE：挂在 pppoe-wan/ppp0 时 TC 看到裸 IP（l2_len=0）。若把程序挂到承载 PPPoE 的以太网口，且 PPP 协议字段为 1 字节压缩，IP 头会从奇数偏移开始；内核 bpf_l3/l4_csum_replace 拒绝奇数 offset，当前会丢弃该包。OpenWrt 默认挂 pppoe-wan，不会走到该路径。
- 分片表容量：1024 条 LRU，表满时旧记录被挤出，后续分片会被丢弃；不会把私网地址发出去，但单个大数据报可能缺片。
- 本机监听端口：守护进程每 30 秒按当前 /proc/net/udp{,6} 的监听集合整体对账；服务停止后端口会回到池中。仍被映射占用的端口不会立即回收。
- 端口池：端口状态使用 FREE/QUEUED 位；preferred 成功只清 FREE、保留 QUEUED，release 不会重复入队。主 egress 和 frag v4 每侧最多 64 次（32 primary + 32 fallback），由 `bpf_loop` 回调执行；frag v6 因 verifier 预算只能 1/0。仍失败时置 `PORT_FLAGS`，由用户态重建队列。eBPF 对象携带 BTF，目标需有 vmlinux BTF；`bpf_loop` 还需 CAP_BPF（当前 root 运行）。
- 过期回收：`last_seen` 为 u32 秒，32 位读原子；删除前复核 inbound/outbound，删除本身仍非原子。WAN 变化递增 frag key epoch，旧缓存不命中。

---

## 许可证

本项目采用 [GPL-3.0-or-later](LICENSE) 许可证开源。
