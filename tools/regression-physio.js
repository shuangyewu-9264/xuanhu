/* 生理回归测试：把两轮科学审查发现的每个具体缺陷固化成断言。
 * 任何一条失败，说明那次修复被改回去了。
 * 用法：node tools/regression-physio.js
 */
require('../prototype/substances.js');
require('../prototype/traits.js');
require('../prototype/generator.js');
const E = require('../prototype/engine.js');

/* 固定病人身份：对照与处置必须是同一个人，否则性别/年龄差异会污染结论 */
try { const _E = require('../prototype/engine.js'); _E.setIdentity && _E.setIdentity({ name:'测试患者', sex:'男', age:45, weight:70, height:172 }); } catch (e) {}
const G = globalThis.CASEGEN;

const out = [];
function check(name, ok, detail) { out.push({ name, ok, detail }); }

{
  const apap = E.create(G.generate(1, 123, ['apap']));
  const waiting = E.dischargeCheck(apap);
  apap.t = 2 * 3600;
  check('对乙酰氨基酚中毒的留观时限', waiting.observationEndsAt === apap.t &&
    waiting.reasons.some(reason => reason.includes('肝损窗口')) && E.dischargeCheck(apap).observationEndsAt === null,
    '提前等待，到满两小时结束');

  const stemi = E.create(G.generate(1, 123, ['stemi']));
  const beforePci = E.dischargeCheck(stemi).observationEndsAt;
  stemi.reperfused = true;
  stemi.reperfusionAt = stemi.t = 120;
  const afterPci = E.dischargeCheck(stemi).observationEndsAt;
  stemi.t = 1020;
  check('PCI 后的留观时限', beforePci === null && afterPci === 1020 && E.dischargeCheck(stemi).observationEndsAt === null,
    '从再通时起计十五分钟');
}

{
  const s = { arrests: 1, t: 3600, cost: 920, death: {}, penalties: 2, penaltyReasons: [{ label: '重复处置', count: 1 }] };
  const report = E.scoreBreakdown(s);
  check('结算分数可由明细逐项还原', report.score === 20 && E.finalScore(s) === 20 &&
    report.base + report.items.reduce((n, item) => n + item.delta, 0) === 20 &&
    report.items.some(item => item.label.includes('重复处置') && item.delta === -6),
    '骤停、死亡、费用、带教及旧记录');
}

/* 1. 首帧自洽：create 后与第一个 tick 的血压差 < 3 mmHg */
for (const id of ['hyperkalemia', 'dka', 'bleed', 'sepsis', 'opioid']) {
  const S = E.create(id);
  const a = E.bp(S).sys;
  E.tick(S, 1);
  const b = E.bp(S).sys;
  check(`首帧跳变 ${id}`, Math.abs(b - a) < 3, `${a} → ${b}`);
}

/* 2. 高钾 → 心动过缓（不是心动过速） */
{
  const hr = {};
  for (const k of [4.5, 7.5]) {
    const S = E.create('hyperkalemia');
    S.k = k; S.hr = 80;
    for (let i = 0; i < 8; i++) E.tick(S, 30);
    hr[k] = S.hr;
  }
  check('高钾致心动过缓', hr[7.5] < hr[4.5], `K4.5→${Math.round(hr[4.5])}, K7.5→${Math.round(hr[7.5])}`);
}

/* 3. 常规剂量吗啡不应致死 */
{
  const S = E.create('sepsis');
  E.give(S, 'morphine', 10);
  let died = false;
  for (let i = 0; i < 90 && S.running; i++) { E.tick(S, 30); if (S.death) died = true; }
  check('10 mg 吗啡不致死', !died || !String(S.death.reason).includes('昏迷'), S.death ? S.death.reason : '存活');
}

/* 4. 苯二氮卓会代谢（3 h 后药物负担显著下降） */
{
  const S = E.create('hyperkalemia');   /* 会自然死亡的病例会让 tick 停摆 */
  E.give(S, 'diazepam', 5);
  for (let i = 0; i < 30; i++) E.tick(S, 30);
  const mid = E.benzodiazepineExposure(S).load;
  for (let i = 0; i < 30; i++) E.tick(S, 60);   /* 30 min = 半个半衰期 */
  const late = E.benzodiazepineExposure(S).load;
  check('苯二氮卓代谢', mid > 0 && late < mid * 0.8, `${mid.toFixed(1)} → ${late.toFixed(1)}`);
}

/* 5. 等渗盐水不显著改变血钠 */
{
  const S = E.create('sepsis');
  const na0 = S.na;
  E.give(S, 'nacl', 2000);
  for (let i = 0; i < 150; i++) E.tick(S, 30);
  check('等渗盐水不改变血钠', Math.abs(S.na - na0) < 4, `${na0.toFixed(1)} → ${S.na.toFixed(1)}`);
}

/* 6. 健康人 6 h 血糖不漂移 */
{
  const S = E.create('sepsis');
  const g0 = S.glu;
  for (let i = 0; i < 360; i++) E.tick(S, 60);
  check('血糖不漂移', Math.abs(S.glu - g0) < 2.5, `${g0.toFixed(1)} → ${S.glu.toFixed(1)}`);
}

/* 7. 血钾 6 h 不因无摄入而流失 */
{
  const S = E.create('sepsis');
  const k0 = S.k;
  for (let i = 0; i < 360; i++) E.tick(S, 60);
  check('血钾不流失', Math.abs(S.k - k0) < 0.6, `${k0.toFixed(1)} → ${S.k.toFixed(1)}`);
}

/* 8. CPR 的血压支持会消退 */
{
  const S = E.create('sepsis');
  S.mapBoost = 25;
  E.tick(S, 60);
  check('CPR 支持消退', S.mapBoost < 24, `25 → ${S.mapBoost.toFixed(1)}`);
}

/* 9. 低钠纠正过度会被判脱髓鞘（不可出院） */
{
  const S = E.create(G.generate(1, 101, ['hyponatremia']));
  E.give(S, 'hypertonic_saline', 150);
  for (let i = 0; i < 40; i++) E.tick(S, 30);
  E.give(S, 'hypertonic_saline', 150);
  for (let i = 0; i < 40; i++) E.tick(S, 30);
  E.give(S, 'hypertonic_saline', 150);
  for (let i = 0; i < 40; i++) E.tick(S, 30);
  const rise = S.na - (S.na0 == null ? S.na : S.na0);
  const blocked = E.dischargeCheck(S).reasons.some(r => r.includes('脱髓鞘'));
  check('纠正过度 → 脱髓鞘且不能出院', !blocked || rise > 16, `升幅 ${rise.toFixed(1)}，拦截=${blocked}`);
}

