# tcp-bbr3

BBRv3（`hrimfaxi/tcp_bbr_modules`）+ 自适应 LFN 丢包容忍。

模块注册的拥塞控制名是 **`bbr3`**，卸载干净、可按 netns 独立配置。

## 为什么需要它

BBRv3 把「丢包率 > 2%」一律当作 `inflight` 过高：探测期（PROBE_UP）会冻结/回砍
`inflight_hi`，稳态期会把 `bw_lo` / `inflight_lo` 按 `(1-beta)` 砍一刀，STARTUP 阶段
则会提前退出。

跨境、卫星、长肥管道上的丢包有相当一部分是物理原因（FEC 残差、LEO 切换、微波雨衰），
不是拥塞。这类路径上 BBRv3 会被 2% 的天花板长期按住，跑不满物理带宽。

本补丁不调大常数，而是**学习**这条路径的「丢包下限」：只从看起来没有排队的采样里
估计 `lfn_floor`，然后容忍 `floor + 1%` 以内的丢包，超出的仍然走原生响应。

## 生效条件

`thresh` 之外还有四道闸门，任一不满足即回退原生行为（这是个重要的安全性质：

* 采样丢包率不得超过 `thresh`（**量级本身仍然是判据**）；
* `min_rtt` 新鲜（默认 15s 内刷新过）；
* `srtt - min_rtt <= max(min_rtt/20, 1ms)`，即没有可见排队；
* `tx_in_flight <= 1.15 x BDP`（STARTUP 阶段例外，那里本来就在 `2 x BDP` 上探）；
* 整轮无「探测中」/「有排队」/「超上限大丢包」标记。

`lfn_floor` 只在 PROBE_BW 的 CRUISE 轮里折叠一次，所以 STARTUP 和探测阶段不会污染估计。

## 参数

```
net.ipv4.tcp_bbr_lfn_loss_thresh_pct   0=关闭  1=自动(默认)  2..8=手动上限(%)
net.ipv4.tcp_bbr_lfn_min_rtt_fresh_ms  min_rtt 有效年龄，0=不校验（默认 15000）
```

自动模式的阈值是 `max(2%, floor + 1%)`，硬顶 8%；干净链路永远停在原生 2%。
模块参数 `lfn_loss_thresh_pct` / `lfn_min_rtt_fresh_ms` 作为各 netns 的初始值。

## 已知边界

* **自动模式不影响 STARTUP。** `lfn_floor` 只能从 PROBE_BW 采样学习，而 STARTUP 在
  连接最前面，此时 floor 必然是 0，阈值等于原生 2%。想让 STARTUP 也容忍丢包，
  必须手动设 `pct >= 2`。
* **学习是 per-socket 的。** 新连接从 0 开始学，短连接永远学不到，收益集中在长寿流。
* **识别不了 policer / AQM 丢包。** 令牌桶和 CoDel 类丢包不抬 RTT，能通过「无排队」
  闸门；浅缓冲瓶颈排队能靠上面的 srtt 判据挡住，但对无排队丢包只能依赖
  `1.15 x BDP` 屋顶和量级上限兜底。已知 8% 顶偏高，激进场景请手动调低。
* 路径 `min_rtt < 10ms` 时整个特性不生效（`BBR_LFN_MIN_PATH_RTT_US`），避免误伤
  局域网/数据中心。

## qdisc 建议

这套判据的效果高度依赖本地队列行为：

| qdisc | 结论 | 备注 |
|:---|:---|:---|
| `fq` | 最佳 | EDT 将积压压到 1–2 个 TSO 段，RTT 采样最干净 |
| `fq_codel` | 需调参 | 默认 `target 5ms` 对 LFN 过敏感，建议 `target 15ms interval 300ms` |
| `fq_pie` | 可用 | 比 CoDel 温和，建议 `target 20ms` |
| `cake` | **必须限速** | `bandwidth ... oceanic/satellite`；**不限速的 cake 会在软件 pacing 下产生突发毛刺，频繁踩中排队判据** |

OpenWrt 默认 `fq_codel`、SQM 常用 `cake`，两点都踩在上表的「需调参」区间，部署前请确认。

## 验证

```sh
# 是否真的注册上了（模块加载失败时这里不会有 bbr3）
cat /proc/sys/net/ipv4/tcp_available_congestion_control
cat /proc/sys/net/ipv4/tcp_congestion_control

# 参数是否可读可写（范围外写入应报 Invalid argument）
cat /proc/sys/net/ipv4/tcp_bbr_lfn_loss_thresh_pct
sysctl -w net.ipv4.tcp_bbr_lfn_loss_thresh_pct=3
```

复现用 netem（注意 modem/网卡队列会吃掉一部分丢包，最好在中间设备上做）：

```sh
tc qdisc add dev eth0 root netem delay 100ms loss 3%
iperf3 -c <peer> -t 60 -i 1
```

对照组建议跑 `pct=0` / `pct=1`（自动）/ `pct=5`，观察吞吐、重传率与 `inflight_hi` 被回调的频率。
仅用 `loss` 复现的是随机丢包；要验证 policer 场景请用 `tbf` / `police`。
