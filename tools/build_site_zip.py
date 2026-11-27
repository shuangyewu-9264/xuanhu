# -*- coding: utf-8 -*-
"""用 Python 的 zipfile 重打部署包，保证内部路径是正斜杠 /（Netlify 认这个）。"""
import zipfile

import os
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
DEP = os.path.join(ROOT, 'dist', '部署包')
OUT = os.path.join(ROOT, 'dist', '悬壶-网站包.zip')

if os.path.exists(OUT):
    os.remove(OUT)

count = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(DEP):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, DEP).replace('\\', '/')
            z.write(full, rel)
            count += 1

print('打包完成:', OUT)
print('文件数:', count)
with zipfile.ZipFile(OUT) as z:
    names = z.namelist()
    print('前 10 条:')
    for n in names[:10]:
        print('  ', n)
    bad = [n for n in names if '\\' in n]
    print('含反斜杠的条目:', len(bad))
