# -*- coding: utf-8 -*-
# 【历史脚本归档】难度重排：合并为两档 + 新增三档
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/patch_difficulty.py`
G = r'.\prototype\generator.js'
s = open(G, encoding='utf-8', newline='').read()
n = 0

def rep(a, b, tag):
    global s, n
    if a in s:
        s = s.replace(a, b, 1); n += 1; return True
    a2 = a.replace('\n', '\r\n'); b2 = b.replace('\n', '\r\n')
    if a2 in s:
        s = s.replace(a2, b2, 1); n += 1; return True
    print('MISS:', tag); return False

# ① 难度重排：5 档 → 前两档合并（普通/重症），后新增三档（危重/极危/噩梦）
rep("  const nMods = diff <= 1 ? 1 : (diff === 2 ? 1 : (diff === 3 ? 1 : (diff === 4 ? 2 : 2)));",
"""  /* 难度重排：
     1 普通（原 1–2 合并）  2 重症（原 3–5 合并）
     3 危重 / 4 极危 / 5 噩梦（新增，叠加更多病理、更快恶化、更多基础病） */
  const nMods = diff <= 2 ? 1 : (diff === 3 ? 2 : 3);""", 'nmods')

# ② 推进倍率
rep("  init.hardScale = 1.20 + diff * 0.06;      /* 难度 1→1.26，难度 5→1.50 */",
    "  init.hardScale = diff <= 2 ? (1.05 + diff * 0.10) : (1.30 + (diff - 2) * 0.22);   /* 1.15 / 1.25 / 1.52 / 1.74 / 1.96 */", 'scale')

# ③ 基础病：难度≥2 就有概率，≥3 必有
rep("  if (diff >= 4 && (diff >= 5 || rnd() < 0.6)) {",
    "  if (diff >= 2 && (diff >= 3 || rnd() < 0.5)) {", 'comorb')

# ④ 体质：难度越高越多
rep("    const nT = diff <= 1 ? 0 : (diff <= 3 ? (rnd() < 0.55 ? 1 : 0) : (rnd() < 0.75 ? 1 : 2));",
    "    const nT = diff <= 1 ? 0 : (diff === 2 ? (rnd() < 0.7 ? 1 : 0) : (diff === 3 ? (rnd() < 0.5 ? 1 : 2) : 2));", 'traits')

open(G, 'w', encoding='utf-8', newline='').write(s)
print('applied', n)