/* 10. 去甲肾上腺素在感染性休克中的升压及撤除支持后的循环观察 */
{
  const se = E.create('sepsis');
  const m0 = E.bp(se).map;
  E.give(se, 'norepi', 8);
  for (let i = 0; i < 20; i++) E.tick(se, 30);
  check('去甲肾上腺素升压（脓毒症）', E.bp(se).map > m0 + 6, `${m0} → ${E.bp(se).map}`);
}

{
  const makeBed = () => E.create({ id: 'circulation-test', init: { ...G.BASE } });
  const observe = S => E.dischargeCheck(S).circulationObservation;
  const setPressure = (S, map) => {
    S.hr = 100;
    S.sv = 32;
    S.svr = (map - S.cvp) / (S.hr * S.sv / 1000);
  };
  const advance = (S, seconds) => {
    const until = S.t + seconds;
    while (S.running && S.t < until) E.tick(S, Math.min(10, until - S.t));
  };
  const bed = makeBed();
  const untreated = makeBed();
  check('未用过循环支持的病例沿用原出院条件', E.dischargeCheck(untreated).ok && !observe(untreated),
    '入院即稳定，无循环支持医嘱');

  bed.t = 158;
  setPressure(bed, 73);
  const firstPressure = E.bp(bed);
  E.give(bed, 'norepi', 8, '泵入');
  bed.t = 165;
  setPressure(bed, 70);
  const secondPressure = E.bp(bed);
  E.give(bed, 'dobutamine');
  bed.t = 170;
  setPressure(bed, 81);
  const thirdPressure = E.bp(bed);
  bed.t = 173;
  const supported = observe(bed);
  E.stopPump(bed, 'norepi');
  const onePump = observe(bed);
  E.stopPump(bed, 'dobutamine');
  const off = observe(bed);
  check('02:53 循环支持下血压回升仍需留观', firstPressure.sys === 83 && firstPressure.dia === 68 &&
    secondPressure.sys === 80 && secondPressure.dia === 65 && thirdPressure.sys === 91 && thirdPressure.dia === 76 &&
    supported?.phase === 'active' && supported.reason.includes('去甲肾上腺素、多巴酚丁胺') &&
    onePump?.phase === 'active' && onePump.reason.includes('多巴酚丁胺') &&
    off?.phase === 'observing' && off.remainingSeconds === 900 && !E.dischargeCheck(bed).ok,
    '83/68 → 80/65 → 91/76，两台泵全停才开始计时');

  advance(bed, 120);
  bed.running = false;
  E.tick(bed, 900);
  const paused = observe(bed);
  bed.running = true;
  E.give(bed, 'norepi', 8);
  E.give(bed, 'norepi', 12);
  const adjusted = E.pumpRate(bed, 'norepi') === 12 && bed.given.at(-1).pumpAction === 'adjust';
  advance(bed, 120);
  E.stopPump(bed, 'norepi');
  const restarted = observe(bed);
  check('循环观察按模拟时间推进，重新给药清空已观察时间', paused?.remainingSeconds === 780 && adjusted &&
    restarted?.remainingSeconds === 900 && E.pumpEffect(bed, 'norepi') > 0.02,
    '暂停后仍剩 13 分钟，新一轮停泵时即使有残效也从 15 分钟起计');

  advance(bed, 180);
  const relapseAt = bed.t;
  setPressure(bed, 70);
  const hypotensive = observe(bed);
  advance(bed, 20);
  for (let i = 0; i < 120 && observe(bed)?.phase === 'unstable'; i++) advance(bed, 1);
  const stableSince = bed.circulationStableSince;
  const checkpoint = observe(bed);
  advance(bed, 120);
  const { cas, ...snapshot } = bed;
  const saved = JSON.parse(JSON.stringify(snapshot));
  const restored = Object.assign(makeBed(), saved);
  E.restoreDischargeObservation(restored, saved);
  const restoredRemaining = observe(restored)?.remainingSeconds;
  advance(restored, stableSince + 899 - restored.t);
  const stillWaiting = !E.dischargeCheck(restored).ok && observe(restored)?.reason.includes('还需 1 秒');
  advance(restored, 1);
  check('低血压后重计，观察进度可存档并在满十五分钟时放行', hypotensive?.phase === 'unstable' &&
    stableSince > relapseAt && checkpoint?.remainingSeconds >= 880 && restored.circulationStableSince === stableSince &&
    restoredRemaining === checkpoint.remainingSeconds - 120 && stillWaiting && E.dischargeCheck(restored).ok &&
    observe(restored)?.phase === 'complete', '恢复血压后重计，重载继续观察，边界前一秒仍未达标');

  const oldOrder = { id: 'norepi', n: '去甲肾上腺素', route: '泵入', t: 0, onset: 1, dur: 8,
                     scale: 1, eff: { svr: 6, hr: 2 } };
  const oldSave = { t: 240, pk: [oldOrder] };
  const legacy = Object.assign(makeBed(), oldSave);
  E.restoreDischargeObservation(legacy, oldSave);
  const legacyOn = observe(legacy);
  advance(legacy, 540);
  const effectPreserved = legacy.pk[0] === oldOrder && legacy.mod.svr > 0;
  advance(legacy, 100);
  check('旧去甲肾上腺素医嘱保留原药效并自动进入停药观察', legacyOn?.phase === 'legacy' &&
    legacyOn.remainingSeconds === 624 && !E.pumpRate(legacy, 'norepi') && effectPreserved &&
    legacy.pk.length === 0 && observe(legacy)?.phase === 'observing', '旧有限医嘱按原药代消退，无需为旧医嘱手动停泵');

  const phaseAfter = (drug, route) => {
    const patient = makeBed();
    E.give(patient, drug, undefined, route);
    return observe(patient)?.phase;
  };
  check('有限时程的升压强心药触发观察，常用降压和调心率药沿用原条件',
    phaseAfter('epi', '静推') === 'legacy' && phaseAfter('milrinone') === 'legacy' &&
    !phaseAfter('nitroprusside') && !phaseAfter('atropine'), '肾上腺素静推、米力农、硝普钠、阿托品');
}

