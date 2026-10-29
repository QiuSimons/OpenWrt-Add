#!/usr/bin/env python3
"""Generate index.html for root and per-architecture directories in public feed."""
import sys, pathlib


def main():
    if len(sys.argv) < 2:
        print("Usage: generate_index_html.py <public_dir>", file=sys.stderr)
        return 1

    pub = pathlib.Path(sys.argv[1]).resolve()
    if not pub.is_dir():
        print(f"Error: {pub} is not a directory", file=sys.stderr)
        return 1

    arches = sorted([d.name for d in pub.iterdir() if d.is_dir() and d.name != 'keys' and not d.name.startswith('.')])

    # Root index.html
    root_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenWrt-Add APK Feed</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 850px; margin: 40px auto; padding: 0 20px; color: #24292f; background: #f6f8fa; }}
    .card {{ background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 28px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(31,35,40,0.08); }}
    h1, h2 {{ color: #1f2328; border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }}
    pre {{ background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }}
    a {{ color: #0969da; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    ul {{ padding-left: 20px; }}
    li {{ margin-bottom: 6px; }}
    .badge {{ display: inline-block; padding: 2px 8px; font-size: 12px; font-weight: 600; border-radius: 12px; background: #dafbe1; color: #1a7f37; }}
    .arch-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-top: 12px; }}
    .arch-item {{ background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; text-align: center; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>📦 OpenWrt-Add APK 软件源 <span class="badge">Active</span></h1>
    <p>自用 OpenWrt 第三方软件包与 LuCI 插件二进制源，适配 Alpine/OpenWrt apk 包管理器。</p>
    
    <h2>🚀 路由器在线配置命令</h2>
    <pre><code># 1. 导入源公钥
wget -qO /etc/apk/keys/custom-feed.rsa.pub https://qiusimons.github.io/OpenWrt-Add/keys/custom-feed.rsa.pub

# 2. 添加软件源配置 (自动匹配当前路由器架构)
echo "https://qiusimons.github.io/OpenWrt-Add/$(apk --print-arch)" > /etc/apk/repositories.d/custom-feed.list

# (可选) aarch64 cortex 设备启用通用源:
grep -qx aarch64_generic /etc/apk/arch 2>/dev/null || echo aarch64_generic >> /etc/apk/arch
echo "https://qiusimons.github.io/OpenWrt-Add/aarch64_generic" >> /etc/apk/repositories.d/custom-feed.list

# 3. 更新并安装
apk update
apk add &lt;包名&gt;</code></pre>

    <h2>📂 支持的硬件架构</h2>
    <div class="arch-grid">
      {''.join(f'<div class="arch-item"><a href="{a}/"><strong>{a}</strong></a><br><small><a href="{a}/packages.adb">packages.adb</a></small></div>' for a in arches)}
    </div>

    <h2>💾 离线资源与公钥</h2>
    <ul>
      <li>公钥文件：<a href="keys/custom-feed.rsa.pub">keys/custom-feed.rsa.pub</a></li>
      <li>ImageBuilder 离线包：<a href="https://github.com/QiuSimons/OpenWrt-Add/releases/tag/latest-packages">GitHub Releases: openwrt-add-apks-bundle.tar.gz</a></li>
    </ul>
  </div>
</body>
</html>
"""
    (pub / "index.html").write_text(root_html, encoding="utf-8")

    # Per-architecture index.html
    for a in arches:
        arch_dir = pub / a
        apks = sorted([f.name for f in arch_dir.glob("*.apk")])
        arch_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{a} - OpenWrt-Add APK Feed</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #24292f; background: #f6f8fa; }}
    .card {{ background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(31,35,40,0.08); }}
    h1 {{ color: #1f2328; border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }}
    a {{ color: #0969da; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    ul {{ list-style-type: none; padding-left: 0; }}
    li {{ padding: 6px 10px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 13px; }}
    li:nth-child(even) {{ background: #fcfcfc; }}
    .back {{ display: inline-block; margin-bottom: 16px; font-weight: 500; }}
  </style>
</head>
<body>
  <div class="card">
    <a href="../" class="back">← 返回软件源首页</a>
    <h1>架构目录: {a} ({len(apks)} 个包)</h1>
    <p>索引文件：<a href="packages.adb"><strong>packages.adb</strong></a></p>
    <ul>
      {''.join(f'<li><a href="{apk}">{apk}</a></li>' for apk in apks)}
    </ul>
  </div>
</body>
</html>
"""
        (arch_dir / "index.html").write_text(arch_html, encoding="utf-8")

    print(f"[INFO] Generated index.html for root and {len(arches)} architectures.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
