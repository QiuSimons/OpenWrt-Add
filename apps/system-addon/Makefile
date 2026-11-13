#
# Copyright (C) 2016-2026 GitHub 
#
# This is free software, licensed under the GNU General Public License v3.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=system-addon
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPLv3
PKG_LICENSE_FILES:=LICENSE

PKG_BUILD_DIR := $(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/system-addon
  SECTION:=luci
  CATEGORY:=LuCI
  TITLE:=Custom settings and system tuning addon
  PKGARCH:=all
  DEPENDS:=+luci-base +openssl-util +@LUCI_LANG_zh_Hans +ethtool
endef

define Package/system-addon/description
  System customization and performance tuning addon for OpenWrt.
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/system-addon/install
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/zzz-default-settings $(1)/etc/uci-defaults/99-default-settings

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/sys-tuning $(1)/etc/init.d/sys-tuning

	$(INSTALL_DIR) $(1)/etc/hotplug.d/net
	$(INSTALL_BIN) ./files/01-maximize_nic_rx_tx_buffers $(1)/etc/hotplug.d/net/01-maximize_nic_rx_tx_buffers

	$(INSTALL_DIR) $(1)/etc/hotplug.d/block
	$(INSTALL_BIN) ./files/01-zram-tuning $(1)/etc/hotplug.d/block/01-zram-tuning

	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	po2lmo ./i18n/default.zh_Hans.po $(1)/usr/lib/lua/luci/i18n/default.zh-cn.lmo
endef

define Package/system-addon/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/sys-tuning enable
exit 0
endef

define Package/system-addon/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/sys-tuning disable
exit 0
endef

$(eval $(call BuildPackage,system-addon))