{
  const dx = require('../prototype/diagnosis');
  const S = E.create('hyperkalemia');
  const hasPoisoning = () => dx.classifyAll(S).some(d => d.primaryId === 'apapOD');
  const dose = E.give(S, 'acetaminophen');
  check('常规对乙酰氨基酚不触发中毒', dose === 500 && !E.acetaminophenExposure(S).aboveLimit && !hasPoisoning(), dose + ' mg');
  S.hepatotox = 0.85;
  check('常规剂量与非特异性肝损分开', !hasPoisoning(), '其他病因的肝损');
  S.hepatotox = 0;
  for (let i = 1; i < 8; i++) E.give(S, 'paracetamol', 500, '栓剂');
  check('不同途径合并用量', E.acetaminophenExposure(S).mg24h === 4000 && !E.acetaminophenExposure(S).aboveLimit, '4000 mg');
  E.give(S, 'acetaminophen', 500);
  check('超出累计上限仅提示用量', E.acetaminophenExposure(S).aboveLimit && !hasPoisoning(), '4500 mg');
  E.give(S, 'acetaminophen', 5500);
  check('高风险暴露提示', E.acetaminophenExposure(S).highRisk, '高风险');
  S.t += 86400;
  check('旧剂量不计入当天', E.acetaminophenExposure(S).mg24h === 0 && !hasPoisoning(), '已过 24 小时');
  S.tags = ['apap'];
  check('入院过量病例仍识别', E.acetaminophenExposure(S).known && hasPoisoning(), '有入院病史');
}
{
  const dx = require('../prototype/diagnosis');
  const cas = E.CASES.hyperkalemia;
  const create = () => E.create({ ...cas, init: { ...cas.init, k: 4, gcs: 15, rr: 16 } });
  const minutes = (s, n) => { for (let i = 0; i < n * 6; i++) E.tick(s, 10); };
  const diagnosed = s => dx.classifyAll(s).some(d => d.primaryId === 'benzoOD');
  for (const [id, dose, route] of [
    ['diazepam', 5], ['midazolam', 5], ['clonazepam', 1],
    ['lorazepam', 0.5, '口服'], ['lorazepam', 2, '静推'],
  ]) {
    const s = create();
    E.give(s, id, dose, route);
    const initially = diagnosed(s);
    minutes(s, route === '口服' ? 35 : 5);
    const exposure = E.benzodiazepineExposure(s);
    check('常规镇静 ' + id + (route || ''), !initially && !diagnosed(s) && exposure.load > 0 &&
      !exposure.high && s.gcs < 15, dose + ' mg');
  }
  const seizure = create(); seizure.seizure = 0.9; seizure.gcs = 7;
  E.give(seizure, 'diazepam', 10); E.give(seizure, 'diazepam', 10);
  minutes(seizure, 5);
  check('游戏内两次止惊处置', !E.benzodiazepineExposure(seizure).high && !diagnosed(seizure), '保留止惊疗程');

  const excessive = create();
  for (let i = 0; i < 6; i++) E.give(excessive, 'midazolam', 5);
  minutes(excessive, 3);
  check('重复暴露伴意识抑制', E.benzodiazepineExposure(excessive).overdose && diagnosed(excessive), '风险标签与诊断一致');
  E.give(excessive, 'flumazenil', 0.2);
  minutes(excessive, 7);
  check('拮抗后效应减退', !diagnosed(excessive) && excessive.gcs > 8, '有效负荷减退');
  minutes(excessive, 180);
  check('既往镇静史不持续触发诊断', !E.benzodiazepineExposure(excessive).sedated && !diagnosed(excessive), '作用已消退');

  const barbiturate = create();
  E.give(barbiturate, 'phenobarbital', 100);
  barbiturate.tox.benzo = 100; // Old v3 recorded the barbiturate mg a second time.
  E.restoreBenzodiazepines(barbiturate, {});
  const matched = JSON.parse(JSON.stringify(barbiturate));
  E.give(barbiturate, 'flumazenil', 0.2);
  minutes(barbiturate, 7); minutes(matched, 7);
  check('旧存档的苯巴比妥独立起效', barbiturate.tox.benzo === 0 && !diagnosed(barbiturate) &&
    barbiturate.gcs < 15 && barbiturate.gcs === matched.gcs, '拮抗剂不清除苯巴比妥作用');
}
{
  const patient = (init = {}) => E.create({ id: 'thermal', init: { ...G.BASE, ...init } });
  function advance(s, minutes) {
    for (let i = 0; i < minutes * 6 && s.running; i++) {
      E.tick(s, 10);
      G.step(s, 10, E);
    }
  }

  const cold = patient({ temp: 34.2 });
  const matched = patient({ temp: 34.2 });
  E.give(cold, 'acetaminophen', 500);
  check('低体温监护与出院判定', E.temperatureStatus(cold.temp) === 'crit' &&
    E.dischargeCheck(cold).reasons.some(s => s.includes('体温')), '34.2℃ 需复温观察');
  advance(cold, 45); advance(matched, 45);
  check('退热药不加重低体温', Math.abs(cold.temp - matched.temp) < 0.01, '单次常规剂量，与对照比较');
  const fever = patient({ temp: 39, infection: 0.8 });
  const untreated = patient({ temp: 39, infection: 0.8 });
  E.give(fever, 'acetaminophen', 500);
  advance(fever, 45); advance(untreated, 45);
  check('感染发热对退热药有反应', fever.temp < untreated.temp - 0.1, '病因相同的配对病例');

  const hot = E.create(G.generate(1, 13, ['heatstroke']));
  const drugOnly = E.create(G.generate(1, 13, ['heatstroke']));
  const dx = require('../prototype/diagnosis');
  const ids = s => dx.classifyAll(s).map(d => d.primaryId);
  check('热射病识别并保留合并感染的可能', dx.classify(hot).primary === '热射病' &&
    !ids(hot).includes('septicShock') && ids({ ...hot, infection: 0.8 }).includes('septicShock'), '比较有无感染负荷');
  const myxedema = E.create(G.generate(1, 13, ['myxedema']));
  check('甲减危象识别并保留合并阿片中毒的可能', dx.classify(myxedema).primary.includes('甲减') &&
    !ids(myxedema).includes('opioidOD') && ids({ ...myxedema, opioidTox: true }).includes('opioidOD'), '比较有无阿片中毒证据');
  E.setEnv(hot, 'cooling', true);
  E.give(drugOnly, 'acetaminophen', 500);
  advance(hot, 45); advance(drugOnly, 45);
  check('物理降温达标后停止且继续恢复', hot.running && !hot.env.cooling && hot.heatstrokeCooled &&
    hot.temp < 38.5 && hot.temp >= 36 && hot.history.some(p => p.temp > 40), hot.temp.toFixed(1) + '℃');
  check('普通退热药不解除热射病负荷', drugOnly.heatstrokeDrive === 1.30 && !!drugOnly.death, '未启动物理降温');

  const thyroid = E.create(G.generate(1, 13, ['thyroid']));
  E.give(thyroid, 'propylthiouracil', 200);
  advance(thyroid, 5);
  const early = thyroid.thyroidHeatDrive;
  advance(thyroid, 45);
  check('甲亢治疗按药物起效延迟降温', early >= 0.70 && thyroid.thyroidHeatDrive < early, '比较 5 与 50 分钟');
  const combined = E.create(G.generate(3, 13, ['heatstroke', 'seizure']));
  const reversed = E.create(G.generate(3, 13, ['seizure', 'heatstroke']));
  const initial = Math.min(combined.temp, reversed.temp);
  combined.seizure = 0;
  advance(combined, 1);
  check('复合病例保留入院高温与独立热负荷', initial > 40 && combined.heatstrokeDrive === 1.3 &&
    !combined.tempDrive, '热射病合并癫痫，互换模块顺序');
  const legacy = { tempDrive: 0.38, env: { cold: 1 } };
  const restored = E.create(G.generate(1, 13, ['heatstroke']));
  E.restoreTemperature(restored, legacy);
  check('继承旧存档进行中的降温', restored.heatstrokeDrive === 0.38 && !restored.tempDrive &&
    restored.env.cooling && !restored.env.cold && legacy.env.cold, '已取得的治疗进度保留');

  const low = patient({ temp: 34.2 });
  E.setEnv(low, 'cold', true); E.setEnv(low, 'warming', true);
  advance(low, 45);
  check('保暖回到目标后自动停止', !low.env.warming && low.log.some(([, msg]) => msg.includes('停止被动保暖')),
    '在寒冷环境中开启被动保暖');
}
{
  const general = E.create({ id: 'stable', init: { ...G.BASE } });
  const blocked = (st, hr) => E.dischargeCheck({ ...st, hr }).reasons.some(r => r.includes('心率'));
  check('通用出院心率与监护读数一致', [50, 114, 115, 119, 119.49].every(hr => !blocked(general, hr)) &&
    [49, 119.5, 120, NaN].every(hr => blocked(general, hr)), '显示 50–119 次/分');
  const hypo = E.create(G.generate(1, 13, ['myxedema']));
  const both = E.create(G.generate(3, 13, ['myxedema', 'organophosphate']));
  check('合并病例取更严格的心率下限', blocked(hypo, 54) && !blocked(hypo, 55) &&
    blocked(both, 59) && !blocked(both, 60), '甲减危象 55，有机磷中毒 60');
}
{
  const glucoseReasons = (S, glu) => E.dischargeCheck({ ...S, glu }).reasons.filter(reason => reason.startsWith('血糖'));
  const dkaCases = [E.create('dka'), E.create(G.generate(1, 13, ['dka'])),
    E.create(G.generate(3, 13, ['dka', 'bleed'])), E.create(G.generateVersion(3, 13, 1, ['dka', 'bleed']))];
  check('DKA 病例的血糖目标与出院拦截一致', dkaCases.every(S =>
    S.cas.goals.includes('血糖 <11 mmol/L') && glucoseReasons(S, 10.9).length === 0 &&
    [11.0, 11.6, 12.1].every(glu => {
      const reasons = glucoseReasons(S, glu);
      return reasons.length === 1 && reasons[0].includes(`${glu.toFixed(1)} mmol/L`) && reasons[0].includes('<11 mmol/L');
    })), '固定、生成、合并与旧版生成病例各报告一次');
  const nearLimit = { ...dkaCases[0], glu: 10.96 };
  check('DKA 出院血糖使用监护快照精度', E.snapshot(nearLimit).glu === 11 && glucoseReasons(nearLimit, 10.96).length === 1 &&
    glucoseReasons(nearLimit, 10.94).length === 0, '10.96 显示为 11.0，10.94 显示为 10.9');
  const others = [E.create({ id: 'stable', init: { ...G.BASE } }), E.create(G.generate(1, 13, ['hhs']))];
  check('其他病例采用通用出院血糖范围', others.every(S =>
    [4.0, 10.9, 11.0, 11.6, 12.0].every(glu => glucoseReasons(S, glu).length === 0) &&
    [3.9, 12.1].every(glu => glucoseReasons(S, glu).length === 1)), '含高渗高血糖状态，范围 4–12 mmol/L');
  check('出院遇到缺失血糖时提示复测', [dkaCases[0], others[0]].every(S =>
    [NaN, undefined, null].every(glu => glucoseReasons(S, glu).some(reason => reason.includes('需复测')))),
    'DKA 与通用判据均要求已知血糖');
  const review = (S, glu, start) => E.glucoseReviewStatus({ ...S, glu }, start);
  const general = others[0];
  check('复查复用通用出院血糖边界', [3.96, 12.04].every(glu => {
    const status = review(general, glu, 13);
    return status.inTarget && status.reason === 'target' && status.target === '4–12 mmol/L';
  }) && [3.94, 12.06].every(glu => !review(general, glu).inTarget), '监护读数 4.0 与 12.0 含边界');
  check('DKA 复查复用出院血糖上限', dkaCases.every(S => {
    const below = review(S, 10.94, 14);
    const limit = review(S, 10.96, 14);
    return below.glucose === 10.9 && below.reason === 'target' && below.target === '≥4 且 <11 mmol/L' &&
      limit.glucose === 11 && !limit.inTarget && limit.reason === null;
  }), '监护读数 10.9 达标，11.0 继续复查');
  check('血糖复查识别反向恶化', [
    [14.2, 12.3, null], [14.3, 12.3, 'worse'], [1.8, 3.7, null], [1.7, 3.7, 'worse'],
    [3.9, 12.3, 'worse'], [12.1, 3.9, 'worse']
  ].every(([glu, start, reason]) => review(general, glu, start).reason === reason),
    '覆盖升降 1.9 与 2.0 mmol/L 以及跨过目标区间');
  check('血糖复查保留缺测状态', [NaN, undefined, null].every(glu => {
    const status = review(general, glu, 13);
    return status.glucose === null && !status.inTarget && status.reason === 'missing';
  }) && review(general, 13).reason === null, '缺少当前值时需复测，可单独评估当前读数');
}
{
  const bed = E.create({ id: 'stable', init: { ...G.BASE, hr: 80, rr: 16, temp: 37, gcs: 15, k: 4, glu: 7 } });
  bed.spo2 = 98;
  const changeHr = hr => ({ hr, sv: bed.sv * bed.hr / hr });
  const review = (start, change) => E.conditionReviewChange({ ...start, ...change }, E.conditionReviewBaseline(start));
  const changes = [
    ['心率', changeHr(94), changeHr(95), '80 → 95 次/分'],
    ['呼吸频率', { rr: 12 }, { rr: 11 }, '16 → 11 次/分'],
    ['收缩压', { cvp: bed.cvp + 14 }, { cvp: bed.cvp + 15 }, `${E.bp(bed).sys} → ${E.bp(bed).sys + 15} mmHg`],
    ['血氧 SpO₂', { spo2: 95 }, { spo2: 94 }, '98 → 94 %'],
    ['体温', { temp: 37.4 }, { temp: 37.5 }, '37.0 → 37.5 ℃'],
    ['GCS', { gcs: 14 }, { gcs: 13 }, '15 → 13 分'],
    ['血钾', { k: 4.4 }, { k: 4.5 }, '4.0 → 4.5 mmol/L'],
  ];
  check('病情复评识别显著体征变化并显示前后值', changes.every(([label, small, large, values]) =>
    review(bed, small) === null && review(bed, large) === `${label} ${values}`),
    '心率、呼吸、收缩压、血氧、体温、GCS、血钾');

  const lowOxygen = { ...bed, spo2: 91 };
  check('病情复评跨监护阈值需最小幅度', review(lowOxygen, { spo2: 92 }) === null &&
    review(lowOxygen, { spo2: 93 }) === '血氧 SpO₂ 91 → 93 %' &&
    review({ ...bed, rr: 23 }, { rr: 25 }) === '呼吸频率 23 → 25 次/分' &&
    review({ ...bed, gcs: 12 }, { gcs: 11 }) === 'GCS 12 → 11 分' &&
    review({ ...bed, k: 5.5 }, { k: 5.6 }) === null &&
    review({ ...bed, k: 5.5 }, { k: 5.7 }) === '血钾 5.5 → 5.7 mmol/L',
    '边界附近的小波动、跨阈值的改善和恶化');

  const baseline = E.conditionReviewBaseline(bed);
  check('病情复评从等待起点累计变化，重开后从新读数计', [81, 84, 94].every(hr =>
    E.conditionReviewChange({ ...bed, ...changeHr(hr) }, baseline) === null) &&
    E.conditionReviewChange({ ...bed, ...changeHr(95) }, baseline) === '心率 80 → 95 次/分' &&
    review({ ...bed, ...changeHr(95) }, {}) === null,
    '小变动累积达到门槛，原地重开继续等待');

  const dka = E.create(G.generate(1, 13, ['dka']));
  check('病情复评提示血糖达标、离开目标和双向明显变化', [
    [bed, 12.1, 12, /12\.1 mmol\/L → 12\.0 mmol\/L.*进入本病例目标范围/],
    [bed, 4, 3.9, /4\.0 mmol\/L → 3\.9 mmol\/L.*偏离本病例目标范围/],
    [dka, 11, 10.9, /进入本病例目标范围（≥4 且 <11 mmol\/L）/],
    [dka, 10.9, 11, /偏离本病例目标范围（≥4 且 <11 mmol\/L）/],
    [dka, 15, 13, /15\.0 mmol\/L → 13\.0 mmol\/L/],
    [dka, 13, 15, /13\.0 mmol\/L → 15\.0 mmol\/L/],
    [bed, 7, null, /7\.0 mmol\/L → 缺测/],
  ].every(([patient, start, glu, expected]) => expected.test(review({ ...patient, glu: start }, { glu }))) &&
    review({ ...dka, glu: 15 }, { glu: 13.1 }) === null && review({ ...bed, glu: 7 }, { glu: 7.1 }) === null &&
    review(bed, {}) === null, '通用与 DKA 目标边界，达标后重开、持续目标外、缺测和小幅波动');

  check('病情复评识别床旁抽搐和心律状态变化',
    review(bed, { seizure: 0.14 }) === null &&
    review(bed, { seizure: 0.2 }) === '抽搐征象 未见抽搐 → 间断可见肢体抽动' &&
    review({ ...bed, seizure: 0.65 }, { seizure: 0 }) === '抽搐征象 持续肢体抽搐 → 未见抽搐' &&
    review(bed, { rhythm: 'vf' }) === '心律 窦性心律 → 心室颤动' &&
    review({ ...bed, rhythm: 'asystole' }, { rhythm: 'sinus' }) === '心律 心静止 → 窦性心律',
    '隐匿活动、发作、停止、心律恶化和恢复');

  const bleeding = { ...bed, bleedingSites: { bleed: 0.01, spleen: 0.02 } };
  const baselineBleeding = E.conditionReviewBaseline(bleeding);
  E.setBleedingRate(bleeding, 'bleed', 0.005);
  const slowed = E.conditionReviewChange(bleeding, baselineBleeding);
  E.setBleedingRate(bleeding, 'bleed', 0);
  const stopped = E.conditionReviewChange(bleeding, baselineBleeding);
  const baselineStopped = E.conditionReviewBaseline(bleeding);
  E.setBleedingRate(bleeding, 'bleed', 0.005);
  check('病情复评按部位识别止血和再出血', slowed === null &&
    stopped === '上消化道出血 活动性出血 → 已止血' &&
    E.conditionReviewChange(bleeding, baselineStopped) === '上消化道出血 未见活动性出血 → 活动性出血',
    '脾脏持续出血，上消化道出血先减缓再停止，随后复发');
}
{
  const cases = [E.create('hyperkalemia'), ...[['highK'], ['aki'], ['bph'], ['highK', 'aki']].map(ids =>
    E.create(G.generate(3, 13, ids))), E.create(G.generateVersion(3, 13, 1, ['highK', 'aki']))];
  const potassiumReasons = (bed, k) => E.dischargeCheck({ ...bed, k }).reasons.filter(reason => reason.startsWith('血钾'));
  check('高低血钾各只提示一次并显示目标', cases.every(bed =>
    [3.4, 5.7, 7.1].every(k => {
      const reasons = potassiumReasons(bed, k);
      return reasons.length === 1 && reasons[0].includes(`${k} mmol/L`) && reasons[0].includes('3.5–5.5');
    }) && [3.5, 4.4, 5.5].every(k => potassiumReasons(bed, k).length === 0)),
    '覆盖固定、生成、复合和旧版病例，两个边界值都达标');
  const combined = E.create(G.generate(3, 13, ['highK', 'dka']));
  check('血钾和血糖同时异常时各提示一次', [5.7, 7.1].every(k => [10.9, 11, 11.6, 12.1].every(glu => {
    const { reasons } = E.dischargeCheck({ ...combined, k, glu });
    return reasons.filter(r => r.startsWith('血钾')).length === 1 &&
      reasons.filter(r => r.startsWith('血糖')).length === (glu >= 11 ? 1 : 0);
  })), '高钾合并 DKA');
}
{
  const assess = (ids, patch) => E.dischargeCheck(Object.assign(E.create(G.generate(4, 13, ids)), patch)).reasons;
  const count = (rows, prefix) => rows.filter(row => row.startsWith(prefix)).length;
  const seizure = assess(['seizure', 'highK'], { gcs: 3, k: 6.9, seizure: 0.79 });
  check('癫痫合并高钾的出院评估分列三项', count(seizure, '意识') === 1 && count(seizure, '血钾') === 1 &&
    count(seizure, '仍有抽搐') === 1, 'GCS 3、血钾 6.9 和床旁抽搐各提示一次');
  const mixed = assess(['opioid', 'hyponatremia'], { gcs: 14, rr: 11, na: 125 });
  check('合并病例保留较严的意识、呼吸和血钠门槛', ['意识', '呼吸', '血钠'].every(prefix => count(mixed, prefix) === 1) &&
    mixed.some(r => r.startsWith('意识') && r.includes('15 分（本病例要求意识完全恢复）')) &&
    !assess(['opioid', 'hyponatremia'], { gcs: 15, rr: 12, na: 130 }).some(r => /^(意识|呼吸 |血钠 )/.test(r)),
    'GCS 14、呼吸 11、血钠 125 仍拦截，达到各项目标后消除');
  const renal = cr => assess(['apap', 'aki', 'bph'], { cr }).filter(r => r.startsWith('肌酐'));
  check('肌酐读数合并并注明各病种的阈值', renal(450).length === 1 &&
    ['≤130', '≤180', '≤400'].every(target => renal(450)[0].includes(target)) &&
    renal(150).length === 1 && renal(150)[0].includes('≤130') && !renal(130).length, '对乙酰氨基酚中毒合并肾损伤、尿潴留');
  const bleeding = assess(['bleed', 'trauma'], { hb: 70, bleedingSites: { bleed: 1, trauma: 1 } });
  check('重复血红蛋白合并，两个出血部位分别保留', count(bleeding, '血红蛋白') === 1 &&
    bleeding.includes('消化道出血未止') && bleeding.includes('创伤出血未控制'), '不同处置原因仍逐项可见');
  const urine = assess(['pancreatitis', 'hhs'], { uo: 0.3, weight: 70 }).filter(r => r.startsWith('尿量'));
  check('合并病例可区分两种尿量要求', urine.length === 1 && urine[0].includes('18 mL/h') && urine[0].includes('≥30 mL/h') &&
    urine[0].includes('>0.5 mL/kg/h'), '尿量和按体重折算的尿量各保留单位与目标');
  const bed = E.create(G.generate(3, 13, ['seizure', 'hyponatremia']));
  check('床旁抽搐征象与出院拦截同步', [0.79, 0.54, 0.15, 0.11, 0.10, 0].every(seizure => {
    const sample = { ...bed, seizure };
    return Boolean(E.convulsionSigns(sample)) === (seizure > 0.10) &&
      count(E.dischargeCheck(sample).reasons, '仍有抽搐') === Number(seizure > 0.10);
  }), '合并低钠时保留更严格的发作观察条件');
}
{
  const edema = E.create(G.generate(2, 101, ['edema']));
  E.ACTIONS.oxygen.apply(edema);
  const samplingAt = E.TESTS.abg.min * 60;
  let consistent = true;
  for (let sec = 0; sec < 18 * 60; sec += 2) {
    E.tick(edema, 2);
    G.step(edema, 2, E);
    if (edema.t === samplingAt) E.orderTest(edema, 'abg');
    E.pollTests(edema);
    consistent &&= Math.abs(edema.spo2 - E.hill(edema.pao2) * 100) < 0.01;
  }
  const abg = E.testValue(edema, 'abg');
  const report = edema.labSnap.abg;
  const latest = E.snapshot(edema);
  check('高浓度吸氧时动脉血气与监护血氧一致', consistent && report?.t === samplingAt &&
    report.reportedAt === samplingAt + E.TESTS.abg.min * 60 && abg?.oxygenModelVersion === 2 &&
    Math.abs(abg.sao2 - E.hill(abg.pao2) * 100) < 1 && abg.spo2 === abg.sao2 &&
    edema.endCapillaryPo2 > 600 && latest.pao2 < abg.pao2 && latest.spo2 < abg.spo2 &&
    latest.pao2 < edema.endCapillaryPo2 && latest.spo2 < 97,
    `首份血气 ${abg?.pao2} mmHg / ${abg?.sao2}%，后续 ${latest.pao2} mmHg / ${latest.spo2}%`);

  const support = E.create({ id: 'oxygen-test', init: { ...G.BASE } });
  Object.assign(support, { shunt: 0.35, t: 300, spontaneousRr: 16, spontaneousCO2: 40, respiratoryAssessmentAt: 300 });
  E.ACTIONS.oxygen.apply(support);
  support.vent = 1;
  const low = E.roomAirSaturation(support, support.spontaneousCO2);
  E.ACTIONS.extubate.apply(support);
  const refused = support.vent;
  E.ACTIONS.oxygen_off.apply(support);
  check('机械通气中降低氧浓度只改变 FiO₂', support.vent && support.fio2 === 0.21 &&
    support.log.at(-1)[1].includes('继续机械通气') && E.dischargeCheck(support).reasons.includes('仍需机械通气'),
    support.log.at(-1)[1]);
  support.shunt = 0;
  E.ACTIONS.extubate.apply(support);
  E.ACTIONS.oxygen_off.apply(support);
  const onRoomAir = support.log.at(-1)[1].includes('改室内空气');
  E.tick(support, 1);
  check('撤机与撤氧使用室内空气估算和观察', low < 92 && refused && !support.vent && onRoomAir &&
    support.fio2 === 0.21 && E.roomAirSaturation(support) >= 94 &&
    E.dischargeCheck(support).reasons.some(reason => reason.includes('室内空气血氧需稳定')),
    `高分流室气估计 ${low.toFixed(1)}%，解除分流后允许撤机`);

  const healthy = E.create({ id: 'oxygen-test', init: { ...G.BASE } });
  const co = E.create({ id: 'oxygen-test', init: { ...G.BASE, coHb: 0.4 } });
  check('碳氧血红蛋白降低氧输送，血氧仪可维持假正常', Math.abs(healthy.pao2 - co.pao2) < 0.1 &&
    Math.abs(healthy.spo2 - co.spo2) < 0.1 && co.spo2 >= 94 && co.do2 < healthy.do2 * 0.7,
    `SpO₂ ${co.spo2.toFixed(1)}%，氧输送 ${Math.round(healthy.do2)} → ${Math.round(co.do2)} mL/min`);

  const oldSample = { s: { pao2: 631, spo2: 90 } };
  const saved = { pao2: 631, spo2: 90, shunt: 0.25, svo2: 0.50, labSnap: { abg: oldSample } };
  const restored = Object.assign(E.create({ id: 'oxygen-test', init: { ...G.BASE } }), saved);
  E.restoreCardiorespiratory(restored, saved);
  check('恢复旧档时重算现时氧合并保留原血气', restored.endCapillaryPo2 === 631 &&
    restored.pao2 < 200 && Math.abs(restored.spo2 - E.hill(restored.pao2) * 100) < 0.01 &&
    restored.labSnap.abg === oldSample && oldSample.s.pao2 === 631 && !oldSample.s.oxygenModelVersion,
    `实时 PaO₂ ${Math.round(restored.pao2)} mmHg，旧报告 631 mmHg`);
}

