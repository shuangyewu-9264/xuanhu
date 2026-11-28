#!/usr/bin/env node
/* =========================================================================
 * Node 验证 · tools/handbook-test.js
 * 用途：不需要浏览器，直接验证诊断分类器 / 行医手册 / 首次体征提示。
 *
 *   1) 生成 20 个不同 seed 的病例，各跑 10 分钟，打印分类表格人工核对；
 *   2) 模拟 4 局（治好 / 治死 / 中途放弃 / 出院失败），验证手册累计与误治记录；
 *   3) 验证 SIGNS.newOnes 首次返回全部、第二次返回空；
 *   4) 额外回归 5 个固定教学病例。
 *
 * 运行：node tools/handbook-test.js
 * ========================================================================= */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', 'prototype');

/* Node 没有 localStorage 时注入内存实现，顺便验证持久化键 */
if (typeof globalThis.localStorage === 'undefined') {
  const data = {};
  globalThis.localStorage = {
    getItem: k => Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null,
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
  };
}

function load(f) { return require(path.join(ROOT, f)); }
load('substances.js');
load('traits.js');
const GEN = load('generator.js');
const E = load('engine.js');
const D = load('diagnosis.js');
const H = load('handbook.js');
const SI = load('signs.js');

/* ---------------- 断言 ---------------- */
const fails = [];
const warns = [];
function check(cond, msg) {
  if (cond) return true;
  fails.push(msg);
  console.log('  ✗ ' + msg);
  return false;
}
function warn(msg) { warns.push(msg); console.log('  ⚠ ' + msg); }
function section(title) { console.log('\n=== ' + title + ' ==='); }

function fmt(S) {
  if (E && typeof E.fmt === 'function') {
    try { return E.fmt(S.t || 0); } catch (e) {}
  }
  const m = Math.floor((S.t || 0) / 60);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function advance(S, seconds) {
  const dt = 0.2, steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    if (!S.running) break;
    try {
      E.tick(S, dt);
      if (GEN && typeof GEN.step === 'function') GEN.step(S, dt, E);
    } catch (e) {
      warn('推进失败：' + e.message);
      break;
    }
  }
  return S;
}

section('0. 诊断覆盖清单');
const REQUIRED = [
  '高钾血症', '低钾血症', '高钠血症', '低钠血症',
  '代谢性酸中毒', '代谢性碱中毒', '呼吸性酸中毒', '呼吸性碱中毒',
  '低血糖', '高血糖', '糖尿病酮症酸中毒',
  '感染性休克', '失血性休克', '心源性休克',
  '急性左心衰', '急性呼吸衰竭', '心室颤动', '心静止',
  '苯二氮卓过量', '有机磷中毒', '对乙酰氨基酚中毒',
  '阿片类药物过量', '甲状腺危象',
];
const catalogNames = D.catalog().map(x => x.name);
const missing = REQUIRED.filter(n => catalogNames.indexOf(n) < 0);
check(missing.length === 0, '缺少任务要求的诊断：' + missing.join('、'));
console.log(`  分类器覆盖 ${catalogNames.length} 种诊断，任务要求的 23 种${missing.length ? '缺 ' + missing.length : '全部覆盖'}`);

