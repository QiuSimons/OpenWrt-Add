#!/usr/bin/env python3
"""Incremental build planner and cache manager for OpenWrt-Add."""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile


def compute_source_fingerprint(dir_path: pathlib.Path) -> str:
    """Compute SHA-256 fingerprint of source directory contents."""
    if not dir_path.exists():
        return ""
    if dir_path.is_file():
        h = hashlib.sha256()
        h.update(dir_path.read_bytes())
        return h.hexdigest()

    entries = []
    ignored_names = {'.git', '.svn', '.hg', '__pycache__', '.DS_Store'}

    for root, dirs, files in os.walk(dir_path, followlinks=False):
        dirs[:] = sorted([d for d in dirs if d not in ignored_names])
        for f in sorted(files):
            if f in ignored_names or f.endswith(('.tmp', '.swp', '.pyc')):
                continue
            fpath = os.path.join(root, f)
            relpath = os.path.relpath(fpath, dir_path)
            try:
                if os.path.islink(fpath):
                    target = os.readlink(fpath)
                    entries.append((relpath, f"link:{target}"))
                else:
                    st = os.stat(fpath)
                    with open(fpath, 'rb') as fp:
                        chash = hashlib.sha256(fp.read()).hexdigest()
                    entries.append((relpath, f"file:{st.st_size}:{chash}"))
            except Exception:
                continue

    entries.sort(key=lambda x: x[0])
    hasher = hashlib.sha256()
    for relpath, meta in entries:
        hasher.update(f"{relpath}={meta}\n".encode('utf-8'))
    return hasher.hexdigest()


