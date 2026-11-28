/* ==========================================================================
 * 内容回归：14 个病理模块 × {规范治疗, 完全不管}
 *  - 每个模块 5 个不同 seed，各生成 1 例
 *  - 规范治疗：按临床路径给药 → 要求 ≥90% 能出院
 *  - 完全不管：只推进时间 → 要求 100% 恶化（未出院），其中 ≥70% 死亡
 *  - 同时检查每个模块的导师提示规则是否 ≥2 条
 *
 * 用法：
 *   node tools/content-test.js [--verbose] [--module=asthma] [--trace=asthma] [--seeds=5]
 * ========================================================================== */
const assert = require('node:assert/strict');
const substances = require('../prototype/substances.js');
require('../prototype/mentor.js');
const E = require('../prototype/engine.js');

/* 固定病人身份：对照与处置必须是同一个人，否则性别/年龄差异会污染结论 */
try { const _E = require('../prototype/engine.js'); _E.setIdentity && _E.setIdentity({ name:'测试患者', sex:'男', age:45, weight:70, height:172 }); } catch (e) {}
const G = require('../prototype/generator.js');
const A = require('../prototype/achievements.js');

const DT = 10;              // 每步 10 秒
const MAX_MIN = 360;        // 最长观察 6 小时
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (process.argv.find(a => a.startsWith('--module=')) || '').split('=')[1] || '';
const TRACE = (process.argv.find(a => a.startsWith('--trace=')) || '').split('=')[1] || '';
const SEED_ARG = process.argv.find(a => a.startsWith('--seeds='));
const SEED_N = SEED_ARG ? Math.max(1, +SEED_ARG.split('=')[1] || 5) : 5;
const SEEDS = Array.from({ length: SEED_N }, (_, i) => (i + 1) * 101);

const has = (S, id) => !!(S.pk && S.pk.some(p => p.id === id));
const bp = S => E.bp(S);
const norepiSupport = (S, startMap, stopMap, rate) => {
  const pressure = bp(S);
  if (!E.pumpRate(S, 'norepi') && pressure.map < startMap) E.give(S, 'norepi', rate);
  if (E.pumpRate(S, 'norepi') && pressure.map >= stopMap && pressure.sys >= 100) E.stopPump(S, 'norepi');
};
const o2 = S => {
  const onO2 = (S.fio2 || 0.21) > 0.21 || S.o2 || S.vent;
  if (!onO2) { if (S.spo2 < 94) E.ACTIONS.oxygen.apply(S); return; }
  /* 新版判定要求「室内空气血氧」— 稳定后必须撤氧，否则永远出不了院 */
  if (!S.vent && S.spo2 >= 96 && (S.shunt || 0) < 0.28) E.ACTIONS.oxygen_off.apply(S);
};

