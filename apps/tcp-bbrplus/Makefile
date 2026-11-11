# SPDX-License-Identifier: GPL-2.0-only

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

PKG_NAME:=tcp-bbrplus
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Dual BSD/GPL

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/hrimfaxi/tcp_bbr_modules.git
PKG_SOURCE_VERSION:=c5c557584175b5fed8939bf91ec249aed158597d
PKG_MIRROR_HASH:=skip

include $(INCLUDE_DIR)/package.mk

define KernelPackage/tcp-bbrplus
  SUBMENU:=Network Support
  TITLE:=BBRplus TCP congestion control
  FILES:=$(PKG_BUILD_DIR)/tcp_bbrplus.ko
  AUTOLOAD:=$(call AutoLoad,60,tcp_bbrplus)
  EXTRA_DEPENDS:=
endef

define KernelPackage/tcp-bbrplus/description
  TCP BBRplus congestion control algorithm.
  Automatically sets bbrplus as the default TCP congestion control algorithm.
endef

MAKE_OPTS:= \
	$(KERNEL_MAKEOPTS) \
	M="$(PKG_BUILD_DIR)"

define Build/Compile
	$(MAKE) -C "$(LINUX_DIR)" $(MAKE_OPTS) modules
endef

define KernelPackage/tcp-bbrplus/install
	$(INSTALL_DIR) $(1)/etc/sysctl.d
	$(INSTALL_DATA) ./files/15-tcp-bbrplus.conf $(1)/etc/sysctl.d/15-tcp-bbrplus.conf
endef

define Package/kmod-tcp-bbrplus/postinst
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
sysctl -w net.ipv4.tcp_congestion_control=bbrplus
exit 0
endef

$(eval $(call KernelPackage,tcp-bbrplus))
