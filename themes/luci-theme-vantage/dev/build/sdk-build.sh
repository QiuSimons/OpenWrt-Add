#!/usr/bin/env bash
# Build the Vantage packages with the official OpenWrt SDK image in podman.
#
#   dev/build/sdk-build.sh [sdk-release=25.12.4] [git-rev=HEAD]
#
# Builds from a self-contained clone of <git-rev> (not the working tree and
# not a git worktree), so file timestamps come from git and the packages are
# byte-identical to any other build of the same commit with the same pinned
# SDK image. The SDK entrypoint is openwrt/gh-action-sdk's, pinned by hash.
# The SDK image is pinned by digest (table below). Every package is checked
# by security-tests/verify_built_apk.js before anything reaches
# dist/<release>/, which then holds exactly the two packages, one language
# package per po/<lang>/ directory of each (luci-i18n-vantage-<lc>,
# luci-i18n-vantage-theme-<lc>), SHA256SUMS and BUILDINFO (plus the signed
# index when signing). Exits 0 only when all of them were built, verified
# and hashed.
#
# Optional environment:
#   VANTAGE_SDK_IMAGE  SDK image for a release without a pinned digest below;
#                      must be a digest reference (<name>@sha256:<64 hex>)
#   VANTAGE_SDK_SUM    with VANTAGE_SDK_IMAGE: the line the image's
#                      /builder/sha256sums_min must contain
#   VANTAGE_SIGN_KEY   private key (outside this repository) that signs a
#                      package index written next to the packages: an EC
#                      private key in PEM form for 25.12 (apk, packages.adb),
#                      a usign secret key for 23.05/24.10 (opkg, Packages.sig).
#                      The packages themselves stay unsigned and byte-identical.
#                      See docs/INSTALL.md, "Signed packages".
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
release=${1:-25.12.4}
packages="luci-theme-vantage luci-app-vantage"

die() { echo "sdk-build: $*" >&2; exit 2; }

# the release also names dist/<release>/, so accept nothing but x.y.z
[[ $release =~ ^(23\.05|24\.10|25\.12)\.[0-9]+$ ]] || die "unsupported SDK release: $release"
case $release in 25.12.*) fmt=apk ;; *) fmt=ipk ;; esac
rev=$(git -C "$repo" rev-parse --verify --quiet "${2:-HEAD}^{commit}") || die "unknown git revision: ${2:-HEAD}"

# Pinned SDK images and the SDK tarball each one was built from (the line in
# the image's /builder/sha256sums_min). To add or update a release:
#   podman pull ghcr.io/openwrt/sdk:x86_64-<release>
#   podman image inspect --format '{{index .RepoDigests 0}}' ghcr.io/openwrt/sdk:x86_64-<release>
#   podman run --rm --network=none --entrypoint cat <name@sha256:...> /builder/sha256sums_min
# and check that this line equals the SDK tarball's line in
# https://downloads.openwrt.org/releases/<release>/targets/x86/64/sha256sums
# (after checking that file's signature, sha256sums.asc, against the
# OpenWrt release key).
pinned_sdk() {
	case $1 in
	25.12.4)
		sdk_image=ghcr.io/openwrt/sdk@sha256:820d614294e64d048059cfe3dac58049fc0ce621a9d3ac21217c2caafb7d9616
		sdk_sum='28e004c1be4d215d19c1f12a6aa4c8d8f80689549eb707d0ff5a71f16fa8d05f *openwrt-sdk-25.12.4-x86-64_gcc-14.3.0_musl.Linux-x86_64.tar.zst'
		;;
	24.10.8)
		sdk_image=ghcr.io/openwrt/sdk@sha256:b28d5e4087dbd3f815a8bf5440a11e54e6bbd3d7400c3729d872e7940a4a77c1
		sdk_sum='ac4a0405d2eea821b06f93c14ba13ffa90ad0457648903df7dde02570027ab21 *openwrt-sdk-24.10.8-x86-64_gcc-13.3.0_musl.Linux-x86_64.tar.zst'
		;;
	*) return 1 ;;
	esac
}