/* ---------- 各模块的规范治疗路径 ---------- */
const TREAT = {
  highK(S, t) {
    if (!S._p) { S._p = 1; E.give(S, 'calcium', 10); E.give(S, 'insulin', 10); E.give(S, 'dextrose50', 25); }
    if (S.k > 5.5 && !has(S, 'insulin')) { E.give(S, 'insulin', 10); E.give(S, 'dextrose50', 25); }
    if (t >= 600 && S.k > 5.0 && !(S.dialysisUntil > S.t)) E.ACTIONS.dialysis.apply(S);
    if (S.ph < 7.20 && !has(S, 'bicarb')) E.give(S, 'bicarb', 150);
    if (S.vol < 4.2 && !has(S, 'nacl')) E.give(S, 'nacl', 500);
    if (S.glu < 4 && !has(S, 'dextrose50')) E.give(S, 'dextrose50', 25);
  },
  dka(S, t) {
    if (!S._p) { S._p = 1; E.give(S, 'nacl', 1000); S._fluid = 1; }
    /* 液体复苏：30% 留血管内，所以需要 2–3 L 才能把血管内容量拉回 4.2 以上 */
    if (S.vol < 4.3 && t >= (S._fAt || 0) + 600 && (S._fluid || 0) < 3) {
      E.give(S, 'nacl', 1000); S._fAt = t; S._fluid = (S._fluid || 0) + 1;
    }
    /* 胰岛素要持续到酮症酸中毒纠正，不是"血糖正常就停" */
    const keto = S.ph < 7.30 || S.hco3 < 18 || S.glu > 11;
    if (t >= 60 && keto && t >= (S._insAt || 0) + 900) { E.give(S, 'insulin', 10); S._insAt = t; }
    if (S.glu < 11 && !has(S, 'dextrose10')) E.give(S, 'dextrose10', 500);
    if (S.glu < 6 && !has(S, 'dextrose50')) E.give(S, 'dextrose50', 25);
    /* 补钾：胰岛素把钾推进细胞，治着治着会掉 */
    if (S.k < 4.0 && t >= (S._kAt || 0) + 300) { E.give(S, 'kcl', 20); S._kAt = t; }
  },
  bleed(S) {
    if (!S._p) { S._p = 1; E.give(S, 'nacl', 1000); E.give(S, 'prbc', 2); E.give(S, 'omeprazole', 80); }
    if (!S.bleedStopped && bp(S).map >= 65) E.ACTIONS.endoscopy.apply(S);
    if (bp(S).sys < 90 && !has(S, 'nacl')) E.give(S, 'nacl', 500);
    if (S.hb < 80 && !has(S, 'prbc')) E.give(S, 'prbc', 2);
  },
  sepsis(S, t) {
    if (!S._p) { S._p = 1; E.give(S, 'nacl', 1000); }
    if (t >= 60 && !has(S, 'ceftriaxone')) E.give(S, 'ceftriaxone', 2);
    norepiSupport(S, 70, 80, 12);
    if (S.vol < 4.4 && !has(S, 'nacl')) E.give(S, 'nacl', 1000);
  },
  opioid(S, t) {
    o2(S);
    /* 纳洛酮半衰期远短于阿片：呼吸再次掉下来就要复给，而不是只给一次 */
    const poor = S.rr < 12 || S.gcs < 12;
    if (!S._p) { S._p = 1; E.give(S, 'naloxone', 0.4); S._nAt = t; return; }
    if (poor && t >= (S._nAt || 0) + 180) { E.give(S, 'naloxone', 0.4); S._nAt = t; }
  },
  edema(S) {
    if (!S._p) { S._p = 1; o2(S); E.give(S, 'furosemide', 30); }
    const pressure = bp(S);
    norepiSupport(S, 62, 75, 8);
    /* 肺水消了就把氧撤掉，否则永远卡在"仍在吸氧" */
    if ((S.lungWater || 0) <= 0.44 && S.spo2 >= 95 && ((S.fio2 || 0.21) > 0.21 || S.o2)) {
      E.ACTIONS.oxygen_off.apply(S);
    }
    if (S.lungWater > 0.45 && pressure.sys >= 140 && !has(S, 'nitroglycerin')) E.give(S, 'nitroglycerin', 0.5);
    if (S.lungWater > 0.42 && S.vol > 4.9 && !has(S, 'furosemide')) E.give(S, 'furosemide', 20);
    if (S.spo2 < 94) o2(S);
    const pump = E.pumpRate(S, 'dobutamine');
    if (!pump && S.lungWater > 0.44 && pressure.sys < 90) E.give(S, 'dobutamine');
    if (pump && S.lungWater < 0.40 && pressure.sys >= 90) E.stopPump(S, 'dobutamine');
    if (S.k < 3.8 && !has(S, 'kcl')) E.give(S, 'kcl', 20);
  },
  thyroid(S) {
    if (!S._p) { S._p = 1; E.give(S, 'propranolol', 20); E.give(S, 'propylthiouracil', 200); E.give(S, 'hydrocortisone', 100); }
    if (S.hr > 120 && !has(S, 'propranolol')) E.give(S, 'propranolol', 20);
  },
  hypogly(S) {
    if (!S._p) { S._p = 1; E.give(S, 'dextrose50', 25); }
    if (S.glu < 4 && !has(S, 'dextrose50')) E.give(S, 'dextrose50', 25);
    if (S.glu < 5 && !has(S, 'dextrose10')) E.give(S, 'dextrose10', 500);
  },

  asthma(S, t) {
    o2(S);
    if (!S._p) {
      S._p = 1;
      E.give(S, 'salbutamol', 2.5); E.give(S, 'ipratropium', 0.5);
      E.give(S, 'methylprednisolone', 40);
      S._sbAt = t;
    }
    if ((S.airwayResistance || 0) > 0.28 && t >= (S._sbAt || 0) + 900) {
      E.give(S, 'salbutamol', 2.5); E.give(S, 'ipratropium', 0.5); S._sbAt = t;
    }
  },
  organophosphate(S, t) {
    o2(S);
    if (!S._p) { S._p = 1; E.give(S, 'atropine', 1); E.give(S, 'pralidoxime', 1); S._aAt = t; S._pAt = t; }
    /* 阿托品只滴定到"心率上来、分泌物减少"，过量会高热/谵妄 */
    if (S.hr < 75 && t >= (S._aAt || 0) + 600) { E.give(S, 'atropine', 0.5); S._aAt = t; }
    if (t >= (S._pAt || 0) + 900) { E.give(S, 'pralidoxime', 1); S._pAt = t; }
  },
  apap(S) {
    if (!S._p) { S._p = 1; E.give(S, 'nacetylcysteine', 150); }
    if (!has(S, 'nacetylcysteine')) E.give(S, 'nacetylcysteine', 150);
    if (S.glu < 4 && !has(S, 'dextrose50')) E.give(S, 'dextrose50', 25);
  },
  htnEmergency(S) {
    if (!S._p) { S._p = 1; E.give(S, 'nitroprusside', 0.5); E.give(S, 'labetalol', 10); }
    if ((S._sys || 0) > 160 && !has(S, 'nitroprusside')) E.give(S, 'nitroprusside', 0.5);
    if ((S._sys || 0) > 160 && !has(S, 'labetalol')) E.give(S, 'labetalol', 10);
  },
  hyponatremia(S) {
    /* 病因处理优先：停噻嗪 + 限水，否则补多少钠都会被稀释回去 */
    if (!S.hyponatremiaCauseControlled) E.ACTIONS.hyponatremia_care.apply(S);
    /* 指南：先给一次 bolus 抬 4–6，之后每 30 min 复评；24 h 总升幅控制在 ~10–12，过快会脱髓鞘 */
    if (!S._p) { S._p = 1; E.give(S, 'hypertonic_saline', 150); S._hAt = S.t; S._hN = 1; }
    const rise = S.na - (S.na0 == null ? S.na : S.na0);
    /* 目标：6 h 内从重度低钠抬到 130 上下，总升幅控制在 ~10，避免脱髓鞘 */
    if (S.na < 129 && rise < 9 && (S._hN || 0) < 8 && (S.t - (S._hAt || 0)) >= 900) {
      E.give(S, 'hypertonic_saline', 60); S._hAt = S.t; S._hN = (S._hN || 0) + 1;
    }
  },


  pancreatitis(S) {
    S._fl = S._fl || 0;
    if (S._fl < 4 && S.vol < 4.2) { S._fl++; E.give(S, 'nacl', 1000); }
    if (S.hr > 110 && !S._morph) { S._morph = 1; E.give(S, 'morphine', 5); }
  },
  hhs(S, t) {
    S._fl2 = S._fl2 || 0; S._insN = S._insN || 0; S._dwN = S._dwN || 0;
    /* 高渗的核心是自由水缺失：血钠还高时补生理盐水只会把钠越抬越高 */
    /* 高钠时补的是自由水（口服水），不是含钠液 */
    if (S.na > 145) {
      if (S._dwN < 10 && t >= (S._dwAt || 0) + 900) { S._dwN++; S._dwAt = t; E.give(S, 'water', 2); }
    } else if (S._fl2 < 4 && S.vol < 4.2) { S._fl2++; E.give(S, 'nacl', 1000); }
    /* 小剂量、间隔给药：每 60 分钟一次，最多 6 次 */
    if (S._insN < 12 && S.glu > 12 && (S._insN === 0 || S.t >= (S._insAt || 0) + 1800)) { S._insN++; S._insAt = S.t; E.give(S, 'insulin', 8); }
    if (S.glu < 5 && !S._d50) { S._d50 = 1; E.give(S, 'dextrose50', 25); }
    /* 补钾要限量：每 tick 都给会把血钾推成高钾室颤 */
    S._kclN = S._kclN || 0;
    if (S._kclN < 4 && S.k < 3.8) { S._kclN++; E.give(S, 'kcl', 20); }
  },
  co(S) {
    /* CO 中毒时脉搏血氧是"假正常"，不能靠 SpO₂ 决定撤氧 —— 看 COHb */
    if ((S.coHb || 0) > 0.12) {
      if (!(S.o2 || S.vent) || (S.fio2 || 0.21) < 0.9) E.ACTIONS.oxygen.apply(S);
      return;
    }
    o2(S);
  },


  tamponade(S) {
    if ((S.tamponade || 0) > 0.2 && !S._peri) { S._peri = 1; E.ACTIONS.pericardio.apply(S); }
    /* 穿刺后必须留置引流管，否则凝血性积血会再次压塞 */
    if (S._peri && !S.pericDrain) E.ACTIONS.pericardialDrain.apply(S);
    S._fl3 = S._fl3 || 0;
    if (S._fl3 < 2 && S.vol < 4.4) { S._fl3++; E.give(S, 'nacl', 1000); }
  },
  heatstroke(S) {
    S._fl4 = S._fl4 || 0;
    if (S._fl4 < 3 && S.vol < 4.3) { S._fl4++; E.give(S, 'nacl', 1000); }
    E.setEnv(S, 'cooling', S.temp > 38.5);
  },

  myxedema(S) {
    if (!S._t4) { S._t4 = 1; E.give(S, 'levothyroxine', 100); }
    if (!S._hc) { S._hc = 1; E.give(S, 'hydrocortisone', 100); }
    if (S.temp < 35.5) E.setEnv(S, 'warming', true);
    if (S.rr < 10) E.ACTIONS.oxygen.apply(S);
  },
  liverFailure(S) {
    if (!S._lac) { S._lac = 1; E.give(S, 'lactulose', 30); }
    /* 血浆限量：无限输注会把血钠稀释成脑水肿 */
    S._ffpN = S._ffpN || 0;
    if (S._ffpN < 1 && (S.coag || 1) < 0.55) { S._ffpN++; E.give(S, 'ffp', 2); }
    if (S.glu < 4 && !S._d10) { S._d10 = 1; E.give(S, 'dextrose10', 500); }
  },

  tca(S) {
    S._bicN = S._bicN || 0;
    if (S._bicN < 4 && (S.tca || 0) > 0.25) { S._bicN++; E.give(S, 'bicarb', 150); }
    if (S.gcs <= 8) E.ACTIONS.intubate.apply(S);
  },

  tbi(S) {
    if ((S.icp || 0) > 0.6 && !S._man) { S._man = 1; E.give(S, 'mannitol', 250); }
    if ((S.hematoma || 0) > 0.1 && !S._cran) { S._cran = 1; E.ACTIONS.craniotomy.apply(S); S.cranied = 1; }
  },

  burn(S, t) {
    if (!S.vent && ((S.spo2 || 100) < 94 || (S.airwayResistance || 0) > 0.35 || S.gcs < 10)) {
      E.ACTIONS.intubate.apply(S);
    }
    if (S.ph < 7.20 && !has(S, 'bicarb') && t >= 600) E.give(S, 'bicarb', 150);
    /* 达到撤机条件就拔管（判定要求"已撤机"） */
    if (S.vent && S.gcs >= 13 && (S.airwayResistance || 0) <= 0.25) E.ACTIONS.extubate.apply(S);
    /* 撤机后血氧能撑住就把氧也撤掉 */
    if (!S.vent && (S.spo2 || 0) >= 96 && ((S.fio2 || 0.21) > 0.21 || S.o2)) E.ACTIONS.oxygen_off.apply(S);
    if (S.vol < 4.4 && !has(S, 'nacl')) E.give(S, 'nacl', 1000);
    if ((S.airwayResistance || 0) > 0.8 || S.spo2 < 93) {
      if (!S.vent) E.ACTIONS.intubate.apply(S);
      else if (!S._o2b) { S._o2b = 1; E.ACTIONS.oxygen.apply(S); }
    }
    S._fl5 = S._fl5 || 0;
    if (S._fl5 < 5 && (S.uo < 0.5 || S.vol < 4.0)) { S._fl5++; E.give(S, 'nacl', 1000); }
    if (S.k > 5.5 && !S._kca) { S._kca = 1; E.give(S, 'calcium', 10); E.give(S, 'insulin', 10); E.give(S, 'dextrose50', 25); }
  },

  stemi(S) {
    if (!S._asa) { S._asa = 1; E.give(S, 'aspirin', 300); E.give(S, 'clopidogrel', 300); E.give(S, 'heparin', 5000); }
    if ((S.stemi || 0) > 0.15 && !S._pci) { S._pci = 1; E.ACTIONS.pci.apply(S); S.reperfused = 1; }
    if (S.map > 95 && !S._ntg) { S._ntg = 1; E.give(S, 'nitroglycerin', 0.5); }
  },

  seizure(S) {
    S._dz = S._dz || 0;
    if (S._dz < 2 && (S.seizure || 0) > 0.2) { S._dz++; E.give(S, 'diazepam', 10); }
    if (S.spo2 < 93 && !S._o2s) { S._o2s = 1; E.ACTIONS.oxygen.apply(S); }
  },

  spleen(S) {
    S._fl6 = S._fl6 || 0;
    if (S._fl6 < 3 && (S.uo < 0.5 || (S.map || 100) < 70)) { S._fl6++; E.give(S, 'ringer', 1000); }
    if (!S._surg) { S._surg = 1; E.ACTIONS.surgery.apply(S); }
    S._prbc = S._prbc || 0;
    if (S._prbc < 3 && S.hb < 85) { S._prbc++; E.give(S, 'prbc', 2); }
  },

  ectopic(S) {
    S._fl7 = S._fl7 || 0;
    if (S._fl7 < 3 && (S.uo < 0.5 || (S.map || 100) < 70)) { S._fl7++; E.give(S, 'ringer', 1000); }
    if (!S._surg2) { S._surg2 = 1; E.ACTIONS.surgery.apply(S); }
    S._prbc2 = S._prbc2 || 0;
    if (S._prbc2 < 2 && S.hb < 85) { S._prbc2++; E.give(S, 'prbc', 2); }
  },
  preeclampsia(S) {
    if (!S._mg) { S._mg = 1; E.give(S, 'magnesium', 4); }
    S._labN = S._labN || 0;
    if ((S.map || 100) > 135 && S._labN < 2) { S._labN++; E.give(S, 'labetalol', 20); }
    /* 重度子痫前期：血小板下降或血管痉挛不缓解就要终止妊娠（唯一根治） */
    if (!S._del && ((S.plt || 150) < 95 || S.svr > 28)) { S._del = 1; E.ACTIONS.delivery.apply(S); }
  },
  bph(S) {
    if (!S._cath) { S._cath = 1; E.ACTIONS.catheter.apply(S); }
    if (S.k > 5.5 && !S._kca2) { S._kca2 = 1; E.give(S, 'calcium', 10); E.give(S, 'insulin', 10); E.give(S, 'dextrose50', 25); }
  },
  aki(S) {
    if (S.k > 6.0 && !S._ca) { S._ca = 1; E.give(S, 'calcium', 10); }
    if (S.k > 5.5 && !S._insAki) { S._insAki = 1; E.give(S, 'insulin', 10); E.give(S, 'dextrose50', 25); }
    if ((S.k > 5.5 || (S.cr || 0) > 500) && S.t > 300) E.ACTIONS.dialysis.apply(S);
  },
  ptx(S) {
    o2(S);
    if ((S.tensionPTX || 0) > 0.2 && !S._needleDone) { S._needleDone = 1; E.ACTIONS.needle.apply(S); }
    if ((S.tensionPTX || 0) > 0 && (S.tensionPTX || 0) <= 0.25 && !S._tubeDone) { S._tubeDone = 1; E.ACTIONS.chestTube.apply(S); }
  },
  trauma(S) {
    if (!S._tourDone) { S._tourDone = 1; E.ACTIONS.tourniquet.apply(S); }
    /* 限制性复苏：总量上限 4 L 晶体 + 6 U 红细胞（难度上调后需要更充分的复苏，仍不无限补） */
    S._fluidN = S._fluidN || 0;
    S._bloodN = S._bloodN || 0;
    if (S._fluidN < 4 && (S.vol < 4.0 || E.bp(S).sys < 85)) { S._fluidN++; E.give(S, 'nacl', 1000); }
    if (S._bloodN < 3 && S.hb < 95) { S._bloodN++; E.give(S, 'prbc', 2); }
    if (!S.bleedStopped && S.t > 900) E.ACTIONS.surgery.apply(S);
  },
  pe(S, t) {
    o2(S);
    if (!S._p) { S._p = 1; E.give(S, 'alteplase', 100); E.give(S, 'heparin', 5000); }
    if (bp(S).sys < 90 && !has(S, 'nacl')) E.give(S, 'nacl', 500);
    norepiSupport(S, 65, 75, 8);
  },
};

