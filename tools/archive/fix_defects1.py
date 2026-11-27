# -*- coding: utf-8 -*-
# 【历史脚本归档】尿量对容量敏感化 / 更年期潮热 / 性别约束
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/fix_defects1.py`
E = r'.\prototype\engine.js'
G = r'.\prototype\generator.js'
J = r'.\prototype\game.js'
e = open(E, encoding='utf-8', newline='').read()
g = open(G, encoding='utf-8', newline='').read()
j = open(J, encoding='utf-8', newline='').read()
n = 0

# ① uo 对容量更敏感（低容量时应该几乎无尿）
old = "  S.uo = clamp(0.9 * renalPerf * clamp(S.vol / 4.4, 0.25, 1.7) + S.diuresis + osmDiuresis, 0, 10);"
new = ("  /* 尿量 = 肾灌注 × 容量因子；低容量时因子降到接近 0（原来下限 0.25 让休克病人也有尿，判据失真） */\n"
       "  const volFactor = clamp((S.vol - 2.3) / 2.1, 0.02, 1.6);\n"
       "  S.uo = clamp(0.95 * renalPerf * volFactor + S.diuresis + osmDiuresis, 0, 10);")
if old in e:
    e = e.replace(old, new, 1); n += 1
else:
    print('uo anchor miss')

# ② 更年期潮热：阵发性体温/心率波动
old2 = "    S.immunity = clamp(1 + (isF ? 0.06 : 0) - Math.max(0, age - 45) * 0.006, 0.55, 1.15);"
new2 = ("    S.immunity = clamp(1 + (isF ? 0.06 : 0) - Math.max(0, age - 45) * 0.006, 0.55, 1.15);\n"
        "    /* 更年期潮热：阵发性血管舒缩症状（~90 分钟一个周期），表现为短暂体温与心率上升 */\n"
        "    if (isF && meno) {\n"
        "      S.flush = 0.5 + 0.5 * Math.sin(S.t / 900 + (S._flushPhase || 0));\n"
        "      if (S.flush > 0.78) {\n"
        "        S.tempDrive = (S.tempDrive || 0) + 0.055;\n"
        "        S.hrDrive = (S.hrDrive || 0) + 3.5;\n"
        "      }\n"
        "    } else S.flush = 0;")
if old2 in e:
    e = e.replace(old2, new2, 1); n += 1
else:
    print('flush anchor miss')

# ③ 病例强制性别优先于测试固定身份
old3 = "  const sex0 = pt0.sex || (frand() < 0.5 ? '男' : '女');"
new3 = "  const sex0 = (C && C.sexReq) || pt0.sex || (frand() < 0.5 ? '男' : '女');   /* 病例本身的性别约束优先 */"
if old3 in e:
    e = e.replace(old3, new3, 1); n += 1
else:
    print('sex0 anchor miss')

open(E, 'w', encoding='utf-8', newline='').write(e)
open(G, 'w', encoding='utf-8', newline='').write(g)
open(J, 'w', encoding='utf-8', newline='').write(j)
print('applied', n)
