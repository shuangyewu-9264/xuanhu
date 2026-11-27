# -*- coding: utf-8 -*-
# 【历史脚本归档】患者身份随机化
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/patch_identity_rand.py`
E = r'.\prototype\engine.js'
e = open(E, encoding='utf-8', newline='').read()
n = 0

# ① 固定病例也随机身份；测试可用 setIdentity 固定
old = """  /* 固定病例：身份由病例 id 哈希决定（同一疾病每次都是同一个人，保证测试可复现）；
     随机生成的病例（caseId 'gen'）在 generator 里已按 seed 生成身份。 */
  const hashStr = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const fixedId = (C && (C.id || C.caseId)) || 'case';
  let _rndSeed = hashStr(String(fixedId)) * 1e9;
  const frand = () => { _rndSeed = (_rndSeed * 16807) % 2147483647; return (_rndSeed - 1) / 2147483646; };
  const pt0 = (C && C.patient) || {};"""
new = """  /* 病人身份：每次开局都重新随机（同一疾病也会是不同的人），
     自动化测试可用 E.setIdentity({...}) 固定，避免结果随性别/年龄漂移。 */
  const forced = IDENTITY;
  const frand = () => Math.random();
  const pt0 = (forced || (C && C.patient) || {});"""
if old in e:
    e = e.replace(old, new, 1); n += 1
else:
    print('identity anchor miss')

# ② 提供 setIdentity
old2 = "  const randName = (sx) => {"
new2 = """  const randName = (sx) => {"""
n += 0
new2b = """  const patient = { name: pt0.name || (C && C.patientName) || randName(sex0), sex: sex0, age: age0, weight: wt0, height: ht0 };"""
if new2b in e and 'IDENTITY' in e:
    # 在 create 之前挂 API
    pass

# ③ 在模块级声明 IDENTITY 与 setter（放在 'use strict' 之后）
old3 = "'use strict';"
if old3 in e and 'const IDENTITY' not in e:
    e = e.replace(old3, """'use strict';
let IDENTITY = null;      /* 测试用：固定病人身份；生产环境为 null（每次随机） */""", 1)
    n += 1

# ④ 导出 setIdentity
old4 = "const API = {"
if old4 in e:
    e = e.replace(old4, "const API = {\n  setIdentity(p) { IDENTITY = p || null; },", 1)
    n += 1

open(E, 'w', encoding='utf-8', newline='').write(e)
print('applied', n)
