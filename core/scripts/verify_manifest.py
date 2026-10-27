#!/usr/bin/env python3
"""OpenWrt-Add 包清单闸门

对比"计划编译的包"与"实际产出的 apk"，凡未产出且不在 allowlist 内的包一律失败。
用于堵住 IGNORE_ERRORS=1 造成的静默残缺 feed。
"""
import argparse
import pathlib
import sys


def load_list(path, allow_missing=False):
    p = pathlib.Path(path)
    if not p.is_file():
        return set()
    out = set()
    for raw in p.read_text(encoding='utf-8').splitlines():
        line = raw.split('#', 1)[0].strip()
        if line:
            out.add(line)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--expected', required=True, help='计划编译的包清单')
    ap.add_argument('--apk-dir', required=True, help='实际产出的 apk 目录')
    ap.add_argument('--allow-missing', default='core/assets/build-allow-missing.conf')
    ap.add_argument('--max-missing', type=int, default=0,
                    help='允许缺失的最大包数，超限即失败')
    ap.add_argument('--allow-empty', action='store_true',
                    help='允许预期清单为空（仅本地调试用）')
    ap.add_argument('--allow-empty', action='store_true',
                    help='允许预期清单为空（仅本地调试用）')
    args = ap.parse_args()

    expected = load_list(args.expected)
    allowed = load_list(args.allow_missing)

    if not expected and not args.allow_empty:
        print('::error::预期包清单为空或缺失: %s' % args.expected)
        print('::error::（容器内 defconfig 阶段未生成清单，说明编译提前崩了）')
        return 1

    if not expected and not args.allow_empty:
        print('::error::预期包清单为空或缺失: %s' % args.expected)
        print('::error::（容器内 defconfig 阶段未生成清单，说明编译提前崩了）')
        return 1

    apk_dir = pathlib.Path(args.apk_dir)
    apks = sorted(p.name for p in apk_dir.glob('*.apk')) if apk_dir.is_dir() else []

    def produced(name):
        prefix = name + '-'
        return any(
            f.startswith(prefix) and f[len(prefix):len(prefix) + 1].isdigit()
            for f in apks
        )

    missing = [p for p in sorted(expected) if not produced(p)]
    tolerated = [p for p in missing if p in allowed]
    real_missing = [p for p in missing if p not in allowed]

    print(f'预期包数: {len(expected)}    产出 apk 数: {len(apks)}')

    if tolerated:
        print('allowlist 内缺失(不阻塞): ' + ', '.join(tolerated))

    if real_missing:
        print('')
        print('::error::以下 %d 个包未产出 apk:' % len(real_missing))
        for p in real_missing:
            print('  - ' + p)
        if len(real_missing) > args.max_missing:
            print('')
            print('若确认该包本就无法在本 SDK 内构建，请加入 core/assets/build-allow-missing.conf:')
            for p in real_missing:
                print(f'  {p}  # 原因')
            return 1
        print('缺失数在阈值内，放行')

    print('manifest 闸门通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
