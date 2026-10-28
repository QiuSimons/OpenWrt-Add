#!/usr/bin/env bash
# ==============================================================================
# Generate Signed APK Index (packages.adb) for Each Architecture
#
# Runs inside the SDK container with access to host-built apk tool.
# ==============================================================================
set -euo pipefail

APK=/builder/staging_dir/host/bin/apk
[ -x "$APK" ] || { echo "::error::apk not found in SDK image"; exit 1; }
"$APK" --version | head -n 1

[ -f /certs/feed-key.pem ] || { echo "::error::Signing key /certs/feed-key.pem not found"; exit 1; }

for dir in /public/*/; do
  [ -d "$dir" ] || continue
  arch=$(basename "$dir")
  [ "$arch" = keys ] && continue
  shopt -s nullglob
  files=("$dir"*.apk)
  [ ${#files[@]} -gt 0 ] || continue
  echo "--> indexing $arch (${#files[@]} apk)"

  max_retries=5
  attempt=0
  indexed=0
  while [ "$attempt" -lt "$max_retries" ]; do
    attempt=$((attempt + 1))
    shopt -s nullglob
    cur_files=("$dir"*.apk)
    [ ${#cur_files[@]} -gt 0 ] || { echo "::warning::[$arch] no apks found"; break; }

    set +e
    out=$(cd "$dir" && "$APK" mkndx --allow-untrusted -o packages.adb --sign /certs/feed-key.pem "${cur_files[@]}" 2>&1)
    ret=$?
    set -e

    if [ $ret -eq 0 ]; then
      echo "--> successfully indexed $arch"
      indexed=1
      break
    fi

    echo "$out"
    bad_files=$(printf '%s\n' "$out" | sed -n 's/^ERROR:[[:space:]]*\([^: ]*\.apk\).*/\1/p' | sort -u || true)

    removed=0
    if [ -n "$bad_files" ]; then
      for bf in $bad_files; do
        target_file=""
        if [ -f "$bf" ]; then
          target_file="$bf"
        elif [ -f "$dir/$(basename "$bf")" ]; then
          target_file="$dir/$(basename "$bf")"
        fi
        if [ -n "$target_file" ]; then
          echo "::warning::[$arch] removing invalid apk: $target_file"
          rm -f "$target_file"
          removed=1
        fi
      done
    fi

    if [ "$removed" -eq 0 ]; then
      echo "::warning::[$arch] mkndx failed with non-recoverable error"
      break
    fi
  done

  if [ "$indexed" -ne 1 ]; then
    echo "::warning::[$arch] failed to create signed packages.adb index after retries"
  fi
done
