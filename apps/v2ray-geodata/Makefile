#
# Copyright (C) 2015-2016 OpenWrt.org
#
# This is free software, licensed under the GNU General Public License v3.
#
include $(TOPDIR)/rules.mk

PKG_NAME:=v2ray-geodata
PKG_VERSION:=$(shell date "+%Y%m%d%H%M%S")
PKG_RELEASE:=1
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=sbwml <admin@cooluc.com>

include $(INCLUDE_DIR)/package.mk

define Package/v2ray-geodata/default
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=IP Addresses and Names
  URL:=https://www.v2fly.org
  PKGARCH:=all
endef

define Package/v2ray-geoip
  $(call Package/v2ray-geodata/default)
  TITLE:=GeoIP List for V2Ray
  LICENSE:=CC-BY-SA-4.0
endef

define Package/v2ray-geosite
  $(call Package/v2ray-geodata/default)
  TITLE:=Geosite List for V2Ray
  LICENSE:=GPL-3.0
endef

GEOIP_URL:=https://github.com/QiuSimons/geoip-moedove/raw/refs/heads/main/geoip.dat
GEOSITE_URL:=https://github.com/MetaCubeX/meta-rules-dat/releases/latest/download/geosite.dat

CURL_OPTS:=--fail --location \
	--retry 10 \
	--retry-all-errors \
	--retry-delay 3 \
	--retry-max-time 180 \
	--connect-timeout 20 \
	--speed-time 30 \
	--speed-limit 1024 \
	--progress-bar

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
	( \
		set -e; \
		cd $(PKG_BUILD_DIR); \
		rm -f geoip.dat.1 geoip.dat.2 geosite.dat.1 geosite.dat.2; \
		for i in 1 2 3; do \
			if curl $(CURL_OPTS) "$(GEOIP_URL)" -o geoip.dat.1 && \
			   curl $(CURL_OPTS) "$(GEOIP_URL)" -o geoip.dat.2 && \
			   test -s geoip.dat.1 && \
			   cmp -s geoip.dat.1 geoip.dat.2; then \
				break; \
			fi; \
			echo "GeoIP download/verify failed, retrying in 5s..."; \
			rm -f geoip.dat.1 geoip.dat.2; \
			sleep 5; \
		done; \
		test -s geoip.dat.1; \
		cmp -s geoip.dat.1 geoip.dat.2; \
		mv -f geoip.dat.1 geoip.dat; \
		rm -f geoip.dat.2; \
		for i in 1 2 3; do \
			if curl $(CURL_OPTS) "$(GEOSITE_URL)" -o geosite.dat.1 && \
			   curl $(CURL_OPTS) "$(GEOSITE_URL)" -o geosite.dat.2 && \
			   test -s geosite.dat.1 && \
			   cmp -s geosite.dat.1 geosite.dat.2; then \
				break; \
			fi; \
			echo "Geosite download/verify failed, retrying in 5s..."; \
			rm -f geosite.dat.1 geosite.dat.2; \
			sleep 5; \
		done; \
		test -s geosite.dat.1; \
		cmp -s geosite.dat.1 geosite.dat.2; \
		mv -f geosite.dat.1 geosite.dat; \
		rm -f geosite.dat.2; \
	)
endef

define Package/v2ray-geoip/install
	$(INSTALL_DIR) $(1)/usr/share/v2ray
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/geoip.dat $(1)/usr/share/v2ray/geoip.dat
endef

define Package/v2ray-geosite/install
	$(INSTALL_DIR) $(1)/usr/share/v2ray
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/geosite.dat $(1)/usr/share/v2ray/geosite.dat
endef

$(eval $(call BuildPackage,v2ray-geoip))
$(eval $(call BuildPackage,v2ray-geosite))