{
  const makeBed = () => E.create({ id: 'blood-test', init: { ...G.BASE } });
  const bed = makeBed();
  const other = makeBed();
  Object.assign(bed, { t: 33, hb: 125, wbc: 9.24, plt: 233.4 });
  const firstReady = E.orderTest(bed, 'cbc');
  Object.assign(bed, { t: firstReady - 1, hb: 109, wbc: 18.4, plt: 175 });
  E.pollTests(bed);
  const waiting = E.testValue(bed, 'cbc') === null;
  bed.t++;
  E.pollTests(bed);
  const first = bed.labSnap.cbc;
  check('血常规按开单时取样并延迟显示', waiting && first?.t === 33 && first?.reportedAt === firstReady &&
    first.s.hb === 125 && first.s.wbc === 9.2 && first.s.plt === 233,
    '等待期间改变血红蛋白、白细胞和血小板');

  const secondAt = bed.t + 12;
  bed.t = secondAt;
  const secondReady = E.orderTest(bed, 'cbc');
  Object.assign(bed, { t: secondAt + 3, hb: 95, wbc: 23, plt: 120 });
  const reusedReady = E.orderTest(bed, 'cbc');
  const waitingOnSecond = E.testValue(bed, 'cbc') === first.s;
  const restored = Object.assign(makeBed(), JSON.parse(JSON.stringify(bed)));
  restored.t = secondReady;
  E.pollTests(restored);
  const second = restored.labSnap.cbc;
  check('血常规复查保留原样本，待出时不重复下单', reusedReady === secondReady && waitingOnSecond &&
    restored.cost === 2 * E.TESTS.cbc.cost && second?.t === secondAt && second?.reportedAt === secondReady &&
    second.s.hb === 109 && second.s.wbc === 18.4 && second.s.plt === 175 &&
    restored.labPrevious.cbc?.t === 33 && restored.labPrevious.cbc.s.hb === 125 && !other.labSnap.cbc,
    '等待复查时存档重载，并检查另一床的报告');

  const legacy = makeBed();
  legacy.t = 2000;
  legacy.tests.cbc = { readyAt: 2000, done: false };
  legacy.labSnap.cbc = { t: 100, s: { hb: 130 } };
  E.pollTests(legacy);
  check('旧档待出报告保留原回报规则和旧结果', legacy.labSnap.cbc?.sampledAtKnown === false &&
    legacy.labSnap.cbc.reportedAt === 2000 && legacy.labPrevious.cbc?.s.hb === 130,
    '旧档缺少开单时样本');
}

