# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2023 ImmortalWrt.org

include $(TOPDIR)/rules.mk

PKG_NAME:=dae
PKG_VERSION:=2025.11.28
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_PROTO:=git
PKG_SOURCE_VERSION:=3942dff88573f36d564ee48db3ea5a7b9e43ea7e
PKG_SOURCE_URL:=https://github.com/LostAttractor/dae.git
PKG_MIRROR_HASH:=skip

PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILE:=LICENSE
PKG_MAINTAINER:=Tianling Shen <cnsztl@immortalwrt.org>

PKG_BUILD_DEPENDS:=golang/host bpf-headers
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

GO_PKG:=github.com/daeuniverse/dae
GO_PKG_EXCLUDES:=control/kern/tests
GO_PKG_LDFLAGS_X:= \
	$(GO_PKG)/cmd.Version=$(PKG_VERSION) \
	$(GO_PKG)/common/consts.MaxMatchSetLen_=1024
GO_PKG_TAGS:=trace

PGO_PROFILE:=$(CURDIR)/pprof/default.pgo

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/bpf.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

GO_PKG_TARGET_VARS+= \
	CGO_LDFLAGS="$(TARGET_LDFLAGS) -static" \
	GOEXPERIMENT=greenteagc

GO_PKG_DEFAULT_LDFLAGS:=-w -s -linkmode external -extldflags '-static'

define Package/dae
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=A lightweight and high-performance transparent proxy solution
  DEPENDS:=$(GO_ARCH_DEPENDS) $(BPF_DEPENDS) \
    +ca-bundle +kmod-sched-core +kmod-sched-bpf +kmod-xdp-sockets-diag \
    +kmod-veth +v2ray-geoip +v2ray-geosite
endef

define Package/dae/conffiles
/etc/dae/
/etc/config/dae
endef

DAE_CFLAGS:= \
	-O2 -Wall -Werror \
	-DMAX_MATCH_SET_LEN=1024 \
	-I$(BPF_HEADERS_DIR)/tools/lib \
	-I$(BPF_HEADERS_DIR)/arch/$(BPF_KARCH)/include/asm/mach-generic
	
define Build/Prepare
	$(call Build/Prepare/Default)
	[ -f "$(PGO_PROFILE)" ] && $(CP) "$(PGO_PROFILE)" "$(PKG_BUILD_DIR)/default.pgo" || true
endef

define Build/Compile
	( \
		pushd $(PKG_BUILD_DIR) ; \
		wget -qO - https://github.com/QiuSimons/dae/commit/f6b4438.patch | patch -p1 -N || true ; \
		wget -qO - https://github.com/QiuSimons/dae/commit/b689ffe.patch | patch -p1 -N || true ; \
		go mod edit -replace="github.com/daeuniverse/outbound=github.com/lostattractor/outbound@next" ; \
		go get -u=patch ; \
		go get github.com/cilium/ebpf@latest ; \
		go mod tidy ; \
		popd ; \
		export \
		$(GO_GENERAL_BUILD_CONFIG_VARS) \
		$(GO_PKG_BUILD_CONFIG_VARS) \
		$(GO_PKG_BUILD_VARS) \
		BPF_CLANG="$(CLANG)" \
		BPF_STRIP_FLAG="-strip=$(LLVM_STRIP)" \
		BPF_CFLAGS="$(DAE_CFLAGS)" \
		BPF_TARGET="bpfel,bpfeb" \
		BPF_TRACE_TARGET="$(GO_ARCH)" ; \
		go generate $(PKG_BUILD_DIR)/control/control.go ; \
		go generate $(PKG_BUILD_DIR)/trace/trace.go ; \
		$(call GoPackage/Build/Compile) ; \
	)
endef

define Package/dae/install
	$(call GoPackage/Package/Install/Bin,$(1))
	$(INSTALL_DIR) $(1)/etc/dae/
	$(INSTALL_CONF) $(PKG_BUILD_DIR)/example.dae $(1)/etc/dae/
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(CURDIR)/files/dae.config $(1)/etc/config/dae
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(CURDIR)/files/dae.init $(1)/etc/init.d/dae
endef

$(eval $(call GoBinPackage,dae))
$(eval $(call BuildPackage,dae))
