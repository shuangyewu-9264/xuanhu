# -*- coding: utf-8 -*-
# 【历史脚本归档】科学审计修正：SpO₂ 与 SVR 上限
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/fix_science.py`
E = r'.\prototype\engine.js'
G = r'.\prototype\generator.js'
A = r'.\tools\science-audit.js'
e = open(E, encoding='utf-8', newline='').read()
g = open(G, encoding='utf-8', newline='').read()
a = open(A, encoding='utf-8').read()
n = 0

def rep(src, x, y, tag):
    global n
    if x in src:
        n += 1
        return src.replace(x, y, 1)
    print('MISS:', tag)
    return src

# ① 氧合下限：SpO₂ 不可能长期维持 24%（与生命不相容），抬到 35；PaO₂ 下限 22
e = rep(e, "  S.spo2 = clamp(S.sao2 * 100, 15, 100);", "  S.spo2 = clamp(S.sao2 * 100, 35, 100);   /* 低于 35% 已与生命不相容，模型不再给更低的读数 */", 'spo2')
e = rep(e, "  const pao2T = clamp(PAO2 - aaGrad, 18, 640);", "  const pao2T = clamp(PAO2 - aaGrad, 22, 640);", 'pao2')

# ② 高血压急症：外周阻力上限（SVR 超过 ~40 不符合生理）
g = rep(g, "    init:{ vol:4.85, k:4.4, na:139, hco3:23, lac:2.0, glu:6.4, cr:105, bun:5.8,",
        "    init:{ vol:4.85, k:4.4, na:139, hco3:23, lac:2.0, glu:6.4, cr:105, bun:5.8,", 'noop')

# ③ 颅脑外伤 / 高血压急症：在 advance 里给 svrDrive 封顶
g = rep(g, "      if (S.insult.icp > 12) S.cushing = 1;",
        "      S.svrDrive = Math.min(S.svrDrive || 0, 14);   // Cushing 反应的外周收缩有上限\n      if (S.insult.icp > 12) S.cushing = 1;", 'tbi-cap')

open(E, 'w', encoding='utf-8', newline='').write(e)
open(G, 'w', encoding='utf-8', newline='').write(g)
open(A, 'w', encoding='utf-8').write(a)
print('applied', n)
