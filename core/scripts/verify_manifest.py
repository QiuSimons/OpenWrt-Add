#!/usr/bin/env python3
"""OpenWrt-Add 包清单闸门

对比"计划编译的包"与"实际产出的 apk"，凡未产出且不在 allowlist 内的包一律失败。
用于堵住 IGNORE_ERRORS=1 造成的静默残缺 feed。
"""
import argparse
import pathlib
import sys


def load_list(path):
    """读取每行一个条目、允许 # 注释与行尾注释的清单。"""
    p = pathlib.Path(path)
    if not p.is_file():
        return set()
    items = set()
    for raw in p.read_text(encoding='utf-8').splitlines():
        line = raw.split('#', 1)[0].strip()
        if line:
            items.add(line)
    return items


def produced(names, package):
    """apk 文件名形如 <pkg>-<version>...，版本以数字开头。"""
    prefix = package + '-'
    return any(n.startswith(prefix) and n[len(prefix):len(prefix) + 1].isdigit()
               for n in names)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--expected', required=True, help='计划编译的包清单')
    ap.add_argument('--apk-dir', required=True, help='实际产出的 apk 目录')
    ap.add_argument('--allow-missing', default='core/assets/build-allow-missing.conf',
                    help='允许缺失的包清单（每行一个包名）')
    args = ap.parse_args()

    expected = load_list(args.expected)
    if not expected:
        print(f'::error::预期包清单为空或缺失: {args.expected}')
        print('::error::（容器内 defconfig 阶段未生成清单，说明编译提前崩了）')
        return 1

    allowed = load_list(args.allow_missing)
    apk_dir = pathlib.Path(args.apk_dir)
    apks = sorted(p.name for p in apk_dir.glob('*.apk')) if apk_dir.is_dir() else []

    missing = sorted(p for p in expected if not produced(apks, p))
    tolerated = [p for p in missing if p in allowed]
    blocking = [p for p in missing if p not in allowed]

    print(f'预期包数: {len(expected)}    产出 apk 数: {len(apks)}')
    if tolerated:
        print('allowlist 内缺失(不阻塞): ' + ', '.join(tolerated))

    if blocking:
        print('')
        print(f'::error::以下 {len(blocking)} 个包未产出 apk:')
        for p in blocking:
            print('  - ' + p)
        print('')
        print('若确认该包本就无法在本 SDK 内构建，请加入 core/assets/build-allow-missing.conf:')
        for p in blocking:
            print(f'  {p}  # 原因')
        return 1

    print('manifest 闸门通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
