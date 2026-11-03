#!/usr/bin/env bash
# The replay with official LuCI add-ons, to check their pages under the
# theme (see "Add-on pages" in dev/replay/README.md).
#
#   dev/replay/addons.sh [--port 8150] [--bootstrap] [--no-demo]
#                        [--cache <dir>] [--fetch-only] [-- <server.js args>...]
#
# Fetches the add-ons from openwrt/luci at LUCI_REV and four adblock/banip
# data files from openwrt/packages at PACKAGES_REV (sparse, shallow fetches
# of those paths only) into a cache outside the repository,
# ${XDG_CACHE_HOME:-~/.cache}/vantage/addons-<luci>-<packages> or --cache
# <dir>. Copies the data files the add-ons read from the device (feed lists,
# statistics plugin descriptions, DoH providers) into <cache>/fixtures,
# then starts dev/replay/server.js with the theme, the dashboard, every
# add-on as --app-dir and dev/replay/fixtures/addons plus <cache>/fixtures
# as --fixtures, pseudonymised (--demo).
#
#   --bootstrap   no --theme-dir: the same pages under Bootstrap, as a control
#   --no-demo     serve the recording as recorded (not for screenshots)
#   --fetch-only  fetch and prepare the cache, print the server command
#
# Recording: $VANTAGE_MIRROR or ../vantage-mirror next to the repository;
# rootfs: $VANTAGE_ROOTFS or the server's default. Nothing fetched runs in
# the replay's process: --app-dir serves the add-ons' static files to the
# browser and reads their menu.d JSON and uci defaults as data, and the
# fixture copies are data.
#
# Needs git, GNU coreutils (realpath -m) and Node.js.
set -euo pipefail

# openwrt-25.12 heads on 2026-10-11, the commits the add-ons were reviewed at
LUCI_REV=8125d1288b359f6df505d3328b712bf059843fc8       # treewide: wrap loose view content in cbi-section
PACKAGES_REV=54d77dd5714bb4747c4bf061735304d18076de0b   # openssh: update to 10.6_p1
LUCI_URL=https://github.com/openwrt/luci.git
PACKAGES_URL=https://github.com/openwrt/packages.git

# luci-app-openvpn is still Lua (luasrc/, no menu.d): the replay cannot run it
ADDONS=(
	applications/luci-app-acme
	applications/luci-app-adblock
	applications/luci-app-attendedsysupgrade
	applications/luci-app-banip
	applications/luci-app-ddns
	applications/luci-app-https-dns-proxy
	applications/luci-app-nlbwmon
	applications/luci-app-sqm
	applications/luci-app-statistics
	applications/luci-app-ttyd
	applications/luci-app-upnp
	applications/luci-app-watchcat
	applications/luci-app-wol
	protocols/luci-proto-wireguard
	libs/luci-lib-chartjs
)
# feed and country lists the adblock and banIP pages read (cgi-download)
PACKAGE_FILES=(
	net/adblock/files/adblock.feeds
	net/adblock/files/adblock.categories
	net/banip/files/banip.feeds
	net/banip/files/banip.countries
)

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

die() { echo "addons.sh: $*" >&2; exit 2; }

port=8150 demo=1 theme=1 fetch_only=0
cache=${XDG_CACHE_HOME:-$HOME/.cache}/vantage/addons-${LUCI_REV:0:12}-${PACKAGES_REV:0:12}
while [ $# -gt 0 ]; do
	case $1 in
	--port) [ $# -ge 2 ] || die "--port needs a value"; port=$2; shift 2 ;;
	--port=*) port=${1#--port=}; shift ;;
	--cache) [ $# -ge 2 ] || die "--cache needs a value"; cache=$2; shift 2 ;;
	--cache=*) cache=${1#--cache=}; shift ;;
	--bootstrap) theme=0; shift ;;
	--no-demo) demo=0; shift ;;
	--fetch-only) fetch_only=1; shift ;;
	--) shift; break ;;
	-h|--help) sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$0"; exit 0 ;;
	*) die "unknown argument $1 (server.js arguments go after --)" ;;
	esac
done
[[ $port =~ ^[0-9]+$ ]] && [ "$port" -gt 0 ] && [ "$port" -lt 65536 ] || die "bad --port $port"