{
  const ptx = E.create(G.generate(2, 101, ['ptx']));
  const asthma = E.create(G.generate(2, 101, ['asthma']));
  const edema = E.create(G.generate(2, 101, ['edema']));
  const isolated = !asthma.lungExam.latest;
  const before = E.auscultate(ptx);
  E.ACTIONS.chestTube.apply(ptx);
  ptx.t = 35;
  const after = E.auscultate(ptx);
  const obstructed = E.auscultate(asthma);
  const wet = E.auscultate(edema);
  check('双肺听诊反映病情机制并分床保存复查', isolated && before.left.includes('消失') &&
    before.left !== before.right && after.left === after.right && after.t === 35 &&
    ptx.lungExam.previous === before && ptx.lungExam.latest === after && !asthma.lungExam.previous &&
    obstructed.left.includes('哮鸣音') && obstructed.left === obstructed.right &&
    wet.left.includes('湿啰音') && wet.left === wet.right,
    '气胸引流前后、哮喘、肺水肿');
}

{
  const makeBed = () => E.create(G.generate(2, 101, ['ptx']));
  const bed = makeBed();
  Object.assign(bed, { t: 33, lungWater: 0.70 });
  const firstReady = E.orderTest(bed, 'cxr');
  E.ACTIONS.chestTube.apply(bed);
  Object.assign(bed, { t: firstReady - 1, lungWater: 0.12 });
  const duplicateReady = E.orderTest(bed, 'cxr');
  E.pollTests(bed);
  const waiting = !E.chestXrayReports(bed).length;
  const restored = Object.assign(makeBed(), JSON.parse(JSON.stringify(bed)));
  E.restoreChestXrayReports(restored);
  restored.t = firstReady + 7;
  E.pollTests(restored);
  const [first] = E.chestXrayReports(restored);
  const secondAt = restored.t + 20;
  restored.t = secondAt;
  const secondReady = E.orderTest(restored, 'cxr');
  restored.t = secondReady + 5;
  E.pollTests(restored);
  const [prior, second] = E.chestXrayReports(restored);
  const receipts = restored.log.filter(([, message]) => message === '床旁胸片 结果已出');
  check('胸片按申请时病情生成，回报可逐份追溯', waiting && duplicateReady === firstReady &&
    first?.sampledAt === 33 && first.reportedAt === firstReady + 7 && first.findings.includes('片状模糊影') &&
    first.findings.includes('左肺明显受压') && prior === first && Object.isFrozen(first) &&
    second?.sampledAt === secondAt && second.reportedAt === secondReady + 5 && second.findings.includes('未见胸腔积气') &&
    second.findings.includes('未见明显肺水肿') && receipts.length === 2 &&
    receipts[0][3] === first.reportedAt && receipts[0][4] === first.id && receipts[1][4] === second.id &&
    first.id !== second.id && restored.cost === 2 * E.TESTS.cxr.cost && !E.chestXrayReports(makeBed()).length,
    '引流后等候首份回报、带待出报告重载、复查和床位隔离');

  const legacy = makeBed();
  legacy.t = 3000;
  legacy.lungWater = 0.12;
  legacy.tests.cxr = { readyAt: 3000, done: false };
  legacy.labSnap.cxr = { t: 1210, s: { lungWater: 0.70 } };
  legacy.log.push(['00:16', '床旁胸片 结果已出', 'good'], ['00:20', '床旁胸片 结果已出', 'good']);
  E.restoreChestXrayReports(legacy);
  E.pollTests(legacy);
  E.restoreChestXrayReports(legacy);
  const [lost, archived, pending] = E.chestXrayReports(legacy);
  const oldReceipts = legacy.log.filter(([, message]) => message === '床旁胸片 结果已出');
  check('旧档胸片保留真实快照和资料缺失标记', lost?.reportedAt === null && lost.findings.includes('未保留') &&
    archived?.sampledAt === null && archived.reportedAt === 1210 && archived.findings.includes('片状模糊影') &&
    archived.findings.includes('未记录胸腔积气') && oldReceipts[0][4] === lost.id && oldReceipts[1][4] === archived.id &&
    pending?.sampledAt === null && pending.reportedAt === 3000 && pending.findings.includes('未保留') &&
    E.chestXrayReports(legacy).length === 3,
    '旧版先前回执、已保存的最后一次快照、缺少采集资料的待出报告');

  const ambiguous = makeBed();
  ambiguous.labSnap.cxr = { t: 1210, s: { lungWater: 0.70 } };
  ambiguous.log.push(['00:20', '床旁胸片 结果已出', 'good'], ['00:20', '床旁胸片 结果已出', 'good']);
  E.restoreChestXrayReports(ambiguous);
  const [oldFirst, oldSecond, oldSnapshot] = E.chestXrayReports(ambiguous);
  check('同分钟旧回执的胸片快照单独保留', oldFirst?.reportedAt === null && oldSecond?.reportedAt === null &&
    oldFirst.findings.includes('未保留') && oldSecond.findings.includes('未保留') &&
    oldSnapshot?.reportedAt === 1210 && oldSnapshot.findings.includes('片状模糊影'),
    '两个旧回执只有相同的分钟时间戳');
}

