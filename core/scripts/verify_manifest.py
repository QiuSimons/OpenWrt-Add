#!/usr/bin/env python3
"""OpenWrt-Add 包清单闸门

对比"计划编译的包"与"实际产出的 apk"，只回答一个问题：这份 feed 能不能发布。

- 个别插件没产出：只告警、照常发布——一个插件编译不过不该阻塞其它插件的更新；
- 缓存里还有该包上一次成功产物时顺手回填，避免失败的插件从 feed 里消失；
- allowlist(core/assets/build-allow-missing.conf) 内的缺失不告警；
- 只有"预期包一个都产不出来"时才拒绝发布，避免用空源覆盖线上 feed。
"""
import argparse
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from incremental_build import find_apks_for_pkg  # noqa: E402  (复用 APK 前缀/完整性校验)


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
    ap.add_argument('--fallback-dir', default='',
                    help='上一次成功产物的缓存目录；本次没编译出来的包用它顶替，feed 不掉包')
    args = ap.parse_args()

    expected = load_list(args.expected)
    if not expected:
        print(f'::error::预期包清单为空或缺失: {args.expected}')
        print('::error::（容器内 defconfig 阶段未生成清单，说明编译提前崩了）')
        return 1

    allowed = load_list(args.allow_missing)
    apk_dir = pathlib.Path(args.apk_dir)
    apk_dir.mkdir(parents=True, exist_ok=True)
    names = sorted(p.name for p in apk_dir.glob('*.apk'))

    fallback_dir = pathlib.Path(args.fallback_dir) if args.fallback_dir else None
    if fallback_dir is not None and not fallback_dir.is_dir():
        fallback_dir = None

    tolerated, carried, blocking = [], [], []
    for pkg in sorted(p for p in expected if not produced(names, p)):
        found = find_apks_for_pkg(fallback_dir, pkg) if fallback_dir is not None else []
        fallback = max(found, key=lambda f: (f.stat().st_mtime, f.name)) if found else None
        if pkg in allowed:
            tolerated.append(pkg)
        elif fallback is not None:
            dst = apk_dir / fallback.name
            if not dst.exists():
                shutil.copy2(fallback, dst)
                names.append(fallback.name)
            carried.append(f'{pkg} {fallback.name}')
        else:
            blocking.append(pkg)

    covered = [p for p in expected if produced(names, p)]
    print(f'预期包数: {len(expected)}    产出: {len(covered)}    '
          f'顶替: {len(carried)}    未产出: {len(blocking)}')
    if tolerated:
        print('allowlist 内缺失（忽略）: ' + ', '.join(tolerated))
    if carried:
        print('本次没编译出来、已用上一版产物顶替:')
        for item in carried:
            print('  ~ ' + item)
        print(f'::warning::以下 {len(carried)} 个插件本次编译失败，已用上一版 apk 顶替: '
              + ', '.join(item.split(' ', 1)[0] for item in carried))
    if blocking:
        print('')
        print(f'::warning::以下 {len(blocking)} 个插件本次未产出 apk（不阻塞其它插件更新）:')
        for p in blocking:
            print('  - ' + p)

    if not covered:
        print('::error::预期包一个都没有产出，拒绝发布空软件源')
        return 1

    print('manifest 闸门放行')
    return 0


if __name__ == '__main__':
    sys.exit(main())
