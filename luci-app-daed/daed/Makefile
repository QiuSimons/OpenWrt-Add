# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2023 ImmortalWrt.org

include $(TOPDIR)/rules.mk

PKG_NAME:=daed
PKG_VERSION:=2025.07.23
DAED_VERSION:=daed-c3588a9
WING_VERSION:=wing-6df3da2
CORE_VERSION:=core-358f459
WING_HASH_SHORT:=$(shell echo $(WING_VERSION) | cut -d- -f2)
CORE_HASH_SHORT:=$(shell echo $(CORE_VERSION) | cut -d- -f2)
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_PROTO:=git
PKG_SOURCE_VERSION:=c3588a904c932d1fc83ee51096761776003fc25c
PKG_SOURCE_URL:=https://github.com/daeuniverse/daed.git
PKG_MIRROR_HASH:=skip

PKG_LICENSE:=AGPL-3.0-only MIT
PKG_LICENSE_FILES:=LICENSE wing/LICENSE
PKG_MAINTAINER:=Tianling Shen <cnsztl@immortalwrt.org>

PKG_BUILD_DIR=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)/wing
PKG_BUILD_DEPENDS:=golang/host bpf-headers node/host
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

GO_PKG:=github.com/daeuniverse/dae-wing
GO_PKG_LDFLAGS:= \
	-s -w -X '$(GO_PKG)/db.AppDescription=$(PKG_NAME) is a integration solution of dae, API and UI.'
GO_PKG_LDFLAGS_X= \
	$(GO_PKG)/db.AppName=$(PKG_NAME) \
	$(GO_PKG)/db.AppVersion=$(DAED_VERSION)_$(WING_VERSION)_$(CORE_VERSION)
GO_PKG_TAGS:=embedallowed
GO_PKG_TARGET_VARS:=$(filter-out CGO_ENABLED=%,$(GO_PKG_TARGET_VARS)) \
	CGO_ENABLED=1 \
	GOEXPERIMENT=greenteagc

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/bpf.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

GO_PKG_DEFAULT_LDFLAGS:=-w -s -extldflags "-static"
TAR_CMD=$(HOST_TAR) -C $(BUILD_DIR)/ $(TAR_OPTIONS)

define Package/daed/Default
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  URL:=https://github.com/daeuniverse/daed
endef

define Package/daed
  $(call Package/daed/Default)
  TITLE:=A Modern Dashboard For dae
  # You need enable KERNEL_DEBUG_INFO_BTF and KERNEL_BPF_EVENTS
  DEPENDS:=$(GO_ARCH_DEPENDS) $(BPF_DEPENDS) \
    +ca-bundle +kmod-sched-core +kmod-sched-bpf +kmod-xdp-sockets-diag \
    +kmod-veth +v2ray-geoip +v2ray-geosite
endef

define Package/daed/description
  daed is a backend of dae, provides a method to bundle arbitrary
  frontend, dae and geodata into one binary.
endef

define Package/daed/conffiles
/etc/daed/wing.db
/etc/config/daed
endef

define Build/Prepare
	( \
		$(TAR) --strip-components=1 -C $(PKG_BUILD_DIR)/../ -xzf $(DL_DIR)/$(PKG_NAME)-$(PKG_VERSION).tar.gz ; \
		rm -rf $(PKG_BUILD_DIR) && git clone https://github.com/daeuniverse/dae-wing $(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)/wing && git -C $(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)/wing checkout $(WING_HASH_SHORT) ; \
		rm -rf $(PKG_BUILD_DIR)/dae-core && git clone https://github.com/daeuniverse/dae $(PKG_BUILD_DIR)/dae-core && git -C $(PKG_BUILD_DIR)/dae-core checkout $(CORE_HASH_SHORT) ; \
		pushd $(PKG_BUILD_DIR)/dae-core ; \
		git submodule update --init ; \
		wget -qO - https://github.com/daeuniverse/dae/pull/763.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/pull/839.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/commit/56fb759.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/commit/af2e2c6.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/commit/d96dc26.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/commit/6ff101c.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/commit/5740b94.patch | patch -p1 ; \
		wget -qO - https://github.com/daeuniverse/dae/commit/cec1642.patch | patch -p1 ; \
		sed -i 's/Warn("failed to write cached DNS resp")/Debug("failed to write cached DNS resp")/g' control/dns_control.go ; \
		sed -i 's/Warn("failed to send DNS response")/Debug("failed to send DNS response")/g' control/dns_control.go ; \
		sed -i 's/Warn("failed to send DNS reject response")/Debug("failed to send DNS reject response")/g' control/dns_control.go ; \
		go mod tidy ; \
		popd ; \
		pushd $(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)/wing ; \
		wget -qO - https://github.com/daeuniverse/dae-wing/commit/ca02961.patch | patch -p1 ; \
		go mod tidy ; \
		popd ; \
		pushd $(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION) ; \
		npm install -g pnpm ; \
		pnpm install ; \
		pnpm build ; \
		popd ; \
		mkdir -p $(PKG_BUILD_DIR)/webrender/web ; \
		cp -rf $(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)/dist/* $(PKG_BUILD_DIR)/webrender/web ; \
		find $(PKG_BUILD_DIR)/webrender/web -type f -size +4k ! -name "*.gz" ! -name "*.woff"  ! -name "*.woff2" -exec sh -c '\
			gzip -9 -k "{}"; \
			if [ "$$$$(stat -c %s {})" -lt "$$$$(stat -c %s {}.gz)" ]; then \
				rm {}.gz; \
			else \
				rm {}; \
			fi' \
		";" ; \
	)
endef

DAE_CFLAGS:= \
	-O2 -Wall -Werror \
	-DMAX_MATCH_SET_LEN=1024 \
	-D__UNROLL_ROUTE_LOOP \
	-I$(BPF_HEADERS_DIR)/tools/lib \
	-I$(BPF_HEADERS_DIR)/arch/$(BPF_KARCH)/include/asm/mach-generic

ifneq ($(CONFIG_USE_MUSL),)
  TARGET_CFLAGS += -D_LARGEFILE64_SOURCE
endif

define Build/Compile
	( \
		pushd $(PKG_BUILD_DIR) ; \
		$(MAKE) deps ; \
		$(GO_GENERAL_BUILD_CONFIG_VARS) \
		$(GO_PKG_BUILD_CONFIG_VARS) \
		$(GO_PKG_BUILD_VARS); \
		go generate ./... ; \
		cd dae-core ; \
		BPF_CLANG="$(CLANG)" \
		BPF_STRIP_FLAG="-strip=$(LLVM_STRIP)" \
		BPF_CFLAGS="$(DAE_CFLAGS)" \
		BPF_TARGET="bpfel,bpfeb" \
		go generate control/control.go ; \
		popd ; \
		$(call GoPackage/Build/Compile) ; \
	)
endef

define Package/daed/install
	$(call GoPackage/Package/Install/Bin,$(PKG_INSTALL_DIR))
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/dae-wing $(1)/usr/bin/daed

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(CURDIR)/files/daed.config $(1)/etc/config/daed

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(CURDIR)/files/daed.init $(1)/etc/init.d/daed
endef

$(eval $(call GoBinPackage,daed))
$(eval $(call BuildPackage,daed))
