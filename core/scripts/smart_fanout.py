#!/usr/bin/env python3
"""Route and fan out APK packages to target architectures based on metadata."""
import os, re, shutil, sys, argparse, tarfile, zlib

ARM64 = ['aarch64_generic', 'aarch64_cortex-a53', 'aarch64_cortex-a72', 'aarch64_cortex-a76', 'aarch64_cortex-a55']
ARCH_RE = re.compile(r'(aarch64_cortex-a\d+|aarch64_generic|aarch64|x86_64|i386_pentium4|arm_cortex-a\d+[a-z0-9_]*|mipsel_[a-z0-9_]+|mips_24kc|riscv64_generic|_all(?=\.apk$)|-all-)')
ARCH_V3_RE = re.compile(rb'\b(aarch64_generic|aarch64|x86_64|i386_pentium4|arm_cortex-a\d+[a-z0-9_]*|mipsel_[a-z0-9_]+|mips_24kc|riscv64_generic|noarch|all)\b')


def get_apk_arch(path):
    """Determine target architecture from APK v3 ADB header, .PKGINFO, or path."""
    # 1. Try APK v3 (ADB format)
    try:
        with open(path, 'rb') as f:
            data = f.read(4096)
        if data.startswith(b'ADBd'):
            d = zlib.decompressobj(-zlib.MAX_WBITS)
            decomp = d.decompress(data[4:4096])
            m = ARCH_V3_RE.search(decomp[:1024])
            if m:
                a = m.group(1).decode('ascii')
                if a in ('all', 'noarch'):
                    return 'all'
                if a in ('aarch64', 'aarch64_generic'):
                    return 'aarch64_generic'
                return a
    except Exception:
        pass

    # 2. Try APK v2 (.PKGINFO in tar/tar.gz)
    try:
        with tarfile.open(path, 'r:*') as tar:
            for m in tar.getmembers():
                if m.name in ('.PKGINFO', 'PKGINFO'):
                    f = tar.extractfile(m)
                    if f:
                        for line in f.read().decode('utf-8', errors='ignore').splitlines():
                            if line.startswith('arch ='):
                                a = line.split('=', 1)[1].strip()
                                if a in ('all', 'noarch'):
                                    return 'all'
                                if a in ('aarch64', 'aarch64_generic'):
                                    return 'aarch64_generic'
                                return a
    except Exception:
        pass

    # Infer architecture from parent directory or filename
    m = ARCH_RE.search(path)
    if m:
        a = m.group(1)
        if a in ('_all', '-all-'):
            return 'all'
        if a in ('aarch64', 'aarch64_generic'):
            return 'aarch64_generic'
        return a

    # UI and translations default to architecture-independent
    name = os.path.basename(path)
    if name.startswith(('luci-', 'translations-')):
        return 'all'

    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument('src')
    p.add_argument('out')
    p.add_argument('--alias-generic', action='store_true', default=True, help='Fan out aarch64_generic to all aarch64 targets')
    a = p.parse_args()

    os.makedirs(a.out, exist_ok=True)
    apks = [os.path.join(r, f) for r, _, fs in os.walk(a.src) for f in fs if f.endswith('.apk')]
    if not apks:
        print('[WARN] no apk found in ' + a.src)
        return 0

    targets = set(ARM64) | {'x86_64'}
    for d in targets:
        os.makedirs(os.path.join(a.out, d), exist_ok=True)

    for f in apks:
        n = os.path.basename(f)
        arch = get_apk_arch(f)

        if arch is None or arch == 'all':
            # Architecture-independent package
            for t in targets:
                shutil.copy2(f, os.path.join(a.out, t, n))
            print('  [all] ' + n)
        elif arch in ('aarch64_generic', 'aarch64'):
            # aarch64 binary
            dst_archs = ARM64 if a.alias_generic else ['aarch64_generic']
            for t in dst_archs:
                shutil.copy2(f, os.path.join(a.out, t, n))
            print('  [arm64] ' + n)
        elif arch == 'x86_64':
            # x86_64 binary
            shutil.copy2(f, os.path.join(a.out, 'x86_64', n))
            print('  [x86_64] ' + n)
        else:
            os.makedirs(os.path.join(a.out, arch), exist_ok=True)
            shutil.copy2(f, os.path.join(a.out, arch, n))
            print('  [' + arch + '] ' + n)

    print('[INFO] Smart fan-out completed for %d apks' % len(apks))
    return 0


if __name__ == '__main__':
    sys.exit(main())
