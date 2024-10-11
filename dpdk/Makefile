include $(TOPDIR)/rules.mk

PKG_NAME:=dpdk
PKG_VERSION:=21.11
PKG_RELEASE:=$(AUTORELEASE)

PKG_SOURCE:=dpdk-$(PKG_VERSION).tar.xz
PKG_SOURCE_URL:=http://static.dpdk.org/rel
PKG_HASH:=skip
PKG_CONFIG_DEPENDS:= \
    CONFIG_KERNEL_HUGETLBFS \
    CONFIG_KERNEL_PROC_PAGE_MONITOR \
    CONFIG_KERNEL_HPET \
    CONFIG_KERNEL_HPET_MMAP

PKG_BUILD_DEPENDS:=meson/host
include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/host-build.mk
include $(TOPDIR)/feeds/packages/devel/meson/meson.mk

TARGET_CFLAGS += -D_GNU_SOURCE -Wno-unused-result -Wno-format-nonliteral

MESON_ARGS += -Ddisable_drivers=common/cnxk

define Package/dpdk
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Data Plane Development Kit (DPDK)
  DEPENDS:=@(x86_64||aarch64) +librt +libpthread +libbpf +libpcap +libopenssl +libatomic
endef

define Package/dpdk/description
  DPDK consists of libraries to accelerate packet processing
  workloads running on a wide variety of CPU architectures.
endef

define Package/dpdk/install
	$(INSTALL_DIR) $(1)/usr/{bin,lib}
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/{dpdk-testpmd,dpdk-proc-info,dpdk-test-flow-perf} $(1)/usr/bin/
	$(CP) $(PKG_INSTALL_DIR)/usr/lib/lib* $(1)/usr/lib/
endef

$(eval $(call BuildPackage,dpdk))
