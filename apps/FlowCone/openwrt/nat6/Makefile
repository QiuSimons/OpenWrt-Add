# SPDX-License-Identifier: GPL-3.0-or-later

include $(TOPDIR)/rules.mk

PKG_NAME:=nat6
PKG_VERSION:=1.0.0
PKG_RELEASE:=3

PKG_LICENSE:=GPL-3.0-or-later
PKG_MAINTAINER:=sbwml <admin@cooluc.com>

include $(INCLUDE_DIR)/package.mk

define Package/nat6
  SECTION:=net
  CATEGORY:=Network
  TITLE:=IPv6 NAT
  PKGARCH:=all
  DEPENDS:=+kmod-nft-nat +nftables-json
endef

define Build/Compile
endef

define Package/nat6/install
	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_DATA) ./files/nat6.hotplug $(1)/etc/hotplug.d/iface/90-nat6
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/nat6.init $(1)/etc/init.d/nat6
	$(INSTALL_BIN) ./files/nat6-flowcone.init $(1)/etc/init.d/nat6-flowcone
	$(INSTALL_DIR) $(1)/usr/share/ucitrack
	$(INSTALL_CONF) ./files/nat6.ucitrack $(1)/usr/share/ucitrack/nat6.json
	$(INSTALL_CONF) ./files/nat6-flowcone.ucitrack $(1)/usr/share/ucitrack/nat6-flowcone.json
endef

define Package/nat6/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/nat6 stop >/dev/null 2>&1 || true
exit 0
endef

define Package/nat6/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || rm -f /tmp/nat6-flowcone.mode
exit 0
endef

$(eval $(call BuildPackage,nat6))
