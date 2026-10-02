#
# Copyright (C) 2006-2017 OpenWrt.org
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=node
PKG_VERSION:=$(shell curl -s https://api.github.com/repos/sbwml/node_workflow/tags | grep '"name"' | head -n 1 | sed -E 's/.*"name": "v([^"]+)".*/\1/')
PKG_RELEASE:=1

PKG_MAINTAINER:=Hirokazu MORIKAWA <morikw2@gmail.com>, Adrian Panella <ianchi74@outlook.com>
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_CPE_ID:=cpe:/a:nodejs:node.js

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/host-build.mk
include $(INCLUDE_DIR)/package.mk

define Package/node
  SECTION:=lang
  CATEGORY:=Languages
  SUBMENU:=Node.js
  TITLE:=Node.js is a platform built on Chrome's JavaScript runtime
  URL:=https://nodejs.org/
  DEPENDS:=@USE_MUSL @HAS_FPU @(i386||x86_64||arm||aarch64) \
	   +libstdcpp +libopenssl +zlib +libnghttp2 \
	   +libcares +libatomic
endef

define Package/node/description
  Node.js® is a JavaScript runtime built on Chrome's V8 JavaScript engine. Node.js uses
  an event-driven, non-blocking I/O model that makes it lightweight and efficient. Node.js'
   package ecosystem, npm, is the largest ecosystem of open source libraries in the world.

  *** The following preparations must be made on the host side. ***
      1. gcc 12.2 or higher is required.
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
	NODE_HOST_ARCH:=x64
endif

ifeq ($(HOST_ARCH),aarch64)
	NODE_HOST_ARCH:=arm64
endif

define Host/Compile
	( \
		pushd $(HOST_BUILD_DIR) ; \
			$(RM) node-v* ; \
			wget https://nodejs.org/dist/v$(PKG_VERSION)/node-v$(PKG_VERSION)-linux-$(NODE_HOST_ARCH).tar.xz ; \
			$(TAR) -xf node-v$(PKG_VERSION)-linux-$(NODE_HOST_ARCH).tar.xz ; \
		popd ; \
	)
endef

define Build/Compile
	( \
		pushd $(PKG_BUILD_DIR) ; \
			wget https://github.com/sbwml/node_workflow/releases/download/v$(PKG_VERSION)/$(ARCH_PACKAGES).tar.gz ; \
			$(TAR) -zxf $(ARCH_PACKAGES).tar.gz ; \
			$(STAGING_DIR_HOST)/bin/apk extract --allow-untrusted *.apk ; \
			$(RM) *.tar.gz *.apk ; \
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
	$(CP) $(HOST_BUILD_DIR)/node-v$(PKG_VERSION)-linux-$(NODE_HOST_ARCH)/* $(STAGING_DIR_HOST)/
endef

$(eval $(call HostBuild))
$(eval $(call BuildPackage,node))
$(eval $(call BuildPackage,node-npm))
