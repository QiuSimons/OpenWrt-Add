# tcp-bbr3

BBRv3（基于 `hrimfaxi/tcp_bbr_modules`）+ 自适应 LFN 丢包容忍。

模块注册为 **`bbr3`**，卸载干净，支持 per-netns 独立配置。直接适配 OpenWrt 默认网络环境（默认 `fq_codel`，无需额外调参或配置 SQM）。

## 为什么需要它

BBRv3 默认将丢包率 > 2%（源码中为 `inflight * 5 / 256`）判定为 `inflight` 过高：探测期会冻结/回砍 `inflight_hi`，稳态期每轮把 `bw_lo` / `inflight_lo` 按 `(1 - beta)` 削减，STARTUP 阶段也会提前退出。

在跨国、海缆、卫星（Starlink / LEO）等长肥管道上，物理背景丢包常年在 1%–4% 波动。BBRv3 在这些链路上会被 2% 的硬门槛长期按住，无法跑满物理带宽。

本补丁不改大全局静态常数，而是**按轮学习路径的无拥塞物理丢包底噪**（`lfn_floor`）：仅在确认没有排队的巡航轮次中学习底噪，动态给予适度容忍；一旦检测到排队、限速或真实拥塞，立刻回退原生惩罚。

## 机制实现

### 1. 整轮丢包统计
主线内核仅提供 `rs->losses`（单次 ACK 新标记的丢包数），若按单个 ACK 计算丢包率，极易受 SACK 聚集和 RACK 突发标记影响。本补丁按轮聚合 `lfn_round_lost` 与 `lfn_round_acked`，以整轮结果结算真实丢包率，消除瞬时采样失真。

### 2. fq_codel 排队时延判据与继承
OpenWrt 默认 qdisc 为 `fq_codel`（target 5ms，interval 100ms）。本补丁过滤 Delayed ACK，以本轮采样最小排队时延 `min_qd` 判定拥塞：
* `min_qd <= 2ms`：确认无 CoDel 队列积压，允许向 `floor` 学习；
* `2ms < min_qd <= 5ms`：存在轻度排队波动，不学习新 floor，但允许沿用已有容忍度；
* `min_qd > 5ms`：触及 `fq_codel` 的 target 门限，立刻判定拥塞，撤销容忍并走原生降窗；
* 引入跨轮排队继承，避免轮首未获得纯净采样时误判回退。

### 3. 探路斜率检查与自愈
为防止把令牌桶限速（Policer）或瓶颈丢包误认作背景丢包，模块对比带宽探测丢包率（`p_probe`）与稳态巡航丢包率（`p_cruise`）。若 `p_probe > p_cruise + 1.0%`，判定丢包随发包量升高而加剧（限速/拥塞特征），标记 `slope_bad` 并限制探路；平稳巡航 4 轮后自动解除标记，避免偶发网络抖动导致永久死锁。

### 4. 路径分级与屋顶限制
* **局域网/低延时（`min_rtt < 20ms`）**：完全禁用该特性，入口直接返回，零 CPU 损耗，保留 Fast-Path；
* **跨运营商（`20ms <= min_rtt < 80ms`）**：容忍上限 3.0%（`floor + 0.5%`），inflight 屋顶限制为 1.15× BDP；
* **长肥跨国（`min_rtt >= 80ms`）**：容忍上限 5.0%（`floor + 1.0%`），inflight 屋顶限制为 1.30× BDP；
* 稳态下界削减豁免严格受上述屋顶约束，防止 cwnd 膨胀至 `cwnd_gain = 2.0` 形成 1 个 BDP 的站立队列。

## 参数

```
net.ipv4.tcp_bbr_lfn_loss_thresh_pct   0=关闭  1=自动(默认)  2..5=手动上限(%)
net.ipv4.tcp_bbr_lfn_min_rtt_fresh_ms  min_rtt 有效年龄(ms)，0=不校验（默认 15000）
```

* **自动模式（`pct=1`）**：
  长肥路径阈值等于 `min(5%, max(2%, floor + 1%))`；跨运营商等于 `min(3%, max(2%, floor + 0.5%))`。无丢包链路始终停在原生 2%。
* 模块参数 `lfn_loss_thresh_pct` / `lfn_min_rtt_fresh_ms` 作为各 netns 的初始值。

## 已知边界

* **自动模式不改变短连接**：`floor` 是 per-socket 在连接稳态中学习的，握手初期 `floor` 为 0，收益集中在长寿流。
* **STARTUP 阶段**：`min_rtt < 80ms` 时 STARTUP 不享受容忍；仅在长肥（`>= 80ms`）且已配置容忍时放行。
* **路由器本地发出的流量生效**：Linux 拥塞控制仅作用于本机发出的 TCP（如代理、内网穿透、测速、本机下载等）。路由器纯转发的流量只经由网卡 qdisc 转发，不经过本机 TCP 拥塞控制。

## 验证

查看加载与当前算法：
```sh
cat /proc/sys/net/ipv4/tcp_available_congestion_control
cat /proc/sys/net/ipv4/tcp_congestion_control
```

修改参数（超出 0..5 范围写入会返回 Invalid argument）：
```sh
sysctl -w net.ipv4.tcp_bbr_lfn_loss_thresh_pct=1
```

在中间设备或对端使用 netem 测试（本机保持默认 `fq_codel`）：
```sh
# 局域网基线（< 20ms）：不进入 LFN
tc qdisc add dev eth0 root netem delay 5ms loss 1%

# 跨运营商（40ms，2% 丢包）：自动容忍，上限 3%
tc qdisc change dev eth0 root netem delay 40ms loss 2%

# 长肥路径（180ms，3% 丢包）：自动容忍，上限 5%
tc qdisc change dev eth0 root netem delay 180ms loss 3%

# 验证限速 Policer：叠加限速，斜率机制生效后迅速收敛，不持续高重传
tc qdisc change dev eth0 root netem delay 40ms
tc qdisc add dev eth0 parent 1:1 handle 10: tbf rate 20mbit burst 32k latency 50ms
```
