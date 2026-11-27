# -*- coding: utf-8 -*-
# 【历史脚本归档】性激素走给药路径而非 PK 积分
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/fix_hormone_give.py`
E = r'.\prototype\engine.js'
e = open(E, encoding='utf-8', newline='').read()
n = 0

# ① PK 循环里跳过外源激素（改为给药时直接进入激素库）
old1 = """      } else if (key === 'estrogen' || key === 'testosterone') {
        /* 外源激素：按平台浓度在 30 分钟内累积到设定强度，之后维持（不是一次性注入） */
        applyDelta(S, key, p.eff[key] * p.scale * cMod * dtMin / 30);
      } else {"""
new1 = """      } else if (key === 'estrogen' || key === 'testosterone') {
        continue;   /* 外源激素在 give() 时直接进入激素库，避免与 PK 的积分路径重复 */
      } else {"""
if old1 in e:
    e = e.replace(old1, new1, 1); n += 1
else:
    print('pk skip anchor miss')

# ② give() 里给药即写入激素库（按剂量缩放）
old2 = "      if (root.TRAITS) root.TRAITS.onDrug(S, s, d);"
new2 = ("      if (root.TRAITS) root.TRAITS.onDrug(S, s, d);\n"
        "      /* 性激素类药物：给药后进入体内激素库（12 h 半衰期），由 tick 里的激素段合并到 S.estrogen/testosterone */\n"
        "      if (s.eff && s.eff.estrogen) S.estrogenExo = clamp((S.estrogenExo || 0) + s.eff.estrogen * scale, -1, 1.6);\n"
        "      if (s.eff && s.eff.testosterone) S.testosteroneExo = clamp((S.testosteroneExo || 0) + s.eff.testosterone * scale, -1, 1.6);")
if old2 in e:
    e = e.replace(old2, new2, 1); n += 1
else:
    print('give anchor miss')

open(E, 'w', encoding='utf-8', newline='').write(e)
print('applied', n)
