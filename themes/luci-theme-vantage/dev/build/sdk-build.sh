#!/usr/bin/env bash
# Build the Vantage packages with the official OpenWrt SDK image in podman.
#
#   dev/build/sdk-build.sh [sdk-release=25.12.6] [git-rev=HEAD]
#   dev/build/sdk-build.sh --sign <sdk-release>
#   dev/build/sdk-build.sh --throwaway-key <sdk-release> <public key file>
#
# Builds from a self-contained clone of <git-rev> (not the working tree and
# not a git worktree), so file timestamps come from git and the packages are
# byte-identical to any other build of the same commit with the same pinned
# SDK image. The SDK entrypoint is openwrt/gh-action-sdk's, pinned by hash.
# The SDK image is pinned by digest (table below). Every package is checked
# by security-tests/verify_built_apk.js before anything reaches
# dist/<release>/, which then holds exactly the four packages, one language
# package per po/<lang>/ directory of each (luci-i18n-vantage-<lc>,
# luci-i18n-vantage-aps-<lc>, luci-i18n-vantage-traffic-<lc>,
# luci-i18n-vantage-theme-<lc>), SHA256SUMS and BUILDINFO. Exits 0 only when
# all of them were built, verified and hashed.
#
# --sign signs the package index of a dist/<release>/ that a build left: a
# step of its own, so that the key is never where the feeds are fetched and
# the packages compiled (see sign_index below). It runs nothing a build
# produced and needs neither node nor dist/.tools, so CI runs it in a job
# of its own, on another machine than the build. A build with
# VANTAGE_SIGN_KEY set runs it once the build is done.
#
# --throwaway-key makes a key of the release's kind inside the SDK image,
# prints the secret key and writes its public half to the file: for trying
# the signing step (CI does on every run that is not a release).
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
#                      Needed by --sign, where "-" means the key comes on
#                      standard input (no file). See docs/INSTALL.md,
#                      "Signed packages".
#   VANTAGE_SIGN_PUB   the public key the signature must verify with, inside
#                      the signing container. Default: the committed key of
#                      the release, keys/vantage-signing.pem (25.12) or
#                      keys/vantage-24.10.usign.pub (24.10); another key
#                      needs its public half named here.
set -euo pipefail

# Where the signing key is, and the public key its signature is checked
# with: out of the environment before anything is started, so that no
# program this script runs inherits them (the build's verification runs
# tools the build produced). sign_index alone uses them.
sign_key=${VANTAGE_SIGN_KEY:-} sign_pub=${VANTAGE_SIGN_PUB:-}
unset VANTAGE_SIGN_KEY VANTAGE_SIGN_PUB

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
mode=build pubout=
case ${1:-} in
--sign)
	mode=sign
	shift
	[ $# -eq 1 ] || { echo "usage: $0 --sign <sdk-release>" >&2; exit 2; }
	;;
--throwaway-key)
	mode=key
	shift
	[ $# -eq 2 ] && [ -n "$2" ] || { echo "usage: $0 --throwaway-key <sdk-release> <public key file>" >&2; exit 2; }
	pubout=$2
	;;
esac
release=${1:-25.12.6}
packages="luci-theme-vantage luci-app-vantage luci-app-vantage-aps luci-app-vantage-traffic"

die() { echo "sdk-build: $*" >&2; exit 2; }

# the release also names dist/<release>/, so accept nothing but x.y.z
[[ $release =~ ^(23\.05|24\.10|25\.12)\.[0-9]+$ ]] || die "unsupported SDK release: $release"
case $release in 25.12.*) fmt=apk ;; *) fmt=ipk ;; esac
[ "$mode" != build ] || rev=$(git -C "$repo" rev-parse --verify --quiet "${2:-HEAD}^{commit}") || die "unknown git revision: ${2:-HEAD}"
# the kind of key and index this release has
kind=usign
[ "$fmt" != apk ] || kind=apk

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
	25.12.6)
		sdk_image=ghcr.io/openwrt/sdk@sha256:a17d6436f7add9207513b6edd0370f5a1aeeceeedf3c9080de8909112892f261
		sdk_sum='1864152619092e781fa36a401960c8e9ae42d6a364c44ee5f0b197ca5f3c0fcc *openwrt-sdk-25.12.6-x86-64_gcc-14.3.0_musl.Linux-x86_64.tar.zst'
		;;
	25.12.4) # releases up to 1.2.0, to rebuild them
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
[ "$mode" != build ] || command -v node >/dev/null || die "node is required (the built packages are verified with security-tests/verify_built_apk.js)"
pv=$(podman version --format '{{.Client.Version}}')
IFS=. read -r pmaj pmin _ <<<"$pv"
pmin=${pmin%%[!0-9]*}
if (( ${pmaj:-0} < 4 || (${pmaj:-0} == 4 && ${pmin:-0} < 3) )); then
	die "podman $pv is too old; 4.3 or later is needed for --userns=keep-id:uid=,gid="
