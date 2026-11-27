# -*- coding: utf-8 -*-
# 【历史脚本归档】开局必定发病（预热到出现异常）
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/patch_presentation.py`
G = r'.\prototype\game.js'
GEN = r'.\prototype\generator.js'
s = open(G, encoding='utf-8', newline='').read()
g = open(GEN, encoding='utf-8', newline='').read()
n = 0

def repS(a, b, tag):
    global s, n
    if a in s:
        s = s.replace(a, b, 1); n += 1; return True
    a2 = a.replace('\n', '\r\n'); b2 = b.replace('\n', '\r\n')
    if a2 in s:
        s = s.replace(a2, b2, 1); n += 1; return True
    print('MISS(game):', tag); return False

# ---------- ① 生成器：未知模块 id 不再崩溃 ----------
a = """  const primary = (only && only.length)
    ? only.map(id => MODULES.find(m => m.id === id)).filter(Boolean).slice(0, nMods)
    : pickWeighted(rnd, MODULES, nMods);"""
b = """  let primary = (only && only.length)
    ? only.map(id => MODULES.find(m => m.id === id)).filter(Boolean).slice(0, nMods)
    : pickWeighted(rnd, MODULES, nMods);
  if (!primary.length) primary = pickWeighted(rnd, MODULES, 1);   /* id 写错时不要崩，退回随机 */"""
if a in g:
    g = g.replace(a, b, 1); n += 1
else:
    print('MISS(gen): primary')

# ---------- ② 开局必定发病：把"正常"的病例推进到已发病 ----------
repS("/* 重症弹窗 */",
"""/* ---------------- 开局必定发病 ----------------
   有些病理的初始值落在正常范围（例如代谢类早期），玩家开局看到一切都正常，
   既没有紧张感也不知道从哪下手。这里在开局时做一次"预热"：
   如果生命体征与关键化验全部正常，就按病程推进几分钟，直到出现异常。
   间歇性发作的病理（癫痫、甲亢危象、低血糖等）因此会直接从发作中开始。 */
function isAllNormal(S) {
  const b = E.bp(S);
  const bad =
    S.spo2 < 94 || S.hr > 100 || S.hr < 60 || b.sys < 95 || b.sys > 150 ||
    S.rr > 22 || S.temp > 37.8 || S.gcs < 15 ||
    S.k < 3.5 || S.k > 5.3 || S.na < 135 || S.na > 145 ||
    S.glu < 3.9 || S.glu > 7.8 || S.hb < 110 || S.lac > 2.5 ||
    S.ph < 7.35 || S.ph > 7.45 || (S.plt && S.plt < 100) || (S.cr && S.cr > 130);
  return !bad;
}

function ensurePresentation(S) {
  if (!S || !S.cas) return S;
  if (!isAllNormal(S)) return S;
  /* 最多推进 45 分钟，每步 1 分钟；不致死（若会死就回退到能撑住的那一刻） */
  let guard = 0;
  const start = JSON.parse(JSON.stringify({
    k: S.k, na: S.na, glu: S.glu, vol: S.vol, hr: S.hr, gcs: S.gcs,
    spo2: S.spo2, lac: S.lac, temp: S.temp, t: S.t,
  }));
  while (guard < 45 && isAllNormal(S) && !S.death && S.running) {
    guard++;
    try { E.tick(S, 60); } catch (e) { break; }
    try { if (window.CASEGEN) CASEGEN.step(S, 60, E); } catch (e) { break; }
  }
  if (S.death) {
    /* 预热把病人推死了：退回初始值，改成小幅恶化（保证"已发病"但还救得回来） */
    S.death = null; S.running = true;
    S.k = start.k; S.na = start.na; S.glu = start.glu; S.vol = start.vol;
    S.hr = start.hr; S.gcs = Math.min(start.gcs, 14); S.spo2 = Math.min(start.spo2, 93);
    S.lac = Math.max(start.lac, 2.8); S.temp = Math.max(start.temp, 37.9);
  }
  if (S.tl) S.tl.length = 0;   /* 预热过程不写时间轴，避免玩家看到"凭空"的记录 */
  S.log = [];
  return S;
}

/* 重症弹窗 */""", 'ensure')

# ---------- ③ 新病例统一走 ensurePresentation，且开局不弹重症窗 ----------
repS("  const ns = E.create(spec);\n  S = ns;",
     "  const ns = ensurePresentation(E.create(spec));\n  S = ns;", 'startcase')

repS("if (!_loaded && window.CASEGEN) { S = E.create(window.CASEGEN.generate(diffFromLevel())); }",
     "if (!_loaded && window.CASEGEN) { S = ensurePresentation(E.create(window.CASEGEN.generate(diffFromLevel()))); }", 'boot')

# 开局就是重症的病例：不打弹窗（弹窗只用于病程中的转变）
repS("  if (realism && S && !S.ins) initInsurance();\n  bracket",
     "  if (realism && S && !S.ins) initInsurance();", 'noop')

repS("      if (nowSevere && !S._severeShown) {",
     "      if (nowSevere && !S._severeShown) {\n        if (!S._seenSevere) { S._seenSevere = 1; S._severeShown = 1; }   /* 开局即重症：不打弹窗 */\n        else continue;", 'popup')

open(G, 'w', encoding='utf-8', newline='').write(s)
open(GEN, 'w', encoding='utf-8', newline='').write(g)
print('applied', n)