# third-party sources never go into the repository
cache=$(realpath -m -- "$cache")
case $cache/ in "$(cd "$repo" && pwd -P)"/*) die "--cache $cache is inside the repository; pick a directory outside it" ;; esac
mkdir -p -- "$cache"

# fetch <url> <rev> <dest> <no-cone pattern>...: a sparse, shallow checkout
# of exactly <rev>; symlinks are checked out as plain files
# (core.symlinks=false), so nothing served from it can point elsewhere
fetch() {
	local url=$1 rev=$2 dest=$3 tmp
	shift 3
	if [ ! -d "$dest" ]; then
		command -v git >/dev/null || die "git not found"
		echo "addons.sh: fetching ${url%.git}@${rev:0:12} ($# paths) into $dest" >&2
		tmp=$(mktemp -d "$cache/fetch.XXXXXX")
		if ! {
			git -c init.defaultBranch=main init -q "$tmp" &&
			git -C "$tmp" config core.symlinks false &&
			git -C "$tmp" remote add origin "$url" &&
			git -C "$tmp" sparse-checkout set --no-cone "$@" &&
			git -C "$tmp" fetch -q --depth 1 --filter=blob:none origin "$rev" &&
			git -C "$tmp" checkout -q --detach FETCH_HEAD
		}; then
			die "could not fetch $url at $rev (network?); the partial fetch is in $tmp, delete it by hand"
		fi
		mv -- "$tmp" "$dest"
	fi
	[ "$(git -C "$dest" rev-parse HEAD 2>/dev/null)" = "$rev" ] && git -C "$dest" diff --quiet HEAD -- 2>/dev/null ||
		die "$dest is not a clean checkout of $rev; delete that directory and run again"
}

src=$cache/luci pkgs=$cache/packages fx=$cache/fixtures
patterns=()
for a in "${ADDONS[@]}"; do patterns+=("/$a/"); done
fetch "$LUCI_URL" "$LUCI_REV" "$src" "${patterns[@]}"
patterns=()
for f in "${PACKAGE_FILES[@]}"; do patterns+=("/$f"); done
fetch "$PACKAGES_URL" "$PACKAGES_REV" "$pkgs" "${patterns[@]}"
for a in "${ADDONS[@]}"; do [ -d "$src/$a" ] || die "$src lacks $a; delete $src and run again"; done
for f in "${PACKAGE_FILES[@]}"; do [ -f "$pkgs/$f" ] || die "$pkgs lacks $f; delete $pkgs and run again"; done

# data the add-ons read from the device's file system, taken from the
# packages themselves; built once per cache (it depends only on the pins)
if [ ! -d "$fx" ]; then
	stage=$(mktemp -d "$cache/fixtures.XXXXXX")
	put() { # <source file or directory/*>... <device directory>
		local to=$stage/root${*: -1}
		mkdir -p -- "$to"
		cp -- "${@:1:$#-1}" "$to/"
	}
	stat=$src/applications/luci-app-statistics
	put "$stat"/root/usr/share/luci/statistics/plugins/*.json /usr/share/luci/statistics/plugins
	put "$stat"/htdocs/luci-static/resources/statistics/rrdtool/definitions/*.js /www/luci-static/resources/statistics/rrdtool/definitions
	put "$src"/applications/luci-app-https-dns-proxy/root/usr/share/https-dns-proxy/providers/*.json /usr/share/https-dns-proxy/providers
	put "$pkgs"/net/adblock/files/adblock.{feeds,categories} /etc/adblock
	put "$pkgs"/net/banip/files/banip.{feeds,countries} /etc/banip
	mv -- "$stage" "$fx"
fi

mirror=${VANTAGE_MIRROR:-$(dirname "$repo")/vantage-mirror}
args=(--mirror "$mirror" --port "$port")
[ -n "${VANTAGE_ROOTFS:-}" ] && args+=(--rootfs "$VANTAGE_ROOTFS")
[ "$demo" = 1 ] && args+=(--demo)
[ "$theme" = 1 ] && args+=(--theme-dir "$repo/luci-theme-vantage/htdocs/luci-static/vantage" --theme vantage)
args+=(--app-dir "$repo/luci-app-vantage")
for a in "${ADDONS[@]}"; do args+=(--app-dir "$src/$a"); done
args+=(--fixtures "$repo/dev/replay/fixtures/addons" --fixtures "$fx")
args+=("$@")

if [ "$fetch_only" = 1 ]; then
	printf '%q ' node "$repo/dev/replay/server.js" "${args[@]}"
	echo
	exit 0
fi
[ -d "$mirror" ] || die "no recording at $mirror (set VANTAGE_MIRROR; see dev/replay/README.md)"
exec node "$repo/dev/replay/server.js" "${args[@]}"