fi

# Optional index signing. Only where the key is and which public key its
# signature has to verify with are settled here: the key itself is read by
# sign_index's container alone, from standard input, so it is never in the
# host work directory, a mount or podman's config, and no program on this
# machine opens it.
keysrc= pubabs=
if [ -n "$sign_key" ]; then
	if [ "$sign_key" = - ]; then
		[ "$mode" = sign ] || die "VANTAGE_SIGN_KEY=- (the key on standard input) goes with --sign"
		keysrc=-
	else
		[ -f "$sign_key" ] && [ -r "$sign_key" ] || die "VANTAGE_SIGN_KEY: cannot read $sign_key"
		keysrc=$(realpath -- "$sign_key")
		case $keysrc/ in "$repo"/*) die "refusing a signing key inside the repository ($keysrc); keep keys outside it" ;; esac
		[ -z "$(find "$keysrc" -perm /077)" ] || echo "sdk-build: warning: $keysrc is readable by other users (chmod 600)" >&2
	fi
	pub=$sign_pub
	if [ -z "$pub" ]; then
		case $release in
		25.12.*) pub=$repo/keys/vantage-signing.pem ;;
		24.10.*) pub=$repo/keys/vantage-24.10.usign.pub ;;
		*) die "no committed public key for $release: name the key's public half in VANTAGE_SIGN_PUB" ;;
		esac
	fi
	[ -f "$pub" ] && [ -r "$pub" ] || die "cannot read the public key $pub"
	pubabs=$(realpath -- "$pub")
fi
[ "$mode" != sign ] || [ -n "$keysrc" ] || die "--sign needs VANTAGE_SIGN_KEY (a key file, or - for the key on standard input)"

# Package file names of this format, as the source tree $1 defines them,
# added to the array `expected`: main_names the four packages; lang_names
# their language packages, the way luci.mk derives them: one per po/<lang>/
# directory whose <lang> has a LUCI_LANG entry in the list $2 (the SDK's
# luci.mk, or the commit's copy of its list, dev/i18n/luci-languages.mk),
# named luci-i18n-<LUCI_BASENAME>-<LUCI_LC_ALIAS or lang>, versioned
# PKG_PO_VERSION. luci.mk silently skips unknown directories; this refuses
# them, and a PKG_PO_VERSION other than the package version.
main_names() {
	local pkg ver rel
	for pkg in $packages; do
		ver=$(sed -n 's/^PKG_VERSION:=//p' "$1/$pkg/Makefile")
		rel=$(sed -n 's/^PKG_RELEASE:=//p' "$1/$pkg/Makefile")
		[[ $ver =~ ^[0-9A-Za-z.+~]+$ && $rel =~ ^[0-9]+$ ]] || die "$pkg/Makefile: cannot read PKG_VERSION/PKG_RELEASE"
		if [ "$fmt" = apk ]; then
			expected+=("$pkg-$ver-r$rel.apk")
		else
			expected+=("${pkg}_$ver-r${rel}_all.ipk")
		fi
	done
}
lang_names() {
	local pkg mk ver rel base dir lang lc
	for pkg in $packages; do
		[ -d "$1/$pkg/po" ] || continue
		mk=$1/$pkg/Makefile
		ver=$(sed -n 's/^PKG_VERSION:=//p' "$mk")
		rel=$(sed -n 's/^PKG_RELEASE:=//p' "$mk")
		base=$(sed -n 's/^LUCI_BASENAME:=//p' "$mk")
		base=${base:-${pkg#luci-*-}}
		[[ $base =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "$pkg/Makefile: unusual LUCI_BASENAME $base"
		for dir in "$1/$pkg/po"/*; do
			[ -e "$dir" ] || continue
			lang=${dir##*/}
			[ "$lang" != templates ] || continue
			[[ $lang =~ ^[A-Za-z_]+$ ]] && [ -d "$dir" ] && grep -Eq "^LUCI_LANG\.$lang=." "$2" ||
				die "$pkg/po/$lang: not a language directory of luci.mk (LUCI_LANG.$lang)"
			[ "$(sed -n 's/^PKG_PO_VERSION:=//p' "$mk")" = '$(PKG_VERSION)-r$(PKG_RELEASE)' ] ||
				die "$pkg/Makefile: language packages need PKG_PO_VERSION:=\$(PKG_VERSION)-r\$(PKG_RELEASE)"
			lc=$(sed -n "s/^LUCI_LC_ALIAS\.$lang=\([^ ]*\).*/\1/p" "$2")
			lc=${lc:-$lang}
			if [ "$fmt" = apk ]; then
				expected+=("luci-i18n-$base-$lc-$ver-r$rel.apk")
			else
				expected+=("luci-i18n-${base}-${lc}_$ver-r${rel}_all.ipk")
			fi
		done
	done
}

