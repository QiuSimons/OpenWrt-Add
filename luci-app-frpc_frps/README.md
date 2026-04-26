Only Simplified Chinese.
仅中文简体，主要是懒~

用的 lua API，兼容旧版系统

含 ipk 安装包 和 apk 安装包。到 Release 页面下载。

注意：不包含二进制可执行文件，可到下面链接下载：
https://github.com/fatedier/frp/releases
按架构下载，解压即获得二进制文件，传到设备某个目录，在 luci 界面指定这个路径即可。

toml 配置文件格式，必须frp版本不低于v0.52.0

对于apk包跳过证书安装命令
apk add --allow-untrusted luci-app-frpc.apk

![image](https://github.com/superzjg/luci-app-frpc_frps/blob/main/luci_frp.jpeg)
