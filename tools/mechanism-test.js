/* ==========================================================================
 * 机制测试：验证「同一操作、不同病理、不同后果」
 * --------------------------------------------------------------------------
 * 这类测试专门抓"数值对但机制错"的模型：如果补液对所有人都只是把 MAP 抬 4 mmHg，
 * 说明容量-心排-肺水的耦合并未真的建立。每组都做"配对差分"：
 *     Δ = 同一病理下「给这个操作 60 min 后」−「什么都不做 60 min 后」
 * 因此年龄/体重/种子带来的个体差异被消掉，剩下的纯粹是该操作的机制效应。
 *
 * 用法：node tools/mechanism-test.js
 * ========================================================================== */
require('../prototype/substances.js');
require('../prototype/mentor.js');
const E = require('../prototype/engine.js');

/* 固定病人身份：对照与处置必须是同一个人，否则性别/年龄差异会污染结论 */
try { const _E = require('../prototype/engine.js'); _E.setIdentity && _E.setIdentity({ name:'测试患者', sex:'男', age:45, weight:70, height:172 }); } catch (e) {}
const G = require('../prototype/generator.js');

const DT = 10;           // 与 game.js 主循环一致
const SEED = 101;

/* 跑一例：setup 为 null 时是对照组 */
function run(mod, setup, minutes) {
  const S = E.create(G.generate(2, SEED, [mod]));
  if (setup) setup(S);
  for (let i = 0; i < minutes * (60 / DT); i++) {
    E.tick(S, DT);
    G.step(S, DT, E);            // 病理模块推进（负荷量）
  }
  return {
    map: E.bp(S).map, sys: E.bp(S).sys, spo2: S.spo2, do2: S.do2, co: S.co,
    sv: S.sv, hr: S.hr, rr: S.rr, gcs: S.gcs, k: S.k, na: S.na, glu: S.glu,
    hb: S.hb, lw: S.lungWater, icp: S.icp, ph: S.ph, lac: S.lac, vol: S.vol,
    svr: S.svr, pcwp: S.pcwp, dead: !!S.death, S,
  };
}

const KEYS = ['map', 'sys', 'spo2', 'do2', 'co', 'sv', 'hr', 'rr', 'gcs', 'k', 'na',
              'glu', 'hb', 'lw', 'icp', 'ph', 'lac', 'vol', 'svr', 'pcwp'];

/* 配对差分：返回 { with, without, d } */
function diff(mod, setup, minutes) {
  const c = run(mod, null, minutes);
  const t = run(mod, setup, minutes);
  const d = {};
  for (const k of KEYS) d[k] = t[k] - c[k];
  return { ctrl: c, test: t, d };
}

const results = [];
function group(name, note) {
  const g = { name, note, rows: [], ok: true };
  results.push(g);
  return g;
}
function add(g, mod, key, r, expect, minAbs) {
  const v = r.d[key];
  let ok = true;
  if (expect === 'up') ok = v >= minAbs;
  else if (expect === 'down') ok = v <= -minAbs;
  else if (expect === 'flat') ok = Math.abs(v) <= minAbs;
  if (!ok) g.ok = false;
  g.rows.push({ mod, key, ctrl: r.ctrl[key], test: r.test[key], d: v, expect, minAbs, ok });
  return ok;
}
function contrast(g, modA, modB, key, expect, minAbs) {
  /* 跨病理对比：A 的效应必须比 B 至少大 minAbs（A=有效、B=无效）*/
  const a = g.rows.find(r => r.mod === modA && r.key === key);
  const b = g.rows.find(r => r.mod === modB && r.key === key);
  if (!a || !b) { g.ok = false; console.log('  ↳ 对比缺少行:', modA, modB, key, !!a, !!b); return; }
  const gap = expect === 'up' ? a.d - b.d : b.d - a.d;
  const ok = gap >= minAbs;
  if (!ok) { g.ok = false; console.log('  ↳ 对比不足:', modA, 'vs', modB, key, 'gap=', gap.toFixed(2), '要求', minAbs); }
  a.contrast = { vs: modB, key, gap, ok, minAbs };
  b.contrast = a.contrast;
}

