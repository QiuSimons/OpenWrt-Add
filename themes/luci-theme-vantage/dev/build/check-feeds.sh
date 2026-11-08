#!/usr/bin/env bash
# Is every feed of an SDK build pinned? Each must be at a commit; only the
# base feed of a 24.10 build may name the tag of the release being built
# instead, which is how the 24.10 SDK ships it. Used by sdk-build.sh.
#
#   check-feeds.sh <feeds.conf> <release>
set -euo pipefail

file=$1 release=$2
[ -s "$file" ] || { echo "check-feeds: $file is missing or empty" >&2; exit 1; }

bad=0 tag=";v$release"
while IFS= read -r line || [ -n "$line" ]; do
	case $line in
		'' | '#'* | 'src-link '*) continue ;;
	esac
	[[ $line =~ \^[0-9a-f]{40}$ ]] && continue
	[[ $release == 24.10.* && $line =~ ^src-git(-full)?\ (--root=[a-z]+\ )?base\  && $line == *"$tag" ]] && continue
	echo "check-feeds: not pinned to a commit: $line" >&2
	bad=1
done < "$file"
exit "$bad"
