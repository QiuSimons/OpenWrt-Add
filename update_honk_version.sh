#!/bin/bash
# Keep the honk package pinned to the latest Glassyiris/honk release.
# Runs inside the Update_PKG workflow after openwrt-honk is cloned.

set -e

HONK_UPSTREAM="Glassyiris/honk"
HONK_ROOT="./openwrt-honk"

# Locate the honk package Makefile regardless of the upstream layout.
HONK_MAKEFILE="$(find "$HONK_ROOT" -type f -name Makefile -exec grep -l '^PKG_NAME:=honk$' {} + | head -n 1)"
if [ -z "$HONK_MAKEFILE" ]; then
	echo "error: cannot find honk/Makefile under $HONK_ROOT" >&2
	exit 1
fi
HONK_SOURCE_MK="$(dirname "$HONK_MAKEFILE")/source.mk"

git_ls_remote() {
	local out=""
	for attempt in 1 2 3 4 5; do
		out="$(git ls-remote "$@" 2>/dev/null)" && break
		sleep 3
	done
	printf '%s' "$out"
}

# Resolve the latest release tag. Test hooks allow overriding the network calls.
if [ -n "$HONK_RELEASE_JSON" ]; then
	HONK_JSON="$HONK_RELEASE_JSON"
elif [ -n "$HONK_RELEASE_TAG" ]; then
	HONK_TAG="$HONK_RELEASE_TAG"
else
	HONK_JSON="$(curl -fsSL --retry 3 --retry-all-errors "https://api.github.com/repos/$HONK_UPSTREAM/releases/latest" 2>/dev/null || true)"
	if [ -n "$HONK_JSON" ]; then
		HONK_TAG="$(printf '%s' "$HONK_JSON" | python3 -c 'import json,sys
data=json.load(sys.stdin)
rel=data if isinstance(data,dict) else next(r for r in data if not r.get("draft") and not r.get("prerelease"))
print(rel["tag_name"])' 2>/dev/null || true)"
	fi
	if [ -z "$HONK_TAG" ]; then
		HONK_TAG="$(git_ls_remote --tags "https://github.com/$HONK_UPSTREAM.git" | awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}' | sort -V | tail -n 1)"
	fi
fi

if [ -z "$HONK_TAG" ]; then
	echo "error: failed to resolve the latest $HONK_UPSTREAM release tag" >&2
	exit 1
fi

# Resolve the commit SHA pointed to by the tag.
HONK_COMMIT="$(git_ls_remote "https://github.com/$HONK_UPSTREAM.git" "refs/tags/${HONK_TAG}^{}" "refs/tags/${HONK_TAG}")"
HONK_COMMIT="$(printf '%s\n' "$HONK_COMMIT" | awk '$2 ~ /\^\{\}/ { print $1; exit }')"
if [ -z "$HONK_COMMIT" ]; then
	HONK_COMMIT="$(git_ls_remote "https://github.com/$HONK_UPSTREAM.git" "refs/tags/${HONK_TAG}" | awk 'NR==1 { print $1 }')"
fi

if [ -z "$HONK_COMMIT" ]; then
	echo "error: failed to resolve commit for tag $HONK_TAG" >&2
	exit 1
fi

# apk/ipk-safe version: strip a leading v and move the qualifier after an
# underscore, e.g. v0.0.1.beta.32 -> 0.0.1_beta32.
HONK_VERSION="$(printf '%s' "$HONK_TAG" | sed -e 's/^[vV]//')"
HONK_PREFIX="$(printf '%s' "$HONK_VERSION" | sed -E 's/[A-Za-z].*$//' | sed -E 's/[^0-9.]+$//; s/\.$//')"
HONK_SUFFIX="$(printf '%s' "$HONK_VERSION" | sed -E 's/^[^A-Za-z]*//' | tr -cd 'A-Za-z0-9')"
if [ -n "$HONK_PREFIX" ] && [ -n "$HONK_SUFFIX" ]; then
	HONK_VERSION="${HONK_PREFIX}_${HONK_SUFFIX}"
elif [ -n "$HONK_PREFIX" ]; then
	HONK_VERSION="$HONK_PREFIX"
else
	HONK_VERSION="$(printf '%s' "$HONK_VERSION" | sed -e 's/[^0-9.]/./g' -e 's/\.\{2,\}/./g' -e 's/^\.//' -e 's/\.$//')"
fi
if [ -z "$HONK_VERSION" ]; then
	echo "error: release tag '$HONK_TAG' does not contain a usable version" >&2
	exit 1
fi

# Update an existing PKG_* variable, or insert it before package.mk is included.
set_pkg_var() {
	local file="$1" key="$2" value="$3"
	if grep -q "^$key:=" "$file"; then
		sed -i "s|^$key:=.*|$key:=$value|" "$file"
	elif grep -q '^include $(INCLUDE_DIR)/package.mk' "$file"; then
		awk -v key="$key" -v value="$value" '
			/^include \$\(INCLUDE_DIR\)\/package\.mk/ && !done {
				print key ":=" value
				done = 1
			}
			{ print }
		' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
	else
		printf '%s:=%s\n' "$key" "$value" >> "$file"
	fi
}

set_pkg_var "$HONK_MAKEFILE" PKG_VERSION "$HONK_VERSION"
set_pkg_var "$HONK_SOURCE_MK" PKG_SOURCE_VERSION "$HONK_COMMIT"
set_pkg_var "$HONK_SOURCE_MK" PKG_SOURCE "$HONK_COMMIT.tar.gz"
set_pkg_var "$HONK_SOURCE_MK" PKG_SOURCE_URL "https://github.com/$HONK_UPSTREAM/archive"
set_pkg_var "$HONK_SOURCE_MK" PKG_MIRROR_HASH skip

echo "honk updated to $HONK_TAG ($HONK_COMMIT, PKG_VERSION=$HONK_VERSION)"
grep -E '^PKG_VERSION:=' "$HONK_MAKEFILE"
grep -E '^(PKG_SOURCE_VERSION|PKG_SOURCE|PKG_SOURCE_URL|PKG_MIRROR_HASH):=' "$HONK_SOURCE_MK"