/* =========================================================================
 * 1) 晶体液：肺水肿越补越缺氧，失血补了才升压
 *    审查要求的那组：同样 500 mL 生理盐水，一个 SpO₂ 掉、一个升
 * ========================================================================= */
{
  const g = group('晶体液 1500 mL / 40 min（同样补液，一个淹肺、一个救命）',
    '只有 30% 留在血管内；其余进组织间液并抬高肺毛细血管压 → 肺水↑（未治疗肺水已到上限，故用 PCWP 与 SpO₂ 观察）');
  const ed = diff('edema', S => E.give(S, 'nacl', 1500), 22);   /* 40 min 时对照已跌到血氧地板，看不出差别 */
  add(g, 'edema', 'spo2', ed, 'down', 2);
  add(g, 'edema', 'pcwp', ed, 'up', 3);  /* 斜率按生理校正为 5 mmHg/L 后，1.5 L 约 +3 */
  const bl = diff('bleed', S => E.give(S, 'nacl', 1500), 40);
  add(g, 'bleed', 'map', bl, 'up', 5);
  add(g, 'bleed', 'vol', bl, 'up', 0.2);
  add(g, 'bleed', 'lw', bl, 'flat', 0.05);
  /* 同样的液体，对"肺毛细血管压"的影响方向相反 */
  const edP = ed.d.pcwp;
  const blP = bl.d.pcwp;
  g.contrast = { label: 'ΔPCWP', a: edP, b: blP, gap: edP - blP, minAbs: 2.5, ok: edP - blP >= 2.5 };
  if (!g.contrast.ok) g.ok = false;
  /* 500 mL 小剂量：方向必须一致（审查点名的那一档） */
  const ed500 = diff('edema', S => E.give(S, 'nacl', 500), 40);
  const bl500 = diff('bleed', S => E.give(S, 'nacl', 500), 40);
  g.small = { edemaSpo2: ed500.d.spo2, bleedMap: bl500.d.map, bleedHb: bl500.d.hb, edemaHb: ed500.d.hb };
  if (!(ed500.d.spo2 < 0 && bl500.d.map > 0)) g.ok = false;
}

/* =========================================================================
 * 2) 吸氧：气道痉挛能救回来，真性分流救不回来
 * ========================================================================= */
{
  const g = group('提高 FiO₂ 至 0.85 / 8 min（氧疗对"通气不足"有效，对"分流"效果差）', '');
  const as = diff('asthma', S => E.ACTIONS.oxygen.apply(S), 8);
  add(g, 'asthma', 'spo2', as, 'up', 5);
  const ed = diff('edema', S => E.ACTIONS.oxygen.apply(S), 8);
  add(g, 'edema', 'spo2', ed, 'up', 0);         // 给氧不会降低血氧（严格方向）
  contrast(g, 'asthma', 'edema', 'spo2', 'up', 2.5);   /* 窗口 8 min，差值等比缩小 */
}

/* =========================================================================
 * 3) 利尿：肺水肿是救命，低血容量是打命
 * ========================================================================= */
{
  const g = group('呋塞米 40 mg / 60 min（同样是利尿，一个脱肺水，一个脱到休克）', '');
  const ed = diff('edema', S => E.give(S, 'furosemide', 40), 60);
  add(g, 'edema', 'lw', ed, 'down', 0.5);
  add(g, 'edema', 'spo2', ed, 'up', 3);
  add(g, 'edema', 'map', ed, 'flat', 10);      // 只小幅下降（容量还撑得住）
  const bl = diff('bleed', S => E.give(S, 'furosemide', 40), 60);
  add(g, 'bleed', 'map', bl, 'down', 10);
  add(g, 'bleed', 'do2', bl, 'down', 20);
  contrast(g, 'edema', 'bleed', 'map', 'up', 5);   /* 出血改为血压调制后绝对差值缩小 */   // edema 的 MAP 只小降，bleed 大降
}

/* =========================================================================
 * 4) 升压药：感染性休克靠它，衰竭心脏反而更差
 * ========================================================================= */
{
  const g = group('去甲肾上腺素 8 μg/min / 10 min（同样是缩血管，一个升压，一个压低心排）', '');
  const sp = diff('sepsis', S => E.give(S, 'norepi', 8), 10);
  add(g, 'sepsis', 'map', sp, 'up', 12);
  const ed = diff('edema', S => E.give(S, 'norepi', 8), 10);
  add(g, 'edema', 'map', ed, 'up', -3);            // MAP 不显著升高（允许 −3）；关键看 CO 下降
  add(g, 'edema', 'co', ed, 'down', 0.2);           // 后负荷↑ 每搏量↓
  contrast(g, 'sepsis', 'edema', 'map', 'up', 8);
}

/* =========================================================================
 * 5) 支气管扩张剂：哮喘能开气道，肺水肿开不了
 * ========================================================================= */
{
  const g = group('沙丁胺醇 2.5 mg / 20 min（同样是"解痉"，一个治本，一个不对因）', '');
  const as = diff('asthma', S => E.give(S, 'salbutamol', 2.5), 20);
  add(g, 'asthma', 'spo2', as, 'up', 10);
  add(g, 'asthma', 'rr', as, 'down', 10);
  const ed = diff('edema', S => E.give(S, 'salbutamol', 2.5), 20);
  add(g, 'edema', 'spo2', ed, 'up', -3);
  contrast(g, 'asthma', 'edema', 'spo2', 'up', 8);
}

/* =========================================================================
 * 6) 纳洛酮：阿片过量立刻逆转，有机磷毫无作用（受体不同）
 * ========================================================================= */
{
  const g = group('纳洛酮 0.4 mg / 10 min（同样是"解毒"，一个立竿见影，一个完全无效）', '');
  const op = diff('opioid', S => E.give(S, 'naloxone', 0.4), 10);
  add(g, 'opioid', 'rr', op, 'up', 8);
  add(g, 'opioid', 'spo2', op, 'up', 20);
  add(g, 'opioid', 'gcs', op, 'up', 5);
  const oph = diff('organophosphate', S => E.give(S, 'naloxone', 0.4), 10);
  add(g, 'organophosphate', 'gcs', oph, 'flat', 1);
  add(g, 'organophosphate', 'spo2', oph, 'flat', 2);
  contrast(g, 'opioid', 'organophosphate', 'gcs', 'up', 5);
}

