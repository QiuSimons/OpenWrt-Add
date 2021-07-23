# Copyright (C) 2018-2019 Lienol
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-dnsproxy
PKG_VERSION:=1.2
PKG_RELEASE:=1

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-dnsproxy
	SECTION:=luci
	CATEGORY:=LuCI
	SUBMENU:=3. Applications
	TITLE:=LuCI Support for dnsproxy
	PKGARCH:=all
	DEPENDS:= \
		+dnsproxy
endef

define Package/luci-app-dnsproxy/description
	LuCI Support for dnsproxy
endef

define Build/Prepare
endef

define Build/Compile
endef

define Package/luci-app-dnsproxy/conffiles
/etc/config/DNSProxy
endef

define Package/luci-app-dnsproxy/install
    $(INSTALL_DIR) $(1)/usr/lib/lua/luci
	cp -pR ./luasrc/* $(1)/usr/lib/lua/luci
	$(INSTALL_DIR) $(1)/
	cp -pR ./root/* $(1)/
	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	po2lmo ./po/zh_Hans/dnsproxy.po $(1)/usr/lib/lua/luci/i18n/dnsproxy.zh-cn.lmo
endef

define Package/luci-app-dnsproxy/postinst
#!/bin/sh
	/etc/init.d/DNSProxy enable >/dev/null 2>&1
	enable=$(uci get DNSProxy.DNSProxy.enabled 2>/dev/null)
	if [ "$enable" == "1" ]; then
		/etc/init.d/DNSProxy reload
	fi
	rm -f /tmp/luci-indexcache
	rm -f /tmp/luci-modulecache/*
exit 0
endef

define Package/luci-app-dnsproxy/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
     /etc/init.d/DNSProxy disable
     /etc/init.d/DNSProxy stop
uci -q batch <<-EOF >/dev/null 2>&1
	delete ucitrack.@DNSProxy[-1]
	commit ucitrack
EOF
fi
exit 0
endef

$(eval $(call BuildPackage,luci-app-dnsproxy))