if [ -n "${VANTAGE_SDK_IMAGE:-}" ]; then
	sdk_image=$VANTAGE_SDK_IMAGE
	sdk_sum=${VANTAGE_SDK_SUM:-}
	[[ $sdk_image =~ ^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$ ]] ||
		die "VANTAGE_SDK_IMAGE must be a digest reference (<name>@sha256:<64 hex>), not a tag"
	echo "sdk-build: warning: using $sdk_image, not a digest from the pinned table" >&2
	[ -n "$sdk_sum" ] || echo "sdk-build: warning: VANTAGE_SDK_SUM unset, the SDK tarball hash is not checked" >&2
elif ! pinned_sdk "$release"; then
	die "no pinned SDK image for $release; add it to the table in $0, or set VANTAGE_SDK_IMAGE=<name>@sha256:<digest>"
fi

command -v podman >/dev/null || die "podman is required"
command -v node >/dev/null || die "node is required (the built packages are verified with security-tests/verify_built_apk.js)"
pv=$(podman version --format '{{.Client.Version}}')
IFS=. read -r pmaj pmin _ <<<"$pv"
pmin=${pmin%%[!0-9]*}
if (( ${pmaj:-0} < 4 || (${pmaj:-0} == 4 && ${pmin:-0} < 3) )); then
	die "podman $pv is too old; 4.3 or later is needed for --userns=keep-id:uid=,gid="
fi

# optional index signing; the key is streamed to the container on stdin, so
# it is never written to the host work directory, a mount or podman's config
sign= keyabs=
if [ -n "${VANTAGE_SIGN_KEY:-}" ]; then
	[ -f "$VANTAGE_SIGN_KEY" ] && [ -r "$VANTAGE_SIGN_KEY" ] || die "VANTAGE_SIGN_KEY: cannot read $VANTAGE_SIGN_KEY"
	keyabs=$(realpath -- "$VANTAGE_SIGN_KEY")
	case $keyabs/ in "$repo"/*) die "refusing a signing key inside the repository ($keyabs); keep keys outside it" ;; esac
	first=$(head -n 1 -- "$keyabs")
	if [ "$fmt" = apk ]; then
		[[ $first =~ ^-----BEGIN\ (EC\ )?PRIVATE\ KEY-----$ ]] || die "VANTAGE_SIGN_KEY: not a PEM private key (apk needs an EC key, see docs/INSTALL.md)"
		sign=apk
	else
		[[ $first == 'untrusted comment:'* ]] || die "VANTAGE_SIGN_KEY: not a usign secret key"
		sign=usign
	fi
	[ -z "$(find "$keyabs" -perm /077)" ] || echo "sdk-build: warning: $keyabs is readable by other users (chmod 600)" >&2
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/vantage-build.XXXXXX")
git clone --quiet --no-local "$repo" "$work/feed"
git -C "$work/feed" checkout --quiet --detach "$rev"
mkdir "$work/artifacts" "$work/out"

# openwrt/gh-action-sdk@f5813d30eeef3534b58ac7e79c5d8842b6035434 entrypoint.sh;
# checked on the copy that is mounted
entry_sha=e78cc3ca3ffe9a15d47096e2e9a2aa07399a22a77acdca31f4e5aef2fa0e6a9c
install -m 0644 "$here/entrypoint.sh" "$work/entrypoint.sh"
echo "$entry_sha  $work/entrypoint.sh" | sha256sum -c --quiet

# expected package file names, from the Makefiles of the commit being built
expected=()
for pkg in $packages; do
	ver=$(sed -n 's/^PKG_VERSION:=//p' "$work/feed/$pkg/Makefile")
	rel=$(sed -n 's/^PKG_RELEASE:=//p' "$work/feed/$pkg/Makefile")
	[[ $ver =~ ^[0-9A-Za-z.+~]+$ && $rel =~ ^[0-9]+$ ]] || die "$pkg/Makefile: cannot read PKG_VERSION/PKG_RELEASE"
	if [ "$fmt" = apk ]; then
		expected+=("$pkg-$ver-r$rel.apk")
	else
		expected+=("${pkg}_$ver-r${rel}_all.ipk")
	fi
done

# Runs inside the container instead of the entrypoint directly:
# - the release image already contains the extracted SDK, so drop setup.sh,
#   which would download it again (first request over plain HTTP, checked
#   against a keyring that also trusts OpenWrt's snapshot key); instead
#   check that the image's SDK is the pinned tarball;
# - read the signing key from stdin into the variable the entrypoint uses;
# - afterwards hand out the SDK's apk, jsmin and po2lmo so the host can
#   verify the packages with the exact tools that built them, plus the feed
#   pins and the luci feed's luci.mk (language list and package names).
# shellcheck disable=SC2016
inner='
if [ -n "${SDK_SUM:-}" ] && ! grep -Fxq -- "$SDK_SUM" sha256sums_min; then
	echo "::error::the SDK in this image is not the pinned tarball"; cat sha256sums_min; exit 90
fi
rm -f setup.sh
case ${SIGN:-} in
	apk) PRIVATE_KEY=$(cat); export PRIVATE_KEY ;;
	usign) KEY_BUILD=$(cat); export KEY_BUILD ;;
esac
rc=0
bash /entrypoint.sh || rc=$?
unset PRIVATE_KEY KEY_BUILD
mkdir -p /artifacts/tools
if [ "${SIGN:-}" = apk ] && [ -f private-key.pem ]; then
	staging_dir/host/bin/openssl pkey -in private-key.pem -pubout -out /artifacts/tools/public-key.pem || rc=91
fi
rm -f private-key.pem public-key.pem key-build
cp feeds.conf /artifacts/tools/feeds.conf 2>/dev/null
cp feeds/luci/luci.mk /artifacts/tools/luci.mk 2>/dev/null
grep -E "^(# )?CONFIG_LUCI_(JSMIN|CSSTIDY|SRCDIET)[ =]" .config > /artifacts/tools/luci.config 2>/dev/null
# host/bin/apk and host/bin/usign are wrappers around the relocated
# binaries; the binaries themselves only need the host C library
[ ! -f staging_dir/host/bin/.apk.bin ] || cp staging_dir/host/bin/.apk.bin /artifacts/tools/apk
j=$(find staging_dir -path "*/bin/jsmin" -type f 2>/dev/null | head -n 1)
[ -z "$j" ] || cp "$j" /artifacts/tools/jsmin
p=$(find staging_dir -path "*/bin/po2lmo" -type f 2>/dev/null | head -n 1)
[ -z "$p" ] || cp "$p" /artifacts/tools/po2lmo
[ ! -f staging_dir/host/bin/.usign.bin ] || cp staging_dir/host/bin/.usign.bin /artifacts/tools/usign
exit "$rc"
'

