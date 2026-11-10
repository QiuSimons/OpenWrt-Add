# SPDX-License-Identifier: GPL-3.0-or-later
#
# Copyright (C) 2026 QiuSimons <https://github.com/QiuSimons>

include $(TOPDIR)/rules.mk

PKG_NAME:=flowcone
PKG_VERSION:=0.1.2
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/QiuSimons/FlowCone.git
PKG_SOURCE_VERSION:=master
PKG_MIRROR_HASH:=skip

PKG_SOURCE_SUBDIR:=$(PKG_NAME)-$(PKG_VERSION)
PKG_SOURCE:=$(PKG_SOURCE_SUBDIR)-$(PKG_SOURCE_VERSION).tar.gz
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_SOURCE_SUBDIR)

PKG_LICENSE:=GPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=QiuSimons <45143996+QiuSimons@users.noreply.github.com>

PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

include $(INCLUDE_DIR)/package.mk

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

ifeq ($(ARCH),aarch64)
  RUST_TARGET:=aarch64-unknown-linux-musl
else ifeq ($(ARCH),x86_64)
  RUST_TARGET:=x86_64-unknown-linux-musl
else ifeq ($(ARCH),arm)
  RUST_TARGET:=armv7-unknown-linux-musleabihf
else ifeq ($(ARCH),riscv64)
  RUST_TARGET:=riscv64gc-unknown-linux-musl
else ifeq ($(ARCH),i386)
  RUST_TARGET:=i686-unknown-linux-musl
else ifeq ($(ARCH),i686)
  RUST_TARGET:=i686-unknown-linux-musl
else
  RUST_TARGET:=$(ARCH)-unknown-linux-musl
endif

RUST_TARGET_UPPER:=$(shell echo $(RUST_TARGET) | tr 'a-z-' 'A-Z_')

# 探测本地源码树，空则走 OpenWrt 标准 git fetch。
FLOWCONE_LOCAL_DIR := $(strip \
  $(if $(FLOWCONE_SRC_DIR),\
    $(FLOWCONE_SRC_DIR),\
    $(if $(wildcard $(CURDIR)/crates/flowcone-daemon/Cargo.toml),\
      $(CURDIR),\
      $(if $(wildcard $(CURDIR)/../../crates/flowcone-daemon/Cargo.toml),\
        $(CURDIR)/../..,\
        $(if $(wildcard $(TOPDIR)/../../FlowCone/crates/flowcone-daemon/Cargo.toml),\
          $(TOPDIR)/../../FlowCone,\
        )\
      )\
    )\
  )\
)

ifneq ($(FLOWCONE_LOCAL_DIR),)
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	if [ -f $(CURDIR)/files/flowcone.bin ]; then \
		echo "Prebuilt flowcone.bin detected in files/, skipping source unpack."; \
	else \
		echo "Using local source tree at $(FLOWCONE_LOCAL_DIR)..."; \
		$(CP) $(FLOWCONE_LOCAL_DIR)/Cargo.toml $(PKG_BUILD_DIR)/; \
		$(CP) $(FLOWCONE_LOCAL_DIR)/Cargo.lock $(PKG_BUILD_DIR)/; \
		$(CP) $(FLOWCONE_LOCAL_DIR)/crates $(PKG_BUILD_DIR)/; \
		$(CP) $(FLOWCONE_LOCAL_DIR)/LICENSE $(PKG_BUILD_DIR)/ 2>/dev/null || true; \
	fi
endef
endif

define Build/Compile
	if [ -f $(CURDIR)/files/flowcone.bin ]; then \
		echo "Using prebuilt flowcone.bin, skipping compilation."; \
	else \
		export PATH="$(HOME)/.cargo/bin:$(PATH)"; \
		export STAGING_DIR="$(STAGING_DIR)"; \
		command -v cargo >/dev/null 2>&1 || { \
			echo "ERROR: host cargo not found! Please install Rust (>= 1.98.0) via https://rustup.rs" >&2; \
			exit 1; \
		}; \
		if command -v rustup >/dev/null 2>&1; then \
			rustup target add $(RUST_TARGET) 2>/dev/null || true; \
		fi; \
		export CARGO_TARGET_$(RUST_TARGET_UPPER)_LINKER="$(TARGET_CC)"; \
		export CC_$(RUST_TARGET_UPPER)="$(TARGET_CC)"; \
		export CXX_$(RUST_TARGET_UPPER)="$(TARGET_CXX)"; \
		export AR_$(RUST_TARGET_UPPER)="$(TARGET_AR)"; \
		export CFLAGS_$(RUST_TARGET_UPPER)="$(TARGET_CFLAGS)"; \
		export CARGO_BUILD_TARGET_DIR="$(PKG_BUILD_DIR)/target"; \
		cargo build --release --locked \
			-p flowcone-daemon \
			--manifest-path $(PKG_BUILD_DIR)/Cargo.toml \
			--target $(RUST_TARGET); \
	fi
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	if [ -f $(CURDIR)/files/flowcone.bin ]; then \
		$(INSTALL_BIN) $(CURDIR)/files/flowcone.bin $(PKG_INSTALL_DIR)/bin/flowcone; \
	elif [ -f $(PKG_BUILD_DIR)/target/$(RUST_TARGET)/release/flowcone ]; then \
		$(INSTALL_BIN) $(PKG_BUILD_DIR)/target/$(RUST_TARGET)/release/flowcone $(PKG_INSTALL_DIR)/bin/flowcone; \
	fi
endef

define Package/flowcone/install
	$(INSTALL_DIR) $(1)/usr/bin/
	if [ -f $(PKG_INSTALL_DIR)/bin/flowcone ]; then \
		$(INSTALL_BIN) $(PKG_INSTALL_DIR)/bin/flowcone $(1)/usr/bin/flowcone; \
	elif [ -f $(CURDIR)/files/flowcone.bin ]; then \
		$(INSTALL_BIN) $(CURDIR)/files/flowcone.bin $(1)/usr/bin/flowcone; \
	else \
		$(INSTALL_BIN) $(PKG_BUILD_DIR)/target/$(RUST_TARGET)/release/flowcone $(1)/usr/bin/flowcone; \
	fi

	$(INSTALL_DIR) $(1)/etc/config/
	$(INSTALL_CONF) $(CURDIR)/files/flowcone.config $(1)/etc/config/flowcone

	$(INSTALL_DIR) $(1)/etc/init.d/
	$(INSTALL_BIN) $(CURDIR)/files/flowcone.init $(1)/etc/init.d/flowcone
endef

define Package/flowcone/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /usr/share/nftables.d/chain-pre/srcnat/10-flowcone.nft
	rm -f /usr/share/nftables.d/chain-pre/forward/10-flowcone.nft
	rm -f /etc/nftables.d/flowcone.nft
}
exit 0
endef

$(eval $(call BuildPackage,flowcone))
