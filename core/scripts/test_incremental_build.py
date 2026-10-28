#!/usr/bin/env python3
"""OpenWrt-Add 增量编译逻辑验证测试。"""
import gzip
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile


def create_dummy_apk(path: pathlib.Path, pkg_name: str, version: str):
    """创建一个最小合法的 APK (gzip 格式 tar 归档，包含 .PKGINFO)。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tf:
        info_content = f"pkgname = {pkg_name}\npkgver = {version}\narch = x86_64\n".encode('utf-8')
        ti = tarfile.TarInfo(name='.PKGINFO')
        ti.size = len(info_content)
        ti.mtime = 1700000000
        tf.addfile(ti, io.BytesIO(info_content))
    path.write_bytes(buf.getvalue())


def run_cmd(cmd, env=None):
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
    return res.returncode, res.stdout, res.stderr


def main():
    print("=" * 60)
    print(">>> 开始执行 OpenWrt-Add 增量编译逻辑替代法验证 <<<")
    print("=" * 60)

    work_dir = pathlib.Path(tempfile.mkdtemp(prefix="openwrt_inc_test_"))
    script_path = pathlib.Path(__file__).resolve().parent / "incremental_build.py"
    manifest_checker = pathlib.Path(__file__).resolve().parent / "verify_manifest.py"

    try:
        # 1. 构造模拟环境
        pkg_feed_dir = work_dir / "package" / "feeds" / "custom"
        pkg_feed_dir.mkdir(parents=True)
        cached_apks = work_dir / "cached_apks"
        artifacts_bin = work_dir / "artifacts" / "bin"
        targets_file = work_dir / "targets.txt"
        manifest_file = work_dir / "manifest" / "expected.txt"
        manifest_file.parent.mkdir(parents=True)
        pkginfo_file = work_dir / "tmp" / ".packageinfo"
        pkginfo_file.parent.mkdir(parents=True)

        # 模拟 4 个典型包
        # 1. luci-app-demo (单包单产物)
        d_demo = pkg_feed_dir / "luci-app-demo"
        d_demo.mkdir()
        (d_demo / "Makefile").write_text("define Package/luci-app-demo\nendef\n")

        # 2. frp (一源码多产物: frpc, frps)
        d_frp = pkg_feed_dir / "frp"
        d_frp.mkdir()
        (d_frp / "Makefile").write_text("define Package/frpc\nendef\ndefine Package/frps\nendef\n")

        # 3. r8168 (内核模块多产物: kmod-r8168, kmod-r8168-rss)
        d_r8168 = pkg_feed_dir / "r8168"
        d_r8168.mkdir()
        (d_r8168 / "Makefile").write_text("define Package/kmod-r8168\nendef\ndefine Package/kmod-r8168-rss\nendef\n")

        # 4. sing-box (预编译二进制: sing-box-tiny)
        d_singbox = pkg_feed_dir / "sing-box"
        d_singbox.mkdir()
        (d_singbox / "Makefile").write_text("define Package/sing-box-tiny\nendef\n")

        # 构造 expected.txt
        expected_pkgs = [
            "luci-app-demo",
            "frpc",
            "frps",
            "kmod-r8168",
            "kmod-r8168-rss",
            "sing-box-tiny"
        ]
        manifest_file.write_text("\n".join(expected_pkgs) + "\n")

        # 构造 tmp/.packageinfo
        pkginfo_content = f"""Source-Makefile: feeds/custom/luci-app-demo/Makefile
