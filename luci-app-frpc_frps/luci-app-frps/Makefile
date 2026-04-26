include $(TOPDIR)/rules.mk

PKG_VERSION:=20251216
PKG_RELEASE:=8
PKG_NAME:=luci-app-frps

# 高版本24.10.4的sdk会增加依赖luci-lua-runtime导致低版本系统装不上ipk，建议22.03.7
LUCI_TITLE:=LuCI support for Frps
LUCI_DEPENDS:=+libc
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/frps
endef

# 安装前脚本，若存在同名配置文件，本配置文件会被重命名但旧配置文件可能不兼容，导致luci界面首页空白
define Package/$(PKG_NAME)/preinst
#!/bin/sh
if [ -f /etc/config/frps ] ; then
  uci show frps.main >/dev/null 2>&1 && exit 0
  echo "备份旧 uci 配置文件 /etc/config/frps 到 /etc/config/frps.old"
  /etc/init.d/frps stop 2>/dev/null
  mv -f /etc/config/frps /etc/config/frps.old
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
