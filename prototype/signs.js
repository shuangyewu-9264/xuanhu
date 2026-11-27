/* =========================================================================
 * 首次症状提示 · signs.js
 * 用途：从当前状态识别临床体征；只对「本机从未见过」的体征弹提示。
 * 接口：
 *   SIGNS.detect(S)      -> [{ id, name, level, brief, causes }]
 *   SIGNS.newOnes(list)  -> 只返回本机从未见过的条目
 *   SIGNS.markSeen(list) -> 记入已见集合（localStorage('life.signs')）
 *   SIGNS.resetSeen()    -> 清空已见集合（测试/重置用）
 * 分级：
 *   critical：室颤 / 心静止 / SpO₂<80 / 血钾>7 / 收缩压<70，才允许打断；
 *   其余一律 warning / info，走非阻断提示。
 * 只读 S，不改引擎状态。
 * ========================================================================= */
(function (root) {
'use strict';

const KEY = 'life.signs';
const LEVEL_RANK = { critical: 0, warning: 1, info: 2 };
let memory = [];

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

function safeLS() {
  try {
    const ls = root.localStorage;
    return (ls && typeof ls.getItem === 'function') ? ls : null;
  } catch (e) { return null; }
}

function readSeen() {
  const ls = safeLS();
  if (!ls) return new Set(memory);
  try {
    const raw = ls.getItem(KEY);
    if (!raw) return new Set();
    const d = JSON.parse(raw);
    if (Array.isArray(d)) return new Set(d.map(String));
    if (d && Array.isArray(d.seen)) return new Set(d.seen.map(String));
    return new Set();
  } catch (e) { return new Set(memory); }
}
function writeSeen(set) {
  memory = Array.from(set);
  const ls = safeLS();
  if (ls) {
    try { ls.setItem(KEY, JSON.stringify(memory)); } catch (e) {}
  }
}

function snapshot(S) {
  if (root.LIFE && typeof root.LIFE.snapshot === 'function') {
    try {
      const s = root.LIFE.snapshot(S);
      if (s && typeof s === 'object') return s;
    } catch (e) {}
  }
  let sys = num(S.sys), dia = num(S.dia), map = num(S.map);
  if (root.LIFE && typeof root.LIFE.bp === 'function') {
    try { const b = root.LIFE.bp(S); sys = b.sys; dia = b.dia; map = b.map; } catch (e) {}
  }
  return {
    hr: Math.round(num(S.hr) || 0), sys: sys || 0, dia: dia || 0, map: map || 0,
    rr: Math.round(num(S.rr) || 0), spo2: S.rhythm && S.rhythm !== 'sinus' ? null : num(S.spo2),
    temp: num(S.temp), gcs: Math.round(num(S.gcs) || 0),
    k: Math.round((num(S.k) || 0) * 10) / 10, na: Math.round(num(S.na) || 0),
    ca: Math.round((num(S.ca) || 0) * 100) / 100,
    ph: Math.round((S.ph != null ? num(S.ph) : 7.4) * 100) / 100,
    paco2: Math.round(num(S.paco2) || 0), pao2: Math.round(num(S.pao2) || 0),
    hco3: Math.round(num(S.hco3) || 0), lac: Math.round((num(S.lac) || 0) * 10) / 10,
    glu: Math.round((num(S.glu) || 0) * 10) / 10, cr: Math.round(num(S.cr) || 0),
    hb: Math.round(num(S.hb) || 0), uo: num(S.uo) || 0,
    rhythm: S.rhythm || 'sinus',
  };
}

function optional(S, key) {
  const v = S && S[key];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

/* ---------------- 体征清单 ---------------- */
const SIGNS = [
  /* ===== critical：只有这几类允许打断 ===== */
  {
    id: 'ventricular_fibrillation', name: '心室颤动', level: 'critical',
    brief: '心电图呈心室颤动，已无有效心排血，需立即除颤。',
    causes: '急性心肌缺血、高钾血症、电击伤、严重缺氧',
    test: s => s.rhythm === 'vf',
  },
  {
    id: 'asystole', name: '心静止', level: 'critical',
    brief: '心电活动消失，需立即开始心肺复苏。',
    causes: '心脏骤停终末节律、严重高钾、极度缺氧',
    test: s => s.rhythm === 'asystole',
  },
  {
    id: 'severe_hypoxemia', name: '重度低氧血症', level: 'critical',
    brief: 'SpO₂ 低于 80%，组织氧供严重不足，随时可能心跳停止。',
    causes: '气道梗阻、肺水肿、肺栓塞、阿片过量、严重肺炎',
    test: s => s.spo2 != null && s.spo2 < 80,
  },
  {
    id: 'severe_hyperkalemia', name: '极重度高钾血症', level: 'critical',
    brief: '血钾超过 7.0 mmol/L，随时可能发生恶性心律失常。',
    causes: '急性肾损伤、横纹肌溶解、重度酸中毒、保钾药过量',
    test: s => s.k > 7.0,
  },
  {
    id: 'severe_hypotension', name: '重度低血压', level: 'critical',
    brief: '收缩压低于 70 mmHg，重要脏器灌注不足。',
    causes: '失血、脓毒症、心源性休克、过敏性休克',
    test: s => s.sys > 0 && s.sys < 70,
  },

  /* ===== 电解质 ===== */
  {
    id: 'hyperkalemia', name: '高钾血症', level: 'warning',
    brief: '血钾高于 5.5 mmol/L，需关注心电图改变与心肌毒性。',
    causes: '肾排钾减少、细胞破坏、酸中毒、保钾药物',
    test: s => s.k > 5.5 && s.k <= 7.0,
  },
  {
    id: 'hypokalemia', name: '低钾血症', level: 'warning',
    brief: '血钾低于 3.0 mmol/L，可出现乏力、肠麻痹与心律失常。',
    causes: '呕吐腹泻、利尿剂、胰岛素/β₂ 激动剂、碱中毒',
    test: s => s.k < 3.0,
  },
  {
    id: 'hypernatremia', name: '高钠血症', level: 'warning',
    brief: '血钠高于 150 mmol/L，提示高渗状态与脑细胞脱水。',
    causes: '脱水、尿崩症、高渗液输注过多',
    test: s => s.na > 150,
  },
  {
    id: 'hyponatremia', name: '低钠血症', level: 'warning',
    brief: '血钠低于 125 mmol/L，可致脑水肿、抽搐与意识障碍。',
    causes: 'SIADH、利尿剂、心力衰竭稀释性低钠、大量饮水',
    test: s => s.na > 0 && s.na < 125,
  },
  {
    id: 'hypocalcemia', name: '低钙血症', level: 'warning',
    brief: '血钙低于 0.9 mmol/L，可出现手足搐搦与 QT 延长。',
    causes: '大量输血、碱中毒、甲状旁腺功能减退、胰腺炎',
    test: s => s.ca > 0 && s.ca < 0.9,
  },

  /* ===== 酸碱 ===== */
  {
    id: 'metabolic_acidosis', name: '代谢性酸中毒', level: 'warning',
    brief: 'HCO₃⁻ 低于 22 mmol/L 且 pH 偏酸，提示有机酸或碳酸氢盐丢失。',
    causes: '酮症、乳酸酸中毒、肾衰竭、腹泻、中毒',
    test: s => s.hco3 < 22 && s.ph < 7.35,
  },
  {
    id: 'severe_acidemia', name: '重度酸血症', level: 'warning',
    brief: 'pH 低于 7.10，心肌收缩力与儿茶酚胺反应均受抑制。',
    causes: '重度酮症/乳酸酸中毒、呼吸衰竭、中毒',
    test: s => s.ph < 7.10,
  },
  {
    id: 'metabolic_alkalosis', name: '代谢性碱中毒', level: 'warning',
    brief: 'HCO₃⁻ 高于 26 mmol/L 且 pH 偏碱，提示酸丢失或碱负荷。',
    causes: '呕吐、胃肠减压、利尿剂、低钾血症',
    test: s => s.hco3 > 26 && s.ph > 7.45,
  },
  {
    id: 'respiratory_acidosis', name: '呼吸性酸中毒', level: 'warning',
    brief: 'PaCO₂ 高于 45 mmHg 且 pH 偏酸，提示肺泡通气不足。',
    causes: '阿片/镇静过量、COPD 急性加重、呼吸肌疲劳',
    test: s => s.paco2 > 45 && s.ph < 7.35,
  },
  {
    id: 'respiratory_alkalosis', name: '呼吸性碱中毒', level: 'warning',
    brief: 'PaCO₂ 低于 35 mmHg 且 pH 偏碱，提示过度通气。',
    causes: '焦虑、疼痛、发热、脓毒症早期、肺栓塞',
    test: s => s.paco2 < 35 && s.ph > 7.45,
  },
  {
    id: 'hyperlactatemia', name: '乳酸升高', level: 'warning',
    brief: '乳酸高于 2 mmol/L，提示组织低灌注或代谢紊乱。',
    causes: '休克、严重感染、癫痫发作、肝功能不全',
    test: s => s.lac > 2 && s.lac <= 6,
  },
  {
    id: 'severe_lactic_acidosis', name: '重度乳酸酸中毒', level: 'warning',
    brief: '乳酸高于 6 mmol/L，提示严重组织缺氧或休克。',
    causes: '失血性/感染性休克、肠缺血、严重肝衰竭',
    test: s => s.lac > 6,
  },

  /* ===== 糖代谢 ===== */
  {
    id: 'hypoglycemia', name: '低血糖', level: 'warning',
    brief: '血糖低于 3.9 mmol/L，可出现交感兴奋与意识障碍。',
    causes: '胰岛素/磺脲类过量、进食不足、肝衰竭、脓毒症',
    test: s => s.glu < 3.9 && s.glu >= 2.5,
  },
  {
    id: 'severe_hypoglycemia', name: '重度低血糖', level: 'warning',
    brief: '血糖低于 2.5 mmol/L，可致抽搐、昏迷与不可逆脑损伤。',
    causes: '胰岛素过量、磺脲类中毒、长期饥饿',
    test: s => s.glu < 2.5,
  },
  {
    id: 'hyperglycemia', name: '高血糖', level: 'warning',
    brief: '血糖高于 11.1 mmol/L，需排查应激性高血糖与糖尿病急症。',
    causes: '糖尿病、感染应激、糖皮质激素、胰腺炎',
    test: s => s.glu > 11.1 && s.glu <= 25,
  },
  {
    id: 'severe_hyperglycemia', name: '重度高血糖', level: 'warning',
    brief: '血糖高于 25 mmol/L，需警惕酮症酸中毒或高渗状态。',
    causes: '糖尿病酮症酸中毒、高渗高血糖状态、严重感染',
    test: s => s.glu > 25,
  },
  {
    id: 'ketosis_pattern', name: '高血糖伴酸中毒', level: 'warning',
    brief: '高血糖合并 HCO₃⁻ 下降与酸血症，符合酮症酸中毒的指标组合。',
    causes: '1 型糖尿病停用胰岛素、感染、饥饿、酒精',
    test: s => s.glu > 13 && s.hco3 < 18 && s.ph < 7.30,
  },

  /* ===== 氧合 / 呼吸 ===== */
  {
    id: 'hypoxemia', name: '低氧血症', level: 'warning',
    brief: 'SpO₂ 低于 90%，需寻找气道、肺实质或循环方面的原因。',
    causes: '肺炎、肺水肿、肺栓塞、哮喘、低通气',
    test: s => s.spo2 < 90 && s.spo2 >= 80,
  },
  {
    id: 'tachypnea', name: '呼吸过速', level: 'warning',
    brief: '呼吸频率高于 28 次/分，提示代酸、低氧或呼吸做功增加。',
    causes: '代谢性酸中毒、低氧、疼痛、发热、焦虑',
    test: s => s.rr > 28,
  },
  {
    id: 'bradypnea', name: '呼吸过缓', level: 'warning',
    brief: '呼吸频率低于 8 次/分，通气不足可迅速导致高碳酸血症。',
    causes: '阿片/镇静过量、颅内压升高、呼吸肌疲劳',
    test: s => s.rr < 8,
  },
  {
    id: 'apnea', name: '呼吸濒停', level: 'warning',
    brief: '呼吸频率低于 5 次/分，需立即评估气道与通气。',
    causes: '阿片过量、镇静剂过量、脑干损伤',
    test: s => s.rr < 5,
  },
  {
    id: 'respiratory_failure_pattern', name: '通气与氧合衰竭', level: 'warning',
    brief: '低氧血症合并呼吸过速，提示呼吸衰竭正在发生。',
    causes: '重症肺炎、肺水肿、肺栓塞、哮喘持续状态',
    test: s => s.spo2 != null && s.spo2 < 90 && s.rr > 28,
  },

  /* ===== 循环 ===== */
  {
    id: 'tachycardia', name: '心动过速', level: 'warning',
    brief: '心率高于 130 次/分，需评估容量、感染、疼痛与心律失常。',
    causes: '低血容量、感染、发热、甲亢、心律失常',
    test: s => s.hr > 130,
  },
  {
    id: 'bradycardia', name: '心动过缓', level: 'warning',
    brief: '心率低于 50 次/分，需警惕低灌注与传导阻滞。',
    causes: '有机磷中毒、高钾血症、甲减、房室传导阻滞',
    test: s => s.hr < 50,
  },
  {
    id: 'severe_bradycardia', name: '重度心动过缓', level: 'warning',
    brief: '心率低于 40 次/分，可能出现晕厥与低血压。',
    causes: '三度房室传导阻滞、有机磷中毒、严重高钾',
    test: s => s.hr > 0 && s.hr < 40,
  },
  {
    id: 'hypotension', name: '低血压', level: 'warning',
    brief: '收缩压低于 90 mmHg，需判断是容量、泵功能还是血管张力问题。',
    causes: '失血、脱水、脓毒症、心源性休克、过敏',
    test: s => s.sys < 90 && s.sys >= 70,
  },
  {
    id: 'hypertensive_crisis', name: '高血压急症', level: 'warning',
    brief: '收缩压高于 180 mmHg，需评估靶器官损害。',
    causes: '原发性高血压失控、嗜铬细胞瘤、子痫、停药反跳',
    test: s => s.sys > 180,
  },
  {
    id: 'narrow_pulse_pressure', name: '脉压差缩小', level: 'info',
    brief: '脉压差小于 25 mmHg，常见于心排血量下降或容量不足。',
    causes: '心源性休克、心包填塞、严重低血容量',
    test: s => s.sys > 0 && (s.sys - s.dia) < 25 && s.sys >= 70,
  },
  {
    id: 'shock_pattern', name: '休克状态', level: 'warning',
    brief: '低血压合并乳酸升高，提示组织灌注不足。',
    causes: '失血性、感染性、心源性、过敏性休克',
    test: s => s.sys < 90 && s.lac > 2,
  },

  /* ===== 体温 ===== */
  {
    id: 'fever', name: '体温偏高', level: 'warning',
    brief: '体温高于 37.5℃，结合病史评估感染或其他升温原因。',
    causes: '细菌/病毒感染、脓毒症、药物热、甲亢危象',
    test: (_, S) => Number.isFinite(S.temp) && S.temp > 37.5 && S.temp < 39.5,
  },
  {
    id: 'high_fever', name: '高热', level: 'warning',
    brief: '体温达到 39.5℃，在重症监护中评估病因并持续复测。',
    causes: '脓毒症、甲亢危象、恶性高热、热射病',
    test: (_, S) => Number.isFinite(S.temp) && S.temp >= 39.5 && S.temp <= 40,
  },
  {
    id: 'hyperpyrexia', name: '超高热', level: 'warning',
    brief: '体温高于 40℃，可迅速导致脱水、抽搐与多器官损伤。',
    causes: '脓毒症、甲亢危象、恶性高热、热射病',
    test: (_, S) => Number.isFinite(S.temp) && S.temp > 40,
  },
  {
    id: 'low_temperature', name: '体温偏低', level: 'warning',
    brief: '体温低于 36.1℃，留意冷暴露、代谢异常与体温变化。',
    causes: '寒冷暴露、甲状腺功能减退、低血糖',
    test: (_, S) => Number.isFinite(S.temp) && S.temp >= 35 && S.temp < 36.1,
  },
  {
    id: 'hypothermia', name: '低体温', level: 'warning',
    brief: '体温低于 35℃，可抑制心肌与凝血功能。',
    causes: '长时间暴露、甲减、脓毒症晚期、低血糖',
    test: (_, S) => Number.isFinite(S.temp) && S.temp < 35,
  },

  /* ===== 神经 ===== */
  {
    id: 'altered_consciousness', name: '意识障碍', level: 'warning',
    brief: 'GCS 低于 13，需立即评估气道、血糖、氧合与药物影响。',
    causes: '低血糖、低氧、卒中、中毒、感染、电解质紊乱',
    test: s => s.gcs < 13 && s.gcs >= 8,
  },
  {
    id: 'coma', name: '昏迷', level: 'warning',
    brief: 'GCS 低于 8，气道保护能力下降。',
    causes: '严重低血糖、脑疝、中毒、心跳骤停后脑损伤',
    test: s => s.gcs < 8,
  },

  /* ===== 肾脏 / 血液 ===== */
  {
    id: 'oliguria', name: '少尿', level: 'warning',
    brief: '尿量低于 30 mL/h，提示肾灌注不足或肾实质损伤。',
    causes: '低血容量、休克、急性肾损伤、尿路梗阻',
    test: s => s.uo < 0.5 && s.uo >= 0.2,
  },
  {
    id: 'anuria', name: '无尿', level: 'warning',
    brief: '尿量低于 12 mL/h，需排除梗阻与严重肾损伤。',
    causes: '急性肾小管坏死、双侧梗阻、严重休克',
    test: s => s.uo < 0.2,
  },
  {
    id: 'anemia', name: '贫血', level: 'warning',
    brief: '血红蛋白低于 90 g/L，携氧能力下降。',
    causes: '急性失血、慢性肾病、溶血、营养不良',
    test: s => s.hb < 90 && s.hb >= 60,
  },
  {
    id: 'severe_anemia', name: '重度贫血', level: 'warning',
    brief: '血红蛋白低于 60 g/L，可加重心肌缺血与休克。',
    causes: '大出血、溶血危象、骨髓抑制',
    test: s => s.hb < 60,
  },
  {
    id: 'hypercreatininemia', name: '肌酐升高', level: 'warning',
    brief: '肌酐高于 200 µmol/L，提示肾功能明显受损。',
    causes: '急性肾损伤、慢性肾病、横纹肌溶解',
    test: s => s.cr > 200,
  },
  {
    id: 'aki_pattern', name: '肾功能下降', level: 'warning',
    brief: '肌酐升高合并少尿，符合急性肾损伤的指标组合。',
    causes: '肾前性低灌注、肾毒性药物、梗阻、脓毒症',
    test: s => s.cr > 200 && s.uo < 0.5,
  },

  /* ===== 特殊状态（可选字段缺失时自动跳过） ===== */
  {
    id: 'coagulopathy', name: '凝血功能异常', level: 'warning',
    brief: '凝血指标明显下降，出血风险升高。',
    causes: '肝衰竭、DIC、抗凝药过量、大量输血',
    test: (s, S) => { const v = optional(S, 'coag'); return v != null && v < 0.6; },
  },
  {
    id: 'anaphylaxis', name: '过敏反应', level: 'warning',
    brief: '出现过敏反应表现，可迅速进展为气道水肿与休克。',
    causes: '药物、食物、昆虫叮咬、造影剂',
    test: (s, S) => { const v = optional(S, 'anaphyl'); return v != null && v > 0.15; },
  },
  {
    id: 'bronchospasm', name: '支气管痉挛', level: 'warning',
    brief: '气道痉挛导致呼气受阻与喘鸣，氧合可进行性下降。',
    causes: '哮喘、COPD 急性加重、过敏、异物',
    test: (s, S) => { const v = optional(S, 'bronchospasm'); return v != null && v > 0.25; },
  },
  {
    id: 'hemolysis', name: '溶血', level: 'warning',
    brief: '出现溶血表现，可加重贫血与肾损伤。',
    causes: '输血反应、自身免疫性溶血、药物、感染',
    test: (s, S) => { const v = optional(S, 'hemolysis'); return v != null && v > 0.15; },
  },
  {
    id: 'opioid_toxicity', name: '阿片样呼吸抑制', level: 'warning',
    brief: '呼吸浅慢合并意识下降，符合阿片类过量的表现。',
    causes: '吗啡/芬太尼等阿片类药物过量',
    test: s => s.rr < 10 && s.gcs < 10,
  },
  {
    id: 'thyroid_storm_pattern', name: '高代谢状态', level: 'warning',
    brief: '高热合并明显心动过速，需考虑甲状腺危象。',
    causes: '甲亢未控制、感染、手术、停药',
    test: s => s.temp > 39 && s.hr > 130,
  },
];

/* ---------------- 检测 ---------------- */
function detect(S) {
  if (!S || typeof S !== 'object') return [];
  const s = snapshot(S);
  const out = [];
  for (let i = 0; i < SIGNS.length; i++) {
    const d = SIGNS[i];
    let hit = false;
    try { hit = !!d.test(s, S); } catch (e) { hit = false; }
    if (!hit) continue;
    out.push({
      id: d.id, name: d.name, level: d.level,
      brief: d.brief, causes: d.causes, _order: i,
    });
  }
  out.sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || (a._order - b._order));
  return out.map(x => ({ id: x.id, name: x.name, level: x.level, brief: x.brief, causes: x.causes }));
}

function newOnes(list) {
  const seen = readSeen();
  const out = [];
  const added = new Set();
  for (const x of (Array.isArray(list) ? list : [])) {
    if (!x || !x.id || seen.has(x.id) || added.has(x.id)) continue;
    added.add(x.id);
    out.push(x);
  }
  return out;
}

function markSeen(list) {
  const seen = readSeen();
  let n = 0;
  for (const x of (Array.isArray(list) ? list : [])) {
    const id = (x && typeof x === 'object') ? x.id : x;
    if (!id) continue;
    if (!seen.has(String(id))) { seen.add(String(id)); n += 1; }
  }
  if (n) writeSeen(seen);
  return n;
}

function seen() { return Array.from(readSeen()); }
function resetSeen() { writeSeen(new Set()); return true; }

const API = {
  detect, newOnes, markSeen, resetSeen, seen,
  list: SIGNS.map((x, i) => ({ id: x.id, name: x.name, level: x.level, order: i })),
  catalog: () => SIGNS.map(x => ({
    id: x.id, name: x.name, level: x.level, brief: x.brief, causes: x.causes,
  })),
  version: '1.0.0', key: KEY,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SIGNS = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
