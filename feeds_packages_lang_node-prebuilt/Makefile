#
# Copyright (C) 2006-2017 OpenWrt.org
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=node
PKG_BASE:=packages-24.10
PKG_VERSION:=$(shell curl -s https://downloads.openwrt.org/releases/$(PKG_BASE)/aarch64_generic/packages/Packages | grep -oP '(?<=Filename: node_)\d+\.\d+\.\d+-r\d+')
PKG_BUILD_VERSION:=$(shell curl -s https://downloads.openwrt.org/releases/$(PKG_BASE)/$(ARCH_PACKAGES)/packages/Packages | grep -oP '(?<=Filename: node_)\d+\.\d+\.\d+-r\d+')
PKG_MAJOR_VERSION:=v$(shell echo $(PKG_BUILD_VERSION) | sed 's/-.*//')

PKG_MAINTAINER:=Hirokazu MORIKAWA <morikw2@gmail.com>, Adrian Panella <ianchi74@outlook.com>
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_CPE_ID:=cpe:/a:nodejs:node.js

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_BUILD_VERSION)

include $(INCLUDE_DIR)/host-build.mk
include $(INCLUDE_DIR)/package.mk

define Package/node
  SECTION:=lang
  CATEGORY:=Languages
  SUBMENU:=Node.js
  TITLE:=Node.js is a platform built on Chrome's JavaScript runtime
  URL:=https://nodejs.org/
  DEPENDS:=@USE_MUSL @HAS_FPU @(i386||x86_64||arm||aarch64||mipsel) \
	   +libstdcpp +libopenssl +zlib +libnghttp2 +libuv \
	   +libcares +libatomic +NODEJS_ICU_SYSTEM:icu +NODEJS_ICU_SYSTEM:icu-full-data
endef

define Package/node/description
  Node.js® is a JavaScript runtime built on Chrome's V8 JavaScript engine. Node.js uses
  an event-driven, non-blocking I/O model that makes it lightweight and efficient. Node.js'
   package ecosystem, npm, is the largest ecosystem of open source libraries in the world.

  *** The following preparations must be made on the host side. ***
      1. gcc 10.1 or higher is required.
      2. To build a 32-bit target, gcc-multilib, g++-multilib are required.
      3. Requires libatomic package. (If necessary, install the 32-bit library at the same time.)
     ex) sudo apt-get install gcc-multilib g++-multilib
endef

define Package/node-npm
  SECTION:=lang
  CATEGORY:=Languages
  SUBMENU:=Node.js
  TITLE:=NPM stands for Node Package Manager
  URL:=https://www.npmjs.com/
  DEPENDS:=+node
endef

define Package/node-npm/description
	NPM is the package manager for NodeJS
endef

ifeq ($(HOST_ARCH),x86_64)
	NODE_ARCH:=x64
endif

ifeq ($(HOST_ARCH),aarch64)
	NODE_ARCH:=arm64
endif

define Host/Compile
	( \
		pushd $(HOST_BUILD_DIR) ; \
		$(RM) node-v* ; \
		wget https://nodejs.org/dist/$(PKG_MAJOR_VERSION)/node-$(PKG_MAJOR_VERSION)-linux-$(NODE_ARCH).tar.xz ; \
		$(TAR) -xf node-$(PKG_MAJOR_VERSION)-linux-$(NODE_ARCH).tar.xz ; \
		popd ; \
	)
endef

define Build/Compile
	( \
		echo $(ARCH_PACKAGES) ; \
		pushd $(PKG_BUILD_DIR) ; \
		wget https://downloads.openwrt.org/releases/$(PKG_BASE)/$(ARCH_PACKAGES)/packages/node_$(PKG_BUILD_VERSION)_$(ARCH_PACKAGES).ipk ; \
		$(TAR) -zxf node_$(PKG_BUILD_VERSION)_$(ARCH_PACKAGES).ipk ; \
		$(TAR) -zxf data.tar.gz ; \
		rm -f data.tar.gz control.tar.gz debian-binary ; \
		wget https://downloads.openwrt.org/releases/$(PKG_BASE)/$(ARCH_PACKAGES)/packages/node-npm_$(PKG_BUILD_VERSION)_$(ARCH_PACKAGES).ipk ; \
		$(TAR) -zxf node-npm_$(PKG_BUILD_VERSION)_$(ARCH_PACKAGES).ipk ; \
		$(TAR) -zxf data.tar.gz ; \
		rm -f data.tar.gz control.tar.gz debian-binary ; \
		popd ; \
	)
endef

define Package/node/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/usr/bin/node $(1)/usr/bin/
endef

define Package/node-npm/install
	$(INSTALL_DIR) $(1)/usr/lib/node_modules/npm
	$(CP) $(PKG_BUILD_DIR)/usr/lib/node_modules/npm/{package.json,LICENSE} \
		$(1)/usr/lib/node_modules/npm/
	$(CP) $(PKG_BUILD_DIR)/usr/lib/node_modules/npm/README.md \
		$(1)/usr/lib/node_modules/npm/
	$(CP) $(PKG_BUILD_DIR)/usr/lib/node_modules/npm/{node_modules,bin,lib} \
		$(1)/usr/lib/node_modules/npm/
	$(INSTALL_DIR) $(1)/usr/bin
	$(LN) ../lib/node_modules/npm/bin/npm-cli.js $(1)/usr/bin/npm
	$(LN) ../lib/node_modules/npm/bin/npx-cli.js $(1)/usr/bin/npx
endef

define Host/Install
	$(CP) $(HOST_BUILD_DIR)/node-$(PKG_MAJOR_VERSION)-linux-$(NODE_ARCH)/* $(STAGING_DIR_HOST)/
endef

$(eval $(call HostBuild))
$(eval $(call BuildPackage,node))
$(eval $(call BuildPackage,node-npm))
