include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-dnsproxy
PKG_VERSION:=1.1
PKG_RELEASE:=1

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-dnsproxy
	SECTION:=luci
	CATEGORY:=LuCI
	SUBMENU:=3. Applications
	TITLE:=LuCI Support for dnsproxy
	DEPENDS:=+dnsproxy
endef

define Package/luci-app-dnsproxy/description
	LuCI support for dnsproxy
endef

define Build/Prepare
endef

define Build/Compile
endef

define Package/luci-app-dnsproxy/install
	$(INSTALL_DIR) $(1)/usr/lib/lua/luci
	cp -pR ./luasrc/* $(1)/usr/lib/lua/luci
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/DNSProxy $(1)/etc/init.d/
	$(INSTALL_DIR) $(1)/etc/config
	cp -pR ./root/etc/config/* $(1)/etc/config/
	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	po2lmo ./po/zh-cn/dnsproxy.po $(1)/usr/lib/lua/luci/i18n/dnsproxy.zh-cn.lmo
endef

define Package/luci-app-dnsproxy/postinst
#!/bin/sh
	/etc/init.d/dnsproxy enable >/dev/null 2>&1
exit 0
endef

define Package/luci-app-dnsproxy/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
     /etc/init.d/DNSProxy disable
     /etc/init.d/DNSProxy stop
fi
exit 0
endef

$(eval $(call BuildPackage,luci-app-dnsproxy))