def parse_packageinfo(packageinfo_path: pathlib.Path):
    """Parse OpenWrt tmp/.packageinfo to map directories to binary package names."""
    dir_to_pkgs = collections.defaultdict(set)
    full_path_to_pkgs = collections.defaultdict(set)
    if not packageinfo_path or not packageinfo_path.is_file():
        return dir_to_pkgs, full_path_to_pkgs

    cur_dir = None
    cur_base = None
    try:
        with open(packageinfo_path, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                line = line.strip()
                if line.startswith('Source-Makefile:'):
                    mk = line.split(':', 1)[1].strip()
                    cur_dir = os.path.dirname(mk)
                    cur_base = os.path.basename(cur_dir)
                elif line.startswith('Package:'):
                    p = line.split(':', 1)[1].strip()
                    if cur_dir:
                        full_path_to_pkgs[cur_dir].add(p)
                    if cur_base:
                        dir_to_pkgs[cur_base].add(p)
    except Exception as e:
        print(f"[WARN] Error reading packageinfo: {e}", file=sys.stderr)

    return dir_to_pkgs, full_path_to_pkgs


def parse_makefile_packages(makefile_path: pathlib.Path) -> set:
    """Extract Package/<name> and KernelPackage/<name> definitions from Makefile."""
    pkgs = set()
    if not makefile_path.is_file():
        return pkgs
    try:
        content = makefile_path.read_text(encoding='utf-8', errors='ignore')
        pkg_name = None
        pkg_m = re.search(r'^PKG_NAME\s*:?=\s*(\S+)', content, re.MULTILINE)
        if pkg_m:
            pkg_name = pkg_m.group(1).strip()

        for m in re.finditer(r'^define\s+(Package|KernelPackage)/([^/\s]+)', content, re.MULTILINE):
            kind = m.group(1)
            name = m.group(2).strip()
            if pkg_name and '$(PKG_NAME)' in name:
                name = name.replace('$(PKG_NAME)', pkg_name)
            if kind == 'KernelPackage':
                pkgs.add(f"kmod-{name}")
            else:
                pkgs.add(name)
    except Exception:
        pass
    return pkgs


def is_valid_apk(apk_path: pathlib.Path) -> bool:
    """Verify APK file existence, minimum size, and valid header."""
    if not apk_path.is_file():
        return False
    size = apk_path.stat().st_size
    if size < 128:
        return False
    try:
        with open(apk_path, 'rb') as fp:
            header = fp.read(512)
        # APK v3 (ADB block: ADBd)
        if header.startswith(b'ADBd'):
            import zlib
            d = zlib.decompressobj(-zlib.MAX_WBITS)
            return len(d.decompress(header[4:])) > 0
        if header.startswith(b'ADB'):
            return True
        # Gzip (APK v2)
        if header.startswith(b'\x1f\x8b'):
            return True
        # Zstd
        if header.startswith(b'\x28\xb5\x2f\xfd'):
            return True
        # Tar
        if len(header) >= 262 and header[257:262] == b'ustar':
            return True
        with tarfile.open(apk_path, 'r:*') as tf:
            return len(tf.getmembers()) > 0
    except Exception:
        return False


def find_apks_for_pkg(apk_dir: pathlib.Path, pkg_name: str) -> list:
    """Find valid APK files matching pkg_name in apk_dir."""
    prefix = pkg_name + '-'
    matched = []
    if not apk_dir.is_dir():
        return matched

    for f in apk_dir.glob(f"{prefix}*.apk"):
        ver_part = f.name[len(prefix):]
        if ver_part and ver_part[0].isdigit() and is_valid_apk(f):
            matched.append(f)
    return matched


def load_manifest(manifest_path: pathlib.Path) -> set:
    """Load package names from manifest file."""
    if not manifest_path or not manifest_path.is_file():
        return set()
    items = set()
    for raw in manifest_path.read_text(encoding='utf-8').splitlines():
        line = raw.split('#', 1)[0].strip()
        if line:
            items.add(line)
    return items


def get_safe_package_dirs(custom_dir: pathlib.Path) -> list:
    """Return valid package directories, ignoring broken symlinks."""
    res = []
    if not custom_dir.is_dir():
        return res
    for d in sorted(custom_dir.iterdir()):
        try:
            if d.is_dir() or (d.is_symlink() and d.resolve().is_dir()):
                res.append(d)
        except Exception:
            continue
    return res


def plan(args):
    """Plan incremental build targets against cache and source fingerprints."""
    custom_dir = pathlib.Path(args.package_dir)
    cache_dir = pathlib.Path(args.cache_dir)
    artifacts_bin = pathlib.Path(args.artifacts_bin)
    out_targets = pathlib.Path(args.output_targets)
    pkginfo_path = pathlib.Path(args.packageinfo) if args.packageinfo else None
    manifest_path = pathlib.Path(args.manifest) if args.manifest else None

    cache_dir.mkdir(parents=True, exist_ok=True)
    artifacts_bin.mkdir(parents=True, exist_ok=True)

    fingerprints = {}
    fp_file = cache_dir / 'fingerprints.json'
    if fp_file.is_file():
        try:
            fingerprints = json.loads(fp_file.read_text(encoding='utf-8'))
        except Exception as e:
            print(f"[WARN] Failed to load fingerprints.json: {e}", file=sys.stderr)

    dir_to_pkgs, _ = parse_packageinfo(pkginfo_path)
    expected = load_manifest(manifest_path)

    if not custom_dir.is_dir():
        print(f"[ERROR] package-dir does not exist: {custom_dir}", file=sys.stderr)
        out_targets.write_text("", encoding='utf-8')
        return 1

    targets_to_build = []
    hits = []
    misses = []
    skipped = []

    package_dirs = get_safe_package_dirs(custom_dir)

    for d in package_dirs:
        pkg_dir_name = d.name
        try:
            real_path = d.resolve()
        except Exception:
            real_path = d

        # Collect produced binary packages
        produced_pkgs = set()
        if pkg_dir_name in dir_to_pkgs:
            produced_pkgs.update(dir_to_pkgs[pkg_dir_name])
        mk_pkgs = parse_makefile_packages(real_path / 'Makefile')
        produced_pkgs.update(mk_pkgs)
        if not produced_pkgs:
            produced_pkgs.add(pkg_dir_name)

        # Filter against defconfig-enabled packages
        if expected:
            needed = (produced_pkgs | {pkg_dir_name}) & expected
            if not needed:
                skipped.append(pkg_dir_name)
                continue
        else:
            needed = produced_pkgs

        curr_fp = compute_source_fingerprint(real_path)
        cached_fp = fingerprints.get(pkg_dir_name)

        missing_apks = []
        cached_apks_for_pkg = []
        for p in needed:
            found = find_apks_for_pkg(cache_dir, p)
            if not found:
                missing_apks.append(p)
            else:
                cached_apks_for_pkg.extend(found)

        is_hit = False
        miss_reason = ""
        if not cached_fp:
            miss_reason = "no cache"
        elif cached_fp != curr_fp:
            miss_reason = "source changed"
        elif missing_apks:
            miss_reason = f"missing apk: {', '.join(missing_apks)}"
        else:
            is_hit = True

        if is_hit:
            for apk in cached_apks_for_pkg:
                dst = artifacts_bin / apk.name
                if not dst.exists() or dst.stat().st_size != apk.stat().st_size:
                    shutil.copy2(apk, dst)
            hits.append((pkg_dir_name, len(cached_apks_for_pkg)))
        else:
            targets_to_build.append(f"package/feeds/custom/{pkg_dir_name}/compile")
            misses.append((pkg_dir_name, miss_reason))

    target_str = " ".join(targets_to_build)
    out_targets.parent.mkdir(parents=True, exist_ok=True)
    out_targets.write_text(target_str, encoding='utf-8')

    print("\n=== Incremental Build Plan ===")
    print(f"Total package dirs: {len(package_dirs)}")
    if skipped:
        print(f"Skipped (defconfig): {len(skipped)}")
    print(f"Cache hits (skip):   {len(hits)}")
    print(f"Need build (miss):   {len(misses)}")

    if misses:
        print("\nTargets to build:")
        for name, reason in misses[:30]:
            print(f"  * {name:<30} -> {reason}")
        if len(misses) > 30:
            print(f"  ... and {len(misses) - 30} more")
    else:
        print("[INFO] All packages cached, skip compile")

    print("=" * 30 + "\n")
    return 0


def save(args):
    """Save new APKs to cache directory and update fingerprints."""
    custom_dir = pathlib.Path(args.package_dir)
    cache_dir = pathlib.Path(args.cache_dir)
    artifacts_bin = pathlib.Path(args.artifacts_bin)
    pkginfo_path = pathlib.Path(args.packageinfo) if args.packageinfo else None
    manifest_path = pathlib.Path(args.manifest) if args.manifest else None

    cache_dir.mkdir(parents=True, exist_ok=True)
    fp_file = cache_dir / 'fingerprints.json'
    fingerprints = {}
    if fp_file.is_file():
        try:
            fingerprints = json.loads(fp_file.read_text(encoding='utf-8'))
        except Exception:
            fingerprints = {}

    dir_to_pkgs, _ = parse_packageinfo(pkginfo_path)
    expected = load_manifest(manifest_path)

    if not custom_dir.is_dir():
        return 0

    saved_count = 0
    package_dirs = get_safe_package_dirs(custom_dir)

    for d in package_dirs:
        pkg_dir_name = d.name
        try:
            real_path = d.resolve()
        except Exception:
            real_path = d

        produced_pkgs = set()
        if pkg_dir_name in dir_to_pkgs:
            produced_pkgs.update(dir_to_pkgs[pkg_dir_name])
        mk_pkgs = parse_makefile_packages(real_path / 'Makefile')
        produced_pkgs.update(mk_pkgs)
        if not produced_pkgs:
            produced_pkgs.add(pkg_dir_name)

        if expected:
            needed = (produced_pkgs | {pkg_dir_name}) & expected
            if not needed:
                continue
        else:
            needed = produced_pkgs

        all_present = True
        new_apks = []
        for p in needed:
            found = find_apks_for_pkg(artifacts_bin, p)
            if not found:
                all_present = False
                break
            latest_apk = sorted(found, key=lambda f: (f.stat().st_mtime, f.name), reverse=True)[0]
            new_apks.append(latest_apk)
            for old in found:
                if old != latest_apk:
                    try:
                        old.unlink()
                    except Exception:
                        pass

        if all_present and new_apks:
            # Purge obsolete APK versions in cache
            for p in needed:
                old_files = find_apks_for_pkg(cache_dir, p)
                new_names = {apk.name for apk in new_apks}
                for old in old_files:
                    if old.name not in new_names:
                        try:
                            old.unlink()
                        except Exception:
                            pass

            for apk in new_apks:
                dst = cache_dir / apk.name
                shutil.copy2(apk, dst)

            fingerprints[pkg_dir_name] = compute_source_fingerprint(real_path)
            saved_count += 1
        else:
            fingerprints.pop(pkg_dir_name, None)

    tmp_fp = cache_dir / 'fingerprints.json.tmp'
    tmp_fp.write_text(json.dumps(fingerprints, indent=2, sort_keys=True), encoding='utf-8')
    tmp_fp.replace(fp_file)

    print(f"[INCREMENTAL] Cache updated: {len(fingerprints)}/{len(package_dirs)} packages cached")
    return 0


def main():
    parser = argparse.ArgumentParser(description="OpenWrt-Add incremental build utility")
    subparsers = parser.add_subparsers(dest='command', required=True)

    plan_p = subparsers.add_parser('plan', help='Plan incremental build targets')
    plan_p.add_argument('--package-dir', required=True, help='Path to package/feeds/custom')
    plan_p.add_argument('--packageinfo', default=None, help='Path to tmp/.packageinfo')
    plan_p.add_argument('--manifest', default=None, help='Path to expected.txt')
    plan_p.add_argument('--cache-dir', required=True, help='APK cache directory')
    plan_p.add_argument('--artifacts-bin', required=True, help='Output artifacts/bin directory')
    plan_p.add_argument('--output-targets', required=True, help='Path to output targets.txt')

    save_p = subparsers.add_parser('save', help='Save built APKs and update fingerprints')
    save_p.add_argument('--package-dir', required=True, help='Path to package/feeds/custom')
    save_p.add_argument('--packageinfo', default=None, help='Path to tmp/.packageinfo')
    save_p.add_argument('--manifest', default=None, help='Path to expected.txt')
    save_p.add_argument('--cache-dir', required=True, help='APK cache directory')
    save_p.add_argument('--artifacts-bin', required=True, help='Output artifacts/bin directory')

    args = parser.parse_args()
    if args.command == 'plan':
        return plan(args)
    elif args.command == 'save':
        return save(args)
    return 0


if __name__ == '__main__':
    sys.exit(main())
