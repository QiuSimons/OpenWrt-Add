# kmod-tcp-bbrplus (OpenWrt Package)

OpenWrt out-of-tree (OOT) kernel module package for **TCP BBRplus**.

## Features

- **Pristine upstream source**: Fetches and builds directly from git with zero local patches.
- **Dynamic API feature probing**: Uses lightweight POSIX shell header inspection at build time, eliminating kernel version guessing (`LINUX_VERSION_CODE`) while avoiding heavy runtime dependencies (e.g. Python).
- **Forward & Backward compatible**: Supports Linux 5.4 ~ 6.12+ (OpenWrt 21.02, 22.03, 23.05, 24.10, master/25.x).
- **apk3 & opkg compliant**: Follows SemVer versioning rules (`1.0.0-r1`), fully compatible with modern OpenWrt `apk-tools v3`.
- **Zero bloat**: Preserves OpenWrt default queueing disciplines (`fq_codel` / `cake`), sets `net.ipv4.tcp_congestion_control = bbrplus` automatically on install.

## How to Build

### Option 1: Direct copy into your OpenWrt build tree

```bash
cp -r openwrt-package/tcp-bbrplus <openwrt_dir>/package/
cd <openwrt_dir>
make menuconfig # Select: Kernel modules -> Network Support -> kmod-tcp-bbrplus
make package/tcp-bbrplus/compile V=s
```

### Option 2: Add as custom feed

Add to your `feeds.conf.default`:
```text
src-git bbrplus https://github.com/hrimfaxi/tcp_bbr_modules.git
```

## Installation & Verification

On modern OpenWrt (apk3):
```sh
apk add --allow-untrusted kmod-tcp-bbrplus-*.apk
```

On legacy OpenWrt (opkg):
```sh
opkg install kmod-tcp-bbrplus_*.ipk
```

Verify status:
```sh
sysctl net.ipv4.tcp_congestion_control
# Expected output: net.ipv4.tcp_congestion_control = bbrplus

cat /proc/sys/net/ipv4/tcp_available_congestion_control
# Shows bbrplus in available list
```

