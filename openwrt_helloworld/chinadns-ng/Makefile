include $(TOPDIR)/rules.mk

PKG_NAME:=chinadns-ng
PKG_VERSION:=2025.08.09
PKG_RELEASE:=1

ifeq ($(ARCH),aarch64)
  ifeq ($(BOARD),rockchip)
    PKG_ARCH:=chinadns-ng+wolfssl@aarch64-linux-musl@generic+v8a@fast+lto
    PKG_HASH:=3fe0217615dd7060b7287d2b6b31d2a0b364137398bfb335a03bead322eac716
  else
    PKG_ARCH:=chinadns-ng+wolfssl_noasm@aarch64-linux-musl@generic+v8a@fast+lto
    PKG_HASH:=42ddd494200ec6d88b35902927688d316bc23e06e6c08d9e01eb2412196ab845
  endif
else ifeq ($(ARCH),arm)
  ifeq ($(CONFIG_arm_v6),y)
    PKG_ARCH:=chinadns-ng+wolfssl@arm-linux-musleabi@generic+v6+soft_float@fast+lto
    PKG_HASH:=0a401d1dc11129481b2baf86f847d55d66bd7e725cba4bf57875fdad27ef0052
  else ifeq ($(CONFIG_arm_v7),y)
    ifeq ($(CONFIG_HAS_FPU),y)
      PKG_ARCH:=chinadns-ng+wolfssl@arm-linux-musleabihf@generic+v7a@fast+lto
      PKG_HASH:=dfa1f6ba80fb0925613822f4c4e00df8da68e7b8b772048d26a0d1a9d07d346b
    else
      PKG_ARCH:=chinadns-ng+wolfssl@arm-linux-musleabi@generic+v6+soft_float@fast+lto
      PKG_HASH:=0a401d1dc11129481b2baf86f847d55d66bd7e725cba4bf57875fdad27ef0052
    endif
  else
    PKG_ARCH:=chinadns-ng+wolfssl@arm-linux-musleabi@generic+v5te+soft_float@fast+lto
    PKG_HASH:=dc104953fcd95c1c98b7b2b54b0b6731565e0650f81230e6de127a486803f42f
  endif
else ifeq ($(ARCH),mips)
  PKG_ARCH:=chinadns-ng+wolfssl@mips-linux-musl@mips32+soft_float@fast+lto
  PKG_HASH:=b610821a8f61b0ed3c8c7e82e10d401348a9de17f900988589024a37c4099c8e
else ifeq ($(ARCH),mipsel)
  ifeq ($(CONFIG_HAS_FPU),)
    PKG_ARCH:=chinadns-ng+wolfssl@mipsel-linux-musl@mips32+soft_float@fast+lto
    PKG_HASH:=760544a88724e3b1b9eac79c9400231e81aa8786f8f00a979229e175811ffe6d
  else
    PKG_ARCH:=chinadns-ng+wolfssl@mipsel-linux-musl@mips32@fast+lto
    PKG_HASH:=ec547c31a884e0967437ceb90a5c270864efe81b0e40939e0ec2810c7bfd6653
  endif
else ifeq ($(ARCH),mips64)
  PKG_ARCH:=chinadns-ng+wolfssl@mips64-linux-musl@mips64+soft_float@fast+lto
  PKG_HASH:=2d0fce18a7ef1d74fdc12738767e66998a52c2b30d8790da760933853fe8726e
else ifeq ($(ARCH),mips64el)
  PKG_ARCH:=chinadns-ng+wolfssl@mips64el-linux-musl@mips64+soft_float@fast+lto
  PKG_HASH:=a301d8d200d06582c60bbe0e487a28f5b41e6f0997a548cf882a7b078dab089c
else ifeq ($(ARCH),i386)
  ifneq ($(CONFIG_TARGET_x86_geode)$(CONFIG_TARGET_x86_legacy),)
    PKG_ARCH:=chinadns-ng+wolfssl@i386-linux-musl@i686@fast+lto
    PKG_HASH:=25a215e1b5c18f8b4f0e7f0a0925fd1c959bbfdfeb3383830d2b645a94077fc6
  else
    PKG_ARCH:=chinadns-ng+wolfssl@i386-linux-musl@pentium4@fast+lto
    PKG_HASH:=e78feedf8fafc60749dfca576acd05b3df8e4b99912aa77a320971011ca77b1d
  endif
else ifeq ($(ARCH),x86_64)
  PKG_ARCH:=chinadns-ng+wolfssl@x86_64-linux-musl@x86_64@fast+lto
  PKG_HASH:=9ad100ef18f7acaecad1aaa07b07029e9e50679fc8f119977878211b1ceb96f0
else ifeq ($(ARCH),riscv64)
  PKG_ARCH:=chinadns-ng+wolfssl@riscv64-linux-musl@baseline_rv64@fast+lto
  PKG_HASH:=ed4d2cf72c2d48f19dd7678f419ce726bc2a793afc62afd6345e735dd262ca96
else
  PKG_HASH:=dummy
endif

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION)-$(ARCH_PACKAGES)
PKG_SOURCE_URL:=https://github.com/zfl9/chinadns-ng/releases/download/$(PKG_VERSION)/$(PKG_ARCH)?
UNPACK_CMD=$(CP) $(DL_DIR)/$(PKG_SOURCE) $(PKG_BUILD_DIR)/$(PKG_NAME)

PKG_LICENSE:=AGPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=sbwml <admin@cooluc.com>

include $(INCLUDE_DIR)/package.mk

define Package/chinadns-ng
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=IP Addresses and Names
  TITLE:=ChinaDNS next generation, refactoring with epoll and ipset.
  URL:=https://github.com/zfl9/chinadns-ng
  DEPENDS:=@(aarch64||arm||i386||mips||mipsel||mips64||mips64el||x86_64||riscv64) +ipset
endef

define Build/Compile
endef

define Package/chinadns-ng/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/chinadns-ng $(1)/usr/bin
endef

$(eval $(call BuildPackage,chinadns-ng))
