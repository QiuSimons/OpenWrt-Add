include $(TOPDIR)/rules.mk

PKG_VERSION:=20251216
PKG_RELEASE:=8
PKG_NAME:=luci-app-frpc

# 高版本24.10.4的sdk会增加依赖luci-lua-runtime导致低版本系统装不上ipk，建议22.03.7
LUCI_TITLE:=LuCI support for Frpc
LUCI_DEPENDS:=+libc
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/frpc
endef

# 安装前脚本，若存在同名配置文件，本配置文件会被重命名但旧配置文件可能不兼容，导致luci界面首页空白。
define Package/$(PKG_NAME)/preinst
#!/bin/sh
if [ -f /etc/config/frpc ] ; then
  uci show frpc.main >/dev/null 2>&1 && exit 0
  echo "备份旧 uci 配置文件 /etc/config/frpc 到 /etc/config/frpc.old"
  /etc/init.d/frpc stop 2>/dev/null
  mv -f /etc/config/frpc /etc/config/frpc.old
fi
exit 0
endef

# 安装后脚本，可以配置权限等但不建议
# define Package/$(PKG_NAME)/postinst
# #!/bin/sh
# chmod 0755 /etc/init.d/frpc
# exit 0
# endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