/* ---------------- 1. 20 例分类 ---------------- */
const EXPECT = {
  highK: '高钾血症', dka: '糖尿病酮症酸中毒', bleed: '失血性休克',
  sepsis: '感染性休克', opioid: '阿片类药物过量', edema: '急性左心衰',
  thyroid: '甲状腺危象', hypogly: '低血糖', asthma: '支气管哮喘急性发作',
  organophosphate: '有机磷中毒', apap: '对乙酰氨基酚中毒',
  htnEmergency: '高血压急症', hyponatremia: '低钠血症', pe: '急性肺栓塞',
};
const KEYWORD = {
  highK: '高钾', dka: '酮症酸中毒', bleed: '出血', sepsis: '感染性休克',
  opioid: '阿片', edema: '左心衰', thyroid: '甲状腺危象', hypogly: '低血糖',
  asthma: '哮喘', organophosphate: '有机磷', apap: '对乙酰氨基酚',
  htnEmergency: '高血压急症', hyponatremia: '低钠', pe: '肺栓塞',
};
const COMPLICATIONS = {
  '高钾血症': ['心室颤动', '心静止', '代谢性酸中毒', '急性肾损伤', '低钾血症'],
  '失血性休克': ['心室颤动', '心静止', '代谢性酸中毒', '急性肾损伤'],
  '糖尿病酮症酸中毒': ['代谢性酸中毒', '心静止', '低钾血症', '急性肾损伤'],
  '感染性休克': ['急性呼吸衰竭', '代谢性酸中毒', '急性肾损伤', '心室颤动'],
  '阿片类药物过量': ['急性呼吸衰竭', '心静止', '心室颤动'],
  '急性左心衰': ['心源性休克', '急性呼吸衰竭', '心室颤动'],
  '急性肺栓塞': ['心源性休克', '急性呼吸衰竭', '心室颤动'],
  '支气管哮喘急性发作': ['急性呼吸衰竭', '心静止'],
  '低血糖': ['心静止', '昏迷'],
  '甲状腺危象': ['心室颤动', '急性呼吸衰竭'],
  '低钠血症': ['心室颤动', '急性呼吸衰竭'],
  '对乙酰氨基酚中毒': ['急性肾损伤', '心静止'],
  '有机磷中毒': ['急性呼吸衰竭', '心静止', '心室颤动'],
};

function expectedOf(C) {
  const names = [];
  const cases = Array.isArray(C && C.cases) ? C.cases : [];
  for (const id of cases) if (EXPECT[id]) names.push(EXPECT[id]);
  if (!names.length) {
    const text = String((C && C.name) || '');
    for (const id of Object.keys(KEYWORD)) {
      if (text.indexOf(KEYWORD[id]) >= 0) names.push(EXPECT[id]);
    }
  }
  return names;
}
function matchOf(actual, expected) {
  if (!actual) return { mark: '✗', note: '空' };
  if (expected.indexOf(actual) >= 0) return { mark: '✓', note: '' };
  for (const e of expected) {
    if ((COMPLICATIONS[e] || []).indexOf(actual) >= 0) return { mark: '≈', note: '并发症' };
  }
  return { mark: '✗', note: '需核对' };
}
function validShape(dx) {
  return dx && typeof dx.primary === 'string' && dx.primary.length > 0
    && typeof dx.confidence === 'number' && dx.confidence >= 0 && dx.confidence <= 1
    && Array.isArray(dx.evidence) && Array.isArray(dx.differential)
    && ['critical', 'severe', 'moderate', 'mild'].indexOf(dx.severity) >= 0
    && Array.isArray(dx.tags);
}

section('1. 诊断分类：20 个随机病例 × 10 分钟');
console.log('seed | 生成病理 | t=0 主诊断 | 10min 主诊断 | 置信 | 分级 | 判定');
console.log('-----|----------|-------------|--------------|------|------|------');