# Network stays on: `scripts/feeds update` clones the feeds (over HTTPS, at
# the commits pinned in the image's feeds.conf.default). The user namespace
# maps the caller to the image's buildbot (1000:1000), so /builder and the
# /artifacts bind mount are both writable whatever the host UID is. :z only
# matters on SELinux hosts and relabels nothing but the per-build work dir.
podman_args=(run --rm --pull=missing
	--userns=keep-id:uid=1000,gid=1000
	--cap-drop=all --security-opt=no-new-privileges
	-v "$work/feed:/feed:ro,z"
	-v "$work/artifacts:/artifacts:z"
	-v "$work/entrypoint.sh:/entrypoint.sh:ro,z"
	-e FEEDNAME=vantage -e PACKAGES="$packages" -e V=s
	-e SDK_SUM="$sdk_sum" -e SIGN="$sign")
[ -z "$sign" ] || podman_args+=(-i -e INDEX=1)
podman_args+=(--entrypoint /bin/bash "$sdk_image" -c "$inner")

if [ -n "$sign" ]; then
	podman "${podman_args[@]}" < "$keyabs" > "$work/build.log" 2>&1 || status=$?
else
	podman "${podman_args[@]}" < /dev/null > "$work/build.log" 2>&1 || status=$?
fi
if [ "${status:-0}" -ne 0 ]; then
	echo "SDK build failed (exit ${status}); log: $work/build.log" >&2
	tail -n 40 "$work/build.log" >&2
	exit 1
fi
# the entrypoint only warns (and exits 0) when it skips a package
if grep -q '^::warning file=' "$work/build.log"; then
	grep '^::warning file=' "$work/build.log" >&2
	echo "the SDK skipped a package; log: $work/build.log" >&2
	exit 1
