#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OpenWrt APK 架构分流与扇出脚本
1. arch = all: 保留原生声明，分发至所有目标架构目录。
2. arch = aarch64_generic: 重写 .PKGINFO 中的 arch 为对应子微架构，供客户端 apk-tools 匹配。
3. arch = x86_64 及其他: 归入对应架构目录。
"""

import os
import sys
import io
import shutil
import tarfile
import argparse

DEFAULT_ARM64_ARCHS = [
    "aarch64_generic",
    "aarch64_cortex-a53",
    "aarch64_cortex-a72",
    "aarch64_cortex-a76",
    "aarch64_cortex-a55",
]

def get_apk_arch(apk_path):
    """读取 APK 包内 .PKGINFO 获取声明的 arch"""
    try:
        with tarfile.open(apk_path, "r:*") as tar:
            for member in tar.getmembers():
                if member.name == ".PKGINFO":
                    f = tar.extractfile(member)
                    if f:
                        for line in f.read().decode("utf-8", errors="ignore").splitlines():
                            if line.startswith("arch ="):
                                return line.split("=", 1)[1].strip()
    except Exception as e:
        print(f"[WARN] 无法读取 {apk_path} 的 .PKGINFO: {e}")
    return None

def patch_and_write_apk(src_path, dst_path, target_arch):
    """重写 .PKGINFO 的 arch 声明并生成对应子架构的 APK"""
    with tarfile.open(src_path, "r:*") as tar_in:
        with tarfile.open(dst_path, "w:gz") as tar_out:
            for member in tar_in.getmembers():
                f = tar_in.extractfile(member)
                if member.name == ".PKGINFO" and f is not None:
                    raw_content = f.read().decode("utf-8", errors="ignore")
                    new_lines = []
                    for line in raw_content.splitlines():
                        if line.startswith("arch ="):
                            new_lines.append(f"arch = {target_arch}")
                        else:
                            new_lines.append(line)
                    new_data = ("\n".join(new_lines) + "\n").encode("utf-8")
                    
                    tarinfo = tarfile.TarInfo(name=member.name)
                    tarinfo.size = len(new_data)
                    tarinfo.mode = member.mode
                    tarinfo.mtime = member.mtime
                    tarinfo.type = member.type
                    tarinfo.uid = member.uid
                    tarinfo.gid = member.gid
                    tarinfo.uname = member.uname
                    tarinfo.gname = member.gname
                    
                    tar_out.addfile(tarinfo, io.BytesIO(new_data))
                else:
                    if f is not None:
                        tar_out.addfile(member, f)
                    else:
                        tar_out.addfile(member)

def smart_fanout(src_dir, out_dir, arm64_subarchs=None):
    if arm64_subarchs is None:
        arm64_subarchs = DEFAULT_ARM64_ARCHS

    os.makedirs(out_dir, exist_ok=True)
    
    apk_files = []
    for root, _, files in os.walk(src_dir):
        for file in files:
            if file.endswith(".apk"):
                apk_files.append(os.path.join(root, file))

    if not apk_files:
        print(f"[WARN] 目录 {src_dir} 下未发现任何 .apk 文件。")
        return

    print(f"[INFO] 扫描到 {len(apk_files)} 个 APK 包，开始分流与扇出...")

    all_target_dirs = set(arm64_subarchs) | {"x86_64"}
    for d in all_target_dirs:
        os.makedirs(os.path.join(out_dir, d), exist_ok=True)

    stats = {
        "all": 0,
        "x86_64": 0,
        "aarch64_generic": 0,
        "other": 0,
        "fanout_generated": 0
    }

    for apk_path in apk_files:
        filename = os.path.basename(apk_path)
        arch = get_apk_arch(apk_path)

        if not arch:
            if "_all.apk" in filename:
                arch = "all"
            elif "_x86_64.apk" in filename:
                arch = "x86_64"
            elif "_aarch64_generic.apk" in filename:
                arch = "aarch64_generic"

        if arch == "all":
            stats["all"] += 1
            for target_arch in all_target_dirs:
                dst = os.path.join(out_dir, target_arch, filename)
                if not os.path.exists(dst):
                    shutil.copy2(apk_path, dst)
            print(f"  [ALL] {filename} -> 分发至全部架构目录")

        elif arch == "x86_64":
            stats["x86_64"] += 1
            dst = os.path.join(out_dir, "x86_64", filename)
            shutil.copy2(apk_path, dst)
            print(f"  [x86_64] {filename} -> 归位至 x86_64 目录")

        elif arch == "aarch64_generic":
            stats["aarch64_generic"] += 1
            dst_generic = os.path.join(out_dir, "aarch64_generic", filename)
            shutil.copy2(apk_path, dst_generic)
            print(f"  [aarch64_generic] {filename} -> 归位至 aarch64_generic 目录")

            for sub_arch in arm64_subarchs:
                if sub_arch == "aarch64_generic":
                    continue
                new_filename = filename.replace("aarch64_generic", sub_arch)
                if new_filename == filename:
                    base, ext = os.path.splitext(filename)
                    new_filename = f"{base}_{sub_arch}{ext}"

                dst_sub = os.path.join(out_dir, sub_arch, new_filename)
                patch_and_write_apk(apk_path, dst_sub, sub_arch)
                stats["fanout_generated"] += 1
                print(f"    -> 衍生子架构: {sub_arch}/{new_filename}")

        else:
            stats["other"] += 1
            target_dir = os.path.join(out_dir, arch if arch else "unknown")
            os.makedirs(target_dir, exist_ok=True)
            shutil.copy2(apk_path, os.path.join(target_dir, filename))
            print(f"  [OTHER] {filename} ({arch}) -> 归位至 {arch}/ 目录")

    print("\n[SUMMARY] 扇出处理完毕:")
    print(f"  - 通用 (all) 包: {stats['all']}")
    print(f"  - x86_64 二进制包: {stats['x86_64']}")
    print(f"  - aarch64_generic 二进制包: {stats['aarch64_generic']}")
    print(f"  - 衍生子架构包数量: {stats['fanout_generated']}")
    print(f"  - 其他架构包: {stats['other']}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OpenWrt APK 架构扇出工具")
    parser.add_argument("src_dir", help="输入目录 (存放 SDK 编译生成的 .apk)")
    parser.add_argument("out_dir", help="输出根目录 (发布到 GitHub Pages / 离线包根目录)")
    args = parser.parse_args()

    smart_fanout(args.src_dir, args.out_dir)
