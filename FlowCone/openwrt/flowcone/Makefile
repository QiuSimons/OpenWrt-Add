# SPDX-License-Identifier: GPL-3.0-or-later
#
# Copyright (C) 2026 QiuSimons <https://github.com/QiuSimons>

include $(TOPDIR)/rules.mk

PKG_NAME:=flowcone
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/QiuSimons/FlowCone.git
PKG_SOURCE_VERSION:=master
PKG_MIRROR_HASH = $(if $(wildcard $(DL_DIR)/$(PKG_SOURCE)),$(shell $(MKHASH) sha256 $(DL_DIR)/$(PKG_SOURCE) 2>/dev/null || sha256sum $(DL_DIR)/$(PKG_SOURCE) 2>/dev/null | cut -d" " -f1),skip)

PKG_LICENSE:=GPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=QiuSimons <45143996+QiuSimons@users.noreply.github.com>

PKG_BUILD_DEPENDS:=rust/host
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk

FLOWCONE_RUST_ARCH_DEPENDS:=@(aarch64||arm||i386||i686||riscv64||x86_64)

define Package/flowcone
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Routing and Redirection
  TITLE:=RFC 4787 Full-Cone NAT using eBPF and TCX
  URL:=https://github.com/QiuSimons/FlowCone
  DEPENDS:=$(FLOWCONE_RUST_ARCH_DEPENDS) \
    +nftables +kmod-sched-core +kmod-sched-bpf +vmlinux-btf
endef

define Package/flowcone/description
  Dual-stack RFC 4787 Full-Cone NAT for OpenWrt using eBPF and TCX.
endef

define Package/flowcone/conffiles
/etc/config/flowcone
endef

MAKE_PATH:=crates/flowcone-daemon

# Don't ignore Cargo.lock
ifeq ($(shell grep -o 'RUST_PKG_LOCKED' $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk 2>/dev/null),)
	Build/Compile:=$(call Build/Compile/Cargo,crates/flowcone-daemon,--locked)
endif

define Package/flowcone/install
	$(INSTALL_DIR) $(1)/usr/bin/
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/bin/flowcone $(1)/usr/bin/

	$(INSTALL_DIR) $(1)/etc/config/
	$(INSTALL_CONF) $(CURDIR)/files/flowcone.config $(1)/etc/config/flowcone

	$(INSTALL_DIR) $(1)/etc/init.d/
	$(INSTALL_BIN) $(CURDIR)/files/flowcone.init $(1)/etc/init.d/flowcone
endef

define Package/flowcone/postrm
#!/bin/sh
rm -f /usr/share/nftables.d/chain-pre/srcnat/10-flowcone.nft
rm -f /usr/share/nftables.d/chain-pre/forward/10-flowcone.nft
rm -f /etc/nftables.d/flowcone.nft
exit 0
endef

$(eval $(call RustBinPackage,flowcone))
$(eval $(call BuildPackage,flowcone))
