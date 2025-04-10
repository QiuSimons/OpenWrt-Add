# SPDX-License-Identifier: GPL-3.0-only
#
# Copyright (C) 2021 ImmortalWrt.org

include $(TOPDIR)/rules.mk

PKG_NAME:=redsocks2
PKG_VERSION:=0.71
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/semigodking/redsocks.git
PKG_SOURCE_DATE:=2024-12-05
PKG_SOURCE_VERSION:=5d2db3e15543854da30e88af40748dfe63af2c28
PKG_MIRROR_HASH:=5fb0a360c6411b34012dc013d4166dcaa7da933da6bc3e61f4fafd8c0eea581f

PKG_MAINTAINER:=semigodking <semigodking@gmail.com>
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILE:=LICENSE

PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define Package/redsocks2
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Redirect TCP connection to proxy server
  URL:=https://github.com/semigodking/redsocks
  DEPENDS:=+libevent2 +libopenssl
endef

define Package/redsocks2/description
  This is a modified version of original redsocks.
  Transparent redirector of any TCP/UDP connection to proxy.
endef

MAKE_VARS += DISABLE_SHADOWSOCKS=true

define Package/redsocks2/install
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/redsocks2 $(1)/usr/sbin
	$(INSTALL_DIR) $(1)/etc/redsocks2
	$(INSTALL_DATA) ./files/redsocks2.template $(1)/etc/redsocks2/config.template
endef

$(eval $(call BuildPackage,redsocks2))
