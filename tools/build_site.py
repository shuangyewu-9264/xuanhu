# -*- coding: utf-8 -*-
"""统一构建网页部署包：
   index.html          = 游戏本体（打开根路径直接玩游戏）
   download.html       = 下载页（提供 APK 与单文件版）
   version.json        = 在线更新清单
   web/                = 同一份游戏（兼容旧的 /web/ 链接）
   xuanhu.apk          = 最新安装包
   xuanhu-single.html  = 单文件版
"""
import shutil, json, glob, re

import os
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
PROTO = os.path.join(ROOT, 'prototype')
DIST = os.path.join(ROOT, 'dist')
DEP = os.path.join(DIST, '部署包')

# 版本
ver = '0.0.0'
bg = open(os.path.join(ROOT, 'app', 'android', 'app', 'build.gradle'), encoding='utf-8').read()
m = re.search(r'versionName "([^"]+)"', bg)
if m:
    ver = m.group(1)

if os.path.exists(DEP):
    shutil.rmtree(DEP)
os.makedirs(DEP)
os.makedirs(os.path.join(DEP, 'web'))

# 1) 游戏文件
for f in glob.glob(os.path.join(PROTO, '*.js')):
    shutil.copyfile(f, os.path.join(DEP, os.path.basename(f)))
    shutil.copyfile(f, os.path.join(DEP, 'web', os.path.basename(f)))
shutil.copyfile(os.path.join(PROTO, 'ui-v4.html'), os.path.join(DEP, 'index.html'))
shutil.copyfile(os.path.join(PROTO, 'ui-v4.html'), os.path.join(DEP, 'web', 'index.html'))

# 2) 下载页（放在 download.html）
dl_src = os.path.join(DIST, 'download.html')
if os.path.exists(dl_src):
    shutil.copyfile(dl_src, os.path.join(DEP, 'download.html'))

# 3) APK 与单文件版
apks = sorted(glob.glob(os.path.join(DIST, '*.apk')), key=os.path.getmtime, reverse=True)
apk_size = 0
if apks:
    apk_size = os.path.getsize(apks[0])
    shutil.copyfile(apks[0], os.path.join(DEP, 'xuanhu.apk'))
single = os.path.join(DIST, 'xuanhu-single.html')
if os.path.exists(single):
    shutil.copyfile(single, os.path.join(DEP, 'xuanhu-single.html'))

# 4) 在线更新清单
manifest = {
    'version': ver,
    'web': '/',
    'apk': '/xuanhu.apk',
    'apkName': os.path.basename(apks[0]) if apks else '',
    'apkSize': apk_size,
    'single': '/xuanhu-single.html',
    'download': '/download.html',
    'at': 'build',
}
with open(os.path.join(DEP, 'version.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=1)

# 5) Netlify 表单识别需要 index.html 里有 form（已内联在游戏页面里）
idx = open(os.path.join(DEP, 'index.html'), encoding='utf-8').read()
print('index.html 含反馈表单:', 'data-netlify="true"' in idx)
print('index.html 是游戏页:', '一键病房' in idx or '悬壶' in idx)
print('文件数:', len(glob.glob(os.path.join(DEP, '**', '*'), recursive=True)))
print('版本:', ver, '| APK:', manifest['apkName'], '| 大小: %.2f MB' % (apk_size / 1048576))