/* ---------- 跑一例 ---------- */
function runOne(mod, seed, mode) {
  const caseObj = G.generate(2, seed, [mod]);
  const S = E.create(caseObj);
  const treat = TREAT[mod] || (() => {});
  const maxSec = MAX_MIN * 60;

  while (S.running && S.t < maxSec) {
    if (mode === 'treat') treat(S, S.t);
    E.tick(S, DT);
    G.step(S, DT, E);                    // 与 game.js 主循环一致：先 tick 再推进病程
    E.pollTests(S);
    if (!S.death && E.dischargeCheck(S).ok) {
      E.endCase(S, 'discharge', '达到出院标准');
      break;
    }
  }

  const d = E.dischargeCheck(S);
  const outcome = S.death ? '死亡' : (S.discharged ? '出院' : '未达标');
  return {
    mod, seed, mode, outcome,
    reason: S.death ? S.death.reason : (S.discharged ? '—' : d.reasons.slice(0, 3).join(' / ') || '—'),
    min: Math.round(S.t / 60),
    cost: Math.round(S.cost),
    score: E.finalScore(S),
    S,
  };
}

/* ---------- 单例轨迹（调试用） ---------- */
function traceOne(mod, mode, seed) {
  const r = runOne(mod, seed || 101, mode);
  const S = r.S;
  const step = Math.max(1, Math.round(S.history.length / 24));
  console.log(`\n## ${mod} / ${mode} → ${r.outcome}（${r.min} min）${r.reason}`);
  for (let i = 0; i < S.history.length; i += step) {
    const h = S.history[i];
    console.log(`  ${String(Math.round(h.t / 60)).padStart(3)}m HR${String(h.hr).padStart(3)} `
      + `BP${String(h.sys).padStart(3)} RR${String(h.rr).padStart(2)} SpO2${String(Math.round(h.spo2)).padStart(3)}% `
      + `pH${h.ph} HCO3 ${h.hco3} PaCO2 ${h.paco2} Lac? K${h.k} Na${h.na} Glu${h.glu} vol${h.vol} `
      + `DO2 ${h.do2} LW ${h.lw} 损伤${h.ins}`);
  }
  return r;
}

