# luci-app-graphite

[English](README.md) · [简体中文](README.zh-CN.md)

[luci-theme-graphite](https://github.com/Zakkaus/luci-theme-graphite) 的设置页。
它写入 `/etc/config/graphite`，主题读这个文件，除此之外不需要别的，
所以这个包是可选的。安装之后，改配色与强调色不必再通过 ssh 编辑配置文件。

<img src="docs/screenshots/zh-CN/appearance-light.png" width="820">

它在 **系统 → 外观** 下加一页，共六项：

| 选项 | 作用 |
|---|---|
| 配色 | 界面用六套配色中的哪一套 |
| 强调色 | 主按钮、焦点环、活动徽标与品牌方块的颜色。八个名字之一，留空即不启用 |
| 自定义强调色 | 六位十六进制色号，在任何配色下都优先于上一项 |
| 品牌名 | 标记旁边显示主题名还是设备主机名 |
| 灰阶偏色色相 | 把灰阶往某个色相偏，单位为度 |
| 灰阶偏色强度 | 偏多少，从中性到明显带色 |

强调色的八个名字在每套配色下由该配色自己的取值回答：Catppuccin 取自各 flavour
自己的强调色表，Tokyo Night 取自上游的调色板，Graphite 取自一组为纯灰界面调过
的值。因此换配色不会得到一个不属于那一套的颜色。

灰阶偏色那两项之所以存在，是因为一套配色决定的是**状态色**的色相，
而不是界面其余部分所用的灰阶的色相。它们让一台设备一眼可辨，
同时保住其余一切所依赖的中性底色。

## 安装

`.apk` 包和安装脚本随主题一同发布，见主题的说明。
从源码构建需要与主题相同的 feed 目录结构 —— Makefile 按真实路径解析 `luci.mk`。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
