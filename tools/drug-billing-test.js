const assert = require('node:assert/strict');
const SUB = require('../prototype/substances');
const CASEGEN = require('../prototype/generator');
const E = require('../prototype/engine');
const ACHIEVEMENTS = require('../prototype/achievements');
const SHARE = require('../prototype/share');

const baseline = { id: 'drug-billing-test', init: { ...CASEGEN.BASE } };
const bed = (weight = 70, scenario = baseline) => E.create(scenario, { weight });
const close = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message} (${actual} != ${expected})`);
};
const reload = (scenario, saved) => {
  const base = bed(70, scenario);
  const S = Object.assign(base, structuredClone(saved));
  E.restorePatient(S);
  E.restoreDrugCost(S, saved);
  return S;
};

{
  const S = bed();
  const calcium = SUB.byId('calcium');
  const prbc = SUB.byId('prbc');
  const water = SUB.byId('water');
  const levetiracetam = SUB.byId('levetiracetam');
  E.give(S, 'calcium', calcium.dose / 2);
  E.give(S, 'calcium', 2 * calcium.dose);
  assert.deepEqual(S.given.map(order => order.cost), [calcium.cost / 2, 2 * calcium.cost]);
  let drugCost = 2.5 * calcium.cost;
  E.give(S, 'prbc', prbc.dose / 2);
  drugCost += prbc.cost / 2;
  const platelets = SUB.byId('c_plt');
  E.give(S, platelets.id, platelets.dose);
  drugCost += platelets.cost;
  E.give(S, 'water', 2);
  E.orderTest(S, 'bmp');
  E.give(S, 'levetiracetam', levetiracetam.dose / 2, '静滴');
  drugCost += levetiracetam.cost / 2;
  E.tick(S, 15 * 60);
  close(S.drugCost, drugCost, '短时输注按总量结算一次，药费含血液制品');
  close(S.cost, drugCost + 2 * water.cost + E.TESTS.bmp.cost, '食品和检查另入诊疗总费用');
  E.give(S, 'saline', E.DRUGS.saline.defaultDose / 2);
  close(S.drugCost, drugCost + E.DRUGS.saline.cost / 2, '兼容药物路径同样按量结算');
}

{
  const S = bed(70, E.CASES.opioid);
  assert.ok(S.given.some(order => order.id === 'morphine' && order.cost === 0));
  assert.equal(S.drugCost, 0, '院前吗啡保留给药记录');
  assert.equal(S.cost, 0);
  const scenario = { ...baseline, init: { ...baseline.init, preload: [['norepi', 8]] } };
  const running = bed(70, scenario);
  assert.equal(running.drugCost, 0, '创建病例的初始生理步长无需结算');
  E.tick(running, 1);
  close(running.drugCost, E.drugPrice(SUB.byId('norepi'), 8, running.patient) / 3600, '入院后泵入时间开始计费');
}

{
  const S = bed(105);
  const otherBed = bed(70);
  const norepi = SUB.byId('norepi');
  const dobutamine = SUB.byId('dobutamine');
  const nicardipine = SUB.byId('nicardipine');
  assert.equal(E.drugPrice(dobutamine, dobutamine.dose, S.patient), 1.5 * dobutamine.cost);
  assert.equal(E.drugPrice(dobutamine, dobutamine.dose, otherBed.patient), dobutamine.cost);
  assert.equal(E.drugPrice(norepi, norepi.dose, S.patient), norepi.cost);
  for (const patient of [S, otherBed]) E.give(patient, 'norepi', norepi.dose / 2);
  assert.equal(S.drugCost, 0, '开泵不产生整次费用');
  E.tick(S, 0.2);
  assert.ok(S.drugCost > 0 && S.drugCost < 0.01, '保留低于一分钱的累计费用');
  assert.equal(otherBed.drugCost, 0);
  for (let i = 1; i < 300; i++) E.tick(S, 0.2);
  E.tick(otherBed, 60);
  close(S.drugCost, norepi.cost / 120, '按实际低泵速和模拟时间计费');
  close(S.drugCost, otherBed.drugCost, '不同推进步长结算一致');

  const beforeAdjust = S.drugCost;
  E.give(S, 'norepi', norepi.dose * 2);
  E.give(S, 'nicardipine');
  E.give(S, 'dobutamine');
  assert.equal(E.give(S, 'norepi', norepi.dose * 2), null);
  assert.equal(S.drugCost, beforeAdjust, '调速和增设泵只更新速度');
  const { cas, ...state } = S;
  const saved = JSON.parse(JSON.stringify(state));
  const resumed = reload(cas, saved);
  assert.equal(resumed.drugCost, beforeAdjust);
  assert.equal(resumed.drugCostPartial, false);
  E.tick(resumed, 60);
  const withThreePumps = beforeAdjust + (2 * norepi.cost + 1.5 * dobutamine.cost + nicardipine.cost) / 60;
  close(resumed.drugCost, withThreePumps, '重载后同床三台运行中的泵分别结算');
  assert.equal(E.stopPump(resumed, 'norepi'), norepi.dose * 2);
  assert.equal(E.stopPump(resumed, 'norepi'), null);
  E.tick(resumed, 60);
  const withTwoPumps = withThreePumps + (1.5 * dobutamine.cost + nicardipine.cost) / 60;
  close(resumed.drugCost, withTwoPumps, '停泵后只结算其他仍运行的泵');
  close(resumed.cost, resumed.drugCost, '泵入费用同步计入诊疗总费用');

  delete saved.drugCost;
  delete saved.drugCostPartial;
  saved.cost = 170;
  const oldSave = reload(cas, saved);
  assert.equal(oldSave.drugCost, 0);
  assert.equal(oldSave.cost, 170);
  assert.equal(oldSave.drugCostPartial, true);
  oldSave.insult.acid = 4;
  E.tick(oldSave, 0.2);
  assert.ok(oldSave.death && !oldSave.running);
  const throughDeath = (2 * norepi.cost + 1.5 * dobutamine.cost + nicardipine.cost) * 0.2 / 3600;
  close(oldSave.drugCost, throughDeath, '病例结束的最后一个模拟步长正常结算');
  E.tick(oldSave, 60);
  close(oldSave.drugCost, throughDeath, '结束后不继续计费');
  const { cas: oldCas, ...oldState } = oldSave;
  const secondReload = reload(oldCas, JSON.parse(JSON.stringify(oldState)));
  assert.equal(secondReload.drugCostPartial, true);
  close(secondReload.drugCost, throughDeath, '再次存档保留本版累计金额与标记');
  close(secondReload.cost, 170 + throughDeath, '旧档总费用保留并累加新费用');
}

const earnedNoPressor = S => {
  ACHIEVEMENTS.reset();
  S.discharged = true;
  return ACHIEVEMENTS.evaluate(S).includes('no_pressor');
};

{
  const scenario = E.CASES.sepsis;
  const untreated = bed(70, scenario);
  E.give(untreated, 'ceftriaxone');
  E.give(untreated, 'furosemide');
  assert.ok(untreated.drugCost > 0);
  assert.equal(earnedNoPressor(untreated), true, '非升压药费不影响本床成就');
  const penalized = bed(70, scenario);
  penalized.dischargeOutcome = { status: 'penalized' };
  assert.equal(earnedNoPressor(penalized), false, '扣分出院不符合稳定出院条件');

  for (const id of ['norepi', 'dopamine', 'epi', 'phenylephrine', 'vasopressin']) {
    const treated = bed(70, scenario);
    assert.ok(E.give(treated, id) > 0);
    if (E.pumpRate(treated, id)) E.stopPump(treated, id);
    treated.log = [];
    treated.pk = [];
    const { cas, ...saved } = treated;
    const resumed = reload(cas, JSON.parse(JSON.stringify(saved)));
    assert.equal(earnedNoPressor(resumed), false, `给药记录重载后仍可识别 ${id}`);
    assert.equal(earnedNoPressor(untreated), true, '另一张床的升压药不计入本床');
  }

  const treated = bed(70, scenario);
  E.give(treated, 'norepi');
  const preview = SHARE.parse(SHARE.make(treated)).data;
  assert.ok(preview.a.some(order => order[2] === 'norepi'));
  const retaken = SHARE.rebuild(preview, E);
  assert.equal(retaken.drugCost, 0);
  assert.equal(earnedNoPressor(retaken), true, '会诊接手从接诊初始状态独立累计用药');
}

{
  const scenario = { ...baseline, tags: ['sepsis'], init: { ...baseline.init, preload: [['norepi', 8]] } };
  const pretreated = bed(70, scenario);
  assert.deepEqual(pretreated.log, []);
  assert.equal(pretreated.drugCost, 0);
  assert.equal(earnedNoPressor(pretreated), false, '院前已实际使用升压药，即使尚未计费也有用药记录');

  const oldSave = { cost: 60, log: [['给药', '去甲肾上腺素 8 μg/min 泵入', 'good']] };
  assert.equal(earnedNoPressor(reload(E.CASES.sepsis, oldSave)), false, '旧版给药日志可识别');
  oldSave.log = Array.from({ length: 600 }, () => ['10:00', '查看病情', 'info']);
  assert.equal(earnedNoPressor(reload(E.CASES.sepsis, oldSave)), false, '旧档日志达到上限且给药信息不足时不授予');
  oldSave.drugCost = 0;
  oldSave.given = [];
  assert.equal(earnedNoPressor(reload(E.CASES.sepsis, oldSave)), true, '完整给药记录不受日志上限影响');
}

console.log('药费结算与升压药成就回归通过');
