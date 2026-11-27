# -*- coding: utf-8 -*-
"""重建下载页：用根相对路径（/web/、/single、/apk），桥接与静态站根目录都能用。"""
import glob, re

import os
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
DIST = os.path.join(ROOT, 'dist')

ver = '0.0.0'
try:
    bg = open(os.path.join(ROOT, 'app', 'android', 'app', 'build.gradle'), encoding='utf-8').read()
    m = re.search(r'versionName\s+"([^"]+)"', bg)
    if m: ver = m.group(1)
except Exception:
    pass

apks = sorted(glob.glob(os.path.join(DIST, '*.apk')), key=os.path.getmtime, reverse=True)
apk_mb = (os.path.getsize(apks[0]) / 1048576) if apks else 0

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>悬壶 · 下载</title>
<style>
  :root{{--bg:#f4f2f1;--ink:#141414;--ink2:#6b6b6b;--card:#fff;--line:#e8e4e2;--red:#d33a3a}}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;justify-content:center;padding:28px 16px 60px}}
  .wrap{{width:min(560px,100%)}}
  h1{{font-size:26px;margin:8px 0 4px}}
  .sub{{color:var(--ink2);font-size:13px;margin-bottom:20px}}
  .card{{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:14px}}
  .card h2{{font-size:15px;margin:0 0 8px}}
  .card p{{margin:0 0 10px;color:var(--ink2);font-size:12.5px;line-height:1.7}}
  a.btn{{display:block;text-align:center;padding:13px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px}}
  .primary{{background:var(--red);color:#fff}}
  .ghost{{border:1px solid var(--line);color:var(--ink);margin-top:8px}}
  .meta{{font-size:11.5px;color:#9a9a9a;margin-top:10px;text-align:center}}
  .tag{{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(211,58,58,.08);color:#a33;margin-left:6px}}
  ul{{margin:6px 0 0 18px;padding:0;color:var(--ink2);font-size:12.5px;line-height:1.8}}
</style>
</head>
<body>
<div class="wrap">
  <h1>悬壶<span class="tag">v{ver}</span></h1>
  <div class="sub">一间病房，四位患者，时间不会等你。</div>

  <div class="card">
    <h2>方式一：直接玩网页版（推荐）</h2>
    <p>不用安装，手机或电脑浏览器打开就能玩，进度存在本机。发给朋友最省事的就是发这个链接。</p>
    <a class="btn primary" href="/">开始游戏 →</a>
    <a class="btn ghost" href="/xuanhu-single.html">单文件版（一个 HTML，双击即开）</a>
  </div>

  <div class="card">
    <h2>方式二：安装安卓 APK</h2>
    <p>离线可玩，功能与网页版一致。{('安装包 %.2f MB' % apk_mb) if apks else ''}</p>
    <a class="btn primary" href="/xuanhu.apk">下载 APK</a>
    <div class="meta">第一次安装需允许"未知来源应用"</div>
  </div>

  <div class="card">
    <h2>说明</h2>
    <ul>
      <li>本作是教学模拟，<b>不构成医疗建议</b></li>
      <li>存档在浏览器本地，换设备或清缓存会丢</li>
      <li>网页版始终最新；APK 需要重新下载</li>
    </ul>
  </div>
</div>
</body>
</html>
"""
for name in ('下载页.html', 'download.html'):
    with open(os.path.join(DIST, name), 'w', encoding='utf-8') as f:
        f.write(html)
print('下载页已重建（根相对路径），版本', ver)
