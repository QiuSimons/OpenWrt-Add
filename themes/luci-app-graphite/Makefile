#
# Copyright (C) 2026 Zakk <zakk@gentoozh.org>
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Graphite theme appearance

# Both packages are called *-graphite, so luci.mk derived the same translation
# basename for each and they built two different luci-i18n-graphite-zh-cn
# packages installing two different files to graphite.zh-cn.lmo. Whichever
# landed second won, and the loser's strings silently reverted to English.
LUCI_BASENAME:=graphite-app
LUCI_DEPENDS:=+luci-base +luci-theme-graphite
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0

# The appearance page writes this file, so an upgrade must not overwrite what
# the administrator chose.
define Package/luci-app-graphite/conffiles
/etc/config/graphite
endef

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