{
  const makeBed = () => E.create(G.generate(2, 101, ['preeclampsia']));
  const action = E.ACTIONS.delivery;
  const attempt = bed => {
    action.apply(bed);
    const status = bed.log.at(-1)[2];
    if (status === 'good') bed.cost += action.cost;
    return status;
  };
  const advance = (bed, seconds) => {
    E.tick(bed, seconds);
    G.step(bed, seconds, E);
  };
  const bed = makeBed();
  const noIndication = E.create({ id: 'stable', init: { ...G.BASE } });
  const { svr, plt } = bed;
  const accepted = attempt(bed) === 'good';
  const duplicate = attempt(bed) === 'warn';
  const rejected = attempt(noIndication) === 'warn';
  check('分娩启动保留病因，重复和无指征申请不计费', accepted && duplicate && rejected &&
    bed.deliveryStartedAt === 0 && !bed.delivered && bed.deliveryAt === null && bed.svr === svr &&
    bed.cost === action.cost && noIndication.deliveryStartedAt === null && noIndication.cost === 0,
    '常规操作入口按开始时的成功日志计费');

  bed.running = false;
  advance(bed, E.DELIVERY_DURATION);
  const stayedPaused = bed.t === 0 && !bed.delivered;
  bed.running = true;
  const steps = E.DELIVERY_DURATION / 0.2;
  for (let step = 1; step < steps; step++) advance(bed, 0.2);
  const stillPending = !bed.delivered && bed.deliveryAt === null && bed.plt < plt;
  const { cas, ...stored } = bed;
  const restored = Object.assign(makeBed(), JSON.parse(JSON.stringify(stored)));
  const control = Object.assign(makeBed(), JSON.parse(JSON.stringify(stored)), { deliveryStartedAt: null });
  const beforeDelivery = E.conditionReviewBaseline(restored);
  advance(restored, 0.2);
  advance(control, 0.2);
  const completion = /胎盘已娩出/;
  const atBoundary = restored.deliveryAt === E.DELIVERY_DURATION && restored.delivered &&
    restored.svr === Math.max(18, control.svr - 3) && restored.plt > bed.plt &&
    restored.deliveryRecord?.maternal.includes('SpO₂') && restored.deliveryRecord.newborn.includes('新生儿科') &&
    restored.cas.extra(restored).some(reason => reason.includes('产后观察'));
  attempt(restored);
  advance(restored, 0.2);
  check('分娩按模拟时间完成一次并开始产后观察', stayedPaused && stillPending && atBoundary &&
    restored.cost === action.cost && restored.log.filter(([, msg]) => completion.test(msg)).length === 1,
    '暂停期间冻结，临界点前重载，完成后再次执行');
  check('病情复评在分娩完成时触发', E.conditionReviewChange(bed, beforeDelivery) === null &&
    E.conditionReviewChange(restored, beforeDelivery) === '分娩已完成，胎盘已娩出，进入产后观察' &&
    E.conditionReviewChange(restored, E.conditionReviewBaseline(restored)) === null,
    '临界点前继续等待，分娩完成触发一次');

  const legacy = Object.assign(makeBed(), { t: 700, delivered: true, deliveryAt: 90, cost: action.cost });
  const legacyPlt = legacy.plt;
  const alreadyDelivered = attempt(legacy) === 'warn';
  advance(legacy, 1);
  check('旧档已娩出保留完成时刻和产后病程', alreadyDelivered && legacy.deliveryAt === 90 &&
    legacy.deliveryStartedAt === null && legacy.plt > legacyPlt && legacy.cost === action.cost &&
    !legacy.deliveryRecord && !legacy.log.some(([, msg]) => completion.test(msg)), '兼容即时完成的旧版本');
}

const fails = out.filter(x => !x.ok);
const pad = s => s + ' '.repeat(Math.max(0, 26 - s.length));
console.log(pad('断言') + '结果   实测');
console.log('-'.repeat(70));
for (const r of out) console.log(pad(r.name) + (r.ok ? 'PASS  ' : 'FAIL  ') + r.detail);
console.log('-'.repeat(70));
console.log(`${out.length - fails.length}/${out.length} 通过` + (fails.length ? '　⚠ 有修复被改回' : '　✓ 全部保持'));
process.exit(fails.length ? 1 : 0);

