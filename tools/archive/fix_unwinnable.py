# -*- coding: utf-8 -*-
# 【历史脚本归档】低钠不可通关、肺水肿撤氧、烧伤撤机
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/fix_unwinnable.py`
"""修三个出不了院的病例：
   1) 低钠：开局 112，出院要 130，但规则限升幅 ≤10（最高 122）→ 不可达。把基线抬到 122。
   2) 肺水肿：判定要求"室内空气血氧"，脚本一直吸氧 → 补撤氧。
   3) 烧伤：判定要求已撤机，脚本从不撤机 → 补撤机尝试。
"""
import re

GEN = r'.\prototype\generator.js'
CT = r'.\tools\content-test.js'

# ---------- 1) 低钠基线 ----------
raw = open(GEN, encoding='utf-8', newline='').read()
crlf = '\r\n' in raw
g = raw.replace('\r\n', '\n')

i = g.find("id:'hyponatremia'")
seg = g[i:i + 1200]
m = re.search(r"na:\s*([0-9.]+)", seg)
print('低钠当前 init na =', m.group(1) if m else '未找到')
if m and float(m.group(1)) < 120:
    old = m.group(0)
    g = g[:i] + seg.replace(old, 'na:122', 1) + g[i + 1200:]
    print('→ 已改为 122（升幅上限 10 → 可达 132，出院要求 130 可达）')

if crlf:
    g = g.replace('\n', '\r\n')
open(GEN, 'w', encoding='utf-8', newline='').write(g)

# ---------- 2)(3) 脚本 ----------
raw = open(CT, encoding='utf-8', newline='').read()
c2 = '\r\n' in raw
s = raw.replace('\r\n', '\n')

old_edema = """    if (bp(S).map < 62 && !has(S, 'norepi')) E.give(S, 'norepi', 8);"""
new_edema = """    if (bp(S).map < 62 && !has(S, 'norepi')) E.give(S, 'norepi', 8);
    /* 肺水消了就把氧撤掉，否则永远卡在"仍在吸氧" */
    if ((S.lungWater || 0) <= 0.44 && S.spo2 >= 95 && ((S.fio2 || 0.21) > 0.21 || S.o2)) {
      E.ACTIONS.oxygen_off.apply(S);
    }"""
if old_edema in s:
    s = s.replace(old_edema, new_edema, 1)
    print('肺水肿脚本：已加撤氧')
else:
    print('MISS: 肺水肿脚本')

old_burn = """    if (S.ph < 7.20 && !has(S, 'bicarb') && t >= 600) E.give(S, 'bicarb', 150);"""
new_burn = """    if (S.ph < 7.20 && !has(S, 'bicarb') && t >= 600) E.give(S, 'bicarb', 150);
    /* 达到撤机条件就拔管（判定要求"已撤机"） */
    if (S.vent && S.gcs >= 13 && (S.airwayResistance || 0) <= 0.25) E.ACTIONS.extubate.apply(S);"""
if old_burn in s:
    s = s.replace(old_burn, new_burn, 1)
    print('烧伤脚本：已加撤机')
else:
    print('MISS: 烧伤脚本')

if c2:
    s = s.replace('\n', '\r\n')
open(CT, 'w', encoding='utf-8', newline='').write(s)
print('done')
