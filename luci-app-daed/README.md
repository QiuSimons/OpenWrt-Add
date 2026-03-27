<h1 align="center">luci-app-daed</h1>
<p align="center">
  <img width="100" src="https://github.com/daeuniverse/dae/blob/main/logo.png?raw=true" />
</p>
<p align="center">
  <b>一个基于 eBPF 的高性能透明代理解决方案。</b>
</p>

---

## 快速入门

### 1. 环境准备 (编译主机)

在编译之前，请确保您的编译主机已安装必要的开发工具。参考 [apt.llvm.org](https://apt.llvm.org/) 安装最新版本的 Clang 和 LLVM。

```bash
apt-get update
apt-get install -y clang llvm npm
npm install -g pnpm
```

### 2. 获取源码

进入您的 OpenWrt 目录，克隆本仓库到 `package` 目录：

```bash
git clone https://github.com/QiuSimons/luci-app-daed package/dae
```

### 3. 内核配置要求 (DAE 运行前提)

DAE 依赖 eBPF 和 BTF。请在 `.config` 中添加以下内核配置以启用相关支持：

```makefile
CONFIG_DEVEL=y
CONFIG_KERNEL_DEBUG_INFO=y
CONFIG_KERNEL_DEBUG_INFO_REDUCED=n
CONFIG_KERNEL_DEBUG_INFO_BTF=y
CONFIG_KERNEL_CGROUPS=y
CONFIG_KERNEL_CGROUP_BPF=y
CONFIG_KERNEL_BPF_EVENTS=y
CONFIG_BPF_TOOLCHAIN_HOST=y
CONFIG_KERNEL_XDP_SOCKETS=y
CONFIG_PACKAGE_kmod-xdp-sockets-diag=y
```

### 4. 编译与安装

```bash
make menuconfig # 路径: LUCI -> Applications -> luci-app-daed
make package/dae/luci-app-daed/compile V=s
```

---

## 核心概念：BTF 与 CO-RE

### BTF 来源选择

在 `make menuconfig` 中，您可以根据内核支持情况选择 BTF 来源：

- **Use kernel BTF (integrated)**: **[推荐]** 要求内核开启 `CONFIG_KERNEL_DEBUG_INFO_BTF=y`。
- **Use vmlinux-btf package**: 如果内核不支持原生 BTF，可选择此项以使用外部 [vmlinux-btf](https://github.com/QiuSimons/vmlinux-btf) 软件包。

### vmlinux-btf 依赖说明

由于预编译安装包无法自动探测内核是否支持 BTF，为了确保稳定性，程序默认依赖 `vmlinux-btf`。

- **方案 A：手动补全依赖 (推荐)**
  如果软件源缺失该包，请前往 [opkg.cooluc.com](https://opkg.cooluc.com/) 下载。
  - **建议**: 优先选择与内核版本号 (`x.y.z`) 完全一致的包；至少保证主次版本号 (`x.y`) 一致。
- **方案 B：忽略依赖 (高级用户)**
  如果您确认内核已原生支持 BTF (`CONFIG_KERNEL_DEBUG_INFO_BTF=y`)，可在安装时使用 `--force-depends` 参数忽略依赖检查。

---

## 预览

<p align="center">
<img width="800" src="https://github.com/QiuSimons/luci-app-daed/blob/master/PIC/1.jpg?raw=true" />
<img width="800" src="https://github.com/QiuSimons/luci-app-daed/blob/master/PIC/2.jpg?raw=true" />
</p>
