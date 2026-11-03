# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2026 QiuSimons <https://github.com/QiuSimons>

include $(TOPDIR)/rules.mk

PKG_NAME:=honk
PKG_VERSION:=2026.11.03~77176ff
PKG_RELEASE:=1

# 若 files/ 下无预编译二进制，才声明从 git 下载源码
ifeq ($(wildcard $(CURDIR)/files/honk-core.bin),)
PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/daeuniverse/honk.git
PKG_SOURCE_VERSION:=77176ff8e8cc2b75385a7030dc376536c382574a
PKG_MIRROR_HASH:=skip

PKG_SOURCE_SUBDIR:=$(PKG_NAME)-$(PKG_VERSION)
PKG_SOURCE:=$(PKG_SOURCE_SUBDIR)-$(PKG_SOURCE_VERSION).tar.gz
endif
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=QiuSimons <https://github.com/QiuSimons>

PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

# 本地源码开发树探测：指定 HONK_SRC_DIR，或位于 honk 源码树内/同级
HONK_LOCAL_DIR := $(strip \
  $(if $(HONK_SRC_DIR),\
    $(HONK_SRC_DIR),\
    $(if $(wildcard $(CURDIR)/crates/honk-core/Cargo.toml),\
      $(CURDIR),\
      $(if $(wildcard $(CURDIR)/../../crates/honk-core/Cargo.toml),\
        $(CURDIR)/../..,\
        $(if $(wildcard $(TOPDIR)/../../honk/crates/honk-core/Cargo.toml),\
          $(TOPDIR)/../../honk,\
        )\
      )\
    )\
  )\
)

include $(INCLUDE_DIR)/package.mk

HONK_RUST_ARCH_DEPENDS:=@(aarch64||x86_64)

define Package/honk
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=honk - eBPF transparent proxy engine (dae-compatible)
  URL:=https://github.com/daeuniverse/honk
  DEPENDS:=$(HONK_RUST_ARCH_DEPENDS) \
    +ca-bundle +ip-full \
    +kmod-sched-core +kmod-sched-bpf +kmod-veth +kmod-nft-queue \
    +v2ray-geoip +v2ray-geosite \
    +@KERNEL_XDP_SOCKETS \
    +HONK_USE_VMLINUX_BTF:vmlinux-btf
endef

define Package/honk/config
	choice
		prompt "BTF source for CO-RE"
		default HONK_USE_KERNEL_BTF
		depends on PACKAGE_honk

	config HONK_USE_KERNEL_BTF
		bool "Use kernel BTF (integrated)"
		depends on KERNEL_DEBUG_INFO_BTF

	config HONK_USE_VMLINUX_BTF
		bool "Use vmlinux-btf package"
	endchoice
endef

define Package/honk/conffiles
/etc/honk/config.dae
/etc/honk/config.d/
/etc/honk/state/
/etc/config/honk
endef

ifeq ($(ARCH),aarch64)
  RUST_TARGET:=aarch64-unknown-linux-musl
else ifeq ($(ARCH),x86_64)
  RUST_TARGET:=x86_64-unknown-linux-musl
else
  RUST_TARGET:=$(ARCH)-unknown-linux-musl
endif

RUST_TARGET_UPPER:=$(shell echo $(RUST_TARGET) | tr 'a-z-' 'A-Z_')

ifneq ($(wildcard $(CURDIR)/files/honk-core.bin),)
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) $(CURDIR)/files/honk-core.bin $(PKG_INSTALL_DIR)/bin/honk-core
endef
else
ifneq ($(HONK_LOCAL_DIR),)
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(HONK_LOCAL_DIR)/Cargo.toml $(PKG_BUILD_DIR)/
	$(CP) $(HONK_LOCAL_DIR)/Cargo.lock $(PKG_BUILD_DIR)/
	$(CP) $(HONK_LOCAL_DIR)/crates $(PKG_BUILD_DIR)/
	$(CP) $(HONK_LOCAL_DIR)/rust-toolchain.toml $(PKG_BUILD_DIR)/ 2>/dev/null || true
	$(CP) $(HONK_LOCAL_DIR)/LICENSE $(PKG_BUILD_DIR)/ 2>/dev/null || true
endef
endif

define Build/Compile
	export PATH="$(HOME)/.cargo/bin:$(PATH)"; \
	export STAGING_DIR="$(STAGING_DIR)"; \
	command -v cargo >/dev/null 2>&1 || { \
		echo "ERROR: host cargo not found! Please install Rust via https://rustup.rs" >&2; \
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
		-p honk-core \
		--no-default-features \
		--features ebpf,rprx,native-api,mimalloc \
		--manifest-path $(PKG_BUILD_DIR)/Cargo.toml \
		--target $(RUST_TARGET)
	$(INSTALL_DIR) $(PKG_INSTALL_DIR)/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/target/$(RUST_TARGET)/release/honk-core $(PKG_INSTALL_DIR)/bin/honk-core
endef
endif

define Package/honk/install
	$(INSTALL_DIR) $(1)/usr/bin
	if [ -f $(PKG_INSTALL_DIR)/bin/honk-core ]; then \
		$(INSTALL_BIN) $(PKG_INSTALL_DIR)/bin/honk-core $(1)/usr/bin/honk-core; \
	elif [ -f $(CURDIR)/files/honk-core.bin ]; then \
		$(INSTALL_BIN) $(CURDIR)/files/honk-core.bin $(1)/usr/bin/honk-core; \
	else \
		$(INSTALL_BIN) $(PKG_BUILD_DIR)/target/$(RUST_TARGET)/release/honk-core $(1)/usr/bin/honk-core; \
	fi

	$(INSTALL_DIR) $(1)/etc/honk/config.d
	$(INSTALL_CONF) $(CURDIR)/files/config.dae $(1)/etc/honk/config.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/node.dae $(1)/etc/honk/config.d/node.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/route.dae $(1)/etc/honk/config.d/route.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/dns.dae $(1)/etc/honk/config.d/dns.dae
	$(INSTALL_CONF) $(CURDIR)/files/config.d/api.dae $(1)/etc/honk/config.d/api.dae

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(CURDIR)/files/honk.config $(1)/etc/config/honk

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(CURDIR)/files/honk.init $(1)/etc/init.d/honk
endef

$(eval $(call BuildPackage,honk))
