#
# Copyright (C) 2015-2026 OpenWrt.org
#
# This is free software, licensed under the GNU General Public License v3.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=airconnect
PKG_VERSION:=1.12.4
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/philippe44/AirConnect.git
PKG_SOURCE_VERSION:=1.12.4
PKG_SOURCE_SUBDIR:=$(PKG_NAME)-$(PKG_VERSION)
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION)-$(PKG_SOURCE_VERSION).tar.xz
PKG_MIRROR_HASH = $(if $(wildcard $(DL_DIR)/$(PKG_SOURCE)),$(shell $(MKHASH) sha256 $(DL_DIR)/$(PKG_SOURCE) 2>/dev/null || sha256sum $(DL_DIR)/$(PKG_SOURCE) 2>/dev/null | cut -d" " -f1),skip)
PKG_SOURCE_SUBMODULES:=common/crosstools common/dmap-parser common/libmdns common/libraop common/libpupnp common/libcodecs aircast/nanopb

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

PKG_LICENSE:=MIT
PKG_LICENSE_FILE:=LICENSE
PKG_MAINTAINER:=OpenWrt

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk

define Package/$(PKG_NAME)
  SECTION:=multimedia
  CATEGORY:=Multimedia
  TITLE:=AirConnect (AirPlay to UPnP/Sonos & Chromecast)
  URL:=https://github.com/philippe44/AirConnect
  DEPENDS:=+libupnp +libflac +shine +libopenssl +jansson +libpthread +libstdcpp
endef

define Package/$(PKG_NAME)/description
  Use AirPlay to stream to UPnP/Sonos & Chromecast devices (musl native build).
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/airconnect
endef

define Build/Prepare
	$(call Build/Prepare/Default)
	$(CP) ./files/CMakeLists.txt $(PKG_BUILD_DIR)/CMakeLists.txt
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/etc/config $(1)/etc/init.d
	$(INSTALL_BIN) ./files/airconnect.init $(1)/etc/init.d/airconnect
	$(INSTALL_CONF) ./files/airconnect.config $(1)/etc/config/airconnect
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/bin/aircast $(1)/usr/bin/aircast
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/bin/airupnp $(1)/usr/bin/airupnp
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