Package: luci-app-demo
Version: 1.0-1
@@
Source-Makefile: feeds/custom/frp/Makefile
Package: frpc
Version: 0.58.1-1
@@
Package: frps
Version: 0.58.1-1
@@
Source-Makefile: feeds/custom/r8168/Makefile
Package: kmod-r8168
Version: 8.053.00-1
@@
Package: kmod-r8168-rss
Version: 8.053.00-1
@@
Source-Makefile: feeds/custom/sing-box/Makefile
Package: sing-box-tiny
Version: 1.10.0-1
@@
"""
        pkginfo_file.write_text(pkginfo_content)

        # -------------------------------------------------------------
        # Scenario 1: 冷构建 (Cold Cache)
        # -------------------------------------------------------------
        print("\n--- [Scenario 1] 首次冷构建测试 ---")
        cmd_plan = (
            f"python3 {script_path} plan "
            f"--package-dir {pkg_feed_dir} "
            f"--packageinfo {pkginfo_file} "
            f"--manifest {manifest_file} "
            f"--cache-dir {cached_apks} "
            f"--artifacts-bin {artifacts_bin} "
            f"--output-targets {targets_file}"
        )
        rc, out, err = run_cmd(cmd_plan)
        assert rc == 0, f"plan failed: {err}"
        targets = targets_file.read_text().strip().split()
        print(f"Plan 输出 Targets: {targets}")
        assert len(targets) == 4, f"Cold cache 应产出 4 个 build targets, 实际: {len(targets)}"
        for pkg in ["luci-app-demo", "frp", "r8168", "sing-box"]:
            assert f"package/feeds/custom/{pkg}/compile" in targets

        # 模拟编译产出 APK
        create_dummy_apk(artifacts_bin / "luci-app-demo-1.0-r1.apk", "luci-app-demo", "1.0-r1")
        create_dummy_apk(artifacts_bin / "frpc-0.58.1-r1.apk", "frpc", "0.58.1-r1")
        create_dummy_apk(artifacts_bin / "frps-0.58.1-r1.apk", "frps", "0.58.1-r1")
        create_dummy_apk(artifacts_bin / "kmod-r8168-8.053.00-r1.apk", "kmod-r8168", "8.053.00-r1")
        create_dummy_apk(artifacts_bin / "kmod-r8168-rss-8.053.00-r1.apk", "kmod-r8168-rss", "8.053.00-r1")
        create_dummy_apk(artifacts_bin / "sing-box-tiny-1.10.0-r1.apk", "sing-box-tiny", "1.10.0-r1")

        # 执行 save
        cmd_save = (
            f"python3 {script_path} save "
            f"--package-dir {pkg_feed_dir} "
            f"--packageinfo {pkginfo_file} "
            f"--manifest {manifest_file} "
            f"--cache-dir {cached_apks} "
            f"--artifacts-bin {artifacts_bin}"
        )
        rc, out, err = run_cmd(cmd_save)
        assert rc == 0, f"save failed: {err}"
        assert (cached_apks / "fingerprints.json").is_file(), "fingerprints.json 未生成"
        fp_data = json.loads((cached_apks / "fingerprints.json").read_text())
        assert len(fp_data) == 4, f"指纹库应有 4 个条目，实际: {len(fp_data)}"
        print(f"Save 完成，缓存内 APK 数量: {len(list(cached_apks.glob('*.apk')))}")
        print("✓ Scenario 1 (冷构建与初次缓存归档) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 2: 热缓存零改动 (Warm Cache, No Changes)
        # -------------------------------------------------------------
        print("\n--- [Scenario 2] 热缓存零改动再次构建 ---")
        # 清空 artifacts/bin 模拟新 CI 运行启动
        shutil.rmtree(artifacts_bin)
        artifacts_bin.mkdir(parents=True)

        rc, out, err = run_cmd(cmd_plan)
        assert rc == 0, f"plan failed: {err}"
        targets = targets_file.read_text().strip()
        print(f"Plan 输出 Targets: '{targets}'")
        assert targets == "", "零改动时 targets 必须为空！"

        # 检查 artifacts/bin 是否已由缓存完整恢复
        recovered_apks = sorted([p.name for p in artifacts_bin.glob("*.apk")])
        print(f"复用缓存拷贝的 APK: {recovered_apks}")
        assert len(recovered_apks) == 6, f"应复用 6 个 APK，实际: {len(recovered_apks)}"

        # 运行 verify_manifest.py 验证闸门
        cmd_verify = (
            f"python3 {manifest_checker} "
            f"--expected {manifest_file} "
            f"--apk-dir {artifacts_bin} "
            f"--allow-missing /dev/null"
        )
        rc, out, err = run_cmd(cmd_verify)
        assert rc == 0, f"verify_manifest 验证失败: {out}\n{err}"
        print("✓ Scenario 2 (100% 缓存命中，编译完全跳过且清单校验通过) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 3: 单包源码变更 (Modify Single Package)
        # -------------------------------------------------------------
        print("\n--- [Scenario 3] 单包源码变更增量编译 ---")
        # 修改 luci-app-demo 的源码
        (d_demo / "Makefile").write_text("define Package/luci-app-demo\n# version bump\nendef\n")
        shutil.rmtree(artifacts_bin)
        artifacts_bin.mkdir(parents=True)

        rc, out, err = run_cmd(cmd_plan)
        assert rc == 0, f"plan failed: {err}"
        targets = targets_file.read_text().strip().split()
        print(f"Plan 输出 Targets: {targets}")
        assert targets == ["package/feeds/custom/luci-app-demo/compile"], f"必须仅编译 demo 包，实际: {targets}"

        # 此时其它未变包 (frp, r8168, sing-box) 的 APK 应当已从缓存恢复到 artifacts/bin
        current_apks = [p.name for p in artifacts_bin.glob("*.apk")]
        assert "frpc-0.58.1-r1.apk" in current_apks
        assert "kmod-r8168-8.053.00-r1.apk" in current_apks
        assert "sing-box-tiny-1.10.0-r1.apk" in current_apks
        assert not any("luci-app-demo" in x for x in current_apks), "被修改的包不应复用旧 APK"

        # 模拟该包编译出新版 APK
        create_dummy_apk(artifacts_bin / "luci-app-demo-1.1-r1.apk", "luci-app-demo", "1.1-r1")
        rc, out, err = run_cmd(cmd_save)
        assert rc == 0, f"save failed: {err}"

        # 验证 manifest
        rc, out, err = run_cmd(cmd_verify)
        assert rc == 0, f"verify_manifest 失败: {out}\n{err}"
        print("✓ Scenario 3 (仅单包增量构建，其余包无缝复用) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 4: 上次编译失败缺失包自动重跑 (Missing APK Auto-rebuild)
        # -------------------------------------------------------------
        print("\n--- [Scenario 4] 上次编译未产出 APK 自动捕获重编 ---")
        # 模拟 frps 上次构建未产出（从缓存中删除 frps）
        (cached_apks / "frps-0.58.1-r1.apk").unlink()
        shutil.rmtree(artifacts_bin)
        artifacts_bin.mkdir(parents=True)

        rc, out, err = run_cmd(cmd_plan)
        assert rc == 0, f"plan failed: {err}"
        targets = targets_file.read_text().strip().split()
        print(f"Plan 输出 Targets: {targets}")
        assert "package/feeds/custom/frp/compile" in targets, "缺少 frps 产物的 frp 必须被纳入编译 targets！"
        assert "package/feeds/custom/r8168/compile" not in targets
        assert "package/feeds/custom/sing-box/compile" not in targets

        # 重新产出 frps
        create_dummy_apk(artifacts_bin / "frpc-0.58.1-r1.apk", "frpc", "0.58.1-r1")
        create_dummy_apk(artifacts_bin / "frps-0.58.1-r1.apk", "frps", "0.58.1-r1")
        rc, out, err = run_cmd(cmd_save)
        assert rc == 0
        assert (cached_apks / "frps-0.58.1-r1.apk").is_file()
        print("✓ Scenario 4 (自动检测未产出 APK 并触发定向补编) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 5: 缓存包损坏/0字节容错 (Corrupted APK Protection)
        # -------------------------------------------------------------
        print("\n--- [Scenario 5] 损坏 APK 校验与自动防崩溃 ---")
        # 将 sing-box 的缓存文件置为空文件（损坏）
        (cached_apks / "sing-box-tiny-1.10.0-r1.apk").write_bytes(b"")
        shutil.rmtree(artifacts_bin)
        artifacts_bin.mkdir(parents=True)

        rc, out, err = run_cmd(cmd_plan)
        assert rc == 0
        targets = targets_file.read_text().strip().split()
        print(f"Plan 输出 Targets: {targets}")
        assert "package/feeds/custom/sing-box/compile" in targets, "损坏的 APK 必须被识别为缺失并触发重编！"
        print("✓ Scenario 5 (损坏文件自动识别与安全防护) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 6: 架构不兼容/defconfig未启用包跳过测试
        # -------------------------------------------------------------
        print("\n--- [Scenario 6] defconfig 未启用包自动跳过测试 ---")
        # 添加一个未在 expected.txt 中的包（模拟 x86_64 上的 autocore-arm）
        d_arm = pkg_feed_dir / "autocore-arm"
        d_arm.mkdir()
        (d_arm / "Makefile").write_text("define Package/autocore-arm\nendef\n")

        # 修复 sing-box 的缓存
        create_dummy_apk(cached_apks / "sing-box-tiny-1.10.0-r1.apk", "sing-box-tiny", "1.10.0-r1")
        shutil.rmtree(artifacts_bin)
        artifacts_bin.mkdir(parents=True)

        rc, out, err = run_cmd(cmd_plan)
        assert rc == 0
        targets = targets_file.read_text().strip()
        print(f"Plan 输出 Targets: '{targets}'")
        assert targets == "", "未被 defconfig 启用的包绝不应被加入 targets！"
        print("✓ Scenario 6 (defconfig 未启用包自动跳过) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 7: 版本升级时缓存自动清理旧版本 APK
        # -------------------------------------------------------------
        print("\n--- [Scenario 7] 版本升级缓存自动清理旧 APK ---")
        # 模拟 demo 升级到 2.0
        create_dummy_apk(artifacts_bin / "luci-app-demo-2.0-r1.apk", "luci-app-demo", "2.0-r1")
        # 补齐其它 APK 满足 save 条件
        for f in cached_apks.glob("*.apk"):
            if "luci-app-demo" not in f.name:
                shutil.copy2(f, artifacts_bin / f.name)

        rc, out, err = run_cmd(cmd_save)
        assert rc == 0
        demo_apks = list(cached_apks.glob("luci-app-demo-*.apk"))
        print(f"缓存中 demo 包数量: {len(demo_apks)}, 文件: {[f.name for f in demo_apks]}")
        assert len(demo_apks) == 1, "升级后缓存应仅保留最新版 APK"
        assert demo_apks[0].name == "luci-app-demo-2.0-r1.apk"
        print("✓ Scenario 7 (旧版本 APK 自动清理) 验证通过！")

        # -------------------------------------------------------------
        # Scenario 8: 真实工程目录测试 (Real Apps & Themes Fingerprinting)
        # -------------------------------------------------------------
        print("\n--- [Scenario 8] 真实代码仓库指纹性能与解析验证 ---")
        real_apps = pathlib.Path(__file__).resolve().parent.parent.parent / "apps"
        real_themes = pathlib.Path(__file__).resolve().parent.parent.parent / "themes"
        
        real_dirs = [d for d in real_apps.iterdir() if d.is_dir()] + [d for d in real_themes.iterdir() if d.is_dir()]
        print(f"实际仓库包含 {len(real_dirs)} 个自定义包目录")
        
        sys.path.insert(0, str(script_path.parent))
        import incremental_build
        
        import time
        t0 = time.time()
        fps = {}
        for d in real_dirs:
            fp = incremental_build.compute_source_fingerprint(d)
            assert len(fp) == 64, f"SHA-256 必须为 64 位字符: {d}"
            fps[d.name] = fp
            fp2 = incremental_build.compute_source_fingerprint(d)
            assert fp == fp2, f"指纹必须绝对幂等一致: {d.name}"
            
        elapsed = time.time() - t0
        print(f"真实工程 {len(real_dirs)} 个包全量指纹计算耗时: {elapsed*1000:.1f} ms")
        print("✓ Scenario 8 (真实工程环境测试完全通过)")

        print("\n" + "=" * 60)
        print(">>> 全部 8 项核心场景替代法逻辑验证 100% PASSED! <<<")
        print("=" * 60)

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
