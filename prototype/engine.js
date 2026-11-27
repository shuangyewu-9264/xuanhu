/* =========================================================================
 * LIFE 临床工作站 — 生理引擎 v0.3「机制驱动」
 * 单文件、无依赖、可浏览器/Node 双跑。
 *
 * v0.3 重构要点（对应科学审查的结论：旧版"几乎所有病人 3–30 分钟自己痊愈"）：
 *   1) 新增 4 组状态量：组织间液/肺水、碳酸氢盐（真状态量）、Hill 氧解离+分流、
 *      氧输送 DO2。死亡不再靠"某指标阈值计时器"，而是靠 DO2 不足 / 累积损伤。
 *   2) 药物的血流动力学效应改成"瞬时浓度"而非"累计积分+指数衰减"，
 *      避免重复给药一路叠加到封顶（旧版肺水肿心率压不到 115 的直接原因）。
 *   3) 每个被替换的旧实现都在注释里标注「替代了原来的……」。
 * 设计原则不变：
 *   - 状态是显式变量，每一步用差分方程推进；
 *   - 药物有起效延迟与半衰期；
 *   - 一切可打印、可存档（serialize/deserialize）。
 * ========================================================================= */
(function (root) {
'use strict';
let IDENTITY = null;      /* 测试用：固定病人身份；生产环境使用病例所带资料 */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp  = (a, b, k) => a + (b - a) * k;
const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;

/* 氧解离曲线（Hill）：S = P^2.7 / (P^2.7 + 26.6^2.7) */
const HILL_P50 = 26.6, HILL_N = 2.7;
const HILL_P50_POWER = Math.pow(HILL_P50, HILL_N);
const hill = p => { const x = Math.pow(Math.max(1, p), HILL_N); return x / (x + HILL_P50_POWER); };
const inverseHill = saturation => HILL_P50 * Math.pow(saturation / (1 - saturation), 1 / HILL_N);
const MIN_VENOUS_PO2 = inverseHill(0.15);
const MAX_VENOUS_PO2 = inverseHill(0.85);

/* 药物"体征类"效应键：这些键走瞬时浓度（S.mod），不走累计积分 */
const MOD_KEYS = ['hr', 'svr', 'sv', 'rr', 'spo2', 'temp', 'gcs'];
const THYROID_THERAPY = new Set(['propylthiouracil', 'methimazole', 'hydrocortisone', 'dexamethasone', 'propranolol']);
const COOLING_TARGET = 38.5;
const WARMING_TARGET = 36.1;
const DISCHARGE_GLUCOSE_MIN = 4;
const DISCHARGE_GLUCOSE_MAX = 12;
const DKA_DISCHARGE_GLUCOSE_MAX_EXCLUSIVE = 11;
const DISCHARGE_K_MIN = 3.5;
const DISCHARGE_K_MAX = 5.5;
const potassiumTarget = `${DISCHARGE_K_MIN}–${DISCHARGE_K_MAX} mmol/L`;

function glucoseDischargeTarget(hasDka, includeDkaMinimum = false) {
  if (!hasDka) return `${DISCHARGE_GLUCOSE_MIN}–${DISCHARGE_GLUCOSE_MAX} mmol/L`;
  const minimum = includeDkaMinimum ? `≥${DISCHARGE_GLUCOSE_MIN} 且 ` : '';
  return `${minimum}<${DKA_DISCHARGE_GLUCOSE_MAX_EXCLUSIVE} mmol/L`;
}

function temperatureStatus(temp) {
  if (!Number.isFinite(temp)) return '';
  if (temp < 35 || temp >= 39.5) return 'crit';
  return temp < WARMING_TARGET || temp > 37.5 ? 'warn' : '';
}

/* ---------------- 病例定义（旧版手工病例，保留兼容） ---------------- */
const CASES = {
  hyperkalemia: {
    id: 'hyperkalemia',
    name: '高钾血症',
    comorbidities: ['慢性肾病'],
    age: 45, sex: '男', weight: 72, bloodType: 'A',
    chief: '少尿伴心悸、乏力2天',
      complaint: '2 天前起尿量明显减少，1 天前出现心悸、乏力并逐渐加重。既往慢性肾病 3 期。',
    init: {
      vol: 4.25, k: 6.8, na: 134, cl: 100, ca: 1.15, hco3: 14, lac: 3.4, glu: 5.6,
      cr: 268, bun: 18.2, hb: 112, wbc: 8.1, plt: 210,
      temp: 37.8, gcs: 13,
      hr: 131, sv: 44, svr: 13.6, cvp: 3,
      rr: 28, pao2: 62, paco2: 31, spo2: 91,
      uo: 0.3,
      kProd: 0.160, lactProd: 0.02, insulinBase: 0.55, contractility: 0.74,
      ecfVd: 12, renalFactor: 0.30,
    },
    goals: [`血钾维持 ${potassiumTarget}`, '收缩压维持 ≥ 90', '避免心脏骤停'],
    hint: '高钾的心电图改变先于症状。先保护心肌，再想办法把钾挪走。',
  },
  dka: {
    id: 'dka', name: '糖尿病酮症酸中毒',
    comorbidities: ['1 型糖尿病'],
    age: 23, sex: '女', weight: 58, bloodType: 'O',
    chief: '多饮多尿3天，恶心呕吐伴嗜睡1天',
      complaint: '3 天前起多饮、多尿，1 天前出现恶心、呕吐，今晨嗜睡。1 型糖尿病，自行停用胰岛素。',
    init: {
      vol: 3.6, k: 4.9, na: 130, cl: 98, ca: 1.12, hco3: 8, lac: 2.6, glu: 28.5,
      cr: 156, bun: 14.5, hb: 128, wbc: 14.2, plt: 260,
      temp: 37.2, gcs: 12,
      hr: 118, sv: 50, svr: 11.4, cvp: 2,
      rr: 30, pao2: 88, paco2: 27, spo2: 96,
      uo: 1.6, kProd: 0.012, lactProd: 0.03, insulinBase: 0.12,
      contractility: 0.8, ketoneProd: 0.16, ecfVd: 11,
    },
    goals: [`血糖 ${glucoseDischargeTarget(true)}`, 'pH 升至 7.30 以上', `血钾维持 ${potassiumTarget}`],
    hint: '补液是第一位的。胰岛素要小剂量持续，补钾要跟得上——治着治着血钾会掉。',
  },
  bleed: {
    id: 'bleed', name: '上消化道大出血',
    comorbidities: ['消化性溃疡'],
    age: 61, sex: '男', weight: 78, bloodType: 'B',
    chief: '呕血、黑便1天伴晕厥1次',
      complaint: '1 天前起呕血 2 次、排黑便，起身时晕厥 1 次。长期服用阿司匹林。',
    init: {
      vol: 3.9, k: 4.1, na: 138, cl: 104, ca: 1.18, hco3: 21, lac: 2.9, glu: 7.2,
      cr: 96, bun: 24.5, hb: 78, wbc: 11.5, plt: 180,
      temp: 36.6, gcs: 14,
      hr: 124, sv: 48, svr: 9.6, cvp: 2,
      rr: 26, pao2: 78, paco2: 37, spo2: 94,
      uo: 0.4, kProd: 0.010, lactProd: 0.02, insulinBase: 0.9,
      contractility: 0.85, bleedRate: 0.012, ecfVd: 12,
    },
    goals: ['收缩压 ≥ 90 且心率 < 120', '血红蛋白 ≥ 80 g/L', '止血'],
    hint: '先补容量再谈输血。升压药不能替代容量。',
    extra: S => {
      const out = [];
      if (!S.bleedStopped) out.push('出血未止');
      if (S.hb < 80) out.push(`血红蛋白 ${Math.round(S.hb)}`);
      return out;
    },
  },
  sepsis: {
    id: 'sepsis', name: '感染性休克',
    comorbidities: ['肺部感染'],
    age: 67, sex: '男', weight: 70, bloodType: 'O',
    chief: '发热咳嗽3天，意识模糊伴尿少1天',
      complaint: '3 天前起发热、咳嗽，1 天前出现意识模糊、尿量减少，皮肤花斑。',
    init: {
      vol: 3.70, k: 4.3, na: 132, cl: 98, ca: 1.15, hco3: 17, lac: 5.8, glu: 8.2,
      cr: 186, bun: 24.0, hb: 108, wbc: 19.5, plt: 140,
      temp: 39.2, gcs: 12,
      hr: 128, sv: 52, svr: 9.2, cvp: 2,
      rr: 28, pao2: 68, paco2: 30, spo2: 91,
      uo: 0.25, kProd: 0.012, lactProd: 0.06,
      insulinBase: 0.8, contractility: 0.80, infection: 0.78, ecfVd: 12,
    },
    goals: ['平均动脉压 ≥ 65', '乳酸下降', '感染控制'],
    hint: '先补液，再上血管活性药；抗生素越早越好，每拖一小时病死率都在涨。',
    extra: S => {
      const out = [];
      if ((S.infection || 0) > 0.25) out.push('感染未控制');
      if (S.temp > 38.0) out.push(`仍发热 ${S.temp.toFixed(1)}℃`);
      return out;
    },
  },
  opioid: {
    id: 'opioid', name: '阿片类药物过量',
    comorbidities: [],
    age: 29, sex: '女', weight: 55, bloodType: 'A',
    chief: '被发现呼之不应、呼吸浅慢1小时',
      complaint: '1 小时前被发现倒在房间内，呼之不应，呼吸浅慢，双侧瞳孔针尖样缩小。',
    init: {
      vol: 4.30, k: 4.2, na: 138, cl: 102, ca: 1.18, hco3: 26, lac: 1.6, glu: 5.4,
      cr: 78, bun: 4.5, hb: 128, wbc: 7.2, plt: 230,
      temp: 36.2, gcs: 5,
      hr: 58, sv: 62, svr: 14, cvp: 3,
      rr: 8, pao2: 45, paco2: 64, spo2: 78,
      uo: 0.5, kProd: 0.010, lactProd: 0.02,
      insulinBase: 0.9, contractility: 0.90, ecfVd: 12,
      preload: [['morphine', 12]],
      opioidTox: true,
    },
    goals: ['自主呼吸频率 ≥ 12', '意识恢复', '室内空气血氧 ≥ 94%', '完成阿片暴露后的观察'],
    hint: '呼吸抑制是致命的。纳洛酮起效快但半衰期短，可能需要重复给。',
    extra: S => {
      const out = [];
      if (S.rr < 12) out.push(`呼吸 ${Math.round(S.rr)} 次/分`);
      return out;
    },
  },
};

/* ---------------- 药物库（旧版手工药物，保留兼容；生成器走 SUBSTANCES） ---------------- */
const DRUGS = {
  calcium: { cost: 45, name: '葡萄糖酸钙', unit: 'mL', defaultDose: 10, routes: ['静推'],
    ke: 1.2, dur: 45,
    desc: '提高心肌阈电位，拮抗高钾的心脏毒性。起效 1–3 min，持续 30–60 min。不降钾。',
    apply: (S, dose) => { S.caProtectUntil = S.t + 45 * 60; S.log.push(['给药', '葡萄糖酸钙 10 mL 静推', 'good']); } },
  insulin: { cost: 28, name: '胰岛素', unit: 'U', defaultDose: 10, routes: ['静推', '输液'],
    ke: 0.045, dur: 300,
    desc: '促钾向细胞内转移，同时降糖。起效 15–30 min，峰值 30–60 min，持续 4–6 h。必须配伍葡萄糖。',
    apply: (S, dose) => {
      S.eff.insulin = Math.min(3.5, S.eff.insulin + dose / 10);
      S.log.push(['给药', `胰岛素 ${dose} U`, 'good']);
    } },
  dextrose: { cost: 18, name: '50% 葡萄糖', unit: 'mL', defaultDose: 25, routes: ['静推'],
    ke: 1.5, dur: 30,
    desc: '高渗葡萄糖。配伍胰岛素防低血糖。单独使用不降钾。',
    apply: (S, dose) => {
      S.glu += dose * 0.5 * 50 / 10.8 / 10;
      S.log.push(['给药', `50% 葡萄糖 ${dose} mL 静推`, 'good']);
    } },
  bicarb: { cost: 22, name: '碳酸氢钠', unit: 'mL', defaultDose: 100, routes: ['静滴'],
    ke: 0.3, dur: 60,
    desc: '纠正代谢性酸中毒。仅在合并酸中毒时对降钾有效；过量致碱中毒、低钾、低钙抽搐。',
    apply: (S, dose) => {
      /* 碳酸氢钠现在直接加 HCO₃ 状态量（替代原来加 hco3Extra 再被每拍重算覆盖） */
      const add = dose * (S.ph < 7.20 ? 0.055 : 0.030);
      S.hco3 = clamp(S.hco3 + add, 2, 40);
      S.log.push(['给药', `碳酸氢钠 ${dose} mL 静滴`, S.ph < 7.20 ? 'good' : 'warn']);
    } },
  kcl: { cost: 12, name: '氯化钾', unit: 'mmol', defaultDose: 20, routes: ['口服', '静滴'],
    ke: 0.25, dur: 60,
    desc: '补充钾储备。禁止静脉推注。外周浓度 ≤40 mmol/L，速度 ≤10 mmol/h。',
    apply: (S, dose) => {
      S.k = clamp(S.k + dose / 12 * 0.45, 1.5, 9.5);
      S.log.push(['给药', `氯化钾 ${dose} mmol`, 'warn']);
    } },
  norepi: { cost: 60, name: '去甲肾上腺素', unit: 'μg/min', defaultDose: 8, routes: ['泵入'],
    ke: 1.6, dur: 8,
    desc: 'α₁ 激动，收缩血管提升血压。起效 1–2 min。单次医嘱按有限药效模拟。外渗可致组织坏死。',
    apply: (S, dose) => {
      const drug = DRUGS.norepi;
      const scale = dose / drug.defaultDose;
      S.pk ||= [];
      S.given ||= [];
      S.pk.push({ id: 'norepi', n: drug.name, t: S.t, route: drug.routes[0], onset: 1,
                  dur: drug.dur * (S.pkScale || 1), eff: { svr: 6, hr: 2 }, scale });
      S.given.push({ id: 'norepi', n: drug.name, d: dose, unit: drug.unit, route: drug.routes[0], t: S.t });
      S.eff.norepi += scale;
      if (scale > 0) markCirculatorySupport(S);
      S.log.push(['给药', `去甲肾上腺素 ${dose} μg/min 泵入`, 'good']);
    } },
  amiodarone: { cost: 88, name: '胺碘酮', unit: 'mg', defaultDose: 150, routes: ['静推'],
    ke: 0.12, dur: 240,
    desc: '多通道阻滞，延长动作电位时程。静推需缓慢，可致低血压。',
    apply: (S, dose) => { S.eff.amio += dose / 150; S.log.push(['给药', `胺碘酮 ${dose} mg`, 'good']); } },
  furosemide: { cost: 9, name: '呋塞米', unit: 'mg', defaultDose: 20, routes: ['静推'],
    ke: 0.5, dur: 120,
    desc: '袢利尿剂，促钾与水排出。肾功能不全时效果下降。',
    apply: (S, dose) => {
      S.eff.furo += dose / 20;
      S.diuresis = clamp((S.diuresis || 0) + dose / 20 * 2.0, 0, 9);
      S.log.push(['给药', `呋塞米 ${dose} mg`, 'good']);
    } },
  saline: { cost: 26, name: '生理盐水', unit: 'mL', defaultDose: 500, routes: ['静滴'],
    ke: 2.0, dur: 30,
    desc: '等渗晶体液，扩容。快速大量可致高氯性酸中毒。',
    apply: (S, dose) => {
      /* 晶体液按 30% 留血管内 / 70% 进组织间液分布（替代原来全额加到 vol） */
      applyDelta(S, 'vol', dose / 1000);
      S.cl = clamp(S.cl + dose * 0.0025, 95, 118);
      S.log.push(['给药', `生理盐水 ${dose} mL`, 'good']);
    } },
  prbc: { cost: 520, name: '浓缩红细胞', unit: 'U', defaultDose: 2, routes: ['输血'],
    ke: 1.0, dur: 60,
    desc: '提升携氧能力。1 U 约提升 Hb 10 g/L。',
    apply: (S, dose) => {
      /* 输血增加红细胞质量而不是直接写 hb（替代原来 S.hb += dose*10） */
      S.rbcMass += dose * 10 * S.vol;
      applyDelta(S, 'vol', dose * 0.25);
      S.log.push(['给药', `红细胞 ${dose} U`, 'good']);
    } },
  ppi: { cost: 35, name: '质子泵抑制剂', unit: 'mg', defaultDose: 80, routes: ['静推'],
    ke: 0.2, dur: 240,
    desc: '抑酸，稳定血凝块。上消化道出血的基础用药。',
    apply: (S, dose) => { S.eff.ppi += dose / 80; S.log.push(['给药', `PPI ${dose} mg`, 'good']); } },
};

/* ---------------- 操作 ---------------- */
const DELIVERY_DURATION = 10 * 60;

function setBleedingRate(S, site, rate) {
  S.bleedingSites[site] = rate;
  S.bleedRate = Object.values(S.bleedingSites).reduce((sum, value) => sum + value, 0);
  S.bleedStopped = S.bleedRate === 0;
}

function restoreBleeding(S, saved) {
  // Older saves have only one total rate. Preserve the amount and any completed hemostasis.
  if (saved.bleedingSites) return;
  const sites = Object.entries(S.bleedingSites);
  const total = sites.reduce((sum, [, rate]) => sum + rate, 0);
  if (!total) return;
  const remaining = saved.bleedStopped ? 0 : (saved.bleedRate ?? total);
  for (const [site, rate] of sites) setBleedingRate(S, site, remaining * rate / total);
}

const ACTIONS = {
  delivery: {
    name: '启动分娩流程', cost: 1600,
    desc: '启动重度子痫前期的产科处置。模拟流程耗时 10 分钟，胎盘娩出后母体血管痉挛才开始缓解。',
    apply: (S) => {
      if (!S.running) { S.log.push(['操作', '当前病例已停止推进', 'warn']); return; }
      if (!S.tags.includes('preeclampsia')) { S.log.push(['操作', '当前病例无分娩处置指征', 'warn']); return; }
      if (S.delivered) { S.log.push(['操作', '分娩流程已完成', 'warn']); return; }
      if (Number.isFinite(S.deliveryStartedAt)) { S.log.push(['操作', '分娩流程进行中', 'warn']); return; }
      S.deliveryStartedAt = S.t;
      S.log.push([fmt(S.t), '已启动分娩流程，预计 10 分钟后完成', 'good']);
    },
  },

  catheter: {
    name: '留置导尿', cost: 80,
    desc: '留置导尿管以监测尿量，急性尿潴留时可引流并为膀胱减压。',
    apply: (S) => {
      if (S.urineDrained) { S.log.push(['操作', '导尿管已在位', 'info']); return; }
      S.urineDrained = true;
      if (!S.tags.includes('bph')) {
        S.log.push(['操作', '留置导尿管，开始监测尿量', 'good']);
        return;
      }
      /* 膀胱内的潴留尿已经与循环分离，减压后逐步恢复尿量与肾清除。 */
      if (!S.tags.includes('aki')) S.renalFactor = Math.min(1, (S.renalFactor ?? 0.35) + 0.25);
      S.uo = urineOutput(S, clamp(computeMap(S) / 85, 0.12, 1.25));
      S.log.push(['操作', '留置导尿，引流潴留尿液并为膀胱减压', 'good']);
    },
  },

  pci: {
    name: '急诊 PCI（冠脉再通）', cost: 2600,
    desc: '急性 ST 段抬高心梗的确定性治疗：开通罪犯血管、挽救濒死心肌。时间就是心肌。',
    apply: (S) => {
      if ((S.stemi || 0) > 0.1) {
        S.stemi = Math.max(0, (S.stemi || 0) * 0.15);
        S.reperfused = true;
        S.reperfusionAt = S.t;
        S.log.push(['操作', '急诊 PCI → 罪犯血管开通，ST 段回落', 'good']);
      } else {
        S.log.push(['操作', '急诊 PCI → 无急性缺血证据', 'warn']);
        S.score -= 4;
      }
    },
  },

  craniotomy: {
    name: '开颅血肿清除', cost: 1800,
    desc: '硬膜外/硬膜下血肿的确定性处理：清除血肿、解除脑压迫。内科降颅压只是争取时间。',
    apply: (S) => {
      if ((S.hematoma || 0) > 0.08) {
        S.hematoma = Math.max(0, (S.hematoma || 0) - 0.9);
        S.cranied = true;
        S.craniotomyAt = S.t;
        S.icp = Math.max(0, (S.icp || 0) - 0.5);
        S.log.push(['操作', '开颅血肿清除 → 脑压迫解除', 'good']);
      } else {
        S.log.push(['操作', '开颅 → 未见需清除的血肿', 'warn']);
        S.score -= 5;
      }
    },
  },

  lavage: {
    name: '洗胃', cost: 120,
    desc: '口服中毒 1 小时内最有效；已吸收或腐蚀性物质中毒无益，且有误吸风险。',
    apply: (S) => {
      if (S.t > 3600 && S.t > 3600) {
        S.log.push(['操作', '洗胃 → 已超过 1 小时，毒物多已吸收，收益有限', 'warn']);
        S.score -= 2;
        return;
      }
      let cleared = 0;
      S.tca = Math.max(0, (S.tca || 0) - 0.25); cleared++;
      if (S.tox && S.tox.benzo > 0) { S.tox.benzo = Math.max(0, S.tox.benzo - 2); cleared++; }
      if (S.tox && S.tox.apap > 0) { S.tox.apap = Math.max(0, S.tox.apap - 500); cleared++; }
      if (cleared) S.log.push(['操作', '洗胃 → 清除部分未吸收毒物', 'good']);
      else S.log.push(['操作', '洗胃 → 当前无口服毒物', 'warn']);
    },
  },
  hemoperfusion: {
    name: '血液灌流', cost: 900,
    desc: '活性炭吸附，用于三环类、百草枯等可吸附毒物；对酒精、电解质无效。',
    apply: (S) => {
      if ((S.tca || 0) > 0.05) {
        S.tca = Math.max(0, (S.tca || 0) - 0.35);
        S.log.push(['操作', '血液灌流 → 血中毒物浓度下降', 'good']);
      } else {
        S.log.push(['操作', '血液灌流 → 无适应证（该毒物不可吸附）', 'warn']);
        S.score -= 3;
      }
    },
  },

  pericardialDrain: {
    name: '心包引流管留置', cost: 320,
    desc: '穿刺只能救急；留置引流管持续引流，才能防止凝血性积血再次压塞。',
    apply: (S) => {
      if ((S.tamponade || 0) > 0.05 || S.pericDrain) {
        S.pericDrain = 1;
        S.log.push(['操作', '心包引流管留置 → 持续引流，防止再填塞', 'good']);
      } else {
        S.log.push(['操作', '心包引流管 → 无填塞证据', 'warn']);
        S.score -= 3;
      }
    },
  },

  pericardio: {
    name: '心包穿刺引流', cost: 460,
    desc: '心包填塞的救命操作：抽出积血后心室才能舒张。超声引导下剑突下穿刺。',
    apply: (S) => {
      if ((S.tamponade || 0) > 0.05) {
        S.tamponade = Math.max(0.20, (S.tamponade || 0) - 0.60);   /* 一针救命，但不根治 */
        S.log.push(['操作', '心包穿刺 → 抽出不凝血，心包内压下降', 'good']);
      } else {
        S.log.push(['操作', '心包穿刺 → 未见心包积液', 'warn']);
        S.score -= 3;
      }
    },
  },

  intubate: {
    name: '气管插管 + 机械通气', cost: 380,
    desc: '意识≤8 分或呼吸衰竭时接管气道：固定呼吸频率、消除呼吸肌疲劳、给氧更可靠。',
    apply: (S) => {
      if (S.vent) { S.log.push(['操作', '已在机械通气中', 'warn']); return; }
      if (S.gcs <= 8 || S.rr < 8 || S.spo2 < 88 || (S.airwayResistance || 0) > 0.55) {   // 气道水肿临近阻塞也是插管指征
        S.vent = 1;
        if (S.rhythm !== 'sinus') S.rr = 14;
        S.fio2 = Math.max(S.fio2 || 0.21, 0.60);
        S.o2 = 1;
        S.hadOxygenSupport = true;
        S.roomAirStableSince = null;
        S.log.push(['操作', `气管插管成功 → 机械通气，FiO₂ ${Math.round(S.fio2 * 100)}%`, 'good']);
      } else {
        S.log.push(['操作', '气管插管 → 当前有自主呼吸且意识尚可，暂不插管', 'warn']);
        S.score -= 3;
      }
    },
  },
  extubate: {
    name: '撤除机械通气', cost: 0,
    desc: '气道通畅、意识与自主呼吸恢复后拔管，继续观察呼吸与血氧。',
    apply: (S) => {
      if (!S.vent) { S.log.push(['操作', '当前未使用机械通气', 'info']); return; }
      const rr = S.spontaneousRr;
      const assessmentAge = S.t - S.respiratoryAssessmentAt;
      if (S.gcs < 13 || S.rhythm !== 'sinus' || S.map < 65 || !(assessmentAge >= 0 && assessmentAge <= 10) ||
          !(rr >= 10 && rr <= 25) || (S.airwayResistance || 0) > 0.25 || !(S.spontaneousCO2 <= 55) ||
          roomAirSaturation(S, S.spontaneousCO2) < 92) {
        S.log.push(['操作', '撤机评估：气道、自主通气、氧合或循环尚未恢复，继续支持', 'warn']);
        return;
      }
      S.vent = 0;
      S.hadOxygenSupport = true;
      S.roomAirStableSince = null;
      S.log.push(['操作', '撤除机械通气，继续评估并按氧合撤氧', 'good']);
    },
  },
  pace: {
    name: '临时起搏', cost: 520,
    desc: '症状性心动过缓（心率 < 45 或伴低血压）时的确定性处理；阿托品只是过渡。',
    apply: (S) => {
      if (S.paced) { S.log.push(['操作', '起搏器工作中', 'warn']); return; }
      if (S.rhythm === 'sinus' && (S.hr < 48 || (S.hr < 60 && S.map < 65))) {
        S.paced = 1;
        S.log.push(['操作', '临时起搏器置入 → 心率托底 62 次/分', 'good']);
      } else {
        S.log.push(['操作', '临时起搏 → 心率尚可，无适应证', 'warn']);
        S.score -= 3;
      }
    },
  },

  needle: {
    name: '针刺减压', cost: 60,
    desc: '张力性气胸的救命操作：锁骨中线第二肋间粗针穿刺，减压后才谈得上循环。',
    apply: (S) => {
      if ((S.tensionPTX || 0) > 0.05) {
        S.tensionPTX = Math.max(0.05, (S.tensionPTX || 0) - 0.72);
        S.log.push(['操作', '针刺减压 → 胸腔内压下降，回心血量回升', 'good']);
      } else {
        S.log.push(['操作', '针刺减压 → 未见张力性气胸，操作无益', 'warn']);
        S.score -= 3;
      }
    },
  },
  chestTube: {
    name: '胸腔闭式引流', cost: 220,
    desc: '张力性气胸的确定性处理；减压后仍需引流，否则会复发。',
    apply: (S) => {
      if ((S.tensionPTX || 0) > 0) {
        S.tensionPTX = 0;
        S.chestTubePlaced = true;
        S.log.push(['操作', '胸腔闭式引流完成 → 气胸解除', 'good']);
      } else {
        S.log.push(['操作', '胸腔闭式引流 → 无气胸证据', 'warn']);
        S.score -= 2;
      }
    },
  },
  tourniquet: {
    name: '止血带 / 加压包扎', cost: 30,
    desc: '控制可见的肢体出血；内出血无效。压迫后仍要尽快手术或输血。',
    apply: (S) => {
      if (S.bleedingSites.trauma > 0 && S.externalBleed) {
        if (S.tourniquetApplied) { S.log.push(['操作', '外出血已加压包扎', 'info']); return; }
        S.tourniquetApplied = true;
        setBleedingRate(S, 'trauma', S.bleedingSites.trauma * 0.18);
        S.log.push(['操作', '止血带加压 → 外出血明显减少', 'good']);
      } else if (S.bleedRate && !S.bleedStopped) {
        S.log.push(['操作', '压迫止血 → 这是内出血，压迫无效', 'warn']);
        S.score -= 3;
      } else {
        S.log.push(['操作', '压迫止血 → 当前无明显出血', 'warn']);
      }
    },
  },
  surgery: {
    name: '急诊手术止血', cost: 1800,
    desc: '内出血的确定性处理；需要在容量复苏的同时进行。',
    apply: (S) => {
      const sites = ['trauma', 'ectopic', 'spleen'].filter(site => S.bleedingSites[site] > 0);
      if (sites.length) {
        for (const site of sites) setBleedingRate(S, site, 0);
        S.surgicalHemostasisAt = S.t;
        S.log.push(['操作', '急诊手术 → 出血点已控制', 'good']);
      } else {
        S.log.push(['操作', '急诊手术 → 无活动性出血，探查阴性', 'warn']);
        S.score -= 4;
      }
    },
  },

  defib: {
    name: '电除颤', cost: 0,
    desc: '室颤 / 无脉性室速适用，双相 150–200 J。对心静止无效。',
    apply: (S) => {
      if (S.rhythm === 'vf') {
        const early = Math.max(0, 1 - ((S._vfMin || 0) / 3.5));
        const pressorActivity = Math.max(S.eff.norepi || 0, pumpEffect(S, 'norepi'));
        const drugBonus = (S.eff.amio > 0.2 ? 0.15 : 0) + (pressorActivity > 0.3 ? 0.1 : 0);
        const prob = clamp(0.20 + 0.35 * early + drugBonus, 0.05, 0.85);
        if (Math.random() < prob) {
          restoreSinusRhythm(S, S.preArrestSv || 55);
          S.log.push(['操作', '电除颤 200 J → 恢复窦性心律', 'good']);
        } else {
          S._vfMin = (S._vfMin || 0) + 0.6;
          S.log.push(['操作', '电除颤 200 J → 未成功，继续按压', 'warn']);
        }
      } else if (S.rhythm === 'asystole') {
        S.log.push(['操作', '电除颤 → 无效（心静止不能除颤）', 'bad']);
        S.score -= 5;
      } else {
        S.log.push(['操作', '电除颤 → 非室颤心律，无适应证', 'warn']);
        S.score -= 3;
      }
    },
  },
  cpr: {
    name: '胸外按压', cost: 0,
    desc: '提供一轮两分钟的按压灌注支持。保持气道通畅并评估通气。',
    apply: (S) => {
      if (S.rhythm === 'sinus') {
        S.log.push(['操作', '当前有自主循环，无胸外按压指征', 'warn']);
        return;
      }
      S.cppProgress = (S.cppProgress || 0) + 1;
      S.mapBoost = 25;
      applyArrestPhysiology(S);
      S.log.push(['操作', '开始胸外按压', 'good']);
    },
  },
  dialysis: {
    name: '血液透析', cost: 1800,
    desc: '弥散清除钾/尿素/肌酐并超滤。3–4 小时。',
    apply: (S) => {
      if (S.dialysisUntil && S.t < S.dialysisUntil) return;
      S.dialysisUntil = S.t + 180 * 60;
      S.log.push(['操作', '开始血液透析（预计 3 h）', 'good']);
    },
  },
  oxygen: {
    name: '高流量吸氧', cost: 0,
    desc: '提高吸入氧浓度，目标 SpO₂ ≥94%。',
    apply: (S) => {
      S.fio2 = 1.0;   // 高流量吸氧：FiO₂ 100%
      S.o2 = 1;
      S.hadOxygenSupport = true;
      S.roomAirStableSince = null;
      S.log.push(['操作', `提高吸氧浓度至 FiO₂ ${Math.round(S.fio2 * 100)}%`, 'good']);
    },
  },
  oxygen_off: {
    name: '停止吸氧', cost: 0,
    desc: '将吸入氧浓度调至 21%。使用呼吸机时保留当前通气支持。',
    apply: (S) => {
      if (S.fio2 > 0.21 || S.o2 || S.vent) {
        S.hadOxygenSupport = true;
        S.roomAirStableSince = null;
      }
      S.fio2 = 0.21; S.o2 = 0;
      const message = S.vent ? '呼吸机 FiO₂ 已设为 21%，继续机械通气' : '停止吸氧，改室内空气（FiO₂ 21%）';
      S.log.push(['操作', message, 'info']);
    },
  },
  hyponatremia_care: {
    name: '停用噻嗪并限制饮水', cost: 0,
    desc: '解除噻嗪与过量饮水引起的水潴留，配合复测血钠，按限额分阶段纠正。',
    apply: (S) => {
      if (!S.tags.includes('hypona')) { S.log.push(['操作', '当前病例无噻嗪相关低钠指征', 'info']); return; }
      S.hyponatremiaCauseControlled = true;
      S.log.push(['操作', '停用噻嗪并限制饮水，继续监测血钠', 'good']);
    },
  },
  endoscopy: {
    name: '急诊内镜止血', cost: 2600,
    desc: '明确出血点并止血。需血流动力学相对稳定。',
    apply: (S) => {
      if (!(S.bleedingSites.bleed > 0)) { S.log.push(['操作', '内镜暂缓：无活动性消化道出血', 'warn']); return; }
      if (S.map < 65) { S.log.push(['操作', '内镜 → 血压过低，风险过高，暂缓', 'bad']); S.score -= 4; return; }
      setBleedingRate(S, 'bleed', 0);
      S.log.push(['操作', '内镜下止血成功', 'good']);
    },
  },
};

/* ---------------- 检验 ---------------- */
const TESTS = {
  abg:  { name: '动脉血气',   min: 8,  cost: 120, fields: ['ph','paco2','pao2','hco3','lac','k'] },
  bmp:  { name: '电解质+肾功', min: 35, cost: 180, fields: ['k','na','cl','ca','cr','bun'] },
  cbc:  { name: '血常规',     min: 25, cost: 60,  fields: ['hb','wbc','plt'] },
  ecg:  { name: '12 导联心电图', min: 5, cost: 40, fields: ['ecg'] },
  lac:  { name: '乳酸',       min: 10, cost: 50,  fields: ['lac'] },
  cxr:  { name: '床旁胸片',   min: 15, cost: 90,  fields: [] },
};

/* ---------------- 状态默认值 ---------------- */
function makeInsult() {
  return { hypox: 0, dysoxia: 0, acid: 0, hypercapnia: 0, shock: 0, hyperthermia: 0, hypogly: 0, icp: 0, coma: 0 };
}
function makeEnv() { return { heat: 0, cold: 0, exercise: 0, sleep: 0, cooling: 0, warming: 0 }; }
function makeMod() { return { hr: 0, svr: 0, sv: 0, rr: 0, spo2: 0, temp: 0, gcs: 0 }; }
function makeShunt() { return { airway: 0, clot: 0, edema: 0, op: 0, ptx: 0, other: 0 }; }

/* ---------------- 引擎主体 ---------------- */
function syncPatientFields(S) {
  const { sex, age, weight, height } = S.patient;
  Object.assign(S, { sex, age, weight, height });
}

function restorePatient(S) {
  syncPatientFields(S);
  if (S.traits && root.TRAITS) root.TRAITS.restore(S);
}

function create(caseId, identity = IDENTITY) {
  const C = (caseId && typeof caseId === 'object') ? caseId : (CASES[caseId] || CASES.hyperkalemia);
  /* 病人身份：病例可提供，缺省则随机生成 */
  const randName = (sx) => {
    const SUR = ['王','李','张','刘','陈','杨','赵','黄','周','吴','徐','孙','马','朱','胡','郭','何','高','林','罗'];
    const MG = ['建国','志强','伟','磊','军','洋','勇','杰','涛','鹏','浩','宇','斌','超','明','刚','辉','强','东','峰'];
    const FG = ['秀英','丽','敏','静','娟','芳','燕','娜','婷','雪','琳','悦','慧','倩','萍','梅','兰','霞','洁','颖'];
    const p = sx === '女' ? FG : MG;
    return SUR[Math.floor(frand()*SUR.length)] + p[Math.floor(frand()*p.length)];
  };
  const frand = () => Math.random();
  const pt0 = { sex: C.sex, age: C.age, weight: C.weight, height: C.height, ...C.patient, ...identity };
  const sex0 = C.sexReq || pt0.sex || (frand() < 0.5 ? '男' : '女');
  const age0 = pt0.age ?? 20 + Math.floor(frand()*60);
  const wt0 = pt0.weight ?? (sex0 === '男' ? 62 : 55) + Math.round(frand()*28);
  const ht0 = pt0.height ?? Math.round((sex0 === '男' ? 172 : 160) + (frand()-0.5)*12);
  const patient = { name: pt0.name || C.patientName || randName(sex0), sex: sex0, age: age0, weight: wt0, height: ht0 };

  const S = {
    t: 0, speed: 1, running: true, patient,
    rhythm: 'sinus',
    drugs: [], eff: { insulin: 0, norepi: 0, amio: 0, furo: 0, ppi: 0 },
    pk: [], pumps: {}, benzoPkVersion: 1, mod: makeMod(), modBase: makeMod(),
    log: [], tests: {}, labSnap: {}, labPrevious: {}, lungExam: { latest: null, previous: null }, xrayReports: [],
    score: 100, death: null, discharged: false,
    delivered: false, deliveryStartedAt: null, deliveryAt: null,
    caProtectUntil: -1, dialysisUntil: -1, o2: 0, fio2: 0.21, mapBoost: 0,
    bleedStopped: false, cost: 0, events: [], arrests: 0, infection: 0,
    coag: 1.0, tox: { benzo: 0, op: 0, apap: 0 }, env: makeEnv(),
    tensionPTX: 0, bleedPressDep: 0, externalBleed: false, coHb: 0, vent: 0, paced: 0, tamponade: 0, tca: 0, hematoma: 0, stemi: 0, seizure: 0,
    addict: 0, lastOpioidAt: -1e9, withdraw: 0,

    /* ===== v0.3 新增状态量 ===== */
    interstitium: 11.0,          // 组织间液（L，正常 11）
    lungWater: 0.12,             // 肺水指数（0.12 = 正常，>0.5 = 肺水肿）
    pcwp: 9,                     // 肺毛细血管楔压（mmHg）
    rbcMass: null,               // 红细胞质量（hb = rbcMass / vol）
    naMass: null,                // 钠总量（mmol，ECF 内）
    freeWater: 0,                // ECF 游离水超出量（L）；na = naMass/(ecfVd+freeWater)
    sao2: 0.97, svo2: 0.72,
    shuntSrc: makeShunt(), shunt: 0,
    do2: 900, vo2: 250, do2Crit: 300, co: 5,
    opioidDepress: 0, naloxoneUntil: -1,
    airwayResistance: 0.05,      // 气道阻力（0–1）
    cholinergic: 0, acheActivity: 1, muscarinicBlock: 0,
    pvr: 1.8,                    // 肺血管阻力（Wood 单位量级）
    napqi: 0, gsh: 1, hepatotox: 0,
    svrDrive: 0, hrDrive: 0, tempDrive: 0, heatstrokeDrive: 0, thyroidHeatDrive: 0,
    icp: 0, naRate: 0, odsRisk: 0,
    vt: 450, vdvt: 0.33, vco2: 200,
    renalFactor: 1, crProd: 1.0, diuresis: 0,
    insulinLoad: 0, glucoseIn: 0,
    fatigue: 0, compReserve: 1, workOfBreathing: 0,
    waterClear: 1,               // 自由水清除能力（SIADH 时下调）
    insult: makeInsult(),
    _naPrev: null,
  };
  /* 合并病例定义（后写覆盖前写） */
  Object.assign(S, C.init || {});
  S.bleedingSites = { ...(C.init?.bleedingSites || (C.id === 'bleed' ? { bleed: S.bleedRate } : {})) };
  if (Object.keys(S.bleedingSites).length) {
    S.bleedRate = Object.values(S.bleedingSites).reduce((sum, rate) => sum + rate, 0);
  }
  /* 嵌套对象必须逐个实例化，避免共享引用 */
  S.eff = Object.assign({ insulin: 0, norepi: 0, amio: 0, furo: 0, ppi: 0 }, C.init && C.init.eff || {});
  S.modBase = Object.assign(makeMod(), C.init && C.init.mod || {});
  S.mod = Object.assign({}, S.modBase);
  S.shuntSrc = Object.assign(makeShunt(), C.init && C.init.shuntSrc || {});
  S.insult = Object.assign(makeInsult(), C.init && C.init.insult || {});
  S.env = Object.assign(makeEnv(), C.init && C.init.env || {});
  S.tox = Object.assign({ benzo: 0, op: 0, apap: 0 }, C.init && C.init.tox || {});

  syncPatientFields(S);
  S.caseId = C.id;
  S.cas = C;
  if (root.TRAITS && C.traits) root.TRAITS.applyInit(S, C.traits, C.genVersion > 0 && C.genVersion < 4);
  S.tags = C.tags || ({ hyperkalemia: ['highK'], dka: ['dka'], bleed: ['bleed'],
                        sepsis: ['sepsis'], opioid: ['opioid'] }[C.id] || []);
  /* 红细胞质量由初始 Hb 反推：之后 hb = rbcMass / vol（失血先丢全血、补液才稀释） */
  S.rbcMass = Math.max(20, S.hb * S.vol);
  /* 钠总量由初始 Na 反推 */
  S.cvp0 = S.cvp == null ? 4 : S.cvp;   // 基线 CVP
  S.naMass = S.na * (S.ecfVd + (S.freeWater || 0));
  if (S.na0 == null) S.na0 = S.na;
  S.hb = S.rbcMass / S.vol;
  S.endCapillaryPo2 = S.pao2;
  updateOxygenation(S, S.svo2);
  S.pcwp = computePcwp(S);
  S.ph = computePh(S);
  S.history = [];
  if (S.preload && root.SUBSTANCES) {
    for (const [id, dose] of S.preload) give(S, id, dose);
    S.cost = 0;          // 院前用药不计入本次费用
    S.log = [];
    S.preload = null;
  }
  if (S.opioidTox) S.opioidDepress = 1;
  /* 首帧自洽：跑一拍真实 tick（1 秒），再把时间/日志/给药记录回滚。
     这样所有代数式都走 tick 里的同一份代码，不会再出现"两份公式不同步"。 */
  (function settle() {
    const t0 = S.t, log0 = S.log.slice(), hist0 = (S.history || []).slice();
    const given0 = (S.given || []).slice(), cost0 = S.cost, pk0 = (S.pk || []).slice();
    try { tick(S, 1); } catch (err) { /* 首帧失败不影响创建 */ }
    S.t = t0; S.log = log0; S.history = hist0;
    S.given = given0; S.cost = cost0; S.pk = pk0;
    S.death = null; S.discharged = false; S.running = true;
  })();

  S._naPrev = S.na;
  return S;
}

/* ---------- 通用效应：把物质效应落到状态变量上 ---------- */
function applyDelta(S, key, d) {
  if (!d) return;
  switch (key) {
    case 'k':    S.k    = clamp(S.k + d, 1.2, 9.8); break;
    case 'na':
      /* 钠以"质量"存储：给 Na 量 → naMass，浓度由 naMass/(ecfVd+freeWater) 决定 */
      S.naMass = clamp((S.naMass || 0) + d * (S.ecfVd + (S.freeWater || 0)), 600, 3200);
      break;
    case 'cl':   S.cl   = clamp(S.cl + d, 85, 125); break;
    case 'ca':   S.ca   = clamp(S.ca + d, 0.5, 2.2); break;
    case 'hco3':
      /* HCO₃ 是真状态量：给药直接加，由 dHCO3/dt 自行代谢（替代原来的 hco3Extra） */
      S.hco3 = clamp(S.hco3 + d, 2, 40);
      break;
    case 'lac':  S.lac  = clamp(S.lac + d, 0.2, 25); break;
    case 'glu':  S.glu  = clamp(S.glu + d, 0.4, 45); break;
    case 'halfSaline':
    case 'vol': {
      /* 晶体液分布：只有 30% 留在血管内，70% 进组织间液（替代原来 vol 全额进血管）
         钠按"当前血钠浓度"同步带进/带出 —— 等渗液体不改变血钠；
         真正的自由水负荷由 freeWater 状态量表达（SIADH 模块走那条路）。 */
      const naNow = (S.naMass || 140 * (S.ecfVd || 12)) / Math.max(6, (S.ecfVd || 12) + (S.freeWater || 0));
      const dWater = d * 0.85;
      if (d > 0) {
        S.vol = clamp(S.vol + d * 0.30, 1.5, 7.8);
        S.interstitium = clamp(S.interstitium + d * 0.70, 8.5, 24);
      } else {
        S.vol = clamp(S.vol + d * 0.60, 1.5, 7.8);
        S.interstitium = clamp(S.interstitium + d * 0.40, 8.5, 24);
      }
      /* 水与钠成对进入 ECF：给药当刻血钠不变；之后的自由水清除会让血钠轻度上升（符合"补液后利尿"） */
      S.freeWater = clamp((S.freeWater || 0) + dWater, -3, 14);
      const fluidSodium = key === 'halfSaline' ? 77 : naNow;
      S.naMass = clamp((S.naMass || 0) + fluidSodium * dWater, 600, 3200);
      break;
    }
    case 'hb':
      /* 血红蛋白是导出量：改的是红细胞质量（替代原来直接写 S.hb） */
      S.rbcMass = Math.max(20, (S.rbcMass || 0) + d * S.vol);
      break;
    case 'freeWater':
      /* 口服水中的自由水部分进入稀释容积，不增加钠总量。 */
      S.freeWater = clamp((S.freeWater || 0) + d, -3, 14);
      break;
    case 'uo':
      /* 尿量效应落成"利尿状态"（替代原来加到一个每拍被重算覆盖的 uo 上） */
      S.diuresis = clamp((S.diuresis || 0) + d, 0, 9);
      break;
    case 'infection': S.infection = clamp((S.infection || 0) + d, 0, 1); break;
    case 'estrogen': S.estrogenExo = clamp((S.estrogenExo || 0) + d, -1, 1.5); break;
    case 'testosterone': S.testosteroneExo = clamp((S.testosteroneExo || 0) + d, -1, 1.5); break;
    case 'coag': S.coag = clamp((S.coag || 1) + d, 0.05, 2.0); break;
    case 'pao2': S.endCapillaryPo2 = clamp(S.endCapillaryPo2 + d, 25, 640); break;
    case 'cr':
      /* 肌酐不再被直接改写：nephrotoxin 通过降低肾清除表达（见 tick） */
      S.renalFactor = clamp((S.renalFactor || 1) * (1 - d / 400), 0.05, 1.5);
      break;
    default: break;
  }
}

function computePh(S) {
  const pco2 = Math.max(10, S.paco2);
  const hco3 = Math.max(1, S.hco3);
  return clamp(6.1 + Math.log10(hco3 / (0.03 * pco2)), 6.4, 7.9);
}

/* 肺毛细血管楔压：容量负荷 + 左心功能 + 神经体液血管收缩 */
function computePcwp(S) {
  const contract = (S.contractility == null ? 0.92 : S.contractility) * (1 - 0.62 * (S.stemi || 0));
  return clamp(8
    + 5 * Math.max(0, S.vol - 4.6)
    + (1 - contract) * 18
    + (S.svrDrive || 0) * 0.55
    + Math.max(0, (S.interstitium || 11) - 11.5) * 1.5, 4, 42);
}

/* 模拟器在撤氧后拟合到室内空气；额外观察 5 分钟覆盖体征滞后。 */
const ROOM_AIR_OBSERVATION = 5 * 60;
/* 游戏内撤除循环支持后的连续稳定观察窗口。 */
const CIRCULATION_OBSERVATION = 15 * 60;
const CIRCULATION_MIN_SYSTOLIC = 90;
const CIRCULATION_MIN_MAP = 65;
const CIRCULATORY_PUMPS = new Set(['norepi', 'dobutamine', 'isoproterenol', 'vasopressin']);
const TIMED_PRESSORS = new Set(['epi', 'dopamine', 'phenylephrine']);
const DAY = 24 * 60 * 60;
/* 游戏观察窗口，用近期超限拦截出院；超限提示风险，保留旧病历的既有损伤记录。 */
const SODIUM_RISK_OBSERVATION = 2 * DAY;

function endCapillaryOxygenPressure(S, fio2, co2) {
  const ventilationDeficit = 5 + 25 * Math.max(0, S.vdvt - 0.33);
  return clamp(fio2 * 713 - co2 / 0.8 - ventilationDeficit, 25, 640);
}

function oxygenCapacity(S) {
  return 1.34 * S.hb * (1 - (S.coHb || 0));
}

/* Hb 以 g/L 计，氧含量以 mL O₂/L 计。COHb 占用 Hb 位点，溶解氧仍由分压决定。 */
function oxygenContent(pressure, capacity) {
  return capacity * hill(pressure) + 0.031 * pressure;
}

function oxygenPressure(content, capacity, upperPressure) {
  let low = 0;
  let high = upperPressure;
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2;
    if (oxygenContent(middle, capacity) < content) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function venousOxygenContent(S, capillaryContent, capacity) {
  /* CaO₂ = (1−f)·CcO₂ + f·CvO₂，且 Fick 给出 CaO₂−CvO₂ = VO₂/CO。 */
  const extraction = S.vo2 / (S.co * (1 - S.shunt));
  return clamp(capillaryContent - extraction,
    oxygenContent(MIN_VENOUS_PO2, capacity), oxygenContent(MAX_VENOUS_PO2, capacity));
}

function arterialOxygenPressure(shunt, capillaryPressure, capillaryContent, venousContent, capacity) {
  if (shunt <= 0) return capillaryPressure;
  const arterialContent = lerp(capillaryContent, venousContent, shunt);
  return oxygenPressure(arterialContent, capacity, Math.max(capillaryPressure, MAX_VENOUS_PO2));
}

function updateOxygenation(S, initialVenousSaturation = null) {
  const capacity = oxygenCapacity(S);
  const capillaryPressure = S.endCapillaryPo2;
  const capillaryContent = oxygenContent(capillaryPressure, capacity);
  const venousContent = initialVenousSaturation == null
    ? venousOxygenContent(S, capillaryContent, capacity)
    : oxygenContent(inverseHill(clamp(initialVenousSaturation, 0.15, 0.85)), capacity);
  S.svo2 = hill(oxygenPressure(venousContent, capacity, MAX_VENOUS_PO2));
  S.pao2 = arterialOxygenPressure(S.shunt, capillaryPressure, capillaryContent, venousContent, capacity);
  S.sao2 = hill(S.pao2);
  S.spo2 = S.sao2 * 100;
}

function roomAirSaturation(S, co2 = S.paco2) {
  const pressure = endCapillaryOxygenPressure(S, 0.21, co2);
  const capacity = oxygenCapacity(S);
  const capillaryContent = oxygenContent(pressure, capacity);
  const venousContent = venousOxygenContent(S, capillaryContent, capacity);
  return hill(arterialOxygenPressure(S.shunt, pressure, capillaryContent, venousContent, capacity)) * 100;
}

function recordSodiumSample(correction, t, sodium) {
  const { samples } = correction;
  while (samples.length && t - samples[0].t > DAY) samples.shift();
  while (samples.length && samples[samples.length - 1].na >= sodium) samples.pop();
  samples.push({ t, na: sodium });
  return samples[0].na;
}

function trackSodiumCorrection(S) {
  // 保留 0.01 mmol/L 精度的滚动最低值，并限制长期存档的记录量。
  const sodium = Math.round(S.na * 100) / 100;
  if (!S.naCorrection) {
    const baseline = S.na0 ?? sodium;
    if (Math.min(baseline, sodium) >= 130) return;
    S.naCorrection = { startedAt: baseline < 130 ? 0 : S.t, samples: [{ t: 0, na: baseline }] };
  }

  const nadir = recordSodiumSample(S.naCorrection, S.t, sodium);
  const rise = Math.round((sodium - nadir) * 100) / 100;
  const limit = S.t - S.naCorrection.startedAt <= DAY ? 10 : 8;
  S.odsRisk = nadir < 130 ? clamp(rise / limit, 0, 1.5) : 0;
  if (S.odsRisk <= 1) return;
  if (S.naOvercorrectedAt == null || S.t - S.naOvercorrectedAt >= SODIUM_RISK_OBSERVATION) {
    S.log.push([fmt(S.t), '血钠 24 h 内升幅过大（' + rise.toFixed(1) + ' mmol/L），需观察渗透性脱髓鞘风险', 'bad']);
  }
  S.naOvercorrectedAt = S.t;
}

function restoreDischargeObservation(S, saved) {
  S.hadCirculatorySupport = saved.hadCirculatorySupport ?? (
    Object.keys(S.pumps || {}).some(id => CIRCULATORY_PUMPS.has(id)) ||
    S.pk?.some(p => p.scale > 0 && isTimedCirculatorySupport(p)) ||
    S.given?.some(order => order.d > 0 && isTimedCirculatorySupport(order)) || false
  );
  if (S.hadCirculatorySupport) {
    const since = saved.circulationStableSince;
    S.circulationStableSince = Number.isFinite(since) && since >= 0 && since <= S.t ? since : null;
    trackCirculationObservation(S);
  }
  if (saved.respiratoryAssessmentAt == null) delete S.respiratoryAssessmentAt;
  if (saved.hadOxygenSupport == null && (S.vent || S.o2 || S.fio2 > 0.21 ||
      saved.log?.some(([, text]) => /提高吸氧浓度至|停止吸氧|气管插管成功|撤除机械通气/.test(text)))) {
    S.hadOxygenSupport = true;
    S.roomAirStableSince = null;
  }

  if (saved.naCorrection) return;
  const previous = (saved.history || []).filter(sample => sample.t > 0 && sample.t <= S.t && Number.isFinite(sample.na));
  const firstLow = previous.find(sample => sample.na < 130);
  if (!(S.na0 < 130) && !firstLow && S.na >= 130) return;
  S.naCorrection = { startedAt: S.na0 < 130 ? 0 : firstLow?.t ?? S.t, samples: [] };
  if (S.na0 < 130) recordSodiumSample(S.naCorrection, 0, S.na0);
  for (const sample of previous) {
    // 旧趋势只存整数。用其四舍五入范围，避免凭小数精度不足判定超限。
    const nadir = recordSodiumSample(S.naCorrection, sample.t, sample.na + 0.5);
    const limit = sample.t - S.naCorrection.startedAt <= DAY ? 10 : 8;
    if (nadir < 130 && sample.na - 0.5 - nadir > limit) S.naOvercorrectedAt = sample.t;
  }
  trackSodiumCorrection(S);
}

/* --- 环境与体温处置 --- */
function setEnv(S, key, on) {
  S.env = S.env || {};
  if (key === 'reset') { S.env = makeEnv(); return S.env; }
  if (on && (key === 'heat' || key === 'cold')) { S.env.heat = 0; S.env.cold = 0; }
  if (on && key === 'cooling') {
    if (!(S.temp > COOLING_TARGET)) return S.env;
    S.env.warming = 0;
  }
  if (on && key === 'warming') {
    if (!Number.isFinite(S.temp) || S.temp >= WARMING_TARGET) return S.env;
    S.env.cooling = 0;
  }
  S.env[key] = on ? 1 : 0;
  return S.env;
}

function restoreTemperature(S, saved) {
  if (saved.heatstrokeDrive != null && saved.thyroidHeatDrive != null) return;
  const heatstroke = S.tags.includes('heatstroke');
  const thyroid = S.tags.includes('thyroid');
  if (!heatstroke && !thyroid && !S.tags.includes('seizure')) return;
  // 旧复合病例只保存一份产热驱动，按各病因的初始占比分配现存负荷。
  const drive = Math.max(0, saved.tempDrive ?? 0);
  const heatShare = heatstroke && thyroid ? 1.3 / (1.3 + 0.7) : Number(heatstroke);
  S.heatstrokeDrive = drive * heatShare;
  S.thyroidHeatDrive = thyroid ? drive * (1 - heatShare) : 0;
  S.tempDrive = 0;
  S.env = Object.assign(makeEnv(), saved.env);
  if (heatstroke && S.env.cold) {
    S.env.cold = 0;
    S.env.cooling = Number(S.temp > COOLING_TARGET);
  }
  if (heatstroke && S.temp <= COOLING_TARGET) S.heatstrokeCooled = true;
}

// Administration records are timestamped in simulation seconds and doses in mg.
// A dosing-limit warning, a high-risk exposure and established poisoning are distinct.
function acetaminophenExposure(S) {
  const weight = S.weight > 0 ? S.weight : 70;
  let mg24h = 0, largestDose = 0;
  for (const dose of S.given || []) {
    if (dose.id !== 'acetaminophen' && dose.id !== 'paracetamol') continue;
    const age = S.t - dose.t;
    if (!(age >= 0 && age < 86400 && Number.isFinite(dose.d) && dose.d > 0)) continue;
    mg24h += dose.d;
    largestDose = Math.max(largestDose, dose.d);
  }
  return {
    mg24h,
    aboveLimit: largestDose > (weight < 50 ? 15 * weight : 1000) || mg24h > (weight < 50 ? 75 * weight : 4000),
    highRisk: mg24h >= Math.min(10000, 200 * weight),
    known: (S.apapLoad || 0) > 0 || (S.tags || []).includes('apap'),
  };
}

const BENZODIAZEPINES = new Set(['diazepam', 'lorazepam', 'midazolam', 'clonazepam']);

// Normalized single-dose activity in the game's PK model; different drugs' mg are not additive.
function bolusActivity(p, now) {
  const elapsed = (now - p.t) / 60;
  const lag = (p.onset || 0) * 0.35;
  if (elapsed <= lag || elapsed > p.dur * 1.8) return 0;
  const age = elapsed - lag;
  const ramp = Math.min(1, age / Math.max(1, (p.onset || 1) * 0.8));
  return ramp * Math.exp(-Math.LN2 * age / Math.max(1, p.dur / 4.5));
}

function flumazenilBlock(S) {
  let block = 0;
  for (const p of S.pk || []) if (p.id === 'flumazenil') block += p.scale * bolusActivity(p, S.t);
  return Math.min(1, block);
}

function benzodiazepineExposure(S) {
  let load = (S.tox?.benzo || 0) / 5; // Legacy admission exposure, separate from ward administrations.
  let barbiturate = false;
  for (const p of S.pk || []) {
    if (BENZODIAZEPINES.has(p.id)) load += p.scale * bolusActivity(p, S.t);
    if (p.id === 'phenobarbital' && p.scale * bolusActivity(p, S.t) > 0.1) barbiturate = true;
  }
  load *= 1 - flumazenilBlock(S);
  const baseline = S.benzoBaseline;
  const depressed = (S.gcs <= 10 && (!baseline || S.gcs <= baseline.gcs - 2)) ||
    (S.rr < 10 && (!baseline || S.rr <= baseline.rr - 2));
  // The seizure scenario permits two rescue doses of twice the reference dose.
  // This is a game activity threshold, not a clinical toxic dose.
  const high = load > 4;
  return { load, high, overdose: high && depressed, sedated: load > 0.1 || barbiturate };
}

function restoreBenzodiazepines(S, saved) {
  if (saved.benzoPkVersion === 1) return;
  // Older saves counted ward doses twice (and even added phenobarbital) in this pool.
  if ((S.given || []).some(p => BENZODIAZEPINES.has(p.id) || p.id === 'phenobarbital')) {
    const admission = S.cas?.init?.tox?.benzo || 0;
    S.tox.benzo = Math.min(S.tox.benzo || 0, admission * Math.exp(-S.t / 3600));
  }
  for (const p of S.pk || []) {
    if (BENZODIAZEPINES.has(p.id)) {
      const drug = root.SUBSTANCES?.byId(p.id);
      if (drug) p.eff = drug.eff;
    }
  }
  S.benzoPkVersion = 1;
}

function infusionDetails(dose, unit, minutes) {
  return `总量 ${dose} ${unit}，输注 ${minutes} 分钟`;
}

// 恒速输入和一阶清除后剩余的比例，以本次医嘱的总量为 1。
function infusionActivity(elapsed, duration, ke) {
  const supplied = clamp(elapsed, 0, duration);
  const timeAfter = Math.max(0, elapsed - duration);
  return -Math.expm1(-ke * supplied) * Math.exp(-ke * timeAfter) / (ke * duration);
}

function pumpRate(S, drugId) {
  return S.pumps?.[drugId]?.rate || 0;
}

function pumpOrder(name, action, rate, unit) {
  if (action === 'stop') return `停止泵入 ${name}（停泵前 ${rate} ${unit}）`;
  if (action === 'adjust') return `调整 ${name} 泵速至 ${rate} ${unit}`;
  return `开始持续静脉泵入 ${name}（${rate} ${unit}）`;
}

function pumpActivity(pump, route, time) {
  if (!pump) return 0;
  // 按默认泵速归一化，各次调速以调整时的实际药物浓度为起点。
  const decay = -Math.LN2 * Math.max(0, time - pump.t) / (60 * route.pumpHalfLife);
  return pump.activity * Math.exp(decay) + (pump.rate / route.d) * -Math.expm1(decay);
}

function pumpEffectScale(activity) {
  return 4 / (3 / activity + 1);
}

function isTimedCirculatorySupport(order) {
  return CIRCULATORY_PUMPS.has(order.id) ||
    (order.route === '泵入' && TIMED_PRESSORS.has(order.id)) ||
    (order.route === '静推' && (order.id === 'epi' || order.id === 'milrinone'));
}

function markCirculatorySupport(S) {
  S.hadCirculatorySupport = true;
  S.circulationStableSince = null;
}

function circulationStable(S, pressure) {
  return S.rhythm === 'sinus' && pressure.sys >= CIRCULATION_MIN_SYSTOLIC && pressure.map >= CIRCULATION_MIN_MAP;
}

function activeCirculationSupport(S) {
  const running = Object.keys(S.pumps || {}).filter(id => CIRCULATORY_PUMPS.has(id) && pumpRate(S, id) > 0);
  // 旧版泵入医嘱仍走原有 PK 时程，维持和衰减直到该条 PK 记录移除。
  const timed = (S.pk || []).filter(p => p.scale > 0 && isTimedCirculatorySupport(p) && S.t < timedSupportEndsAt(p));
  return { running, timed };
}

function timedSupportEndsAt(order) {
  return order.t + (order.dur * 1.8 + (order.infusionMinutes || 0)) * 60;
}

function trackCirculationObservation(S) {
  if (!S.hadCirculatorySupport) return;
  const support = activeCirculationSupport(S);
  if (support.running.length || support.timed.length || !circulationStable(S, bp(S))) S.circulationStableSince = null;
  else S.circulationStableSince ??= S.t;
}

function changePump(S, sub, route, rate) {
  const previous = S.pumps?.[sub.id];
  const oldRate = previous?.rate || 0;
  if (rate === oldRate) return null;
  const action = rate === 0 ? 'stop' : oldRate ? 'adjust' : 'start';
  S.pumps ||= {};
  S.pumps[sub.id] = { rate, activity: pumpActivity(previous, route, S.t), t: S.t };
  if (CIRCULATORY_PUMPS.has(sub.id)) {
    if (rate > 0) markCirculatorySupport(S);
    else trackCirculationObservation(S);
  }
  const recordedRate = rate || oldRate;
  S.given ||= [];
  S.given.push({ id: sub.id, n: sub.n, d: recordedRate, unit: sub.unit, route: route.r, t: S.t, pumpAction: action });
  if (action === 'start') {
    S.cost += sub.cost || 0;
    if (root.TRAITS) root.TRAITS.onDrug(S, sub, rate);
  }
  if (rate > 0 && S.lastGiven !== undefined) S.lastGiven = sub.id;
  S.log.push([fmt(S.t), pumpOrder(sub.n, action, recordedRate, sub.unit), 'good']);
  return recordedRate;
}

function stopPump(S, drugId) {
  const sub = root.SUBSTANCES?.byId(drugId);
  const route = sub?.routes?.find(rt => rt.pumpHalfLife);
  return route ? changePump(S, sub, route, 0) : null;
}

function pumpEffect(S, drugId) {
  const sub = root.SUBSTANCES?.byId(drugId);
  const route = sub?.routes?.find(rt => rt.pumpHalfLife);
  return route ? pumpEffectScale(pumpActivity(S.pumps?.[sub.id], route, S.t)) : 0;
}

const EFFECT_DECAY_MINUTES = 90;

function insulinActivity(S) {
  let activity = S.eff.insulin;
  for (const p of S.pk || []) {
    if (p.id === 'insulin' && p.infusionMinutes) {
      activity += p.scale * infusionActivity((S.t - p.t) / 60, p.infusionMinutes, 1 / EFFECT_DECAY_MINUTES);
    }
  }
  return Math.min(3.5, activity);
}

function give(S, drugId, dose, route) {
  const SUB = root.SUBSTANCES;
  if (SUB) {
    const s = SUB.byId(drugId);
    if (s) {
      const pumpRoute = s.routes?.find(rt => rt.pumpHalfLife);
      if (pumpRoute) {
        const rate = dose ?? pumpRoute.d;
        if ((route && route !== pumpRoute.r && route !== '泵入') || !(Number.isFinite(rate) && rate > 0)) return null;
        return changePump(S, s, pumpRoute, rate);
      }
      const selectedRoute = s.routes?.find(x => x.r === route);
      const infusionMinutes = selectedRoute?.infusionMinutes;
      const d = dose ?? (infusionMinutes ? selectedRoute.d : s.dose);
      if (infusionMinutes && !(Number.isFinite(d) && d > 0)) return null;
      if (s.cost) S.cost += s.cost;
      const on = selectedRoute?.on ?? s.onset;
      const du = selectedRoute?.du ?? s.dur;
      // 以同等总量的静推剂量作效应标尺，泵速只决定送入体内的时间。
      const refDose = infusionMinutes ? s.dose : (selectedRoute?.d ?? s.dose);
      const perKg = /\/kg/.test(s.unit || '');
      const wScale = perKg ? (S.weight || 70) / 70 : 1;
      const scale = (d / (refDose || 1)) * wScale;
      const pkMul = S.pkScale || 1;
      S.pk = S.pk || [];
      if (BENZODIAZEPINES.has(s.id) && benzodiazepineExposure(S).load <= 0.1) {
        S.benzoBaseline = { gcs: S.gcs, rr: S.rr };
      }
      const order = { id: s.id, n: s.n, t: S.t, route: selectedRoute?.r || s.route,
                      onset: on, dur: du * pkMul, eff: s.eff, scale,
                      ...(infusionMinutes ? { infusionMinutes, dose: d, unit: s.unit } : {}) };
      S.pk.push(order);
      if (scale > 0 && isTimedCirculatorySupport(order)) markCirculatorySupport(S);
      S.given = S.given || [];
      S.given.push({ id: s.id, n: s.n, d, unit: s.unit, route: route || s.route, t: S.t,
                     ...(infusionMinutes ? { infusionMinutes } : {}) });
      if (root.TRAITS) root.TRAITS.onDrug(S, s, d);
      /* 性激素类药物：给药后进入体内激素库（12 h 半衰期），由 tick 里的激素段合并到 S.estrogen/testosterone */
      if (s.eff && s.eff.estrogen) S.estrogenExo = clamp((S.estrogenExo || 0) + s.eff.estrogen * scale, -1, 1.6);
      if (s.eff && s.eff.testosterone) S.testosteroneExo = clamp((S.testosteroneExo || 0) + s.eff.testosterone * scale, -1, 1.6);
      /* 药物相互作用：这里只记日志。
         效应改由每拍的 PK 浓度驱动（见 tick 内 interactions 段）——
         一次性注入会让"两种药都代谢完了、副作用还在"，与真实时程不符。 */
      try {
        const TBL = SUB.INTERACTIONS || [];
        const prev = (S.given || []).slice(0, -1).map(x => x && x.n).filter(Boolean);
        for (const it of TBL) {
          if (!(it.a === s.n && prev.includes(it.b)) && !(it.b === s.n && prev.includes(it.a))) continue;
          /* 只有另一种药此刻仍在体内（未过 1.8 个疗程）才算真正的相互作用 */
          const other = it.a === s.n ? it.b : it.a;
          const alive = (S.pk || []).some(pp => pp.n === other &&
            (S.t - pp.t) / 60 < (pp.infusionMinutes || 0) + pp.dur * 1.8);
          if (!alive) continue;
          S._ix = S._ix || {};
          const key = [it.a, it.b].sort().join('|');
          if (S._ix[key]) continue;
          S._ix[key] = 1;
          S.log.push([fmt(S.t), '相互作用：' + it.a + ' + ' + it.b + ' —— ' + it.note, 'warn']);
        }
      } catch (err) {}
      /* —— 特殊机制 —— */
      if (s.cls === '阿片') { S.lastOpioidAt = S.t; S.addict = clamp((S.addict || 0) + d / 60, 0, 1); }
      if (s.id === 'paracetamol' || s.id === 'acetaminophen') S.tox.apap += d;
      if (s.id === 'nacetylcysteine') S.tox.apap = 0;
      if (s.id === 'organophosphate') S.tox.op += d;
      if (s.id === 'pralidoxime') S.tox.op = Math.max(0, S.tox.op - d * 2);
      if (s.id === 'atropine' && S.tox.op > 0) S.tox.op = Math.max(0, S.tox.op - d);
      const label = infusionMinutes
        ? `开始泵入 ${s.n}（${infusionDetails(d, s.unit, infusionMinutes)}）`
        : `给予 ${s.n} ${d}${s.unit}（${route || s.route || '静推'}）`;
      S.log.push([fmt(S.t), label, 'good']);
      if (s.id === 'calcium' || s.id === 'calcium_cl') S.caProtectUntil = S.t + (s.dur || 45) * 60;
      if (s.id === 'insulin' && !infusionMinutes) S.eff.insulin = Math.min(3.5, S.eff.insulin + d / 10);
      if (s.id === 'mannitol') S.icp = Math.max(0, (S.icp || 0) - 0.30 * d / 250);
      /* 苯二氮卓：终止癫痫发作（但也会压低意识——这是本病例的教学点） */
      if ((s.id === 'diazepam' || s.id === 'lorazepam' || s.id === 'midazolam') && (S.seizure || 0) > 0)
        S.seizure = Math.max(0, (S.seizure || 0) - 0.55 * (d / 10));   // 渗透性脱水
      /* 碳酸氢钠：三环类中毒的解毒机制（碱化血液 + 钠负荷，窄化 QRS） */
      if (s.id === 'bicarb' && (S.tca || 0) > 0) S.tca = Math.max(0, (S.tca || 0) - 0.12);
      /* 儿茶酚胺的"在体"标记：供除颤成功率等旧逻辑使用（SVR 走 S.mod.svr 的乘法路径） */
      if (s.id === 'norepi' || s.id === 'epi' || s.id === 'dopamine') {
        S.eff.norepi = Math.min(2, (S.eff.norepi || 0) + d / 8);
      }
      if (s.id === 'naloxone') {
        S.naloxoneGiven = true;
        /* 纳洛酮半衰期短：只拮抗 45 分钟，之后呼吸抑制重新出现（所以需要重复给药）
           —— 替代原来直接把 mod.rr / mod.gcs 写死加回来的做法 */
        S.naloxoneUntil = S.t + 45 * 60;
        S.lastNaloxoneAt = S.t;
        S.log.push([fmt(S.t), '纳洛酮拮抗阿片作用', 'good']);
      }
      if (S.lastGiven !== undefined) S.lastGiven = s.id;
      return d;
    }
  }
  const D = DRUGS[drugId]; if (!D) return null;
  const d = (dose == null ? D.defaultDose : dose);
  if (drugId === 'norepi' && !(Number.isFinite(d) && d > 0)) return null;
  if (D.cost) S.cost += D.cost;
  D.apply(S, d, route);
  return d;
}

function urineOutput(S, renalPerf) {
  const volFactor = clamp((S.vol - 2.3) / 2.1, 0.02, 1.6);
  const osmDiuresis = clamp((S.glu - 12) * 0.28, 0, 4.5);
  const renalCapacity = S.tags.includes('aki') ? clamp(S.renalFactor, 0.05, 1) : 1;
  const outflowLimit = S.tags.includes('bph') && !S.urineDrained ? 0.08 : 10;
  const produced = (0.95 * renalPerf * volFactor + S.diuresis + osmDiuresis) * renalCapacity;
  return clamp(produced, 0, outflowLimit);
}

/* =========================================================================
 * 每帧推进
 * ========================================================================= */
function finishDelivery(S) {
  if (!S.running || S.delivered || !Number.isFinite(S.deliveryStartedAt)) return;
  const dueAt = S.deliveryStartedAt + DELIVERY_DURATION;
  /* 0.2 秒模拟步长反复相加会在边界处产生微小舍入误差。 */
  if (S.t < dueAt - 1e-7) return;
  S.delivered = true;
  S.deliveryAt = dueAt;
  S.svr = Math.max(18, (S.svr || 26) - 3);
  const pressure = bp(S);
  const saturation = pulseOximetry(S);
  const maternal = `胎盘已娩出，母体进入产后观察。血压 ${pressure.sys}/${pressure.dia} mmHg，SpO₂ ${saturation == null ? '无信号' : saturation + '%'}`;
  const newborn = '已交接新生儿科观察，后续结局待随访';
  S.deliveryRecord = { maternal, newborn };
  S.log.push([fmt(dueAt), maternal + '。新生儿' + newborn, 'good']);
}

function tick(S, dtSec) {
  if (!S.running) return S;
  if (S.circulationStableSince != null && !circulationStable(S, bp(S))) S.circulationStableSince = null;
  const dtMin = Math.max(1e-5, dtSec / 60);
  /* 一次按压操作代表一轮 CPR，灌注支持在两分钟内消退。 */
  S.mapBoost = Math.max(0, (S.mapBoost || 0) - 12.5 * dtMin);
  const inArrest = S.rhythm !== 'sinus';
  const inAsystole = S.rhythm === 'asystole';
  if (inArrest) applyArrestPhysiology(S);
  const pleuralLoad = clamp(S.tensionPTX || 0, 0, 1);
  const thyroidDepression = clamp(S.myxedemaSeverity || 0, 0, 1);
  const previousTime = S.t;
  S.t += dtSec;

  const env = S.env || {};
  const tox = S.tox || {};

  /* ---------- 0. 体质 / 中毒（沿用旧钩子，只作为驱动） ---------- */
  /* 病例原有的苯二氮卓负荷沿用 60 min 衰减时间常数，病房给药由下方 PK 单独推进。 */
  if (tox.benzo > 0) tox.benzo *= Math.exp(-dtMin / 60);
  const benzoAvailable = 1 - flumazenilBlock(S);
  const benzoF = Math.min(1, (tox.benzo || 0) / 12) * benzoAvailable;
  const opF = Math.min(1, (tox.op || 0) / 5);
  if (root.TRAITS) root.TRAITS.tick(S, dtMin);
  const tm = root.TRAITS ? root.TRAITS.modifiers(S) : { svr: 0, rr: 0, spo2: 0, hr: 0 };
  const toxHr = -(benzoF * 10) - (opF * 22) + (tm.hr || 0);
  const toxRr = -(benzoF * 7) + (opF * 4);
  const toxGcs = -(benzoF * 9) - (opF * 5);
  const envHr = (env.heat ? 6 : 0) + (env.cold ? 7 : 0) + (env.exercise ? 20 : 0) - (env.sleep ? 8 : 0);
  const envRr = (env.exercise ? 7 : 0) + (env.heat ? 3 : 0) + (tm.rr || 0);
  const envTemp = (env.heat ? 1.3 : 0) - (env.cold ? 1.0 : 0) + (env.exercise ? 0.4 : 0);
  const opioidIdle = (S.t - (S.lastOpioidAt ?? -1e9)) / 60;
  S.withdraw = (S.addict || 0) > 0.55 && opioidIdle > 120
    ? clamp(((S.addict || 0) - 0.55) * 40, 0, 1) : 0;
  const wdHr = S.withdraw * 18, wdGcs = -S.withdraw * 2;

  /* ---------- 1. 药代动力学 ----------
   * 体征类效应（hr/svr/sv/rr/temp/gcs）用"瞬时浓度"求和；
   * 替代 v0.1 的「累计积分 + 每 45 min 指数衰减」——旧写法在重复给药时
   * 会一路叠加到封顶（例如每 15 min 追加多巴酚丁胺 → HR +60，肺水肿永远压不下来）。 */
  const drugMod = makeMod();
  let feverReduction = 0;
  let opioidTone = 0;
  let arrestEpinephrine = 0;
  const opioidAntagonized = S.t < (S.naloxoneUntil || -1);
  const concOf = {};   /* 药名 → 当前有效浓度，供相互作用按 PK 时程缩放 */
  S.thyroidReplacement = 0;
  S.thyroidTherapyActivity = {};
  for (const [id, pump] of Object.entries(S.pumps || {})) {
    const sub = root.SUBSTANCES?.byId(id);
    const route = sub?.routes?.find(rt => rt.pumpHalfLife);
    if (!route) continue;
    const activity = pumpActivity(pump, route, S.t);
    const effectScale = pumpEffectScale(activity);
    for (const key of MOD_KEYS) drugMod[key] += (sub.eff[key] || 0) * effectScale;
    concOf[sub.n] = activity;
  }
  S.pk = S.pk || [];
  for (let i = S.pk.length - 1; i >= 0; i--) {
    const p = S.pk[i];
    const el = (S.t - p.t) / 60;                    // 给药后分钟数
    const hl = Math.max(1, p.dur / 4.5);            // 疗程 ≈ 4.5 个半衰期
    const ke = Math.LN2 / hl;
    const lag = Math.max(0, p.onset || 0) * 0.35;   // 起效延迟
    const infusion = p.infusionMinutes;
    if (infusion) {
      const previousElapsed = (previousTime - p.t) / 60;
      const finishedAt = p.t + infusion * 60;
      if (previousTime < finishedAt && S.t >= finishedAt) {
        S.log.push([fmt(finishedAt), `${p.n} 泵入完成（${infusionDetails(p.dose, p.unit, infusion)}）`, 'good', finishedAt]);
      }
      const age = el - lag;
      const previousAge = previousElapsed - lag;
      const active = infusionActivity(age, infusion, ke);
      const supplied = (clamp(age, 0, infusion) - clamp(previousAge, 0, infusion)) / infusion;
      const released = Math.max(0, supplied - active + infusionActivity(previousAge, infusion, ke));
      for (const key in p.eff) applyDelta(S, key, p.eff[key] * p.scale * released);
      concOf[p.n] = Math.max(concOf[p.n] || 0, p.scale * active);
      if (el > infusion + p.dur * 1.8) S.pk.splice(i, 1);
      continue;
    }
    if (el > p.dur * 1.8) { S.pk.splice(i, 1); continue; }
    if (el < lag) continue;
    const c = Math.exp(-ke * (el - lag));           // 归一化浓度
    const rate = ke * c;                            // ∫rate dt = 1 → 总量守恒
    /* 「体征类」效应用平台型时程：输注期间维持（泵入/持续静滴），停药后按半衰期消退。
       替代原来"一给就指数衰减、10 分钟后效应基本消失"的写法——
       那是去甲肾上腺素 32 μg/min 只升 4 mmHg 的原因。 */
    const ramp = Math.min(1, (el - lag) / Math.max(1, (p.onset || 1) * 0.8));
    const plateau = el <= lag + p.dur ? 1 : Math.exp(-ke * (el - lag - p.dur));
    const cMod = BENZODIAZEPINES.has(p.id) ? bolusActivity(p, S.t) * benzoAvailable : Math.max(0, ramp) * plateau;
    concOf[p.n] = Math.max(concOf[p.n] || 0, p.scale * cMod);
    if (THYROID_THERAPY.has(p.id)) {
      const activity = (S.thyroidTherapyActivity[p.id] || 0) + p.scale * cMod;
      S.thyroidTherapyActivity[p.id] = clamp(activity, 0, 1);
    }
    if (p.id === 'levothyroxine') S.thyroidReplacement = Math.max(S.thyroidReplacement, p.scale * cMod);
    if (inAsystole && p.id === 'epi' && p.route === '静推' && el <= p.dur) {
      arrestEpinephrine = Math.max(arrestEpinephrine, clamp(p.scale, 0, 1) * cMod);
    }
    /* 阿片类：记录当前最大的效应浓度（用于呼吸抑制深度） */
    const sub = root.SUBSTANCES?.byId(p.id);
    if (sub?.cls === '阿片') {
      if (opioidAntagonized) continue;
      opioidTone = Math.max(opioidTone, p.scale * c);
    }
    for (const key in p.eff) {
      if (MOD_KEYS.includes(key)) {
        /* Emax 饱和：E = Emax·D/(EC50+D)，取 EC50=3 使 D=1 时等于原有效应。
           替代线性放大——原来给 10 倍剂量就是 10 倍效应，10 mg 吗啡能把人打死。 */
        const sat = p.scale * 4 / (3 + p.scale);
        const effect = p.eff[key] * sat * cMod;
        if (key === 'temp' && effect < 0 && ['NSAID', '解热镇痛', '糖皮质激素'].includes(sub?.cls)) {
          feverReduction -= effect;
        } else {
          drugMod[key] = (drugMod[key] || 0) + effect;
        }
      } else if (key === 'na') {
        /* 钠在 ECF 内 15–20 min 就完成分布：用更快的速率投递，
           否则 3% 高渗盐水要 2 小时才把血钠抬起来（与临床不符） */
        const keNa = Math.LN2 / 4;
        const rNa = keNa * Math.exp(-keNa * Math.max(0, el - lag));
        applyDelta(S, 'na', p.eff[key] * p.scale * rNa * dtMin);
      } else if (key === 'estrogen' || key === 'testosterone') {
        /* 外源激素：按平台浓度在 30 分钟内累积到设定强度，之后维持（不是一次性注入） */
        applyDelta(S, key, p.eff[key] * p.scale * cMod * dtMin / 30);
      } else {
        applyDelta(S, key, p.eff[key] * p.scale * rate * dtMin);
      }
    }
  }
  /* —— 药物相互作用（PK 驱动）：两种药同时在体内才有效应，浓度降下来效应随之消退 ——
     w = min(浓度A, 浓度B)；体征类叠加到 drugMod，电解质/凝血类按 30 min 时间常数累积，
     使"两药同时处于有效浓度"期间的总增量≈原来的单次量。 */
  try {
    if (root.SUBSTANCES) {
      const TBL = root.SUBSTANCES.INTERACTIONS || [];
      for (const it of TBL) {
        const ca = concOf[it.a] || 0, cb = concOf[it.b] || 0;
        if (ca <= 0.02 || cb <= 0.02) continue;
        const w = Math.min(1, Math.min(ca, cb));
        /* 饱和累加：无论共存 30 分钟还是 4 小时，总增量都只等于设计的一份 */
        const acc = (S._ixAcc = S._ixAcc || {});
        const key = it.a + '|' + it.b;
        const prevAcc = acc[key] || 0;
        const nextAcc = Math.min(1, prevAcc + w * dtMin / 30);
        acc[key] = nextAcc;
        const step = nextAcc - prevAcc;
        for (const k in (it.eff || {})) {
          if (MOD_KEYS.includes(k)) drugMod[k] = (drugMod[k] || 0) + it.eff[k] * nextAcc;
          else applyDelta(S, k, it.eff[k] * step);
        }
      }
    }
  } catch (err) {}

  for (const k of MOD_KEYS) S.mod[k] = (S.modBase[k] || 0) + (drugMod[k] || 0);

  /* 阿片呼吸抑制深度（0–1）：拮抗后迅速逆转，纳洛酮作用消退后重新出现
     —— 替代原来 "把 mod.rr / mod.gcs 直接钳到 -19 / -6" 的写法
     （那会让化学感受器照样把病人拉回来，而真实阿片中毒是"对 CO₂ 不再反应"） */
  if (S.opioidTox) {
    const sinceExposure = Math.max(0, S.t - (S.lastOpioidAt >= 0 ? S.lastOpioidAt : 0));
    const target = opioidAntagonized ? 0 : Math.exp(-Math.LN2 * sinceExposure / (45 * 60));
    S.opioidDepress = lerp(S.opioidDepress == null ? 1 : S.opioidDepress, target, clamp(0.30 * dtMin, 0, 1));
  }
  S._opioidTone = opioidTone;

  /* 效应室（旧版内部通道）指数衰减 */
  const effectDecay = Math.exp(-dtMin / EFFECT_DECAY_MINUTES);
  for (const k of Object.keys(S.eff)) {
    S.eff[k] *= effectDecay;
    if (S.eff[k] < 0.001) S.eff[k] = 0;
  }
  const insulinEffect = insulinActivity(S);
  S.insulinLoad = (S.insulinLoad || 0) * Math.exp(-dtMin / 25);
  S.diuresis = Math.max(0, (S.diuresis || 0) - 0.02 * dtMin);

  /* ---------- 2. 体液分布：血浆 / 组织间液 / 肺水 ---------- */
  /* 组织间液经淋巴回流清除（替代原来"容量只有血管一个房室"的设定） */
  const lymph = 0.015 * Math.max(0, S.interstitium - 11) * dtMin;
  S.interstitium = clamp(S.interstitium - lymph, 8.5, 24);
  /* 低容量时毛细血管再充盈：把组织间液吸回血管（补液后 Hb 被稀释的机制） */
  if (S.vol < 4.2 && S.interstitium > 11.05) {
    const refill = Math.min(0.030 * (S.interstitium - 11), 0.02) * dtMin;
    S.interstitium -= refill; S.vol += refill;
  }
  /* 尿量带走血管内水 */
  /* 利尿：60% 来自组织间液、40% 来自血浆——这是肺水肿"脱水救命但不塌血压"的机制 */
  /* 动脉性出血受血压调制：MAP 越高出得越快（这是"允许性低血压"的生理依据） */
  const pressF = 1 + (S.bleedPressDep || 0) * clamp(((S.map || 80) - 70) / 60, -0.45, 0.9);
  const uoVol = S.uo * dtMin / 1000;
  S.vol = clamp(S.vol - uoVol * 0.40, 1.5, 7.8);
  S.interstitium = clamp((S.interstitium || 11) - uoVol * 0.60, 8.5, 24);
  /* 维持水摄入：不喝水的人 7 h 也会浓缩；补上后 Hb/血钾不再漂 */
  const maintenanceIntake = 0.0017 * clamp((5.4 - S.vol) / 0.9, 0, 1);
  S.vol = clamp(S.vol + maintenanceIntake * dtMin, 1.5, 7.8);

  /* 肺水：Starling 滤过（肺毛细血管压 − 胶体渗透压）− 淋巴/利尿清除
     —— 替代原来"肺水肿只能靠模块直接给 SpO₂ 设上限"的写法 */
  S.pcwp = computePcwp(S);
  const filt = S.pcwp - 13 + Math.max(0, (S.interstitium - 11) * 3);
  const diur = (S.diuresis || 0) + (S.eff.furo || 0);
  S.lungWater = clamp((S.lungWater || 0.12) + (0.0018 * filt - 0.012 * (1 + diur)) * dtMin, 0.05, 1.5);

  /* ---------- 3. 血压（先用上一拍的状态，供灌注判定） ---------- */
  /* 心包填塞 / 张力性气胸都会抬高中心静脉压——这是「颈静脉怒张」的量化来源 */
  S.cvp = (S.cvp0 == null ? 4 : S.cvp0) + 10 * (S.tamponade || 0) + 4 * (S.tensionPTX || 0);
  const mapNow = computeMap(S);
  S.map = Math.round(mapNow);
  const coNow = S.hr * S.sv / 1000;

  /* ---------- 4. 肾脏：GFR、尿量、肌酐一阶滞后 ---------- */
  const renalPerf = clamp(mapNow / 85, 0.12, 1.25);
  const hypovol = clamp((S.vol - 1.6) / 2.9, 0.15, 1.15);
  const gfrNow = clamp(110 * renalPerf * hypovol * clamp(S.renalFactor, 0.05, 1.5)
                       * (1 - 0.55 * (S.hepatotox || 0)), 2, 135);
  S.gfr = gfrNow;
  /* 肌酐：生成恒定 − 清除 ∝ GFR，一阶滞后（替代原来"模块直接写 cr"） */
  S.cr = clamp(S.cr + (S.crProd - 0.0128 * (gfrNow / 110) * S.cr) * dtMin, 25, 1400);
  /* 透析清除肌酐与尿素（半衰期约 90 min）——原来只清钾不清肌酐 */
  if (S.dialysisUntil > S.t) {
    S.cr = clamp(S.cr * Math.exp(-Math.LN2 / 90 * dtMin), 40, 1400);
    S.bun = clamp(S.bun * Math.exp(-Math.LN2 / 90 * dtMin), 1.5, 160);
  }

  S.bun = clamp(S.bun + (S.cr * 0.045 + 1.2 - S.bun) * 0.004 * dtMin, 1.5, 160);
  S.uo = urineOutput(S, renalPerf);

  /* ---------- 5. 钠与水：渗透压由 Na 质量 / ECF 水决定 ---------- */
  S.na = clamp((S.naMass || 1680) / Math.max(6, S.ecfVd + S.freeWater), 100, 185);
  const naPrev = S._naPrev == null ? S.na : S._naPrev;
  S._naPrev = S.na;
  const dNa = (S.na - naPrev) / dtMin;                     // mmol/L/min
  S.naRate = lerp(S.naRate || 0, dNa, clamp(0.4 * dtMin, 0, 1));
  /* 自由水：模块给的水负荷 − 肾脏排水（SIADH 时 waterClear 被下调） */
  const fwClear = 0.0025 * (S.waterClear == null ? 1 : S.waterClear) * Math.max(0, S.freeWater || 0) * dtMin;
  if (fwClear > 0) {
    const denom = Math.max(6, S.ecfVd + (S.freeWater || 0));
    S.naMass = clamp((S.naMass || 0) * (1 - fwClear / denom), 600, 3200);
  }
  S.freeWater = clamp((S.freeWater || 0)
      + ((S.freeWaterRate || 0) - 0.0025 * (S.waterClear == null ? 1 : S.waterClear) * Math.max(0, S.freeWater)) * dtMin
      - S.uo * dtMin / 1000 * 0.35, -3, 14);
  /* 脑水肿：绝对低渗 + 血钠下降速率（dICP/dt ∝ -dNa/dt） + 严重高血压
     —— 替代原来模块里直接给 S.gcs 设上限的做法 */
  const icpDrive = 0.0018 * Math.max(0, 126 - S.na)         // 绝对低渗 → 水进入脑细胞
                 + 0.0060 * Math.max(0, -dNa * 60) * clamp((135 - S.na) / 8, 0, 1)   // 只有真正低钠时速率才致脑水肿
                 + 0.0040 * Math.max(0, mapNow - 140)       // 高血压脑病：阈值抬到 MAP 160
                 + 0.100 * (S.hematoma || 0)                 // 颅内血肿占位（硬膜外/下血肿）
                 - 0.030 * (S.icp || 0);                     // 脑脊液回吸收
  S.icp = clamp((S.icp || 0) + icpDrive * dtMin, 0, 2.2);
  /* 雌激素升高凝血因子（口服避孕药/激素替代的经典效应）：基线凝血倾向略高 */
  if ((S.estrogen || 0) > 0.5) S.coag = clamp((S.coag || 1) + 0.00004 * ((S.estrogen || 0) - 0.5) * dtMin, 0.15, 1.6);
  trackSodiumCorrection(S);


  /* ---------- 6. 钾 ---------- */
  const kClear = 0.062 * (gfrNow / 110);
  const dialClear = (S.dialysisUntil > S.t) ? 0.20 * Math.max(0, S.k - 3.2) : 0;
  const insShift = (insulinEffect + S.insulinLoad * 0.4) * 0.080 * Math.max(0, S.k - 3.6);
  const acidShift = (S.ph < 7.30 ? (7.30 - S.ph) * 0.06 : -(S.ph - 7.30) * 0.04);
  const kExcrete = kClear * clamp((S.k - 3.7) / 1.3, 0, 2.2);   // 低钾时肾小管重吸收↑，排钾趋近 0
  const dk = (S.kProd - kExcrete - dialClear - insShift) / S.ecfVd
           + acidShift * 0.02;
  S.k = clamp(S.k + dk * dtMin, 1.2, 9.8);

  /* ---------- 7. 血糖 ---------- */
  const insEff = insulinEffect + (S.insulinLoad || 0) + (S.insulinBase || 0) * 0.30;
  /* 基础（胰岛素非依赖）摄取：脑组织每天约耗糖 120 g，折合约 0.10 mmol/min */
  const basalUptake = 0.10;
  const uptake = basalUptake + 0.0248 * S.glu * insEff * (1 + Math.max(0, S.glu - 10) * 0.085);
  const gprBase = S.tags.includes('dka') ? 0.32 : 0.14;
  /* 低血糖时升糖受"胰岛素过多"压制（替代原来模块里硬把 glu 封顶在 2.8） */
  const gpr = S.glu < 3.6
    ? 0.32 * clamp(0.30 + (1 - insEff) * 1.2, 0, 1.7)
    : gprBase;
  S.glu = clamp(S.glu + (gpr - uptake) / 10.8 * dtMin, 0.4, 45);

  /* ---------- 8. 气体交换：肺泡通气方程 + Hill + 分流 ---------- */
  /* 分流来源由各病理模块写入，引擎汇总并封顶 0.35（解剖+真性分流上限） */
  S.shuntSrc.edema = clamp((S.lungWater - 0.25) * 0.45, 0, 0.35);
  S.shuntSrc.ptx = 0.31 * pleuralLoad;   // 塌陷肺仍有部分血流通过
  let shuntSum = 0;
  for (const k in S.shuntSrc) shuntSum += S.shuntSrc[k];
  S.shunt = clamp(shuntSum, 0, 0.35);
  /* 肺水肿本身会抬高死腔（肺泡被水淹）——取模块设定值与肺水推算值的较大者 */
  const vdvtEff = clamp(Math.max(S.vdvt || 0.33, 0.33 + 0.18 * Math.max(0, S.lungWater - 0.25)), 0.33, 0.80);
  S.vdvt = vdvtEff;
  S.vco2 = 200 * (1 + 0.22 * (S.infection || 0)) + 9 * Math.max(0, S.temp - 37);
  const va = Math.max(0.35, S.vt * (1 - 0.40 * pleuralLoad) * (1 - vdvtEff) * S.rr / 1000);   // L/min
  /* PaCO₂ = 0.863 × VCO₂(mL/min) / VA(L/min) —— 肺泡通气方程 */
  const paco2T = clamp(0.863 * S.vco2 / va, 10, 135);
  S.paco2 = lerp(S.paco2, paco2T, clamp(0.5 * dtMin, 0, 1));
  /* 通气肺毛细血管先响应 FiO₂；与分流血按氧含量混合后，再求动脉 PaO₂ 和 SaO₂。 */
  const capillaryTarget = endCapillaryOxygenPressure(S, S.fio2 ?? 0.21, S.paco2);
  S.endCapillaryPo2 = lerp(S.endCapillaryPo2, capillaryTarget, clamp(0.5 * dtMin, 0, 1));
  updateOxygenation(S);

  /* ---------- 9. 呼吸驱动 / 潮气量 ---------- */
  /* 气道阻力 + 胆碱能分泌物 + 肺水（僵硬肺）→ 呼吸做功
     —— 替代旧模块里直接给 rr 设"下限"的写法 */
  const workLoad = clamp((S.airwayResistance || 0) + 0.8 * (S.cholinergic || 0)
                         + 0.5 * Math.max(0, vdvtEff - 0.33)
                         + 0.6 * Math.max(0, S.lungWater - 0.30) + 0.55 * pleuralLoad, 0, 1.6);
  S.workOfBreathing = workLoad;
  if (workLoad > 0.25) S.fatigue = clamp(S.fatigue + (0.005 + 0.020 * workLoad) * dtMin, 0, 1);
  else S.fatigue = Math.max(0, S.fatigue - 0.010 * dtMin);
  const fatigueF = 1 - 0.55 * S.fatigue;
  /* 阿片抑制的是"化学感受器对 CO₂/缺氧的反应"，不是简单平移 RR
     —— 替代原来 mod.rr = -19 的钳制 */
  /* 阿片让化学感受器不再对 CO₂ 反应：用真实血药浓度驱动（_opioidTone 之前空转）
     tone≈2（10 mg）→ depress 0.5 可救；tone≈4.35（30 mg）→ depress 1，呼吸停止 */
  const depress = clamp(Math.max(S.opioidTox ? (S.opioidDepress || 0) : 0, (S._opioidTone || 0) / 4), 0, 1);
  const thyroidDrive = 1 - 0.65 * thyroidDepression;
  const chemo = (clamp((7.40 - S.ph) * 55, 0, 18) + clamp((S.paco2 - 42) * 0.5, 0, 10))
              * (1 - 0.95 * depress) * thyroidDrive;
  const hypoxDrive = clamp((94 - S.spo2) * 0.55, 0, 12) * (1 - 0.80 * depress) * thyroidDrive;
  const rrT = clamp((12 - 8 * depress - 7 * thyroidDepression + (S.mod.rr || 0) + chemo + hypoxDrive + 30 * workLoad
                     + toxRr + envRr + (S.tags.includes('dka') ? 6 : 0)) * fatigueF, 3, 55);
  if (S.vent) {
    /* 呼吸机接管：频率固定 14 次/分，不再有呼吸肌疲劳，氧合由 FiO₂ + PEEP 保证 */
    S.rr = lerp(S.rr, 14, clamp(0.6 * dtMin, 0, 1));
    S.fatigue = 0;
    if (S.spo2 < 92) S.fio2 = Math.min(1, (S.fio2 || 0.21) + 0.02);
  } else if (!inArrest) {
    S.rr = clamp(lerp(S.rr, rrT, clamp(0.35 * dtMin, 0, 1)), 3, 60);
  }
  const vtT = clamp(450 * (1 - 0.38 * (S.airwayResistance || 0)) * (1 - 0.25 * S.fatigue)
                    * (1 - 0.45 * depress)
                    * clamp(1 - 0.012 * Math.max(0, S.rr - 24), 0.6, 1), 150, 800);
  S.vt = lerp(S.vt, vtT, clamp(0.3 * dtMin, 0, 1));
  S.spontaneousRr = inArrest ? 0 : rrT;
  S.spontaneousCO2 = 0.863 * S.vco2 / Math.max(0.35, vtT * (1 - 0.40 * pleuralLoad) * (1 - vdvtEff) * S.spontaneousRr / 1000);
  S.respiratoryAssessmentAt = S.t;
  const onRespiratorySupport = S.vent || S.fio2 > 0.21 || S.o2;
  if (onRespiratorySupport) S.hadOxygenSupport = true;
  if (inArrest || onRespiratorySupport || S.spo2 < 94 || roomAirSaturation(S) < 94) S.roomAirStableSince = null;
  else if (S.roomAirStableSince == null) S.roomAirStableSince = S.t;
  /* 持续的大呼吸（Kussmaul / 代酸代偿）本身会消耗呼吸肌耐力
     —— 替代原来只有"气道阻力高才算做功"的写法 */
  if (S.rr > 32) S.fatigue = clamp(S.fatigue + (S.rr - 32) * 0.0008 * dtMin, 0, 1);

  /* ---------- 10. 心血管：Starling + 后负荷敏感（衰竭心肌） ---------- */
  /* 张力性气胸压迫腔静脉：每 1.0 的张力减少约 2.2 L 有效循环血量 */
  /* 心包填塞：心室舒张受限，同样表现为前负荷塌陷，但机制不同（心包内压） */
  /* 急性心梗：坏死心肌不收缩 → 有效收缩力下降 */
  const preload = clamp((S.vol - 1.7 - 1.1 * (S.tensionPTX || 0) - 1.7 * (S.tamponade || 0)) / 2.7, 0.10, 1.30);
  S.cEff = clamp((S.contractility == null ? 0.92 : S.contractility)
      * (1 - Math.max(0, S.k - 4.6) * 0.045)            // 高钾抑制心肌
      * (1 - 0.35 * Math.max(0, (70 - S.hb) / 70))       // 贫血 → 心肌缺氧
      * (1 - 0.30 * (S.hepatotox || 0))
      * (1 - 0.62 * (S.stemi || 0)), 0.10, 1.15);   // 心梗：坏死心肌不收缩
  /* 衰竭心肌对后负荷敏感：降低后负荷能提高每搏量（肺水肿"扩血管改善 CO"的机制） */
  const failing = clamp((0.85 - (S.contractility == null ? 0.92 : S.contractility)) / 0.45, 0, 1);
  const afterloadF = clamp(1 - 0.025 * failing * Math.max(0, S.svr - 15), 0.30, 1.08);
  /* 右心后负荷（肺血管阻力）→ 左室前负荷下降（替代旧 PE 模块的 svr 上限钳制） */
  const rvF = clamp(1 - 0.075 * Math.max(0, (S.pvr || 1.8) - 2.0), 0.20, 1);
  const fillF = clamp(1 - 0.10 * Math.max(0, S.hr - 105) / 45, 0.80, 1);
  const nativeSv = clamp(72 * preload * S.cEff * afterloadF * rvF * fillF
                         * (1 + (S.mod.sv || 0) / 100), 8, 135);
  if (!inArrest) S.sv = nativeSv;

  /* 代偿储备：长期低灌注耗尽交感代偿（v0.2 已加，保留） */
  if (mapNow < 65) S.compReserve = Math.max(0, (S.compReserve == null ? 1 : S.compReserve) - 0.012 * dtMin);
  else if (mapNow > 74) S.compReserve = Math.min(1, (S.compReserve == null ? 1 : S.compReserve) + 0.012 * dtMin);
  const reserve = (S.compReserve == null ? 1 : S.compReserve);

  const hypovolemic = Math.max(0, (4.2 - S.vol) / 1.6);
  const symp = clamp((85 - mapNow) / 30 + hypovolemic * 0.8 + 0.15, 0, 2.2);
  /* 高钾抑制心肌传导：K>5.5 起心率下降，K>7 可出现窦室传导甚至停搏（原来只有室颤一条路） */
  const kHr = S.k > 5.5 ? -clamp((S.k - 5.5) * 13, 0, 55) : 0;
  /* 高钾心电图：K>5.5 T 波高尖 → K>6.5 QRS 增宽 → K>7.5 正弦波 */
  S.qrsWide = Math.max(S.k > 6.2 ? clamp((S.k - 6.2) / 2.6, 0, 1) : 0, clamp(S.tca || 0, 0, 1));
  S.prLong  = S.k > 6.0 ? clamp((S.k - 6.0) / 3.0, 0, 1) : 0;
  const hrTarget = clamp(78 + symp * 32 + (S.hrDrive || 0) + (S.mod.hr || 0) + toxHr + envHr + wdHr
                         - 55 * (S.cholinergic || 0) + clamp((S.temp - 37) * 8, 0, 26) + kHr - 32 * thyroidDepression
                         - clamp(((S.icp || 0) - 0.60) * 70, 0, 40) + (S.flushHr || 0), 28, 200);   // Cushing：颅压高 → 心率慢
  if (!inArrest) {
    const hrGo = S.paced ? Math.max(hrTarget, 62) : hrTarget;
    S.hr = lerp(S.hr, hrGo, clamp(0.55 * dtMin, 0, 1));
  }

  /* 压力反射：有饱和（最多 1.9 倍），不是可以无限拉回 85 的比例控制器 */
  const baro = Math.min(1.85, Math.pow(85 / Math.max(45, mapNow), 0.42));
  /* 升压药/扩血管药：药物的血管张力效应（S.mod.svr，单位≈SVR）做成乘法增益。
     替代原来 `+ S.eff.norepi * 8` 的加法路径——那条路径只被旧 DRUGS 表赋值，
     物质库给的去甲肾上腺素根本走不到，而且旧实现还有一个 ±10/±15 的上限，
     32 μg/min 与 8 μg/min 撞到同一个天花板，剂量-效应完全平掉。 */
  const vasoNet = (S.mod.svr || 0);
  const pressorGain = clamp(1 + vasoNet / 16, 0.30, 3.6);
  const toneTarget = clamp(17.5 * baro * (0.45 + 0.55 * reserve) * pressorGain
      - (S.infection || 0) * 11.0
      - (S.hepatotox || 0) * 6.0        // 肝衰竭 → 血管扩张（肝肾综合征/低血压）
      + (S.svrDrive || 0)               // 病理模块的血管收缩驱动（替代旧的 svrFloor 直接钳制）
      + 6.0 * (S.cholinergic || 0)      // 胆碱能 → 血管扩张
      + clamp(((S.icp || 0) - 0.60) * 45, 0, 18)   // Cushing：颅压高 → 外周阻力升（封顶，避免 SVR 冲到 50+）
      - 1.6 * ((S.estrogen || 0) - 0.3)             // 雌激素 → NO 介导的血管舒张（SVR 略降）
      + 1.2 * ((S.testosterone || 0) - 0.4)         // 睾酮 → 肌肉量与血管张力略高
      + (tm.svr || 0), 4, 42);
  S.svr = lerp(S.svr, toneTarget, clamp(0.45 * dtMin, 0, 1));

  /* ---------- 11. 出血 / 红细胞质量 ---------- */
  if (S.bleedRate && !S.bleedStopped) {
    /* 失血丢的是"全血"：红细胞质量与容量同比例下降 → Hb 不立刻掉，补液后才稀释
       （替代原来 S.hb -= bleedRate*22*dtMin 的即时贫血） */
    /* 出血受血压调制：MAP 越高出得越快 */
    const lost = S.bleedRate * pressF * dtMin / Math.min(2.5, Math.max(0.15, S.coag || 1));  // L
    const conc = S.rbcMass / Math.max(0.5, S.vol);        // g/L
    S.rbcMass = Math.max(20, S.rbcMass - lost * conc);
    S.vol = clamp(S.vol - lost, 1.5, 7.8);
    S.freeWater = clamp((S.freeWater || 0) - lost * 0.85, -3, 14);
    S.naMass = clamp((S.naMass || 0) - lost * 140 * 0.85, 600, 3200);
  }
  /* Hb 是导出量 */
  S.hb = clamp(S.rbcMass / Math.max(0.5, S.vol), 15, 210);

  /* ---------- 12. 阿片中毒：由 opioidDepress 驱动（见第 1 节的呼吸驱动），
     这里不再直接钳制 mod.rr / mod.gcs ---------- */

  /* —— 性别 / 年龄的内分泌背景 ——
     只做"有依据的方向"，幅度刻意保守：
       · 绝经前女性雌激素高 → 一氧化氮介导的血管舒张（SVR 略低）、凝血倾向略高
       · 男性睾酮维持肌肉量与血红蛋白（Hb 目标略高）
       · 年龄增长 → 免疫清除能力下降、肾功能与动脉顺应性变差
     这些值每拍按年龄/性别重算，不写进 init，避免被病例的 init 覆盖后失衡。 */
  {
    const pt = S.patient || {};
    const isF = pt.sex === '女';
    const age = pt.age != null ? pt.age : 50;
    const meno = isF && age >= 52;                       // 绝经
    /* 月经周期：育龄女性 28 天一周期（游戏时间推进），雌激素随相位起伏、排卵后基础体温升高 */
    let cycle = 0;
    S.cycleLuteal = 0;
    if (isF && age >= 12 && !meno) {
      S.cycleDay = ((S.cycleDay ?? 14) + dtMin / 1440) % 28;
      const d = S.cycleDay;
      cycle = d < 13 ? 0.15 : (d < 15 ? 0.35 : (d < 23 ? 0.10 : -0.05));   // 排卵前后一个小峰
      S.cycleLuteal = Number(d >= 15);
    }
    const baseE = isF ? (meno ? 0.15 + Math.max(0, (age - 75) * 0.002) : 0.55 - Math.max(0, age - 30) * 0.008)
                      : 0.12;
    /* 外源性激素（药物）：12 小时半衰期 */
    if (S.estrogenExo) S.estrogenExo *= Math.exp(-Math.LN2 / (12 * 60) * dtMin);
    if (S.testosteroneExo) S.testosteroneExo *= Math.exp(-Math.LN2 / (12 * 60) * dtMin);
    S.estrogen = clamp((isF ? baseE + cycle * 0.6 : baseE) + (S.estrogenExo || 0), 0, 1.8);
    const baseT = isF ? 0.10 : Math.max(0.25, 0.85 - Math.max(0, age - 40) * 0.010);
    S.testosterone = clamp(baseT + (S.testosteroneExo || 0), 0, 1.8);
    /* 免疫清除力：女性略强、高龄明显弱 */
    S.immunity = clamp(1 + (isF ? 0.06 : 0) - Math.max(0, age - 45) * 0.006, 0.55, 1.15);
    /* 更年期潮热：阵发性血管舒缩症状（~90 分钟一个周期），表现为短暂体温与心率上升 */
    if (isF && meno) {
      S.flush = 0.5 + 0.5 * Math.sin(S.t / 900 + (S._flushPhase || 0));
      /* 潮热是"阵发"的：用独立字段"设置"而不是累加，否则每拍叠加会让体温无限上升 */
      S.flushDrive = S.flush > 0.78 ? 0.055 : 0;
      S.flushHr = S.flush > 0.78 ? 3.5 : 0;
    } else { S.flush = 0; S.flushDrive = 0; S.flushHr = 0; }
  }

  /* ---------- 13. 感染 / 体温 ---------- */
  if (S.infection > 0) {
  
  S.infection = clamp(S.infection + (S.infection > 0.2 ? 0.0030 : -0.004) * dtMin
                       * (S.infection > 0.2 ? (2 - (S.immunity || 1)) : 1), 0, 1);
  }
  /* D-二聚体：凝血激活 / 感染 / 组织损伤（手术、止血后）都会升高 */
  {
    const target = 0.3
      + Math.max(0, (S.coag || 1) - 1.02) * 60
      + (S.infection || 0) * 3.5
      + (S.bleedStopped ? 1.2 : 0)
      + (S.delivered ? 0.8 : 0)
      + (S.vent ? 0.5 : 0);
    S.ddimer = (S.ddimer == null ? 0.3 : S.ddimer) + (target - (S.ddimer == null ? 0.3 : S.ddimer)) * clamp(0.02 * dtMin, 0, 1);
    S.ddimer = clamp(S.ddimer, 0.1, 20);
  }

  const fever = Math.max(0, (S.infection || 0) * 3 - feverReduction);
  const seizureHeat = (S.seizure || 0) > 0.2 ? clamp(S.seizure * 0.55, 0, 0.95) : 0;
  const heatDrive = (S.tempDrive || 0) + (S.heatstrokeDrive || 0) + (S.thyroidHeatDrive || 0) + seizureHeat;
  let tempT = 36.6 + fever + 4.6 * (heatDrive + (S.flushDrive || 0)) + 0.25 * (S.cycleLuteal || 0)
      + envTemp + (S.mod.temp || 0) - 2.5 * thyroidDepression;
  if (env.warming) {
    tempT += (env.cold ? 1 : 0) + clamp(36.6 - tempT, 0, 0.8);
  }
  if (env.cooling && S.temp > COOLING_TARGET) tempT -= 3;
  const prevTemp = S.temp;
  S.temp = lerp(S.temp, tempT, 1 - Math.exp(-0.05 * dtMin));
  if (env.cooling && S.temp <= COOLING_TARGET) {
    if (prevTemp > COOLING_TARGET) S.temp = COOLING_TARGET;
    env.cooling = 0;
    if (S.heatstrokeDrive > 0) S.heatstrokeCooled = true;
    S.log.push([fmt(S.t), '已达降温目标，停止物理降温', 'info']);
  }
  if (env.warming && S.temp >= WARMING_TARGET) {
    env.warming = 0;
    S.log.push([fmt(S.t), '体温回到参考范围，停止被动保暖', 'info']);
  }

  /* 肝毒性：凝血、乳酸、脑病、肾、血管张力（替代原来模块里直接写 coag/cr/bun） */
  if (S.hepatotox > 0) {
    S.coag = Math.min(S.coag == null ? 1 : S.coag, 1 - 0.78 * S.hepatotox);
    S.lactProd = Math.max(S.lactProd || 0.015, 0.015 + 0.20 * S.hepatotox);
  }

  /* ---------- 14. 氧输送 DO₂：贫血 / 低氧 / 休克 的统一死亡通路 ---------- */
  updateCirculation(S);
  /* 自然半衰期约 4–5 h；吸高浓度氧可缩短到 ~1 h */
  if ((S.coHb || 0) > 0) {
    const kCo = ((S.fio2 || 0.21) > 0.9) ? Math.LN2 / 45 : Math.LN2 / 360;   // 室气 6 h / 纯氧 90 min
    S.coHb = Math.max(0, S.coHb * Math.exp(-kCo * dtMin));
  }
  S.vo2 = 250 * (1 + 0.20 * (S.infection || 0)) + 12 * Math.max(0, S.temp - 37)
        + (env.exercise ? 150 : 0);
  S.do2Crit = 300 * (S.vo2 / 250);
  const o2debt = clamp(1 - S.do2 / Math.max(120, S.do2Crit), 0, 1.8);

  /* ---------- 15. 酸碱：乳酸 → HCO₃ 微分方程（替代 hco3Base 每拍覆盖） ---------- */
  const lacProd = (S.lactProd || 0.015) + 0.30 * o2debt + 0.10 * (S.infection || 0)
                + 0.06 * (S.hepatotox || 0);
  S.lac = clamp(S.lac + (lacProd - 0.02 * S.lac) * dtMin, 0.3, 25);
  const ketone = (S.ketoneProd || 0) * (1 - clamp((insulinEffect + S.insulinLoad * 0.5), 0, 1) * 0.90);
  /* 胰岛素充足时酮体被外周组织氧化，等量 HCO₃ 再生
     （β-羟丁酸是"潜在碳酸氢盐"）——替代原来"补碱之外没有任何回收途径"的写法 */
  const ketoRecover = 0.060 * clamp(insEff - 0.6, 0, 1.6);
  const hco3Gen = clamp(0.004 * (24 - S.hco3) / 8 + 0.004, 0.0015, 0.020)
                * clamp(gfrNow / 110, 0.12, 1.1)
                + (S.dialysisUntil > S.t ? 0.05 : 0)
                + ketoRecover
                + (S.hco3Boost || 0);
  const hco3Cons = 0.004
                 + 0.0022 * Math.max(0, S.lac - 1.2)
                 + 0.10 * ketone
                 + 0.004 * (S.hepatotox || 0);
  S.hco3 = clamp(S.hco3 + (hco3Gen - hco3Cons) * dtMin, 1, 40);
  S.ph = computePh(S);

  /* ---------- 16. 意识 ---------- */
  if (!inArrest) S.gcs = clamp(Math.round(15 + (S.mod.gcs || 0) + toxGcs + wdGcs
      - 3 * thyroidDepression
      - 6 * depress                                     // 阿片对意识的影响（替代 mod.gcs=-6 的钳制）
      - clamp((S.paco2 - 50) * 0.25, 0, 8)              // CO₂ 麻醉
      - clamp((7.00 - S.ph) * 90, 0, 10)
      - clamp((60 - S.map) / 3, 0, 8)
      - clamp((3.4 - S.glu) * 3.5, 0, 9)
      - clamp(((S.glu || 0) - 25) * 0.45, 0, 6)
      - clamp(((S.coHb || 0) - 0.15) * 9, 0, 5)
      - clamp(((S.icp || 0) - 0.50) * 11, 0, 9)
      - clamp((S.seizure || 0) * 9, 0, 8)   // 抽搐发作时意识下降
      - clamp((S.tca || 0) * 7, 0, 6)       // 三环类：抗胆碱能 + 中枢抑制
      - clamp((S.icp || 0) * 9, 0, 10)
      - clamp(((S.hepatotox || 0) - 0.45) * 14, 0, 8)
      - clamp((S.temp - 40) * 4, 0, 6)
      - (S.hco3 < 10 ? 2 : 0)), 3, 15);
  if (S.odsDamage) S.gcs = Math.min(S.gcs, 8);

  /* ---------- 17. 心律 ---------- */
  evaluateRhythm(S, dtMin);
  if (inAsystole) evaluateAsystole(S, dtMin, nativeSv, arrestEpinephrine);
  /* 所有致心律失常的来源都在累积损伤前同步为骤停状态。 */
  if (S.rhythm === 'sinus' && (S._vfRisk || 0) > 1.15) triggerVf(S);

  /* ---------- 18. 累积损伤（剂量×时间积分，替代"某指标超阈值 N 分钟"计时器） ---------- */
  const ins = S.insult;
  if (ins.hyperosmol == null) ins.hyperosmol = 0;
  if (S.co > 0) ins.hypox += Math.max(0, 0.85 - S.sao2) * dtMin;
  ins.dysoxia      += Math.max(0, 1 - S.do2 / Math.max(120, S.do2Crit)) * dtMin;
  ins.acid         += Math.max(0, 6.98 - S.ph) * dtMin;
  /* 高碳酸血症从 60 mmHg 起算（原来只在 85 以上才算，阿片中毒永远等不到） */
  ins.hypercapnia  += clamp((S.paco2 - 60) / 30, 0, 2) * dtMin;
  ins.shock        += S.rhythm === 'sinus' ? clamp((68 - S.map) / 12, 0, 2.5) * dtMin : 0;
  ins.hyperthermia += Math.max(0, S.temp - 40.2) * dtMin;
  ins.hypogly      += Math.max(0, 2.2 - S.glu) * dtMin;
  ins.dysoxia      += Math.pow(S.coHb || 0, 2) * 1.2 * dtMin;   // CO 中毒：按碳氧血红蛋白平方累积（累积暴露）
  ins.icp          += Math.max(0, (S.icp || 0) - 0.55) * dtMin;
  ins.hyperosmol   += ((S.glu || 0) > 35 && (S.gcs || 15) <= 9) ? dtMin * 0.5 : 0;   // 高渗性昏迷
  ins.coma = 0; /* 昏迷不是死亡判据，只用作出院/插管指征 */

  /* 暴发性肝衰竭：肝损到顶 + 凝血崩溃，即使血压还撑得住也会死 */
  if ((S.hepatotox || 0) >= 0.95 && (S.coag || 1) < 0.35) S._liverMin = (S._liverMin || 0) + dtMin;
  else S._liverMin = 0;
  if (!S.death && S._liverMin > 30) endCase(S, 'death', '暴发性肝衰竭');

  if (!S.death) {
    if (S.rhythm === 'asystole' && S.asystoleInsult > 4) endCase(S, 'death', '心脏停搏，复苏失败');
    else if (S.rhythm === 'sinus' && S.map < 30 && S.t > 60) endCase(S, 'death', '循环衰竭');
    else if (ins.shock > 30) {
      /* 同样的"持续低灌注"，按病因给出死因，便于教学复盘 */
      const why = (S.hepatotox || 0) > 0.6 ? '暴发性肝衰竭（循环衰竭）'
                : (S.infection || 0) > 0.5 ? '感染性休克失代偿'
                : (S.bleedRate && !S.bleedStopped) ? '失血性休克失代偿'
                : S.vol < 3.2 ? '低血容量性休克失代偿'
                : '休克失代偿（持续低灌注）';
      endCase(S, 'death', why);
    }
    else if (S.rhythm !== 'sinus' && ins.dysoxia > 12) endCase(S, 'death', '恶性心律失常／心脏骤停');
    else if (ins.dysoxia > 25) endCase(S, 'death', '组织缺氧（DO₂ 持续低于临界值）');
    else if (ins.hypox > 8) endCase(S, 'death', '严重低氧血症');
    else if (ins.acid > 3) endCase(S, 'death', '重度酸中毒');
    else if (ins.hypercapnia > 25) endCase(S, 'death', '二氧化碳蓄积／呼吸衰竭');
    else if (ins.hyperthermia > 18) endCase(S, 'death', '超高热（体温失控）');
    else if (ins.hypogly > 20) endCase(S, 'death', '低血糖脑病');
    else if (ins.icp > 22) endCase(S, 'death', '脑水肿／脑疝');
    else if (ins.hyperosmol > 25) endCase(S, 'death', '高渗性昏迷');

  }

  finishDelivery(S);
  trackCirculationObservation(S);

  /* ---------- 19. 历史 ---------- */
  if (!S._lastHist || S.t - S._lastHist >= 10) {
    S._lastHist = S.t;
    S.history.push({ t: S.t, hr: Math.round(S.hr), sys: bp(S).sys, dia: bp(S).dia, k: r1(S.k),
                     ph: r2(S.ph), spo2: pulseOximetry(S), na: Math.round(S.na),
                     temp: Number.isFinite(S.temp) ? r1(S.temp) : null,
                     do2: Math.round(S.do2), lw: r2(S.lungWater), rr: Math.round(S.rr),
                     hco3: r1(S.hco3), paco2: Math.round(S.paco2), glu: r1(S.glu),
                     map: Math.round(S.map), vol: r2(S.vol), do2c: Math.round(S.do2Crit),
                     ins: r2(S.insult.hypox + S.insult.dysoxia + S.insult.acid + S.insult.hypercapnia
                             + S.insult.shock + S.insult.hyperthermia + S.insult.hypogly
                             + S.insult.icp + S.insult.coma) });
    if (S.history.length > 720) S.history.shift();
  if (S.log.length > 600) S.log.splice(1, S.log.length - 600);
  }
  return S;
}

function cardiacOutput(S) {
  if (S.rhythm === 'sinus') return S.hr * S.sv / 1000;
  return 1.8 * clamp((S.mapBoost || 0) / 25, 0, 1);
}

function computeMap(S) {
  const co = cardiacOutput(S);
  const map = co * S.svr + (S.rhythm === 'sinus' ? S.cvp : 0);
  return clamp(map, 0, 220);
}

function updateCirculation(S) {
  S.co = cardiacOutput(S);
  S.map = Math.round(computeMap(S));
  S.do2 = S.co * oxygenContent(S.pao2, oxygenCapacity(S));
}

function applyArrestPhysiology(S) {
  if (S.sv > 0) S.preArrestSv = S.sv;
  if (S.rhythm === 'asystole' && S.asystoleAt == null) S.asystoleAt = S.t;
  S.hr = 0;
  S.sv = 0;
  S.gcs = 3;
  S.spontaneousRr = 0;
  S.roomAirStableSince = null;
  if (S.hadCirculatorySupport) S.circulationStableSince = null;
  if (!S.vent) S.rr = 0;
  updateCirculation(S);
}

function restoreSinusRhythm(S, sv) {
  S.rhythm = 'sinus';
  S.hr = 96;
  S.sv = sv;
  S._vfRisk = 0;
  S.mapBoost = 0;
  updateCirculation(S);
}

function evaluateAsystole(S, dtMin, nativeSv, epinephrine) {
  /* 游戏复苏模型：按压延缓损伤，充分氧输送和静推肾上腺素生效后，
     可逆因素缓解才能恢复自主循环。阈值与时间尺度属于模拟规则。 */
  const supported = S.co >= 0.8 && S.do2 >= 0.30 * S.do2Crit;
  const prior = S.asystoleInsult ?? Math.max(0, (S.t - S.asystoleAt) / 60 - dtMin);
  S.asystoleInsult = prior + dtMin * (supported ? 0.25 : 1);
  const potassiumStable = S.k >= 2.6 && (S.k <= 7.4 || S.t < S.caProtectUntil);
  const reversibleFactorsControlled = potassiumStable && nativeSv >= 20 && S.sao2 >= 0.85
      && S.ph >= 6.9 && S.temp >= 32 && (S.tensionPTX || 0) <= 0.20
      && (S.tamponade || 0) <= 0.25 && (S.tca || 0) <= 0.45;
  const adequate = supported && epinephrine >= 0.25 && reversibleFactorsControlled;
  S.roscMin = adequate ? (S.roscMin || 0) + dtMin : 0;
  if (S.asystoleInsult <= 4 && S.roscMin >= 0.5) {
    restoreSinusRhythm(S, nativeSv);
    note(S, 'rosc', '复苏后恢复自主循环', 'good');
  }
}

function restoreCardiorespiratory(S, saved) {
  const oldOxygenModel = !Number.isFinite(saved.endCapillaryPo2) && Number.isFinite(saved.pao2);
  if (oldOxygenModel) {
    /* 旧档的 pao2 实际保存的是分流前的值。保留过去已出具的检验报告。 */
    S.endCapillaryPo2 = saved.pao2;
    updateOxygenation(S, Number.isFinite(saved.svo2) ? saved.svo2 : null);
    if (roomAirSaturation(S) < 94) S.roomAirStableSince = null;
  }
  if (S.rhythm !== 'sinus') applyArrestPhysiology(S);
  else if (oldOxygenModel) updateCirculation(S);
  if (S.tags.includes('ptx') && saved.chestTubePlaced == null &&
      S.log.some(([, text]) => text === '胸腔闭式引流完成 → 气胸解除')) {
    S.chestTubePlaced = true;
    S.tensionPTX = 0;
  }
  if (S.tags.includes('myxedema') && saved.myxedemaSeverity == null) {
    S.myxedemaSeverity = 1;
    if (S.tempDrive < 0) S.tempDrive = 0;
    /* 独立甲减旧存档的完整血氧趋势从未低于阈值时，低氧负荷来自旧体温计数。 */
    if (S.tags.length === 1 && S.sao2 >= 0.85 && S.history[0]?.t <= 30 &&
        S.history.every(point => point.spo2 >= 85.5)) S.insult.hypox = 0;
  }
}

function pulseOximetry(S) {
  return S.rhythm === 'sinus' ? Math.round(S.spo2) : null;
}

function bp(S) {
  const map = computeMap(S);
  if (S.rhythm !== 'sinus') {
    const pressure = Math.round(map);
    return { sys: pressure, dia: pressure, map: pressure };
  }
  const pp = clamp(34 * (S.sv / 70) * (17 / Math.max(8, S.svr)), 15, 62);
  return { sys: Math.round(map + pp * 2 / 3), dia: Math.round(map - pp / 3), map: Math.round(map) };
}

function evaluateRhythm(S, dtMin) {
  const unprotected = S.t > S.caProtectUntil;
  if (S.rhythm === 'sinus') {
    if (S.k > 7.4 && unprotected) {
      /* QRS 增宽会放大致心律失常风险（原来只看血钾绝对值） */
      S._vfRisk = (S._vfRisk || 0) + dtMin * (S.k - 7.35) * 2.2 * (1 + (S.qrsWide || 0) * 2);

      if (S._vfRisk > 1.15) triggerVf(S);
    } else if (S.k > 7.4) {
      note(S, 'ca-protect', '钙剂保护中：血钾 ' + r1(S.k) + '，暂未发生恶性心律失常');
    }
    if ((S.stemi || 0) > 0.6 && S.t < 3600) S._vfRisk = (S._vfRisk || 0) + dtMin * (S.stemi - 0.6) * 0.08;   // 心梗急性期致心律失常
    if ((S.tca || 0) > 0.45) S._vfRisk = (S._vfRisk || 0) + dtMin * (S.tca - 0.45) * 4.0;   // 三环类：QRS 增宽 → 室性心律失常
    /* 低钾 / 严重缺氧 / 心肌缺血 → 室性心律失常
       （替代原来只看 "MAP<45 且 Hb<45" 的单一条件） */
    let arrRisk = 0;
    if (S.k < 2.6) arrRisk += (2.6 - S.k) * 0.55;
    if (S.do2 > 0 && S.do2 < 240) arrRisk += (240 - S.do2) / 240 * 0.55;
    if (arrRisk > 0) {
      S._vfRisk = (S._vfRisk || 0) + dtMin * arrRisk * 0.5;
      if (S._vfRisk > 1.15) triggerVf(S);
    }
  } else if (S.rhythm === 'vf') {
    S._vfMin = S._vfMin || 0; S._vfMin += dtMin;
    if (S._vfMin > 3.5) {
      S.rhythm = 'asystole'; S.asystoleAt = S.t;
      S.asystoleInsult = 0; S.roscMin = 0;
      note(S, 'asystole', '室颤退化为心静止', 'bad');
    }
  }
}

function triggerVf(S) {
  if (S.rhythm === 'vf') return;
  S.rhythm = 'vf'; S._vfMin = 0; S._vfRisk = 0; S.arrests = (S.arrests || 0) + 1;
  S.mapBoost = 0;
  applyArrestPhysiology(S);
  note(S, 'vf', '室颤！立即除颤', 'crit');
  S.score -= 20;
}

function note(S, id, msg, lvl) {
  if (S.events.some(e => e.id === id && S.t - e.t < 600)) return;
  S.events.push({ id, t: S.t, msg, lvl: lvl || 'info' });
  S.log.push([fmt(S.t), msg, lvl === 'crit' ? 'bad' : lvl === 'bad' ? 'bad' : 'warn']);
}

function endCase(S, type, reason) {
  if (S.death || S.discharged) return;
  S.running = false;
  if (type === 'death') { S.death = { t: S.t, reason }; S.log.push([fmt(S.t), '患者死亡：' + reason, 'bad']); }
  else { S.discharged = true; S.log.push([fmt(S.t), '患者出院', 'good']); }
}

/* --- 通用出院判据与病例专属判据 --- */
function observationTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (!minutes) return `${remainder} 秒`;
  return remainder ? `${minutes} 分钟 ${remainder} 秒` : `${minutes} 分钟`;
}

function assessCirculationObservation(S, pressure) {
  if (!S.hadCirculatorySupport) return null;
  const { running, timed } = activeCirculationSupport(S);
  const minutes = CIRCULATION_OBSERVATION / 60;
  if (running.length) {
    const names = running.map(id => root.SUBSTANCES?.byId(id)?.n || id).join('、');
    return { phase: 'active', remainingSeconds: null,
      reason: `仍在持续静脉泵入${names}，停泵后需观察循环稳定至少 ${minutes} 分钟` };
  }
  if (timed.length) {
    const names = [...new Set(timed.map(p => p.n || p.id))].join('、');
    const remainingSeconds = Math.ceil(Math.max(...timed.map(timedSupportEndsAt)) - S.t);
    return { phase: 'legacy', remainingSeconds,
      reason: `${names}仍在起效，预计 ${observationTime(remainingSeconds)}后药效消退，再观察循环稳定 ${minutes} 分钟` };
  }
  if (!circulationStable(S, pressure)) {
    return { phase: 'unstable', remainingSeconds: CIRCULATION_OBSERVATION,
      reason: `撤除循环支持后，需窦性心律、收缩压 ≥${CIRCULATION_MIN_SYSTOLIC} mmHg 且平均动脉压 ≥${CIRCULATION_MIN_MAP} mmHg。当前 ${pressure.sys}/${pressure.dia} mmHg，平均动脉压 ${pressure.map} mmHg，达标后重新观察 ${minutes} 分钟` };
  }
  // 0.2 秒的模拟步长可能在观察窗口的边界留下舍入误差。
  const elapsed = Math.max(0, S.t - (S.circulationStableSince ?? S.t));
  const remainingSeconds = Math.max(0, Math.ceil(CIRCULATION_OBSERVATION - elapsed - 1e-7));
  if (!remainingSeconds) return { phase: 'complete', remainingSeconds };
  return { phase: 'observing', remainingSeconds,
    reason: `撤除循环支持后需连续稳定 ${minutes} 分钟，观察还需 ${observationTime(remainingSeconds)}` };
}

function dischargeCheck(S) {
  const b = bp(S);
  const bad = [];
  const tags = S.tags ?? [];
  const opioid = S.opioidTox || tags.includes('opioid');
  const lowSodium = tags.includes('hypona');
  const hyperosmolar = tags.includes('hhs');
  const observationDeadlines = S.cas?.observations?.(S).map(window => window.endsAt) ?? [];
  if (S.rhythm !== 'sinus') bad.push('心律异常');
  if (b.sys < CIRCULATION_MIN_SYSTOLIC) bad.push(`收缩压 ${b.sys}`);
  const minHr = S.cas?.minDischargeHR ?? 50;
  const heartRateTarget = `${minHr}–119 次/分`;
  const hr = Math.round(S.hr);
  if (!Number.isFinite(S.hr)) bad.push('需复测心率');
  else if (hr < minHr || hr >= 120) bad.push(`心率 ${hr} 次/分，出院目标 ${heartRateTarget}`);
  if (!Number.isFinite(S.spo2) || S.rhythm !== 'sinus') bad.push('需确认室内空气下 SpO₂ ≥94%');
  else if (S.spo2 < 94) bad.push(`SpO₂ ${S.spo2.toFixed(1)}%，出院目标为室内空气下 ≥94%`);
  if (S.vent) bad.push('仍需机械通气');
  else if (S.fio2 > 0.21 || S.o2) bad.push('仍在吸氧，需评估室内空气血氧');
  else if (S.hadOxygenSupport && (S.roomAirStableSince == null || S.t - S.roomAirStableSince < ROOM_AIR_OBSERVATION)) {
    bad.push('撤除呼吸支持后，室内空气血氧需稳定至少 5 分钟');
    if (S.roomAirStableSince != null) observationDeadlines.push(S.roomAirStableSince + ROOM_AIR_OBSERVATION);
  }
  const circulationObservation = assessCirculationObservation(S, b);
  if (circulationObservation?.reason) bad.push(circulationObservation.reason);
  if (circulationObservation?.phase === 'observing') {
    observationDeadlines.push((S.circulationStableSince ?? S.t) + CIRCULATION_OBSERVATION);
  }
  const minRespirations = tags.includes('opioid') ? 12 : 10;
  if (S.rr < minRespirations || S.rr > 22) bad.push(`呼吸 ${Math.round(S.rr)} 次/分，出院目标 ${minRespirations}–22 次/分`);
  if (!Number.isFinite(S.temp)) bad.push('需复测体温');
  else if (S.temp < 36 || S.temp > 37.8) bad.push(`体温 ${S.temp.toFixed(1)}℃`);
  if (S.odsDamage) bad.push('渗透性脱髓鞘');
  const originalSodiumExceeded = S.na0 < 130 && S.t <= DAY && S.na - S.na0 > 10;
  if (originalSodiumExceeded || (S.naOvercorrectedAt != null && S.t - S.naOvercorrectedAt < SODIUM_RISK_OBSERVATION)) {
    bad.push('近期血钠纠正过快，需继续观察神经症状');
    if (S.naOvercorrectedAt != null && S.t - S.naOvercorrectedAt < SODIUM_RISK_OBSERVATION) {
      observationDeadlines.push(S.naOvercorrectedAt + SODIUM_RISK_OBSERVATION);
    }
  }
  if ((S.naCorrection || S.na0 < 130) && S.pk?.some(p => p.eff?.na > 0 && S.t - p.t < 30 * 60)) {
    bad.push('最近补钠仍在起效，需复查血钠');
  }
  const minSodium = lowSodium ? 130 : 120;
  if (S.na < minSodium || ((lowSodium || hyperosmolar) && S.na > 145)) {
    const target = lowSodium || hyperosmolar ? `${minSodium}–145` : `≥${minSodium}`;
    bad.push(`血钠 ${S.na.toFixed(1)} mmol/L，出院目标 ${target} mmol/L`);
  }
  if (S.hco3 < 14) bad.push(`HCO₃ ${S.hco3.toFixed(1)}`);
  if (S.ph < 7.28) bad.push(`pH ${S.ph.toFixed(2)}`);
  const potassium = Number.isFinite(S.k) ? r1(S.k) : null;
  if (potassium == null) bad.push(`血钾需复测，出院目标 ${potassiumTarget}`);
  else if (potassium < DISCHARGE_K_MIN || potassium > DISCHARGE_K_MAX) {
    bad.push(`血钾 ${potassium.toFixed(1)} mmol/L，出院目标 ${potassiumTarget}`);
  }
  const hasDka = S.caseId === 'dka' || S.tags?.includes('dka');
  const glucoseTarget = glucoseDischargeTarget(hasDka, true);
  const glucose = Number.isFinite(S.glu) ? r1(S.glu) : null;  /* 与监护快照的血糖精度一致。 */
  if (glucose == null) bad.push(`血糖需复测，出院目标 ${glucoseTarget}`);
  else if (glucose < DISCHARGE_GLUCOSE_MIN ||
           (hasDka ? glucose >= DKA_DISCHARGE_GLUCOSE_MAX_EXCLUSIVE : glucose > DISCHARGE_GLUCOSE_MAX)) {
    bad.push(`血糖 ${glucose.toFixed(1)} mmol/L，出院目标 ${glucoseTarget}`);
  }
  const needsFullConsciousness = opioid || lowSodium || hyperosmolar;
  if (S.gcs < (needsFullConsciousness ? 15 : 13)) {
    const target = needsFullConsciousness ? '15 分（本病例要求意识完全恢复）' : '≥13 分';
    bad.push(`意识 GCS ${S.gcs} 分，出院目标 ${target}`);
  }
  if ((lowSodium || tags.includes('seizure')) && convulsionSigns(S)) bad.push('仍有抽搐，可在「脑」面板复查');
  if (opioid) {
    const lastNaloxone = S.lastNaloxoneAt ?? (S.naloxoneUntil > 0 ? S.naloxoneUntil - 45 * 60 : -Infinity);
    const observationEnds = Math.max((Math.max(S.lastOpioidAt || 0, 0)) + 6 * 3600, lastNaloxone + 4 * 3600);
    if (S.t < observationEnds) {
      bad.push(`阿片中毒观察还需 ${Math.ceil((observationEnds - S.t) / 60)} 分钟`);
      observationDeadlines.push(observationEnds);
    }
    if (S.paco2 > 50) bad.push(`二氧化碳分压 ${Math.round(S.paco2)} mmHg`);
  }
  if (S.cas && S.cas.extra) for (const r of S.cas.extra(S)) bad.push(r);
  const observationEndsAt = observationDeadlines.length ? Math.min(...observationDeadlines) : null;
  return { ok: bad.length === 0, reasons: [...new Set(bad)], heartRateTarget, circulationObservation, observationEndsAt };
}

function convulsionSigns(S) {
  const activity = S.seizure || 0;
  const visibleThreshold = S.tags?.includes('hypona') ? 0.1 : 0.15;
  if (activity >= 0.6) return S.tags?.includes('seizure') ? '持续肢体抽搐，伴牙关紧闭' : '持续肢体抽搐';
  return activity > visibleThreshold ? '间断可见肢体抽动' : null;
}

/* --- 主动听诊、开检验 --- */
function auscultate(S) {
  const sounds = [];
  const cholinergic = (1 - (S.acheActivity ?? 1)) * (1 - (S.muscarinicBlock ?? 0));
  const airway = S.airwayResistance || 0;
  const inhalationInjury = S.tags?.includes('burn');
  if (S.lungWater >= 0.65) sounds.push('多肺区较多湿啰音');
  else if (S.lungWater >= 0.32) sounds.push('肺底少量湿啰音');
  if (cholinergic >= 0.25) sounds.push('痰鸣音');
  if ((!inhalationInjury || S.tags?.includes('asthma')) && airway >= 0.30) {
    sounds.push(airway >= 0.65 ? '广泛哮鸣音' : '散在哮鸣音');
  }
  const breathSound = (S.rr < 8 || (!S.vent && inhalationInjury && airway >= 0.55)) ? '呼吸音减弱' : '呼吸音可闻';
  const bilateral = sounds.length ? `${breathSound}，伴${sounds.join('、')}` : breathSound;
  /* 现有气胸病例设定为左侧，减压后残余气胸仍可使该侧呼吸音减弱。 */
  const left = S.tensionPTX >= 0.65 ? '呼吸音消失' : S.tensionPTX > 0 ? '呼吸音减弱' : bilateral;
  const result = { t: S.t, left, right: bilateral };
  S.lungExam = { latest: result, previous: S.lungExam?.latest ?? null };
  S.log.push([fmt(S.t), `双肺听诊 · 左肺${left}；右肺${bilateral}`, 'info']);
  return result;
}

function isSerialBloodTest(id) {
  return id === 'cbc' || id === 'abg';
}

const CXR_RECEIPT = `${TESTS.cxr.name} 结果已出`;
const CXR_UNRECORDED = '旧版存档未保留本次影像所见。';

function lungWaterFindings(lungWater) {
  if (!Number.isFinite(lungWater)) return '肺水肿征象未记录。';
  if (lungWater >= 0.65) return '双肺门周围可见较广泛的片状模糊影，符合肺水肿表现。';
  if (lungWater >= 0.32) return '双肺间质纹理增多，符合轻度肺淤血或间质性水肿表现。';
  return '双肺未见明显肺水肿征象。';
}

function chestXrayFindings(S) {
  let pleuralFindings = '未见胸腔积气。';
  /* 模拟中的气胸发生在左侧，针刺减压后可残留积气。 */
  if (!Number.isFinite(S.tensionPTX)) pleuralFindings = '胸腔积气征象未记录。';
  else if (S.tensionPTX >= 0.65) pleuralFindings = '左侧胸腔积气，左肺明显受压。';
  else if (S.tensionPTX >= 0.20) pleuralFindings = '左侧胸腔积气，左肺部分受压。';
  else if (S.tensionPTX > 0) pleuralFindings = '左侧少量胸腔积气。';
  return lungWaterFindings(S.lungWater) + pleuralFindings;
}

function chestXrayReports(S) {
  return S.xrayReports?.slice() ?? [];
}

function restoreChestXrayReports(S) {
  const reports = S.xrayReports ??= [];
  for (const report of reports) Object.freeze(report);
  if (S.tests?.cxr?.sample) Object.freeze(S.tests.cxr.sample);
  if (reports.length) return;

  /* 旧版只保存最后一份胸片回报时的生理快照，缺少采集时间和气胸指标。 */
  const legacy = S.labSnap?.cxr;
  const reportedAt = Number.isFinite(legacy?.t) ? legacy.t : null;
  const legacyFindings = Number.isFinite(legacy?.s?.lungWater)
    ? '根据旧版回报时保存的肺水数据，' + lungWaterFindings(legacy.s.lungWater) + '旧版快照未记录胸腔积气征象。'
    : CXR_UNRECORDED;
  const receipts = S.log.filter(row => row[1] === CXR_RECEIPT && !row[4]);
  let matching = [];
  if (reportedAt != null) {
    matching = receipts.filter(row => row[3] === reportedAt);
    if (!matching.length) matching = receipts.filter(row => row[3] == null && row[0] === fmt(reportedAt));
  }
  const legacyReceipt = matching.length === 1 ? matching[0] : null;
  function append(time, findings) {
    const id = `cxr-legacy-${reports.length + 1}`;
    reports.push(Object.freeze({ id, sampledAt: null, reportedAt: time, findings }));
    return id;
  }
  for (const row of receipts) {
    row[4] = row === legacyReceipt ? append(reportedAt, legacyFindings)
      : append(Number.isFinite(row[3]) ? row[3] : null, CXR_UNRECORDED);
  }
  if (legacy && !legacyReceipt) append(reportedAt, legacyFindings);
  else if (!reports.length && S.tests?.cxr?.done) append(null, CXR_UNRECORDED);
}

function testSample(S, id) {
  const sample = snapshot(S);
  if (id === 'cbc') {
    sample.wbc = Number.isFinite(S.wbc) ? r1(S.wbc) : null;
    sample.plt = Number.isFinite(S.plt) ? Math.round(S.plt) : null;
  }
  const test = TESTS[id];
  return { t: S.t, s: sample, name: test.name, fields: test.fields };
}

function orderTest(S, id) {
  const T = TESTS[id]; if (!T) return null;
  const serial = isSerialBloodTest(id);
  const xray = id === 'cxr';
  const current = S.tests[id];
  if ((serial || xray) && current && !current.done) return current.readyAt;
  const readyAt = S.t + T.min * 60;
  const order = { readyAt, done: false };
  if (xray) order.sample = Object.freeze({ sampledAt: S.t, findings: chestXrayFindings(S) });
  else if (serial) order.sample = testSample(S, id);
  S.cost += T.cost;
  S.tests[id] = order;
  S.log.push([fmt(S.t), `开出 ${T.name}（${T.min} 分钟后出结果）`, 'info']);
  return readyAt;
}
function pollTests(S) {
  for (const [id, t] of Object.entries(S.tests)) {
    if (!t.done && S.t >= t.readyAt) {
      if (id === 'cxr') {
        if (!S.xrayReports?.length) restoreChestXrayReports(S);
        const reports = S.xrayReports;
        const sample = t.sample ?? { sampledAt: null, findings: CXR_UNRECORDED };
        const report = Object.freeze({ id: `cxr-${reports.length + 1}`, ...sample, reportedAt: S.t });
        reports.push(report);
        S.log.push([fmt(S.t), CXR_RECEIPT, 'good', S.t, report.id]);
        t.done = true;
        delete t.sample;
        S.lastLabAt = S.t;
        continue;
      }
      t.done = true;
      S.log.push([fmt(S.t), `${TESTS[id].name} 结果已出`, 'good']);
      S.labSnap ??= {};
      const report = t.sample ?? testSample(S, id);
      if (isSerialBloodTest(id)) {
        /* 旧存档中的待出报告只保留了预计回报时间。 */
        if (!t.sample) report.sampledAtKnown = false;
        report.reportedAt = S.t;
        S.labPrevious ??= {};
        if (S.labSnap[id]?.s) S.labPrevious[id] = S.labSnap[id];
        delete t.sample;
      }
      S.labSnap[id] = report;
      S.lastLabAt = S.t;
    }
  }
}
function testValue(S, id) {
  if (id === 'cxr') return S.xrayReports?.at(-1) ?? null;
  return TESTS[id] && (isSerialBloodTest(id) || S.tests[id]?.done) ? S.labSnap?.[id]?.s ?? null : null;
}

function snapshot(S) {
  const b = bp(S);
  return {
    hr: Math.round(S.hr), sys: b.sys, dia: b.dia, map: b.map,
    rr: Math.round(S.rr), spo2: pulseOximetry(S), temp: Number.isFinite(S.temp) ? r1(S.temp) : null, gcs: S.gcs,
    k: r1(S.k), na: Math.round(S.na), cl: Math.round(S.cl), ca: r2(S.ca),
    ph: r2(S.ph), paco2: Math.round(S.paco2), pao2: Math.round(S.pao2),
    oxygenModelVersion: 2,
    hco3: Math.round(S.hco3), lac: r1(S.lac), glu: r1(S.glu),
    cr: Math.round(S.cr), bun: r1(S.bun), hb: Math.round(S.hb),
    uo: S.uo, uoHourly: r2(S.uo * 60), rhythm: S.rhythm, vent: !!S.vent, ef: Math.round((S.cEff || S.contractility) * 100),
    /* v0.3 新增可读量 */
    sao2: Math.round(S.sao2 * 100), do2: Math.round(S.do2), co: r2(S.co),
    shunt: r2(S.shunt), fio2: r2(S.fio2 == null ? 0.21 : S.fio2),
    lungWater: r2(S.lungWater), interstitium: r1(S.interstitium),
    pvr: r1(S.pvr), ache: r2(S.acheActivity), gsh: r2(S.gsh), napqi: r1(S.napqi),
    hepato: r2(S.hepatotox), icp: r2(S.icp), gfr: Math.round(S.gfr || 0),
  };
}

const fmt = s => {
  const m = Math.floor(s / 60); const hh = Math.floor(m / 60); const mm = m % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
};

function scoreBreakdown(S) {
  const base = 100;
  const items = [];
  let subtotal = base;
  function add(label, delta) {
    subtotal += delta;
    if (delta !== 0) items.push({ label, delta });
  }

  add('心脏骤停', -(S.arrests || 0) * 22);
  if (S.discharged) add('出院用时奖励', Math.max(0, 25 - (S.t / 60) / 6));
  if (S.death) add('死亡结局', -45);
  add('诊疗费用', -Math.min(15, Math.max(0, (S.cost - 800) / 120)));

  const penalties = +(S.penalties || 0);
  const penaltyDelta = -penalties * 6;
  subtotal += penaltyDelta;
  if (penaltyDelta !== 0) {
    if (Number.isSafeInteger(penalties) && penalties > 0) {
      let remaining = penalties;
      const reasons = new Map();
      for (const entry of Array.isArray(S.penaltyReasons) ? S.penaltyReasons : []) {
        if (remaining === 0) break;
        if (typeof entry?.label !== 'string' || !Number.isInteger(entry.count) || entry.count <= 0) continue;
        const label = entry.label.trim();
        if (!label) continue;
        const count = Math.min(entry.count, remaining);
        reasons.set(label, (reasons.get(label) || 0) + count);
        remaining -= count;
      }
      for (const [label, count] of reasons) {
        items.push({ label: `带教扣分（${label}，${count} 次）`, delta: -count * 6 });
      }
      if (remaining > 0) {
        items.push({ label: `带教扣分（未记录原因，${remaining} 次）`, delta: -remaining * 6 });
      }
    } else {
      items.push({ label: '带教扣分', delta: penaltyDelta });
    }
  }

  const rounded = Math.round(subtotal);
  if (Number.isFinite(subtotal) && rounded !== subtotal) {
    items.push({ label: '四舍五入', delta: rounded - subtotal });
  }
  const score = Math.max(0, Math.min(100, rounded));
  if (rounded > 100) items.push({ label: '100 分封顶', delta: score - rounded });
  if (rounded < 0) items.push({ label: '0 分保底', delta: score - rounded });
  return { base, items, score };
}

function finalScore(S) {
  return scoreBreakdown(S).score;
}

const API = {
  setIdentity(p) { IDENTITY = p || null; }, CASES, DRUGS, ACTIONS, TESTS, DELIVERY_DURATION, create, restorePatient, tick, give, acetaminophenExposure, setEnv, finalScore, scoreBreakdown, bp, snapshot,
              dischargeCheck, glucoseDischargeTarget, potassiumTarget, convulsionSigns, auscultate, orderTest, pollTests, testValue, chestXrayReports, restoreChestXrayReports,
              computeMap, fmt, endCase, setBleedingRate, restoreBleeding,
              benzodiazepineExposure, restoreBenzodiazepines, temperatureStatus, restoreTemperature, infusionDetails, insulinActivity,
              pumpRate, pumpOrder, pumpEffect, stopPump,
              hill, computePh, computePcwp, roomAirSaturation, restoreCardiorespiratory, restoreDischargeObservation };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.LIFE = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);