# Runs in the signing container: a second one of the same pinned SDK
# image, without network, and the only place that has the key. /in holds
# the packages and their SHA256SUMS, /pub/key the public key, standard
# input the secret key. It indexes with the SDK's own `make package/index`
# (the feed's name where that target looks for it, as the entrypoint writes
# it), deletes the key, and then checks the signed index with the image's
# own tools before handing it out: it verifies with the public key given
# (so another secret fails here), and it lists exactly these packages, each
# with its own hash. Nothing is fetched or compiled here.
inner_sign=$(cat <<'INNER'
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }
if [ -n "${SDK_SUM:-}" ] && ! grep -Fxq -- "$SDK_SUM" sha256sums_min; then
	cat sha256sums_min
	fail "the SDK in this image is not the pinned tarball"
fi
bin=/builder/staging_dir/host/bin in=/in pub=/pub/key out=/artifacts
case ${SIGN:-} in
	apk) ext=apk key=private-key.pem ;;
	usign) ext=ipk key=key-build ;;
	*) fail "no kind of key named" ;;
esac
( cd "$in" && sha256sum -c --quiet --strict SHA256SUMS ) || fail "the packages do not match SHA256SUMS"
have=$(cd "$in" && ls | grep -vx SHA256SUMS | sort) || fail "no packages"
named=$(sed 's/^[0-9a-f]\{64\}  //' "$in/SHA256SUMS" | sort) || fail "SHA256SUMS cannot be read"
[ "$have" = "$named" ] || fail "the packages are not exactly the ones SHA256SUMS names"

umask 077
cat > "$key"
umask 022
case $SIGN:$(head -n 1 "$key") in
	apk:'-----BEGIN EC PRIVATE KEY-----' | apk:'-----BEGIN PRIVATE KEY-----' | usign:'untrusted comment:'*) ;;
	apk:*) rm -f "$key"; fail "not a PEM private key (apk needs an EC key, see docs/INSTALL.md)" ;;
	*) rm -f "$key"; fail "not a usign secret key" ;;