let nonEmpty = 0, exact = 0, approx = 0, mismatch = 0, shapeBad = 0;
for (let i = 1; i <= 20; i++) {
  const seed = i * 7919 + 13;
  let C, S0, S1, dx0, dx1;
  try {
    C = GEN.generate(5, seed);
    S0 = E.create(C);
    dx0 = D.classify(S0);
    S1 = E.create(GEN.generate(5, seed));   // 重新生成，保证 t=0 没被推进
    advance(S1, 600);
    dx1 = D.classify(S1);
  } catch (e) {
    check(false, `seed ${seed} 运行失败：${e.message}`);
    continue;
  }

  if (!validShape(dx0) || !validShape(dx1)) { shapeBad += 1; check(false, `seed ${seed} 返回结构不完整`); }
  if (dx1.primary) nonEmpty += 1; else check(false, `seed ${seed} 主诊断为空`);

  const expected = expectedOf(C);
  const m = matchOf(dx1.primary, expected);
  if (m.mark === '✓') exact += 1;
  else if (m.mark === '≈') approx += 1;
  else { mismatch += 1; warn(`seed ${seed}（${expected.join('/') || C.name}）分类为「${dx1.primary}」，请人工核对`); }

  const cases = (expected.length ? expected : [C.name || '?']).join(' + ');
  console.log([
    String(seed).padEnd(4),
    cases.slice(0, 22).padEnd(22),
    (dx0.primary || '—').slice(0, 16).padEnd(16),
    (dx1.primary || '—').slice(0, 18).padEnd(18),
    dx1.confidence.toFixed(2).padEnd(4),
    dx1.severity.padEnd(8),
    m.mark + (m.note ? '(' + m.note + ')' : ''),
  ].join(' | '));
}
console.log('');
console.log(`汇总：非空 ${nonEmpty}/20 · 完全匹配 ${exact} · 并发症/同义 ${approx} · 需核对 ${mismatch} · 结构异常 ${shapeBad}`);
check(nonEmpty === 20, `主诊断非空应为 20 例，实际 ${nonEmpty}`);
check(shapeBad === 0, `返回结构异常 ${shapeBad} 例`);

/* ---------------- 2. 手册累计 ---------------- */
section('2. 行医手册：治好 / 治死 / 中途放弃 / 出院失败');
H.clear();

function highKCase(diff) {
  const d = diff || 3;
  try {
    const c = GEN.generate(d, 20261126 + d, ['highK']);
    if (c && (c.cases || []).indexOf('highK') >= 0) return c;
  } catch (e) {}
  if (E.CASES && E.CASES.hyperkalemia) return 'hyperkalemia';
  return GEN.generate(d, 20261126 + d);
}
function rec(S) { return H.record(H.fromCase(S, D.classify(S))); }

/* 治好（难度 1） */
const S1 = E.create(highKCase(1));
try { E.give(S1, 'calcium', 10, '静推'); } catch (e) {}
try { E.give(S1, 'insulin', 10, '静推'); } catch (e) {}
try { E.give(S1, 'dextrose50', 25, '静推'); } catch (e) {}
S1.log.push([fmt(S1), '室颤！立即除颤', 'bad']);   // 引擎报警，不应被当成玩家操作
advance(S1, 120);
if (typeof E.endCase === 'function') E.endCase(S1, 'discharge', '测试治愈');
else S1.discharged = true;
rec(S1);

/* 治死（难度 5）：日志里带一条被判错的带教点评 */
const S2 = E.create(highKCase(5));
S2.log.push([fmt(S2), '带教点评：血钾已经很高，补钾会加重病情', 'warn']);
advance(S2, 60);
if (typeof E.endCase === 'function') E.endCase(S2, 'death', '测试死亡');
else S2.death = { reason: '测试死亡' };
rec(S2);

/* 中途放弃（难度 3）：没有出院也没有死亡 */
const S3 = E.create(highKCase(3));
advance(S3, 60);
S3.running = false;
rec(S3);
rec({ ...S3, dischargeOutcome: { status: 'failed' } });

const list = H.entries();
check(list.length === 1, `手册应只有 1 个诊断条目，实际 ${list.length}`);
const e = list[0] || {};
console.log(`  条目：${e.name || '—'} · 遇到 ${e.encounters || 0} 次 · 治好 ${e.cured || 0} · 死亡 ${e.died || 0} · 出院失败 ${e.failed || 0} · 未结 ${e.unknown || 0}`);
check(!!e.name, '手册条目缺少诊断名');
check(e.encounters === 4, `遇到次数应为 4，实际 ${e.encounters}`);
check(e.cured === 1 && e.died === 1 && e.failed === 1 && e.unknown === 1,
  `结局计数应为 1/1/1/1，实际 ${e.cured}/${e.died}/${e.failed}/${e.unknown}`);
