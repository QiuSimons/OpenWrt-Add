# SPDX-License-Identifier: GPL-2.0-only

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

PKG_NAME:=tcp-bbr3
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Dual BSD/GPL

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/hrimfaxi/tcp_bbr_modules.git
PKG_SOURCE_VERSION:=c5c557584175b5fed8939bf91ec249aed158597d
PKG_MIRROR_HASH:=skip

include $(INCLUDE_DIR)/package.mk

define KernelPackage/tcp-bbr3
  SUBMENU:=Network Support
  TITLE:=BBRv3 TCP congestion control
  FILES:=$(PKG_BUILD_DIR)/tcp_bbr3.ko
  AUTOLOAD:=$(call AutoLoad,60,tcp_bbr3)
  EXTRA_DEPENDS:=
endef

define KernelPackage/tcp-bbr3/description
  TCP BBRv3 congestion control algorithm with adaptive LFN loss tolerance.
endef

MAKE_OPTS:= \
	$(KERNEL_MAKEOPTS) \
	M="$(PKG_BUILD_DIR)"

define Build/Compile
	$(MAKE) -C "$(LINUX_DIR)" $(MAKE_OPTS) modules
endef

define KernelPackage/tcp-bbr3/install
	$(INSTALL_DIR) $(1)/etc/sysctl.d
	$(INSTALL_DATA) ./files/15-tcp-bbr3.conf $(1)/etc/sysctl.d/15-tcp-bbr3.conf
endef

define Package/kmod-tcp-bbr3/postinst
#!/bin/sh
[ -z "$$IPKG_INSTROOT" ] || exit 0
sysctl -w net.ipv4.tcp_congestion_control=bbr3
exit 0
endef

$(eval $(call KernelPackage,tcp-bbr3))
