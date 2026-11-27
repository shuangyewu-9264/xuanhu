# -*- coding: utf-8 -*-
"""把 prototype/ 打成单文件 HTML（样式、脚本全内联），用于：
   1) 双击直接打开（file:// 也能跑）
   2) 上传到任意静态托管 / 交给平台托管
"""
import re, io

import os
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
SRC = os.path.join(ROOT, 'prototype')
OUT_DIR = os.path.join(ROOT, 'dist')

html = open(os.path.join(SRC, 'ui-v4.html'), encoding='utf-8').read()

# 1) 收集并内联所有 <script src="x.js"></script>
scripts = re.findall(r'<script src="([^"]+)"[^>]*></script>', html)
print('脚本数:', len(scripts))
for name in scripts:
    path = os.path.join(SRC, name)
    if not os.path.exists(path):
        print('缺文件:', name); continue
    js = open(path, encoding='utf-8').read()
    # 防止 </script> 提前闭合
    js = js.replace('</script>', '<\\/script>')
    tag = '<script src="%s"></script>' % name
    html = html.replace(tag, '<script>\n/* ==== %s ==== */\n%s\n</script>' % (name, js), 1)

# 2) 处理可能存在的 <link rel="stylesheet" href="...">
for css_name in re.findall(r'<link[^>]+href="([^"]+\.css)"[^>]*>', html):
    path = os.path.join(SRC, css_name)
    if os.path.exists(path):
        css = open(path, encoding='utf-8').read()
        html = re.sub(r'<link[^>]+href="%s"[^>]*>' % re.escape(css_name),
                      '<style>\n%s\n</style>' % css, html, count=1)

# 3) 标题与离线标记
html = html.replace('<title>悬壶 · 一间病房四位患者</title>',
                    '<title>悬壶 · 一间病房四位患者（单文件版）</title>')

OUT = os.path.join(OUT_DIR, '悬壶-单文件版.html')
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(html)
size = os.path.getsize(OUT) / 1024
print('输出:', OUT, '%.0f KB' % size)
print('剩余外链:', len(re.findall(r'<script src=', html)), '个 script，',
      len(re.findall(r'<link[^>]+href=', html)), '个 link')