esac
cp feeds.conf.default feeds.conf
echo "src-link vantage /feed/" >> feeds.conf
make defconfig
arch=$(sed -n 's/^CONFIG_TARGET_ARCH_PACKAGES="\(.*\)"$/\1/p' .config)
[ -n "$arch" ] || { rm -f "$key"; fail "the SDK names no package architecture"; }
d=/builder/bin/packages/$arch/vantage
mkdir -p "$d"
cp "$in"/*."$ext" "$d/"
rc=0
make CONFIG_SIGNED_PACKAGES=y V=s package/index || rc=$?
rm -f "$key"
[ "$rc" -eq 0 ] || fail "the SDK's index target failed"

# from here on there is no key: the signed index against the public key
# and against the packages
cd "$d"
t=$(mktemp -d)
if [ "$SIGN" = apk ]; then
	mkdir "$t/keys"
	cp "$pub" "$t/keys/vantage.pem"
	"$bin/apk" --keys-dir "$t/keys" verify packages.adb || fail "packages.adb does not verify with the public key given"
	# what it lists: the same as an index made here from these files, unsigned
	"$bin/apk" mkndx --allow-untrusted --output "$t/ref.adb" *.apk || fail "no index could be made from the packages"
	"$bin/apk" adbdump packages.adb | grep -v '^# sig ' > "$t/signed" || fail "packages.adb cannot be read"
	"$bin/apk" adbdump "$t/ref.adb" | grep -v '^# sig ' > "$t/ref" || fail "the index made from the packages cannot be read"
	[ -s "$t/ref" ] && cmp -s "$t/signed" "$t/ref" || fail "packages.adb does not list exactly these packages"
	cp packages.adb "$out/"
else
	"$bin/usign" -V -m Packages -p "$pub" || fail "Packages.sig does not verify with the public key given"
	fp=$("$bin/usign" -F -x Packages.sig) || fail "Packages.sig names no key"
	of=$("$bin/usign" -F -p "$pub") || fail "the public key given cannot be read"
	[ -n "$fp" ] && [ "$fp" = "$of" ] || fail "Packages.sig is not that key's"
	gunzip -c Packages.gz > "$t/unpacked" || fail "Packages.gz does not unpack"
	cmp -s "$t/unpacked" Packages || fail "Packages.gz is not Packages"
	# each package's own entry names its file and that file's hash
	awk 'BEGIN { RS = ""; FS = "\n" }
		{ f = ""; h = ""
		  for (i = 1; i <= NF; i++) { if ($i ~ /^Filename: /) f = substr($i, 11); else if ($i ~ /^SHA256sum: /) h = substr($i, 12) }
		  if (f == "" || h == "") exit 3
		  print h "  " f }' Packages > "$t/entries" || fail "Packages has an entry without a file name or a hash"
	sort "$t/entries" > "$t/listed" || fail "the entries of Packages cannot be sorted"
	sort "$in/SHA256SUMS" > "$t/named" || fail "SHA256SUMS cannot be read"
	cmp -s "$t/listed" "$t/named" || fail "Packages does not list exactly these packages, each with its hash"
	echo "$fp" > "$out/fingerprint"
	cp Packages Packages.gz Packages.sig "$out/"
fi
INNER
)

# Runs in the container that makes a throwaway key: the secret key on
# standard output, its public half in /artifacts.
inner_key=$(cat <<'INNER'
set -euo pipefail
bin=/builder/staging_dir/host/bin
cd "$(mktemp -d)"
case ${SIGN:-} in
	apk)
		"$bin/openssl" ecparam -name prime256v1 -genkey -noout -out key
		"$bin/openssl" pkey -in key -pubout -out /artifacts/key.pub
		;;
	usign) "$bin/usign" -G -s key -p /artifacts/key.pub ;;
	*) exit 92 ;;
esac
cat key
INNER
)

# a work directory of this script's, removed
drop() { case $1 in "${TMPDIR:-/tmp}"/vantage-*.?*) rm -rf -- "$1" ;; esac; }

# the package files a directory holds, by name
package_files() { find "$1" -maxdepth 1 \( -name '*.apk' -o -name '*.ipk' \) -printf '%f\n' | sort; }

# a container of the pinned SDK image without network, for the two above:
# the options of `podman run` up to the image, into the array `offline`
offline=(run --rm --pull=missing --network=none
	--userns=keep-id:uid=1000,gid=1000
	--cap-drop=all --security-opt=no-new-privileges
	-e SDK_SUM="$sdk_sum" -e SIGN="$kind")

# The signing step: the index of dist/<release>/ as a build left it. The
# key reaches nothing but the container above. Until 1.2.1 it went to the
# build's container, which fetches the feeds and compiles the packages
# with the network on; now that one never has it. This runs no program a
# build produced (CI runs it on another machine than the build, with only
# the build's packages, sums and BUILDINFO). It signs a complete set only:
# the packages are exactly the ones the built commit's source defines,
# SHA256SUMS names exactly those, and they match it, before the key is
# read and again before anything is written to dist/<release>/.
sign_index() {
	local out="$repo/dist/$release" swork want line from fp f rc=0
	local -a index=() expected=() run=()
	[ -f "$out/SHA256SUMS" ] && [ -f "$out/BUILDINFO" ] || die "nothing to sign in dist/$release: build it first ($0 $release)"
	grep -qx 'signed_index=none' "$out/BUILDINFO" || die "dist/$release has a signed index already; build it again to sign anew"
	from=$(sed -n 's/^rev=\([0-9a-f]\{40\}\)$/\1/p' "$out/BUILDINFO")
	[ -n "$from" ] && git -C "$repo" cat-file -e "$from^{commit}" 2>/dev/null ||
		die "dist/$release/BUILDINFO names no commit of this repository"

	swork=$(mktemp -d "${TMPDIR:-/tmp}/vantage-sign.XXXXXX")
	mkdir "$swork/src" "$swork/in" "$swork/pub" "$swork/artifacts"
	# shellcheck disable=SC2086
	git -C "$repo" archive "$from" -- $packages dev/i18n/luci-languages.mk | tar -x -C "$swork/src" ||
		{ drop "$swork"; die "cannot read the packages' source at $from"; }
	main_names "$swork/src"
	lang_names "$swork/src" "$swork/src/dev/i18n/luci-languages.mk"
	want=$(printf '%s\n' "${expected[@]}" | sort)
	[ "$(sed 's/^[0-9a-f]\{64\}  //' "$out/SHA256SUMS" | sort)" = "$want" ] ||
		{ drop "$swork"; die "dist/$release/SHA256SUMS does not name exactly the packages of $from"; }
	[ "$(package_files "$out")" = "$want" ] ||
		{ drop "$swork"; die "dist/$release does not hold exactly the packages of $from"; }
	for f in "${expected[@]}"; do cp -- "$out/$f" "$swork/in/"; done
	cp -- "$out/SHA256SUMS" "$swork/in/"
	# the copies are what gets indexed
	( cd "$swork/in" && sha256sum -c --quiet --strict SHA256SUMS ) ||
		{ drop "$swork"; die "dist/$release does not match its SHA256SUMS"; }
	cp -- "$pubabs" "$swork/pub/key"

	run=("${offline[@]}" -i -v "$swork/in:/in:ro,z" -v "$swork/pub:/pub:ro,z" -v "$swork/artifacts:/artifacts:z"
		--entrypoint /bin/bash "$sdk_image" -c "$inner_sign")
	# the key: this script's own standard input, or the file, to the container's
	if [ "$keysrc" = - ]; then
		podman "${run[@]}" > "$swork/sign.log" 2>&1 || rc=$?
	else
		podman "${run[@]}" < "$keysrc" > "$swork/sign.log" 2>&1 || rc=$?
	fi
	if [ "$rc" -ne 0 ]; then
		echo "signing the index failed (exit $rc); log: $swork/sign.log" >&2
		tail -n 40 "$swork/sign.log" >&2
		exit 1
	fi

	if [ "$kind" = apk ]; then
		index=(packages.adb)
		line="signed_index=packages.adb\nsigning_public_key_sha256=$(sha256sum < "$swork/pub/key" | cut -d' ' -f1)"
	else
		index=(Packages Packages.gz Packages.sig)
		fp=$(cat "$swork/artifacts/fingerprint" 2>/dev/null || true)
		[[ $fp =~ ^[0-9a-f]{16}$ ]] || die "the signing container named no key fingerprint; log: $swork/sign.log"
		line="signed_index=Packages.sig\nsigning_key_fingerprint=$fp"
	fi
	for f in "${index[@]}"; do
		[ -s "$swork/artifacts/$f" ] || die "signed index file $f missing; log: $swork/sign.log"
	done
	# dist/<release>/ is still what was signed
	cmp -s "$out/SHA256SUMS" "$swork/in/SHA256SUMS" && [ "$(package_files "$out")" = "$want" ] &&
		( cd "$out" && sha256sum -c --quiet --strict "$swork/in/SHA256SUMS" ) ||
		die "dist/$release changed while its index was signed; nothing was written to it (work dir: $swork)"

	sed "s/^signed_index=none\$/$line/" "$out/BUILDINFO" > "$swork/BUILDINFO"
	for f in "${index[@]}"; do cp -- "$swork/artifacts/$f" "$out/"; done
	cp -- "$swork/BUILDINFO" "$out/BUILDINFO"
	drop "$swork"
	echo "signed the index of $out (${index[*]})"
}

# A throwaway key made in the SDK image: the secret key on standard
# output, the public key in the file $1.
throwaway_key() {
	local kwork rc=0
	kwork=$(mktemp -d "${TMPDIR:-/tmp}/vantage-key.XXXXXX")
	mkdir "$kwork/artifacts"
	podman "${offline[@]}" -v "$kwork/artifacts:/artifacts:z" --entrypoint /bin/bash "$sdk_image" -c "$inner_key" \
		< /dev/null 2> "$kwork/key.log" || rc=$?
	if [ "$rc" -ne 0 ] || [ ! -s "$kwork/artifacts/key.pub" ]; then
		echo "making a throwaway key failed (exit $rc); log: $kwork/key.log" >&2
		tail -n 20 "$kwork/key.log" >&2
		exit 1
	fi
	cp -- "$kwork/artifacts/key.pub" "$1"
	drop "$kwork"
}

case $mode in
sign) sign_index; exit 0 ;;
key) throwaway_key "$pubout"; exit 0 ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/vantage-build.XXXXXX")
git clone --quiet --no-local "$repo" "$work/feed"
git -C "$work/feed" checkout --quiet --detach "$rev"
# Since OpenWrt 25.12.5 a package's date (SOURCE_DATE_EPOCH, every file's
# time in it) is its newest file's, no longer its last commit's; a clone's
# files all carry the time of the clone. Date each package's files by the
# last commit that touched the package, as git dated it before, so that
# every build of a commit stays byte-identical.
for p in $packages; do
	t=$(git -C "$work/feed" log -1 --format=%ct -- "$p")
	[[ $t =~ ^[0-9]+$ ]] || die "no commit date for $p"
	find "$work/feed/$p" -exec touch -h -d "@$t" {} +
done
mkdir "$work/artifacts" "$work/out"

# openwrt/gh-action-sdk@f5813d30eeef3534b58ac7e79c5d8842b6035434 entrypoint.sh;
# checked on the copy that is mounted
entry_sha=e78cc3ca3ffe9a15d47096e2e9a2aa07399a22a77acdca31f4e5aef2fa0e6a9c
install -m 0644 "$here/entrypoint.sh" "$work/entrypoint.sh"
echo "$entry_sha  $work/entrypoint.sh" | sha256sum -c --quiet

# expected package file names, from the Makefiles of the commit being built
expected=()
main_names "$work/feed"

# Runs inside the container instead of the entrypoint directly:
# - the release image already contains the extracted SDK, so drop setup.sh,
#   which would download it again (first request over plain HTTP, checked
#   against a keyring that also trusts OpenWrt's snapshot key); instead
#   check that the image's SDK is the pinned tarball;
# - no signing key and no index: this container fetches the feeds and
#   compiles (sign_index above signs, in a container of its own);
# - afterwards hand out the SDK's apk, jsmin and po2lmo so the host can
#   verify the packages with the exact tools that built them, plus the feed
#   pins and the luci feed's luci.mk (language list and package names).
# shellcheck disable=SC2016
inner='
if [ -n "${SDK_SUM:-}" ] && ! grep -Fxq -- "$SDK_SUM" sha256sums_min; then
	echo "::error::the SDK in this image is not the pinned tarball"; cat sha256sums_min; exit 90
fi
rm -f setup.sh
rc=0
bash /entrypoint.sh || rc=$?
mkdir -p /artifacts/tools
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
	-e SDK_SUM="$sdk_sum"
	--entrypoint /bin/bash "$sdk_image" -c "$inner")

podman "${podman_args[@]}" < /dev/null > "$work/build.log" 2>&1 || status=$?
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

# and its language packages, by the SDK's own language list
[ -f "$tools/luci.mk" ] || die "the SDK's feeds/luci/luci.mk was not handed out; log: $work/build.log"
lang_names "$work/feed" "$tools/luci.mk"
# every feed at a commit, so BUILDINFO names what was built
"$here/check-feeds.sh" "$tools/feeds.conf" "$release" || die "unpinned feeds; log: $work/build.log"
# the i18n tooling's LuCI pin is the luci feed of the 25.12 SDK; 24.10's is
# another branch, so only the apk build can compare them
if [ "$fmt" = apk ]; then
	want_luci=$(sed -n 's/^LUCI_REV=\([0-9a-f]\{40\}\)$/\1/p' "$work/feed/dev/i18n/update.sh" 2>/dev/null || true)
	have_luci=$(sed -n 's|^src-git luci [^ ]*\^\([0-9a-f]\{40\}\)$|\1|p' "$tools/feeds.conf" 2>/dev/null || true)
	[ -n "$want_luci" ] && [ "$want_luci" = "$have_luci" ] ||
		die "dev/i18n/update.sh pins LuCI ${want_luci:-nothing}, the SDK's luci feed is ${have_luci:-unknown}"
fi

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

verify=(--src "$work/feed" --require-tools --luci-mk "$tools/luci.mk")
[ ! -x "$tools/apk" ] || verify+=(--apk-tool "$tools/apk")
[ ! -x "$tools/jsmin" ] || verify+=(--jsmin "$tools/jsmin")
[ ! -x "$tools/po2lmo" ] || verify+=(--po2lmo "$tools/po2lmo")
[ ! -f "$tools/luci.config" ] || verify+=(--luci-config "$tools/luci.config")
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
	# sign_index puts the index's name and its key here
	echo "signed_index=none"
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
drop "$work"
echo "built $rev for OpenWrt $release -> $out"
[ -z "$keysrc" ] || sign_index
