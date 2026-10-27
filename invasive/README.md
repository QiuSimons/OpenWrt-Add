# 侵入性组件 (Invasive)

本目录用于存放**无法作为标准独立 Package 编译，必须打补丁修改 OpenWrt 源码或 Linux 内核自身（Target Kernel Patch）** 才能运行的侵入性组件。

例如：
- `shortcut-fe`：需要 OpenWrt 内核包含 fast-classifier / sfe hook 支持。
- `fullconenat-nft`：依赖 Lean/LEDE 对内核 netfilter 源码打全锥形 NAT 补丁，通用标准 SDK 无法直接运行。

如果不打补丁直接编译，此类包将无法工作或导致固件构建失败。
普通独立驱动与应用请移步 `apps/`。
