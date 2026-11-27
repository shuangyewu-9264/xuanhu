# -*- coding: utf-8 -*-
# 【历史脚本归档】补齐泼尼松、氨溴索等药物
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/add_drugs2.py`
S = r'.\prototype\substances.js'
s = open(S, encoding='utf-8', newline='').read()

anchor = "  ['amoxicillin','阿莫西林',   '抗生素',   1, 'g',   14, { r:'口服', on:45, du:480, note:'社区获得性感染' }],"
ADD = """  ['prednisone','泼尼松',      '糖皮质激素',30, 'mg',  10, { r:'口服', on:60, du:720, e:{glu:+1.4}, note:'强的松' }],
  ['ambroxol', '氨溴索',       '祛痰',     30, 'mg',   12, { r:'静推', on:15, du:240, note:'沐舒坦' }],
  ['bromhexine','溴己新',      '祛痰',     8,  'mg',    8, { r:'口服', on:30, du:300 }],
  ['metoclopramide','甲氧氯普胺','止吐',   10, 'mg',    9, { e:{gcs:0}, note:'胃复安；锥体外系反应' }],
  ['domperidone','多潘立酮',   '止吐',     10, 'mg',    9, { r:'口服', on:30, du:240 }],
  ['smectite', '蒙脱石',       '止泻',     3,  'g',     8, { r:'口服', on:30, du:360 }],
  ['loperamide','洛哌丁胺',    '止泻',     2,  'mg',    7, { r:'口服', on:45, du:480 }],
  ['dyphylline','二羟丙茶碱',  '平喘',     0.25,'g',   11, { e:{rr:+3, hr:+5}, note:'喘定' }],
  ['clonazepam','氯硝西泮',    '镇静',     1,  'mg',   12, { e:{gcs:-2, rr:-2} }],
  ['hydrochlorothiazide','氢氯噻嗪','利尿', 25, 'mg',    8, { r:'口服', on:60, du:720, e:{vol:-0.35, k:-0.3}, note:'双氢克尿噻' }],"""
if "['prednisone'" not in s:
    s = s.replace(anchor, anchor + "\n" + ADD, 1)
    open(S, 'w', encoding='utf-8', newline='').write(s)
    print('drugs added:', ADD.count('\n['))
else:
    print('already present')

# 修正错误别名：可乐定 ≠ 硝普钠
s = open(S, encoding='utf-8', newline='').read()
if "  '可乐定': '硝普钠',\n" in s:
    s = s.replace("  '可乐定': '硝普钠',\n", "")
    open(S, 'w', encoding='utf-8', newline='').write(s)
    print('wrong alias removed')
