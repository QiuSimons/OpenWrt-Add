#!/usr/bin/env python3
"""verify_manifest.py 行为验证。

核心约定：单个插件编译不过只告警、不阻塞；只有整体性故障（清单为空 / 零产物）才拒绝发布。
"""
import io
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile


def create_dummy_apk(path: pathlib.Path, pkg: str, ver: str):
    """最小合法 APK（gzip tar，含 .PKGINFO）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tf:
        info = f"pkgname = {pkg}\npkgver = {ver}\narch = x86_64\n".encode()
        ti = tarfile.TarInfo(name='.PKGINFO')
        ti.size = len(info)
        ti.mtime = 1700000000
        tf.addfile(ti, io.BytesIO(info))
    path.write_bytes(buf.getvalue())


def write_list(path: pathlib.Path, items):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(items) + ('\n' if items else ''), encoding='utf-8')


def run(cmd):
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return res.returncode, res.stdout + res.stderr


def main():
    verify = pathlib.Path(__file__).resolve().parent / 'verify_manifest.py'
    work = pathlib.Path(tempfile.mkdtemp(prefix='openwrt_gate_test_'))
    try:
        expected = work / 'manifest' / 'expected.txt'
        apk_dir = work / 'artifacts' / 'bin'
        cache = work / 'cached_apks'
        allow = work / 'allow-missing.conf'
        apk_dir.mkdir(parents=True)
        cache.mkdir()
        write_list(allow, ['luci-app-skip  # 本 SDK 内无法构建'])

        base = (f'"{sys.executable}" {verify} --expected {expected} --apk-dir {apk_dir} '
                f'--allow-missing {allow}')

        # 1) 单包失败：放行，只告警
        print('\n--- [1] 单个插件未产出仍然放行 ---')
        write_list(expected, ['luci-app-a', 'luci-app-bad'])
        create_dummy_apk(apk_dir / 'luci-app-a-1.0-r1.apk', 'luci-app-a', '1.0-r1')
        rc, out = run(base)
        assert rc == 0, f'单包失败不应阻塞发布: rc={rc}\n{out}'
        assert '::warning::' in out and 'luci-app-bad' in out, out
        print('PASS')

        # 2) 缓存里有上一版产物：顶替，feed 不掉包
        print('\n--- [2] 用上一版 apk 顶替 ---')
        create_dummy_apk(cache / 'luci-app-bad-0.9-r1.apk', 'luci-app-bad', '0.9-r1')
        rc, out = run(base + f' --fallback-dir {cache}')
        assert rc == 0, out
        assert (apk_dir / 'luci-app-bad-0.9-r1.apk').is_file(), '顶替产物未写回产物目录'
        assert '顶替: 1' in out, out
        print('PASS')

        # 3) allowlist 内的缺失：忽略且不告警
        print('\n--- [3] allowlist 缺失被忽略 ---')
        write_list(expected, ['luci-app-a', 'luci-app-skip'])
        rc, out = run(base)
        assert rc == 0, out
        assert '::warning::' not in out, out
        print('PASS')

        # 4) 预期清单为空（defconfig 崩了）：拒绝发布
        print('\n--- [4] 空清单拒绝发布 ---')
        write_list(expected, [])
        rc, out = run(base)
        assert rc == 1, f'空清单必须拒绝发布: rc={rc}\n{out}'
        print('PASS')

        # 5) 预期包全没产出：拒绝发布（哪怕目录里有别的 apk）
        print('\n--- [5] 预期包全无产出拒绝发布 ---')
        write_list(expected, ['luci-app-a'])
        for f in apk_dir.glob('*.apk'):
            f.unlink()
        create_dummy_apk(apk_dir / 'unrelated-1.0-r1.apk', 'unrelated', '1.0-r1')
        rc, out = run(base)
        assert rc == 1, f'预期包全无产出必须拒绝发布: rc={rc}\n{out}'
        print('PASS')

        print('\n=== manifest 闸门 5 项场景测试全部通过 ===')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
