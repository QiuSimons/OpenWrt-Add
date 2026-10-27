# Copyright (C) 2016 Openwrt.org
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-control-weburl
PKG_VERSION:=1.5
PKG_RELEASE:=20200923

LUCI_TITLE:=LuCI support for Weburl From Koolshare
LUCI_PKGARCH:=all
LUCI_DEPENDS:=+iptables-mod-filter +kmod-ipt-filter

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