check(Array.isArray(e.therapies) && e.therapies.length === 4,
  `疗法记录应为 4 条，实际 ${(e.therapies || []).length}`);
check((e.therapies || []).every(t => Array.isArray(t.操作)),
  '疗法记录应兼容中文键「操作」');
check((e.therapies || []).every(t => typeof t.耗时 === 'number'),
  '疗法记录应兼容中文键「耗时」');
check((e.therapies || []).every(t => !(t.actions || []).some(a => /室颤|心静止/.test(a))),
  '引擎报警日志不应被记成玩家操作');
check(Array.isArray(e.mistreatments) && e.mistreatments.length === 1,
  `误治记录应为 1 条，实际 ${(e.mistreatments || []).length}`);
if (e.mistreatments && e.mistreatments[0]) {
  check(/补钾/.test(e.mistreatments[0].text), '误治原文应包含「补钾」');
}
check(Array.isArray(e.evidence) && e.evidence.length > 0, '证据链为空');
const outcomeSet = (e.therapies || []).map(t => t.outcome).sort().join(',');
check(outcomeSet === 'cured,died,failed,unknown', `四局结局应为 cured/died/failed/unknown，实际 ${outcomeSet}`);
const drugNames = JSON.stringify(e.therapies || []);
check(/葡萄糖酸钙|calcium/.test(drugNames), '疗法记录里应出现实际给过的葡萄糖酸钙');
check(/胰岛素|insulin/.test(drugNames), '疗法记录里应出现实际给过的胰岛素');
/* 院前预置用药不算玩家操作（固定阿片病例 preload 了吗啡） */
if (E.CASES && E.CASES.opioid) {
  const So = E.create('opioid');
  const eo = H.fromCase(So, D.classify(So));
  check((eo.therapy.drugs || []).length === 0, '院前预置用药不应被记成玩家给药');
}

const html = H.render();
check(html.indexOf('这是你自己的记录，系统不会替你补全。') >= 0, '手册顶部缺少说明文案');
check(html.indexOf('遇到 4 次') >= 0, '手册页未显示「遇到 4 次」');
check(/治好 1/.test(html) && /死亡 1/.test(html) && /出院失败 1/.test(html), '手册页未显示各结局计数');
check(!/推荐疗法|标准治疗|首选治疗|建议使用/.test(html), '手册不应出现系统推荐/标准治疗文案');
check(H.has('高钾血症') && H.has('highK') && !H.has('没见过的病'), 'HANDBOOK.has 判定异常');

H.setNote(e.name, '我的复盘：先看心电图，再补钙。');
check((H.entries()[0] || {}).note === '我的复盘：先看心电图，再补钙。', '玩家备注未保存');

/* 导出 → 清空 → 导入 */
const exported = H.export();
let parsed = null;
try { parsed = JSON.parse(exported); } catch (err) {}
check(parsed && parsed.kind === 'handbook' && Array.isArray(parsed.entries), '导出 JSON 结构异常');
const badKeys = [];
for (const ent of (parsed ? parsed.entries : [])) {
  for (const k of Object.keys(ent)) if (['level', 'difficulty', 'diff'].indexOf(k) >= 0) badKeys.push(k);
  for (const t of (ent.therapies || [])) {
    for (const k of Object.keys(t)) if (['level', 'difficulty', 'diff'].indexOf(k) >= 0) badKeys.push(k);
  }
}
check(badKeys.length === 0, '手册不应按难度/等级分叉，发现键：' + badKeys.join(','));
H.clear();
check(H.entries().length === 0, '清空后手册应为空');
const imported = H.import(exported);
check(imported && imported.ok && imported.count === 1, '导入应成功并恢复 1 条');
const again = H.entries()[0] || {};
check(again.name === e.name && again.encounters === 4 && again.cured === 1 && again.died === 1 && H.stats().failed === 1,
  '导入后条目计数未恢复');
