#!/usr/bin/env python3
"""按文件名判定架构并分发 APK 到各架构目录。"""
import os, re, shutil, sys, argparse

ARM64 = ['aarch64_generic','aarch64_cortex-a53','aarch64_cortex-a72','aarch64_cortex-a76','aarch64_cortex-a55']
ARCH_RE = re.compile(r'(aarch64_cortex-a\d+|aarch64_generic|x86_64|i386_pentium4|arm_cortex-a\d+[a-z0-9_]*|mipsel_[a-z0-9_]+|mips_24kc|riscv64_generic|_all(?=\.apk$)|-all-)')

def detect_arch(name):
    m = ARCH_RE.search(name)
    if not m:
        return None
    a = m.group(1)
    if a in ('_all','-all-'):
        return 'all'
    return a

def main():
    p = argparse.ArgumentParser()
    p.add_argument('src'); p.add_argument('out')
    p.add_argument('--alias-generic', action='store_true')
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    apks = [os.path.join(r,f) for r,_,fs in os.walk(a.src) for f in fs if f.endswith('.apk')]
    if not apks:
        print('[WARN] no apk found in ' + a.src); return 0
    targets = set(ARM64) | {'x86_64'}
    for d in targets: os.makedirs(os.path.join(a.out,d), exist_ok=True)
    unknown = []
    for f in apks:
        n = os.path.basename(f); arch = detect_arch(n)
        if arch is None:
            unknown.append(n); continue
        if arch == 'all':
            for t in targets: shutil.copy2(f, os.path.join(a.out,t,n))
            print('  [all] ' + n)
        elif arch == 'aarch64_generic':
            shutil.copy2(f, os.path.join(a.out,'aarch64_generic',n))
            if a.alias_generic:
                for t in ARM64:
                    if t != 'aarch64_generic': shutil.copy2(f, os.path.join(a.out,t,n))
            print('  [generic] ' + n)
        else:
            os.makedirs(os.path.join(a.out,arch), exist_ok=True)
            shutil.copy2(f, os.path.join(a.out,arch,n))
            print('  [' + arch + '] ' + n)
    if unknown:
        print('[ERROR] cannot detect arch from filename: ' + ', '.join(unknown))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