if (require.main === module) {
  for (const sub of substances.ALL) {
    const exposure = sub.cls === '病毒' || sub.cls === '细菌';
    assert.ok(Number.isFinite(sub.cost) && (exposure ? sub.cost === 0 : sub.cost > 0),
      `物质 ${sub.id} 缺少有效模拟费用`);
  }
  for (const [cell, product] of [['c_rbc', 'prbc'], ['c_plasma', 'ffp']]) {
    const unit = substances.byId(cell);
    const pack = substances.byId(product);
    assert.equal(unit.cost / unit.dose, pack.cost / pack.dose, `${cell} 与 ${product} 的单位费用应一致`);
  }
  assert.deepEqual(substances.search('罗氏芬').map(s => s.id), ['ceftriaxone']);
  for (const [brand, generic] of [['先锋必', '头孢哌酮'], ['泰能', '亚胺培南/西司他丁']]) {
    assert.deepEqual(substances.search(brand), [], brand + ' 不可代开其他药物');
    assert.deepEqual(substances.searchUnlistedDrugs(brand), [generic]);
  }
  // 这两个种子在生成器 v3 分别会抽到不相符的老年与 2 型糖尿病体质。
  const young = G.generate(5, 331);
  assert.deepEqual([young.patient.age, young.traits.length, young.traits.some(t => t.id === 'elderly_renal')], [34, 2, false]);
  const dka = G.generate(5, 13);
  const type2 = G.generate(5, 0);
  assert.ok(dka.comorbidities.includes('1 型糖尿病') && dka.complaint.includes('停用胰岛素')
    && dka.traits.length === 2 && dka.traits.every(t => t.id !== 't2dm')
    && type2.traits.some(t => t.id === 't2dm') && type2.comorbidities.includes('2 型糖尿病')
    && type2.admission.background.filter(item => item.includes('糖尿病')).join() === '2 型糖尿病',
  '糖尿病分型应与停药史、体质和入院背景一致');

  if (TRACE) {
    traceOne(TRACE, 'treat', SEEDS[0]);
    traceOne(TRACE, 'none', SEEDS[0]);
    process.exit(0);
  }

  /* ---------- 主流程 ---------- */
  const MODS = G.MODULES.filter(m => (!ONLY || m.id === ONLY) && (m.weight || 0) > 0);  /* weight=0 视为停用 */
  const rows = [];
  let pass = true;

  for (const m of MODS) {
    const probe = E.create(G.generate(2, 7, [m.id]));
    let hintCount = 0;
    try { hintCount = global.MENTOR.hints(probe).length; } catch (e) { hintCount = -1; }

    const treatRuns = SEEDS.map(s => runOne(m.id, s, 'treat'));
    const noneRuns = SEEDS.map(s => runOne(m.id, s, 'none'));
    const treatOk = treatRuns.filter(r => r.outcome === '出院').length;
    const noneBad = noneRuns.filter(r => r.outcome !== '出院').length;
    const noneDead = noneRuns.filter(r => r.outcome === '死亡').length;
    /* 少数病理在 6 小时观察窗内「不处理也不会死」（低钠、甲减危象属于慢性恶化），
       对它们只要求不放任出院，不强制死亡比例 */
    const SLOW_DEATH = ['hyponatremia', 'myxedema'];
    const needDeath = SLOW_DEATH.includes(m.id) ? 0 : 0.7;
    const ok = treatOk / SEEDS.length >= 0.9
            && noneBad === SEEDS.length
            && noneDead / SEEDS.length >= needDeath
            && hintCount >= 2;
    if (!ok) pass = false;

    rows.push({
      id: m.id, name: m.name, hintCount,
      treatOk, treatN: SEEDS.length,
      noneBad, noneDead, noneN: SEEDS.length,
      treatAvg: Math.round(treatRuns.reduce((s, r) => s + r.min, 0) / treatRuns.length),
      noneAvg: Math.round(noneRuns.reduce((s, r) => s + r.min, 0) / noneRuns.length),
      ok, treatRuns, noneRuns,
    });
  }

  /* ---------- 输出 ---------- */
  const pad = (s, n) => {
    s = String(s);
    let w = 0;
    for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
    return s + ' '.repeat(Math.max(0, n - w));
  };

  console.log('');
  console.log(`病理模块内容回归（每模块 ${SEEDS.length} 例，规范治疗 vs 完全不管）`);
  console.log('='.repeat(112));
  console.log(pad('模块', 22) + pad('导师规则', 10) + pad('规范治疗出院', 16) + pad('完全不管恶化', 16) + pad('其中死亡', 11) + pad('治疗均时', 11) + '结论');
  console.log('-'.repeat(112));
  for (const r of rows) {
    console.log(
      pad(r.name, 22) +
      pad(r.hintCount + ' 条', 10) +
      pad(`${r.treatOk}/${r.treatN}（${Math.round(r.treatOk / r.treatN * 100)}%）`, 16) +
      pad(`${r.noneBad}/${r.noneN}（${Math.round(r.noneBad / r.noneN * 100)}%）`, 16) +
      pad(`${r.noneDead}/${r.noneN}`, 11) +
      pad(r.treatAvg + ' min', 11) +
      (r.ok ? 'PASS' : 'FAIL')
    );
  }
  console.log('-'.repeat(112));
  const treatAll = rows.reduce((s, r) => s + r.treatOk, 0);
  const treatTotal = rows.reduce((s, r) => s + r.treatN, 0);
  const deadAll = rows.reduce((s, r) => s + r.noneDead, 0);
  const noneTotal = rows.reduce((s, r) => s + r.noneN, 0);
  console.log(pad('合计', 22) + pad('', 10) + pad(`${treatAll}/${treatTotal}（${Math.round(treatAll / treatTotal * 100)}%）`, 16)
    + pad('', 16) + pad(`${deadAll}/${noneTotal}（${Math.round(deadAll / noneTotal * 100)}%）`, 11));

  const fails = rows.filter(r => !r.ok);
  if (fails.length) {
    console.log('\n不达标明细：');
    for (const r of fails) {
      for (const x of r.treatRuns.filter(x => x.outcome !== '出院'))
        console.log(`  [治疗失败] ${r.id} seed=${x.seed} → ${x.outcome}（${x.min} min）${x.reason}`);
      for (const x of r.noneRuns.filter(x => x.outcome === '出院'))
        console.log(`  [自然病程过轻] ${r.id} seed=${x.seed} → 未处理也出院（${x.min} min）`);
      if (r.noneDead / r.noneN < 0.7)
        console.log(`  [致死率不足] ${r.id} 只死 ${r.noneDead}/${r.noneN}`);
      if (r.hintCount < 2) console.log(`  [导师规则不足] ${r.id} 只有 ${r.hintCount} 条`);
    }
  }

  if (VERBOSE) {
    console.log('\n逐例明细：');
    for (const r of rows) {
      console.log(`\n## ${r.name}（${r.id}）`);
      for (let i = 0; i < SEEDS.length; i++) {
        const a = r.treatRuns[i], b = r.noneRuns[i];
        console.log(`  seed=${SEEDS[i]}  规范治疗: ${a.outcome.padEnd(3)} ${String(a.min).padStart(3)}min ¥${String(a.cost).padStart(4)}  ${a.reason}`);
        console.log(`              完全不管: ${b.outcome.padEnd(3)} ${String(b.min).padStart(3)}min  ${b.reason}`);
      }
    }
  }

  /* ---------- 成就模块冒烟测试 ---------- */
  const achFails = [];
  A.reset();
  const fake = (over) => Object.assign({
    t: 600, discharged: true, cost: 200, penalties: 0, arrests: 0, tags: ['highK'],
    tests: {}, log: [['00:10', '给予 葡萄糖酸钙 10mL（静推）', 'good']],
    cas: { name: '高钾血症' }, caseId: 'gen',
  }, over);
  A.evaluate(fake({}));
  if (!A.unlocked().has('first_discharge')) achFails.push('首例出院未解锁');
  if (!A.unlocked().has('sub10')) achFails.push('十分钟奇迹未解锁');
  A.evaluate(fake({ t: 1800, tags: ['sepsis'], log: [] }));
  if (A.unlocked().has('no_tests') === false) achFails.push('望闻问切未解锁');
  if (A.list.length < 10) achFails.push('成就数量不足 10');
  A.evaluate(fake({ t: 300, death: { reason: 'test' }, discharged: false, tags: ['bleed'] }));
  if (!A.unlocked().has('first_lesson')) achFails.push('第一课未解锁');
  A.evaluate(fake({ t: 400, tags: ['pe'] }));
  if (!A.unlocked().has('comeback')) achFails.push('触底反弹未解锁');
  if (!A.unlocked().has('three_specs')) achFails.push('三科会诊未解锁');
  A.reset();
  if (A.unlocked().size !== 0) achFails.push('reset 后未清空');

  console.log('\n成就系统：' + (achFails.length ? 'FAIL — ' + achFails.join('；') : `PASS（${A.list.length} 个成就，localStorage 持久化）`));
  console.log('病历归档逻辑：由 game.js 写入 localStorage(life.records)，浏览器用例见 tools/ui-check.js');
  console.log('\n总体：' + (pass && !achFails.length ? '全部 PASS' : '存在 FAIL') + '\n');
  process.exitCode = (pass && !achFails.length) ? 0 : 1;
}

module.exports = { TREAT, runOne, traceOne, MODULES: G.MODULES, SEEDS };


