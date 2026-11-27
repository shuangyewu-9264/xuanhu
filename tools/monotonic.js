/* 因果方向测试：只验证"方向对不对"，不验证具体数值。
 * 这类 bug（升压药越给越降、高钾心率升、抗凝药促出血）靠"能出院/会死"是测不出来的。
 *
 * 用法：node tools/monotonic.js
 */
require('../prototype/substances.js');
require('../prototype/traits.js');
const E = require('../prototype/engine.js');

/* 固定病人身份：对照与处置必须是同一个人，否则性别/年龄差异会污染结论 */
try { const _E = require('../prototype/engine.js'); _E.setIdentity && _E.setIdentity({ name:'测试患者', sex:'男', age:45, weight:70, height:172 }); } catch (e) {}

function run(caseId, setup, minutes) {
  const S = E.create(caseId);
  if (setup) setup(S);
  for (let i = 0; i < minutes * 2; i++) E.tick(S, 30);
  return {
    map: E.bp(S).map, sys: E.bp(S).sys, spo2: S.spo2, k: S.k, ph: S.ph,
    vol: S.vol, coag: S.coag || 1, lac: S.lac, glu: S.glu, hr: S.hr,
  };
}

const results = [];
function check(name, values, expect, tol = 0.5, minEffect = 0) {
  /* expect: 'up' | 'down'；values 按剂量从低到高 */
  let ok = true;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (expect === 'up' && d < -tol) ok = false;
    if (expect === 'down' && d > tol) ok = false;
  }
  const spread = Math.abs(values[values.length - 1] - values[0]);
  if (spread < minEffect) ok = false;
  results.push({ name, expect, values, ok, spread, minEffect });
}

/* 1. 去甲肾上腺素 → MAP 升 */
{
  const v = [0, 8, 32].map(d => run('sepsis', S => { if (d) E.give(S, 'norepi', d); }, 10).map);
  check('去甲肾上腺素 0/8/32 → MAP', v, 'up', 2, 8);
}
/* 2. 生理盐水 → 低血容量时 MAP 升 */
{
  const v = [0, 500, 1500].map(d => run('bleed', S => { if (d) E.give(S, 'nacl', d); }, 10).map);
  check('生理盐水 0/500/1500 → MAP（失血）', v, 'up', 2);
}
/* 3. 吸氧 → 低氧时 SpO2 升 */
{
  const v = [0, 1].map(d => run('opioid', S => { if (d) E.ACTIONS.oxygen.apply(S); }, 8).spo2);
  check('吸氧 无/有 → SpO2（低氧）', v, 'up', 1, 5);
}
/* 4. 胰岛素 → 血钾降 */
{
  const v = [0, 10, 30].map(d => run('hyperkalemia', S => { if (d) E.give(S, 'insulin', d); }, 30).k);
  check('胰岛素 0/10/30 → 血钾', v, 'down', 0.05);
}
/* 5. 碳酸氢钠 → pH 升 */
{
  const v = [0, 150, 300].map(d => run('dka', S => { if (d) E.give(S, 'bicarb', d); }, 20).ph);
  check('碳酸氢钠 0/150/300 → pH', v, 'up', 0.01);
}
/* 6. 呋塞米 → 血容量降 */
{
  const v = [0, 20, 80].map(d => run('edema', S => { if (d) E.give(S, 'furosemide', d); }, 30).vol);
  check('呋塞米 0/20/80 → 血容量', v, 'down', 0.05);
}
/* 7. 肝素 → 凝血功能降 */
{
  const v = [0, 5000, 15000].map(d => run('bleed', S => { if (d) E.give(S, 'heparin', d); }, 60).coag);
  check('肝素 0/5000/15000 → 凝血', v, 'down', 0.02);
}
/* 8. 氨甲环酸 → 凝血功能升（且不应加快出血） */
{
  const v = [0, 1, 3].map(d => run('bleed', S => { if (d) E.give(S, 'tranexamic_acid', d); }, 60).coag);
  check('氨甲环酸 0/1/3 → 凝血', v, 'up', 0.02);
}
/* 9. 阿托品 → 心动过缓时心率升 */
{
  const v = [0, 1, 3].map(d => run('hyperkalemia', S => { if (d) E.give(S, 'atropine', d); }, 10).hr);
  check('阿托品 0/1/3 → 心率', v, 'up', 2);
}
/* 10. 葡萄糖 → 血糖升 */
{
  const v = [0, 25, 75].map(d => run('hypogly', S => { if (d) E.give(S, 'dextrose50', d); }, 20).glu);
  check('50% 葡萄糖 0/25/75 → 血糖', v, 'up', 0.2);
}

/* 输出 */
const pad = s => s + ' '.repeat(Math.max(0, 34 - s.length));
console.log(pad('测试项') + '方向   实测（低→高）                      结果');
console.log('-'.repeat(92));
let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  const vals = r.values.map(x => (Math.round(x * 10) / 10).toString()).join('  →  ');
  console.log(pad(r.name) + pad(r.expect === 'up' ? '↑' : '↓') + ' ' + pad(vals) + (r.ok ? 'PASS' : (r.spread < r.minEffect ? 'FAIL(效应太弱)' : 'FAIL(方向错)')));
}
console.log('-'.repeat(92));
console.log(`${results.length - fail}/${results.length} 通过` + (fail ? `　⚠ ${fail} 项方向错误或剂量无效` : '　全部方向正确'));
process.exit(fail ? 1 : 0);



