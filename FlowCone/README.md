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
  - **端口保持与奇偶性保持**：空闲端口队列 + 奇偶性队列，优先复用原始内网端口；端口唯一性由 BPF_NOEXIST 映射插入原子保证，无位图扫描、无用户态 GC。
- **L2 自适应**：Ethernet、802.1Q/802.1ad VLAN、PPPoE session、PPP（含 1 字节协议压缩）和 RAWIP/TUN/WireGuard 均可解析。
- **防火墙失效安全**：fw4 规则引用带 timeout 的 liveness set；守护进程崩溃/被 SIGKILL/禁用/卸载后 set 元素自动过期，fw4 masquerade/fullcone 接管，不会留下“eBPF 已停但 nft 仍豁免”的私网泄漏。
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
    └── luci-app-flowcone/      # OpenWrt LuCI Web 管理界面
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

### 1. 本地独立编译

编译 eBPF 模块需使用 Rust Nightly 工具链及 `bpfel-unknown-none` 目标：

```bash
# 1. 安装 eBPF 目标架构组件
rustup target add bpfel-unknown-none --toolchain nightly
rustup component add rust-src --toolchain nightly

# 2. 编译 eBPF 数据面二进制
cargo +nightly build --release \
  --target=bpfel-unknown-none \
  -Z build-std=core \
  --manifest-path crates/flowcone-ebpf/Cargo.toml

# 3. 编译用户态守护进程 (自动嵌入上一步生成的 eBPF 字节码)
cargo build --release -p flowcone-daemon

# 产物位于 target/release/flowcone
```

### 2. OpenWrt 源码树编译

将 `openwrt/flowcone` 和 `openwrt/luci-app-flowcone` 放入 OpenWrt 源码树的 `package/` 目录：

```bash
./scripts/feeds update -a && ./scripts/feeds install -a
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
      --interval <SEC>       GC sweep interval in seconds (default: 5)
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

- UDP 数据面：FlowCone 负责 UDP EIM/EIF 和端口保持；TCP/ICMP 仍由系统 NAT/fw4 处理。standalone 表会为 TCP/ICMP 提供 masquerade 回退。
- IPv4 分片：出站/入站分片通过独立 fragment target 做首片建映射、后续片查缓存；IPv4 大 UDP 已实测双向通过。
- IPv6 分片：自建 veth 双向 3000B 已通过；主路由仍运行稳定 pre-frag6，尚未部署分片版本。
- Hairpin：当前没有 LAN 侧 TC 入口，未实现 RFC 4787 REQ-9 的 hairpin。
- IPv6 ULA NAT66：受控 veth、PPP 拓扑和主路由 PPPoE 均已验证 SNAT 到 WAN GUA + EIF 非请求回包（64B）；PPP TC 数据为裸 IP，l2_len=0，v6 inbound binding 使用显式写入。IPv6 分片已实现。
- ICMP 错误：IPv4 Destination Unreachable/Time Exceeded/Parameter Problem 会翻译外层目的地址和嵌入 UDP 源，并重算外层 ICMP/内层 IP/UDP 校验和；IPv4 支持非空 UDP 载荷触发的可变长度错误。ICMPv6 错误翻译已在自建 veth lab 通过。
- 软件 flow offload：forward accept 规则带 ct state new，并放在 fw4 flow add @ft 之后；已建立流继续走 flowtable，不阻断软件 offload。硬件 flow offload 仍会绕过 TC，必须关闭。
- honk / daed 等 TC eBPF 透明代理：FlowCone 保持 TCX LinkOrder::last，只 OR 自己的 mark 位，不清除其他程序的 mark；DNAT mark 位可通过 --mark 配置以避免冲突。代理流量可用 --bypass-mark 让出，nft 豁免规则也会排除该 mark。OpenWrt init 的 START 从 95 调到 99，确保 honk(96)/dae(96)/daed(99) 先挂载、FlowCone 后挂载。运行期每 30 秒用进程内 query_tcx 检查一次；只有发现 FlowCone 不再是 TCX 尾部时才切换。切换使用两个 56 字节级的 tail-call dispatcher（A/B），它们指向同一份 FlowCone 主程序：先把未激活的 dispatcher 挂到链尾，再摘旧 dispatcher；主程序幂等，因此切换期间无 WAN 空窗、无双 NAT。检查不 fork tc/bpftool；正常场景不产生链路抖动。若之后单独重启代理，最多 30 秒后 FlowCone 会重新挂到最后；无法阻止其他程序在任意时刻再抢 last。
- fw4 规则生命周期：规则引用 /etc/nftables.d/flowcone.nft 中的 timeout set；chain-pre 只保存规则，不保存活跃状态。fw4 reload 后由 SIGHUP/周期刷新重新填充 set，最坏 15 秒内回退到系统 masquerade。
- generic 非 fw4 路径：仍使用内联前缀规则，liveness 保障只覆盖 fw4 与 standalone 表；通用 Linux 建议使用 fw4/nftables。

---

## 许可证

本项目采用 [GPL-3.0-or-later](LICENSE) 许可证开源。
