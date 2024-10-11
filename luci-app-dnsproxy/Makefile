include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-dnsproxy
PKG_VERSION:=1.2
PKG_RELEASE:=2

LUCI_TITLE:=LuCI Support for dnsproxy
LUCI_PKGARCH:=all
LUCI_DEPENDS:=+dnsproxy

define Package/$(PKG_NAME)/conffiles
/etc/config/dnsproxy
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