fi

tools=$work/artifacts/tools

# Language packages, the way the SDK's luci.mk derives them: one per
# po/<lang>/ directory whose <lang> has a LUCI_LANG entry, named
# luci-i18n-<LUCI_BASENAME>-<LUCI_LC_ALIAS or lang>, versioned
# PKG_PO_VERSION. luci.mk silently skips unknown directories; this refuses
# them, and a PKG_PO_VERSION other than the package version.
[ -f "$tools/luci.mk" ] || die "the SDK's feeds/luci/luci.mk was not handed out; log: $work/build.log"
for pkg in $packages; do
	[ -d "$work/feed/$pkg/po" ] || continue
	mk=$work/feed/$pkg/Makefile
	ver=$(sed -n 's/^PKG_VERSION:=//p' "$mk")
	rel=$(sed -n 's/^PKG_RELEASE:=//p' "$mk")
	base=$(sed -n 's/^LUCI_BASENAME:=//p' "$mk")
	base=${base:-${pkg#luci-*-}}
	[[ $base =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "$pkg/Makefile: unusual LUCI_BASENAME $base"
	for dir in "$work/feed/$pkg/po"/*; do
		[ -e "$dir" ] || continue
		lang=${dir##*/}
		[ "$lang" != templates ] || continue
		[[ $lang =~ ^[A-Za-z_]+$ ]] && [ -d "$dir" ] && grep -Eq "^LUCI_LANG\.$lang=." "$tools/luci.mk" ||
			die "$pkg/po/$lang: not a language directory of the SDK's luci.mk (LUCI_LANG.$lang)"
		[ "$(sed -n 's/^PKG_PO_VERSION:=//p' "$mk")" = '$(PKG_VERSION)-r$(PKG_RELEASE)' ] ||
			die "$pkg/Makefile: language packages need PKG_PO_VERSION:=\$(PKG_VERSION)-r\$(PKG_RELEASE)"
		lc=$(sed -n "s/^LUCI_LC_ALIAS\.$lang=\([^ ]*\).*/\1/p" "$tools/luci.mk")
		lc=${lc:-$lang}
		if [ "$fmt" = apk ]; then
			expected+=("luci-i18n-$base-$lc-$ver-r$rel.apk")
		else
			expected+=("luci-i18n-${base}-${lc}_$ver-r${rel}_all.ipk")
		fi
	done
done
# the i18n tooling should use the luci feed commit this SDK builds with
want_luci=$(sed -n 's/^LUCI_REV=\([0-9a-f]\{40\}\)$/\1/p' "$work/feed/dev/i18n/update.sh" 2>/dev/null || true)
have_luci=$(sed -n 's|^src-git luci [^ ]*\^\([0-9a-f]\{40\}\)$|\1|p' "$tools/feeds.conf" 2>/dev/null || true)
[ -z "$want_luci" ] || [ "$want_luci" = "$have_luci" ] ||
	echo "sdk-build: warning: dev/i18n/update.sh pins LuCI $want_luci, the SDK's luci feed is ${have_luci:-unknown}" >&2

# exactly the expected packages, nothing else
mapfile -t built < <(find "$work/artifacts/bin" -type f \( -name 'luci-*-vantage*.apk' -o -name 'luci-*-vantage*.ipk' \) | sort)
names=$(printf '%s\n' "${built[@]##*/}" | sort)
want=$(printf '%s\n' "${expected[@]}" | sort)
if [ "$names" != "$want" ]; then
	echo "expected packages:" >&2; echo "$want" >&2
	echo "built:" >&2; echo "$names" >&2
	echo "log: $work/build.log" >&2
	exit 1
fi
cp -- "${built[@]}" "$work/out/"

index=()
if [ -n "$sign" ]; then
	feeddir=$(dirname -- "${built[0]}")
	if [ "$sign" = apk ]; then index=(packages.adb); else index=(Packages Packages.gz Packages.sig); fi
	for f in "${index[@]}"; do
		[ -f "$feeddir/$f" ] || { echo "signed index file $f missing; log: $work/build.log" >&2; exit 1; }
		cp -- "$feeddir/$f" "$work/out/"
	done
fi

verify=(--src "$work/feed" --require-tools --luci-mk "$tools/luci.mk")
[ ! -x "$tools/apk" ] || verify+=(--apk-tool "$tools/apk")
[ ! -x "$tools/jsmin" ] || verify+=(--jsmin "$tools/jsmin")
[ ! -x "$tools/po2lmo" ] || verify+=(--po2lmo "$tools/po2lmo")
[ ! -f "$tools/luci.config" ] || verify+=(--luci-config "$tools/luci.config")
[ "$sign" != usign ] || [ -x "$tools/usign" ] || die "the SDK's usign was not handed out; log: $work/build.log"
if [ "$sign" = apk ]; then
	mkdir "$work/keys"
	cp -- "$tools/public-key.pem" "$work/keys/vantage.pem"
	verify+=(--index "$work/out/packages.adb" --keys-dir "$work/keys")
fi
if ! node "$repo/security-tests/verify_built_apk.js" "${verify[@]}" "${expected[@]/#/$work/out/}"; then
	echo "package verification failed; dist/$release was not changed; work dir: $work" >&2
	exit 1
fi

( cd "$work/out" && sha256sum -- "${expected[@]}" > SHA256SUMS )
{
	echo "rev=$rev"
	echo "sdk_release=$release"
	echo "sdk_image=$sdk_image"
	echo "sdk_tarball=${sdk_sum:-unchecked}"
	echo "entrypoint_sha256=$entry_sha"
	grep -v '^src-link ' "$tools/feeds.conf" 2>/dev/null | sed 's/^/feed=/'
	sed -n 's/^CONFIG_LUCI_JSMIN=\(.*\)$/luci_jsmin=\1/p; s/^# CONFIG_LUCI_JSMIN is not set$/luci_jsmin=n/p' "$tools/luci.config" 2>/dev/null
	if [ "$sign" = apk ]; then
		echo "signed_index=packages.adb"
		echo "signing_public_key_sha256=$(sha256sum < "$tools/public-key.pem" | cut -d' ' -f1)"
	elif [ "$sign" = usign ]; then
		echo "signed_index=Packages.sig"
		echo "signing_key_fingerprint=$("$tools/usign" -F -x "$work/out/Packages.sig")"
	else
		echo "signed_index=none"
	fi
	echo "verified_by=security-tests/verify_built_apk.js"
} > "$work/out/BUILDINFO"

# Replace what an earlier build left in dist/<release>/: only our own file
# names, never the directory.
out="$repo/dist/$release"
mkdir -p "$out"
rm -f -- "$out"/luci-theme-vantage[-_]*.apk "$out"/luci-theme-vantage[-_]*.ipk \
	"$out"/luci-app-vantage[-_]*.apk "$out"/luci-app-vantage[-_]*.ipk \
	"$out"/luci-i18n-vantage-*.apk "$out"/luci-i18n-vantage-*.ipk \
	"$out"/SHA256SUMS "$out"/BUILDINFO \
	"$out"/packages.adb "$out"/Packages "$out"/Packages.gz "$out"/Packages.sig
cp -- "$work/out"/* "$out/"
extra=$(find "$out" -mindepth 1 -maxdepth 1 ! -name 'luci-*-vantage[-_]*' ! -name SHA256SUMS ! -name BUILDINFO \
	! -name packages.adb ! -name 'Packages*' -printf '%f\n')
[ -z "$extra" ] || echo "sdk-build: warning: $out also holds files this script did not write: $extra" >&2

# keep the SDK's apk, jsmin, po2lmo and luci.mk so verify_built_apk.js can
# re-check dist/ later without an SDK (dist/ is not committed)
tcache="$repo/dist/.tools/$release"
mkdir -p "$tcache"
for t in apk jsmin po2lmo usign luci.config luci.mk; do
	[ ! -f "$tools/$t" ] || install -m "$(case $t in *.*) echo 0644 ;; *) echo 0755 ;; esac)" -- "$tools/$t" "$tcache/$t"
done

cat "$out/SHA256SUMS"
# the clone and SDK output are only needed to debug a failed build
case $work in "${TMPDIR:-/tmp}"/vantage-build.?*) rm -rf -- "$work" ;; esac
echo "built $rev for OpenWrt $release -> $out"