check((again.therapies || []).length === 4, '导入后疗法记录未恢复');
check(again.note === '我的复盘：先看心电图，再补钙。', '导入后玩家备注未恢复');
try {
  const raw = globalThis.localStorage.getItem('life.handbook');
  check(!!raw, 'localStorage 键 life.handbook 未写入');
} catch (err) { warn('localStorage 读取失败：' + err.message); }

/* ---------------- 3. 首次体征提示 ---------------- */
section('3. 首次体征提示：newOnes 去重');
SI.resetSeen();
const S4 = E.create(highKCase());
const det = SI.detect(S4);
console.log('  当前检出：' + det.map(x => `${x.name}(${x.level})`).join('、'));
check(det.length > 0, '高钾病例应检出至少一条体征');
const first = SI.newOnes(det);
check(first.length === det.length, `首次 newOnes 应返回全部（${det.length}），实际 ${first.length}`);
const marked = SI.markSeen(first);
check(marked === first.length, `markSeen 应标记 ${first.length} 条，实际 ${marked}`);
const second = SI.newOnes(det);
check(second.length === 0, `第二次 newOnes 应为空，实际 ${second.length}`);
const seen = SI.seen();
check(seen.length === det.length, `已见集合应为 ${det.length} 条，实际 ${seen.length}`);
try {
  const raw = globalThis.localStorage.getItem('life.signs');
  check(!!raw, 'localStorage 键 life.signs 未写入');
} catch (err) { warn('localStorage 读取失败：' + err.message); }

const ALLOWED_CRITICAL = ['ventricular_fibrillation', 'asystole', 'severe_hypoxemia',
  'severe_hyperkalemia', 'severe_hypotension'];
const badCritical = SI.list.filter(x => x.level === 'critical' && ALLOWED_CRITICAL.indexOf(x.id) < 0);
check(badCritical.length === 0, '存在非授权 critical 体征：' + badCritical.map(x => x.id).join(','));
check(SI.list.length >= 40, `体征条目应约 40 条，实际 ${SI.list.length}`);
const signCat = SI.catalog();
check(signCat.every(x => x.name && x.brief && x.brief.length >= 8 && x.causes),
  '存在缺少名称 / brief / causes 的体征条目');
console.log(`  体征总数：${signCat.length} 条（critical ${SI.list.filter(x => x.level === 'critical').length} 条）`);

/* ---------------- 4. 固定病例回归 ---------------- */
section('4. 固定教学病例回归');
const FIXED = {
  hyperkalemia: '高钾血症', dka: '糖尿病酮症酸中毒', bleed: '失血性休克',
  sepsis: '感染性休克', opioid: '阿片类药物过量',
};
let fixedOk = 0, fixedTotal = 0;
for (const id of Object.keys(FIXED)) {
  if (!E.CASES || !E.CASES[id]) continue;
  fixedTotal += 1;
  try {
    const S = E.create(id);
    const dx = D.classify(S);
    const okk = dx.primary === FIXED[id];
    if (okk) fixedOk += 1;
    console.log(`  ${okk ? '✓' : '✗'} ${id.padEnd(14)} → ${dx.primary} (${dx.confidence.toFixed(2)}, ${dx.severity})`);
    if (!okk) warn(`固定病例 ${id} 期望「${FIXED[id]}」，实际「${dx.primary}」`);
  } catch (err) {
    check(false, `固定病例 ${id} 运行失败：${err.message}`);
  }
}
check(fixedOk === fixedTotal, `固定病例应全部分类正确（${fixedOk}/${fixedTotal}）`);

/* ---------------- 汇总 ---------------- */
section('汇总');
console.log(`断言失败：${fails.length} · 人工核对提示：${warns.length}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('✓ 全部断言通过');