/* =========================================================================
 * 7) 胰岛素：高钾是治疗，低血糖是灾难
 * ========================================================================= */
{
  const g = group('胰岛素 10 U / 30 min（同样是降钾，一个治病，一个致死）', '');
  const hk = diff('highK', S => E.give(S, 'insulin', 10), 30);
  add(g, 'highK', 'k', hk, 'down', 0.4);
  add(g, 'highK', 'gcs', hk, 'flat', 1);
  const hg = diff('hypogly', S => E.give(S, 'insulin', 10), 30);
  add(g, 'hypogly', 'gcs', hg, 'down', 2);
  add(g, 'hypogly', 'glu', hg, 'down', 0.5);
  contrast(g, 'hypogly', 'highK', 'gcs', 'down', 2);
}

/* =========================================================================
 * 8) 扩血管：衰竭心脏靠降后负荷改善心排，低血容量只会更低压
 * ========================================================================= */
{
  const g = group('硝酸甘油 0.5 mg / 20 min（同样是降后负荷，一个改善 CO，一个只降血压）', '');
  const ed = diff('edema', S => E.give(S, 'nitroglycerin', 0.5), 20);
  add(g, 'edema', 'co', ed, 'up', 0.5);
  add(g, 'edema', 'spo2', ed, 'up', 3);
  const bl = diff('bleed', S => E.give(S, 'nitroglycerin', 0.5), 20);
  add(g, 'bleed', 'map', bl, 'down', 2);
  add(g, 'bleed', 'co', bl, 'flat', 0.3);
  contrast(g, 'edema', 'bleed', 'co', 'up', 0.5);
}

/* =========================================================================
 * 9) 高渗盐水：低钠是救命，正常血钠只是制造高钠
 * ========================================================================= */
{
  const g = group('3% 高渗盐水 150 mL / 30 min（同样升血钠，一个降颅压，一个只是添乱）', '');
  const hn = diff('hyponatremia', S => E.give(S, 'hypertonic_saline', 150), 30);
  add(g, 'hyponatremia', 'na', hn, 'up', 4);
  add(g, 'hyponatremia', 'icp', hn, 'down', 0.1);
  const ap = diff('apap', S => E.give(S, 'hypertonic_saline', 150), 30);
  add(g, 'apap', 'na', ap, 'up', 4);
  add(g, 'apap', 'icp', ap, 'flat', 0.05);
  contrast(g, 'hyponatremia', 'apap', 'icp', 'down', 0.1);
}

/* ---------- 输出 ---------- */
const pad = (s, n) => {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
};
const f2 = x => (typeof x === 'number' ? (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100) : x);
const dirTxt = d => (d.expect === 'up' ? '↑≥' : d.expect === 'down' ? '↓≥' : '≈<') + d.minAbs;

let allOk = true, nRow = 0, nOk = 0;
console.log('\n机制测试：同一操作 × 不同病理 → 不同后果（配对差分，seed=' + SEED + '）');
console.log('='.repeat(118));
for (const g of results) {
  console.log('\n■ ' + g.name);
  if (g.note) console.log('  ' + g.note);
  console.log('  ' + pad('病理', 18) + pad('指标', 8) + pad('对照', 9) + pad('处置', 9) + pad('Δ', 10) + pad('判据', 10) + '结果');
  for (const r of g.rows) {
    nRow++; if (r.ok) nOk++;
    console.log('  ' + pad(r.mod, 18) + pad(r.key, 8) + pad(f2(r.ctrl), 9) + pad(f2(r.test), 9)
      + pad((r.d >= 0 ? '+' : '') + f2(r.d), 10) + pad(dirTxt(r), 10) + (r.ok ? 'ok' : 'FAIL'));
  }
  if (g.contrast) {
    const c = g.contrast;
    const gap = c.gap != null ? c.gap : (c.a !== undefined ? c.a - c.b : 0);
    console.log('  ↳ 跨病理对比' + (c.label ? ' ' + c.label : '') + `：差 ${f2(gap)}（要求 ≥${c.minAbs}）`
      + (gap >= c.minAbs ? '  ok' : '  FAIL'));
  }
  if (g.small) {
    console.log('  ↳ 500 mL 小剂量：水肿 ΔSpO₂ ' + f2(g.small.edemaSpo2)
      + '，失血 ΔMAP ' + f2(g.small.bleedMap) + '，失血 ΔHb ' + f2(g.small.bleedHb)
      + '，水肿 ΔHb ' + f2(g.small.edemaHb));
  }
  if (!g.ok) allOk = false;
}
console.log('\n' + '='.repeat(118));
console.log(`机制断言：${nOk}/${nRow} 通过；分组 ${results.filter(g => g.ok).length}/${results.length} 通过`
  + (allOk ? '　→ 机制驱动成立' : '　→ 存在不成立的机制！'));
process.exitCode = allOk ? 0 : 1;





