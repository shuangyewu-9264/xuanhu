/* 入院问诊。病例描述是素材，病历只显示已取得的证据。 */
(function (root) {
'use strict';

const VERSION = 2;
const SOURCES = [
  { id: 'patient', label: '患者自述' },
  { id: 'family', label: '家属转述', absent: '目前没有可联系的家属。' },
  { id: 'witness', label: '现场目击者', absent: '目前没有可联系的目击者。' },
  { id: 'ems', label: '急救交接', absent: '本次就诊没有现场急救交接。' },
  { id: 'records', label: '既往病历与用药记录', absent: '目前没有可查阅的既往病历或用药记录。' },
];
const TOPICS = [
  { id: 'present', label: '现病史' },
  { id: 'history', label: '既往史' },
  { id: 'medications', label: '用药与暴露' },
  { id: 'allergies', label: '药物过敏' },
  { id: 'prehospital', label: '院前情况' },
];
const chiefSources = {
  opioid: 'ems', hypogly: 'family', organophosphate: 'witness',
  ptx: 'ems', trauma: 'ems', hhs: 'family', co: 'witness', tamponade: 'ems',
  heatstroke: 'witness', myxedema: 'ems', liverFailure: 'family', tca: 'ems',
  tbi: 'witness', burn: 'ems', seizure: 'witness',
};
const criticalChiefs = new Set(['opioid', 'hypogly', 'seizure']);
const arrestRhythms = new Set(['vf', 'pea', 'asystole']);
/* 可由急救人员亲见的转运情况。 */
const transportObservations = {
  highK: ['送诊时需搀扶', '接触患者时乏力明显，需搀扶转运。'],
  dka: ['转运前呕吐', '急救人员到场后见患者仍有呕吐。'],
  bleed: ['现场可见血性呕吐物', '急救人员在现场见到血性呕吐物。'],
  edema: ['转运时呼吸急促', '转运时呼吸急促，有粉红色泡沫样痰。'],
  thyroid: ['转运时烦躁', '转运时患者烦躁，皮肤温热。'],
  asthma: ['转运时可闻喘鸣', '转运时可闻喘鸣，患者说话断续。'],
  htnEmergency: ['转运前呕吐、反应变慢', '转运前曾呕吐，随后反应变慢。'],
  hyponatremia: ['转运前呕吐、反应变差', '转运前曾呕吐，随后反应明显变差。'],
  pe: ['急救人员到场时呼吸困难', '急救人员在现场见患者呼吸困难。'],
  pancreatitis: ['转运前反复呕吐', '转运前仍有反复呕吐。'],
  aki: ['送诊时眼睑及下肢水肿', '急救人员见患者眼睑及下肢水肿。'],
  tca: ['急救人员到场时反应迟钝', '急救人员到场时见患者反应迟钝。'],
  stemi: ['急救人员到场时面色苍白、出冷汗', '急救人员到场时见患者面色苍白、出冷汗。'],
  ectopic: ['急救人员到场时曾反应迟缓', '急救人员到场时患者反应迟缓，面色苍白。'],
  preeclampsia: ['送诊时双下肢水肿', '急救人员见双下肢水肿。'],
  bph: ['送诊时下腹膨隆', '急救人员观察到下腹膨隆。'],
};
const sourceByDescription = {
  '病史回顾': 'reported', '院前病史': 'reported',
  '急救交接': 'ems', '院前交接': 'ems',
  '家属转述': 'family', '现场人员转述': 'witness', '患者自述': 'patient',
};
const acuteBackground = new Set(['肺部感染', '骨盆骨折', '胸部外伤', '头部外伤', '腹部钝性外伤', '密闭空间火灾']);
const pregnancyHistory = new Set(['早孕', '妊娠 34 周']);
const legacyPregnancy = '旧版产科记录与患者资料或孕周记录存在冲突';
/* 旧病例素材及旧病历的合并记述。顺序为文字、主题、时间、素材来源。 */
const legacyHistory = {
  '近期停用胰岛素，三天前开始多饮、多尿。': [
    ['近期停用胰岛素。', 'medications', null], ['开始多饮、多尿。', 'present'],
  ],
  '近期停用胰岛素，三天前开始明显口渴。': [
    ['近期停用胰岛素。', 'medications', null], ['开始明显口渴。', 'present'],
  ],
  '到院前注射胰岛素后未进食。': [['注射胰岛素后未进食。', 'medications']],
  '到院前注射胰岛素后未进食，随后大汗、反应变差。': [
    ['注射胰岛素后未进食。', 'medications'], ['到院前出现大汗、反应变差。', 'present', null, '家属转述'],
  ],
  '到院前呕血两次，起身时曾晕厥。': [
    ['到院前呕血两次。', 'present'], ['起身时曾晕厥。', 'present'],
  ],
  '一天前开始排黑便，至到院前已呕血两次。': [
    ['开始排黑便。', 'present'], ['至到院前已呕血两次。', 'present', null],
  ],
  '送医前出现尿少、反应变慢，皮肤可见花斑。': [
    ['送医前出现尿量减少、反应变慢。', 'present', null, '家属转述'],
    ['转运时皮肤可见花斑。', 'prehospital'],
  ],
  '到院前喷洒农药，约两小时后出现大汗、流涎和呕吐。': [
    ['发病前曾喷洒农药。', 'medications'], ['喷洒农药约两小时后出现大汗、流涎和呕吐。', 'present'],
  ],
  '吞服约 20 片对乙酰氨基酚，随后恶心。': [
    ['吞服约 20 片对乙酰氨基酚。', 'medications'], ['服药后出现恶心。', 'present', null],
  ],
  '出现剧烈头痛、视物模糊和呕吐，随后反应变慢。': [
    ['出现剧烈头痛、视物模糊和呕吐。', 'present'], ['随后反应变慢。', 'present', null],
  ],
  '出现乏力、嗜睡，近期饮水增多。': [
    ['出现乏力、嗜睡。', 'present'], ['近期饮水增多。', 'present', null],
  ],
  '近期长时间久坐，到院前突发胸痛、呼吸困难，曾晕倒。': [
    ['近期曾长时间久坐。', 'present'], ['到院前突发胸痛、呼吸困难，曾晕倒。', 'present'],
  ],
  '受伤后出现左胸剧痛、明显气促，左侧呼吸音减弱。': [
    ['受伤后出现左胸剧痛。', 'present', null, '院前病史'], ['转运时见患者明显气促，左侧呼吸音减弱。', 'prehospital'],
  ],
  '近几天饮水少，逐渐出现乏力、嗜睡，送医前反应明显变差。': [
    ['近几天饮水少。', 'present'], ['逐渐出现乏力、嗜睡，送医前反应明显变差。', 'present'],
  ],
  '近几天饮水量变化，逐渐出现乏力、嗜睡，送医前反应明显变差。': [
    ['近几天饮水量变化。', 'present'], ['逐渐出现乏力、嗜睡，送医前反应明显变差。', 'present'],
  ],
  '在通风不良的房间使用燃气热水器，离开现场前反应变慢。': [
    ['在通风不良的房间使用燃气热水器。', 'medications'], ['离开现场前，患者反应变慢。', 'present'],
  ],
  '在通风不良的火场中吸入烟气，离开现场前反应变慢。': [
    ['在密闭火场中吸入烟气。', 'medications'], ['离开现场前，患者反应变慢。', 'present'],
  ],
  '在高温环境中持续暴露约四小时，随后晕倒。': [
    ['晕倒前在高温环境中持续暴露约四小时。', 'medications'], ['现场有人目击患者晕倒。', 'present'],
  ],
  '近一周皮肤黄染加深，逐渐出现白天嗜睡、夜间烦躁。': [
    ['近一周皮肤黄染加深。', 'present'], ['随后逐渐出现白天嗜睡、夜间烦躁。', 'present', null],
  ],
  '吞服约 20 片阿米替林，约两小时后被发现反应迟钝、口干。': [
    ['吞服约 20 片阿米替林。', 'medications'], ['服药约两小时后被发现反应迟钝。', 'present'],
    ['服药后口干。', 'present', null, '患者自述'],
  ],
  '同时吞服对乙酰氨基酚和阿米替林各约 20 片，约两小时后被发现反应迟钝、口干，曾诉恶心。': [
    ['同时吞服对乙酰氨基酚和阿米替林各约 20 片。', 'medications'], ['服药后出现恶心。', 'present', null],
    ['服药约两小时后被发现反应迟钝。', 'present', null, '院前病史', 'tca'],
    ['服药后口干。', 'present', null, '患者自述', 'tca'],
  ],
  '左颞部撞伤后曾清醒，约一小时后逐渐出现嗜睡、呕吐。': [
    ['左颞部撞伤后曾清醒，约一小时后逐渐出现嗜睡、呕吐。', 'present', null, '现场人员转述'],
  ],
  '从密闭空间火灾中救出，伴面颈部烧伤、声音嘶哑及炭末样痰，估计烧伤面积约 35%。': [
    ['从密闭空间火灾中救出。', 'medications'],
    ['转运时见面颈部烧伤、声音嘶哑及炭末样痰，估计烧伤面积约 35%。', 'prehospital'],
  ],
  '出现持续的胸骨后压榨样痛，向左肩放射，伴冷汗。曾含服硝酸甘油，疼痛持续。': [
    ['出现持续的胸骨后压榨样痛，向左肩放射，伴冷汗。', 'present'],
    ['曾含服硝酸甘油，疼痛持续。', 'prehospital', null],
  ],
  '开始持续抽搐，伴牙关紧闭和发绀。': [
    ['开始持续抽搐。', 'present', 20, '现场人员转述'], ['抽搐时伴牙关紧闭和发绀。', 'prehospital'],
  ],
  '左上腹受撞击后疼痛，向左肩放射，伴面色苍白、冷汗。': [
    ['左上腹受撞击后疼痛，向左肩放射。', 'present', null, '院前病史'],
    ['急救人员见患者面色苍白、出冷汗。', 'prehospital'],
  ],
  '停经七周，送医前突发下腹撕裂样痛、肛门坠胀，曾晕厥。': [
    ['已停经约七周。', 'present', null, '患者自述'], ['送医前突发下腹撕裂样痛、肛门坠胀，曾晕厥。', 'present'],
  ],
  '近两天尿量明显减少。': [['尿量开始明显减少。', 'present']],
  '心悸、乏力逐渐加重。': [['出现心悸、乏力，随后逐渐加重。', 'present']],
  '三天前开始多饮、多尿。': [['开始多饮、多尿。', 'present']],
  '一天前开始反应变慢，尿量减少。': [['开始反应变慢，尿量减少。', 'present']],
};

function splitLegacyEntry(entry) {
  if (!Object.hasOwn(legacyHistory, entry.text)) return null;
  return legacyHistory[entry.text].map(([text, section, minutesBefore = entry.minutesBefore,
    source = entry.source, moduleId = entry.moduleId]) => ({ ...entry, text, section, minutesBefore, source, moduleId }));
}

/* 这些旧记录对应同一件事，原有文字与事件时间仍须保留。 */
const legacyEquivalents = {
  '近期停用胰岛素。': '本次注射胰岛素前曾有一段时间停用。',
  '晕倒前在高温环境中持续暴露约四小时。': '火场中有高温暴露。',
  '被发现倒在房间，呼吸浅慢。': '据发现者向急救人员报告，患者被发现倒在房间，呼吸浅慢。',
  '胸部受伤后曾烦躁，颈静脉怒张，心音低弱。': '急救人员到场时见患者烦躁、颈静脉怒张，心音低弱。',
  '转运时见面颈部烧伤、声音嘶哑及炭末样痰，估计烧伤面积约 35%。': '转运时见面颈部烧伤、气促、声音嘶哑及炭末样痰，估计烧伤面积约 35%。',
  '抽搐时伴牙关紧闭和发绀。': '急救人员到场时仍在抽搐，伴牙关紧闭和发绀。',
};
const fixedCases = {
  hyperkalemia: {
    module: 'highK', chief: '心悸、乏力约 1 天', minutesBefore: 1440,
    history: [[2880, '病史回顾', '尿量开始明显减少。'], [1440, '病史回顾', '出现心悸、乏力，随后逐渐加重。']],
    background: ['慢性肾病 3 期'],
  },
  dka: {
    module: 'dka', chief: '恶心、呕吐约 1 天', minutesBefore: 1440,
    history: [[4320, '病史回顾', '开始多饮、多尿。'], [1440, '病史回顾', '开始恶心、呕吐。'], [null, '家属转述', '今晨开始嗜睡。']],
    background: ['1 型糖尿病'], medications: ['近期自行停用胰岛素。'],
  },
  bleed: {
    module: 'bleed', chief: '黑便约 1 天，伴呕血', minutesBefore: 1440,
    history: [[1440, '病史回顾', '开始排黑便。'], [null, '院前病史', '至到院前已呕血两次。'], [null, '院前病史', '起身时曾晕厥一次。']],
    background: ['消化性溃疡'], medications: ['长期服用阿司匹林。'],
  },
  sepsis: {
    module: 'sepsis', chief: '发热、咳嗽约 3 天', minutesBefore: 4320,
    history: [[1440, '家属转述', '开始反应变慢，尿量减少。'], [null, '院前交接', '送医时皮肤可见花斑。']],
  },
  opioid: {
    module: 'opioid', chief: '被发现呼之不应约 1 小时', minutesBefore: 60,
    history: [[60, '院前交接', '据发现者向急救人员报告，患者被发现倒在房间，呼吸浅慢。'],
      [null, '院前交接', '急救人员检查时见双侧瞳孔针尖样缩小。']],
  },
};

function formatTime(minutesBefore) {
  if (minutesBefore == null) return '到院前，时间未详';
  if (minutesBefore === 0) return '到院时';
  if (minutesBefore % 1440 === 0) return `到院前约 ${minutesBefore / 1440} 天`;
  if (minutesBefore % 60 === 0) return `到院前约 ${minutesBefore / 60} 小时`;
  return `到院前约 ${minutesBefore} 分钟`;
}

function moduleById(id) {
  const generator = root.CASEGEN || (typeof module !== 'undefined' && module.exports ? require('./generator.js') : null);
  return generator?.MODULES.find(m => m.id === id);
}

function subject(S) {
  const C = S.cas || {};
  const fixed = fixedCases[C.id];
  if (fixed) {
    return {
      ids: [fixed.module], chief: fixed.chief, chiefMinutes: fixed.minutesBefore,
      history: fixed.history.map(([minutesBefore, source, text]) => ({ moduleId: fixed.module, minutesBefore, source, text })),
      background: fixed.background || [], medications: fixed.medications || [],
    };
  }
  const ids = C.cases || [];
  const primary = moduleById(ids[0]);
  return {
    ids, chief: primary?.chief ?? '已送至急诊，来诊经过待核实。', chiefMinutes: primary?.chiefMinutesBefore ?? null,
    history: C.admission?.history || [], background: C.admission?.background || [],
    medications: C.admission?.medicationHistory || [],
  };
}

function hashText(key) {
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function seededContact(S, salt) {
  const key = String(S.cas?.seed ?? S.seed ?? S.caseId ?? S.cas?.id ?? 'fixed') + ':' + salt;
  return hashText(key) % 100;
}

function historyFacts({ ids, history, background, medications }, traits, admissionCanSpeak) {
  const facts = [];
  const add = (section, text, source, minutesBefore = null, moduleId = null, optional = false) => {
    const clean = text?.trim();
    if (!clean) return;
    if (facts.some(fact => fact.section === section && fact.text === clean &&
      fact.source === source && fact.minutesBefore === minutesBefore)) return;
    const id = optional && moduleId === ids[0] ? 'transport-observation'
      : `intake-${hashText(JSON.stringify([section, clean, source, minutesBefore, moduleId])).toString(36)}`;
    facts.push({ id, section, text: clean, source, minutesBefore, moduleId, optional });
  };
  const entries = history.flatMap(entry => entry.section ? [entry] : splitLegacyEntry(entry) || [entry]);
  for (const { moduleId, minutesBefore, source: description, section, text } of entries) {
    const source = sourceByDescription[description] || 'reported';
    add(section || (source === 'ems' ? 'prehospital' : 'present'), text, source, minutesBefore, moduleId);
  }
  if (ids.includes('opioid')) {
    add('medications', '急救人员在发现患者的现场见到吗啡药品，暴露时间与实际用量待核实。', 'ems', null, 'opioid');
    add('medications', '患者回忆失去意识前用过吗啡，具体剂量记不清。', 'patient', null, 'opioid');
  }
  if (ids.includes('tca')) {
    add('medications', '急救人员在现场发现打开的阿米替林药盒，实际吞服量待核实。', 'ems', null, 'tca');
  }
  if (ids.includes('apap')) {
    add('medications', '急救人员在现场发现打开的对乙酰氨基酚药盒，实际吞服量待核实。', 'ems', null, 'apap');
  }
  for (const text of medications) {
    const source = text.startsWith('长期服用') ? 'background' : text.startsWith('旧版') ? 'records' : 'reported';
    add('medications', text, source);
  }
  for (const text of background) {
    if (medications.includes(text) || acuteBackground.has(text)) continue;
    const section = pregnancyHistory.has(text) || text === legacyPregnancy ? 'present' : 'history';
    add(section, text, text.includes('旧版') ? 'records' : 'background');
  }
  for (const trait of traits) {
    if (trait.id === 'elderly_renal') continue;
    const section = trait.id === 'pcn_allergy' ? 'allergies' : 'history';
    const aliases = {
      ckd: ['慢性肾病', '慢性肾病 3 期'], asthma_hx: ['哮喘', '哮喘史'],
      baseline_htn: ['高血压', '原发性高血压'],
    };
    if (facts.some(f => (aliases[trait.id] || [trait.n]).includes(f.text))) continue;
    add(section, trait.n, trait.id === 'slow_cyp' ? 'records' : 'background');
  }
  for (const id of ids) {
    const observation = transportObservations[id];
    if (!observation || (!admissionCanSpeak && id === 'highK')) continue;
    const text = !admissionCanSpeak && id === 'asthma' ? '转运时可闻喘鸣。' : observation[1];
    add('prehospital', text, 'ems', null, id, true);
  }
  return facts;
}

function patientUnavailable(S) {
  if (S.death) return '患者已死亡。';
  if (S.vent) return '患者正在气管插管，暂时无法应答。';
  if (!Number.isFinite(S.gcs) || S.gcs < 13 || arrestRhythms.has(S.rhythm)) {
    return '当前意识状态无法完成问诊，待恢复后可补问。';
  }
  return '';
}

function availableSources(S, contacts) {
  return SOURCES.map(({ id, label, absent }) => {
    const reason = id === 'patient' ? patientUnavailable(S) : contacts[id] ? '' : absent;
    return { id, label, available: !reason, reason };
  });
}

function sourceOptions(fact) {
  if (fact.source === 'background') return ['records', 'patient', 'family'];
  if (fact.source === 'reported') return ['patient', 'family'];
  return [fact.source];
}

function evidence(fact, source, obtainedAt) {
  const label = SOURCES.find(item => item.id === source).label;
  return {
    id: fact.id, section: fact.section, text: fact.text, source,
    sourceLabel: label, minutesBefore: fact.minutesBefore, obtainedAt,
  };
}

function atAdmission(S) {
  const vitals = S.admissionVitals;
  return {
    gcs: vitals?.gcs ?? (S.t === 0 ? S.gcs : S.cas?.init?.gcs ?? S.gcs),
    vent: vitals?.vent ?? (S.t === 0 ? S.vent : null),
    rhythm: vitals?.rhythm ?? (S.t === 0 ? S.rhythm : null),
  };
}

function planFor(S, admissionCanSpeak = !patientUnavailable(atAdmission(S))) {
  const subjectData = subject(S);
  const traits = S.traits || S.cas?.traits || [];
  return { ...subjectData, facts: historyFacts(subjectData, traits, admissionCanSpeak) };
}

function upgradeIntake(S, saved) {
  const admissionCanSpeak = !saved.chief.text.startsWith('患者暂无法自述。');
  const { facts } = planFor(S, admissionCanSpeak);
  const known = [];
  for (const old of saved.known) {
    const entries = splitLegacyEntry(old) || [old];
    for (const entry of entries) {
      const equivalent = legacyEquivalents[entry.text] || entry.text;
      const matching = facts.filter(fact => fact.section === entry.section && (fact.text === entry.text || fact.text === equivalent));
      const fact = matching.find(item => item.minutesBefore === entry.minutesBefore) || matching[0];
      let id = fact?.id || (entries.length === 1 ? old.id : `${old.id}-${known.length}`);
      const earlier = known.find(item => item.id === id);
      if (earlier?.source === old.source && earlier?.obtainedAt === old.obtainedAt) continue;
      if (earlier) id = `${old.id}-${known.length}`;
      known.push({ ...old, id, section: entry.section, text: entry.text, minutesBefore: entry.minutesBefore });
    }
  }
  const contacts = { ...saved.contacts };
  for (const { source, optional } of facts) {
    if (!optional && typeof contacts[source] !== 'boolean' &&
      SOURCES.some(item => item.id === source && item.id !== 'patient')) contacts[source] = true;
  }
  return { ...saved, version: VERSION, admissionCanSpeak, contacts, known };
}

function init(S, fixedDifficulty = 1) {
  if (S.intake?.version === VERSION) return S.intake;
  if (S.intake?.version === 1) {
    S.intake = upgradeIntake(S, S.intake);
    return S.intake;
  }
  const difficulty = Math.max(1, Math.min(6, Math.trunc((S.diff ?? S.cas?.diff ?? fixedDifficulty) || 1)));
  const admission = atAdmission(S);
  const admissionCanSpeak = !patientUnavailable(admission);
  const plan = planFor(S, admissionCanSpeak);
  const criticalId = !admissionCanSpeak && admission.gcs <= 8 && plan.ids.find(id => criticalChiefs.has(id));
  const lead = criticalId || plan.ids[0];
  const expectedChiefSource = chiefSources[lead];
  const contacts = {
    family: plan.facts.some(f => f.source === 'family') || expectedChiefSource === 'family' || seededContact(S, 'family') < 45,
    witness: plan.facts.some(f => f.source === 'witness'),
    ems: !admissionCanSpeak || plan.facts.some(f => f.source === 'ems' && !f.optional) ||
      expectedChiefSource === 'ems' || seededContact(S, 'ems') < 40,
    records: traitsHaveAllergy(S) || plan.facts.some(f => f.source === 'records') ||
      (plan.facts.some(f => f.source === 'background') && seededContact(S, 'records') < 65),
  };
  const criticalModule = criticalId && criticalId !== plan.ids[0] ? moduleById(criticalId) : null;
  const arrivalObservation = arrestRhythms.has(admission.rhythm) ? '送诊时无有效自主循环。'
    : admission.vent ? '急救转运时已气管插管。' : null;
  const chiefSource = arrivalObservation ? 'ems' : contacts[expectedChiefSource] ? expectedChiefSource
    : admissionCanSpeak ? 'patient' : contacts.family ? 'family' : 'ems';
  const observedChief = chiefSource === 'ems' && (arrivalObservation || !expectedChiefSource)
    ? arrivalObservation || (lead !== 'highK' && transportObservations[lead]?.[0]) || '送诊时应答困难。' : null;
  const chiefText = observedChief || (criticalModule?.chief ?? plan.chief);
  const chief = evidence({
    id: 'chief', section: 'chief',
    text: admissionCanSpeak ? chiefText : '患者暂无法自述。' + chiefText,
    minutesBefore: observedChief ? null : criticalModule ? criticalModule.chiefMinutesBefore : plan.chiefMinutes,
  }, chiefSource, 0);
  const available = { ...contacts, patient: admissionCanSpeak };
  const ranked = plan.facts.map(fact => ({ fact, source: sourceOptions(fact).find(id => available[id]) }))
    .filter(item => item.source);
  ranked.sort((a, b) => {
    const rank = ({ fact }) => (fact.moduleId === lead ? 4 : 0) +
      (['present', 'prehospital'].includes(fact.section) ? 2 : 0) + (fact.section === 'allergies' ? 1 : 0);
    return rank(b) - rank(a);
  });
  const visibleFraction = [1, 0.75, 0.50, 0.30, 0.15, 0][difficulty - 1];
  const count = difficulty < 6 && ranked.length ? Math.max(1, Math.round(ranked.length * visibleFraction)) : 0;
  const known = ranked.slice(0, count).map(({ fact, source }) => evidence(fact, source, 0));
  S.intake = { version: VERSION, difficulty, contacts, chief, known, admissionCanSpeak };
  return S.intake;
}

function traitsHaveAllergy(S) {
  return (S.traits || S.cas?.traits || []).some(trait => trait.id === 'pcn_allergy');
}

function view(S) {
  const intake = init(S);
  return {
    chief: intake.chief,
    known: intake.known.slice().sort((a, b) => (b.minutesBefore ?? -1) - (a.minutesBefore ?? -1)),
    inquiries: (intake.inquiries || []).slice(),
    sources: availableSources(S, intake.contacts), topics: TOPICS.slice(),
    difficulty: intake.difficulty,
  };
}

function ask(S, sourceId, topicId) {
  const intake = init(S);
  const source = availableSources(S, intake.contacts).find(item => item.id === sourceId);
  if (!source?.available) return { status: 'unavailable', evidence: [], message: source?.reason || '当前信息来源不可用。' };
  if (!TOPICS.some(topic => topic.id === topicId)) return { status: 'unavailable', evidence: [], message: '没有这项问诊主题。' };
  const facts = planFor(S, intake.admissionCanSpeak).facts.filter(fact => fact.section === topicId && sourceOptions(fact).includes(sourceId));
  const obtainedAt = Number.isFinite(S.t) ? S.t : 0;
  if (!facts.length) {
    intake.inquiries ??= [];
    if (!intake.inquiries.some(item => item.source === sourceId && item.section === topicId)) {
      intake.inquiries.push({ source: sourceId, sourceLabel: source.label, section: topicId, obtainedAt });
    }
    return { status: 'unknown', evidence: [], message: '已记录本次询查，该来源暂未提供这方面的信息。' };
  }
  const learned = [];
  const known = [];
  for (const fact of facts) {
    const previous = intake.known.find(item => item.id === fact.id);
    if (previous) known.push(previous);
    else learned.push(evidence(fact, sourceId, obtainedAt));
  }
  if (learned.length) {
    intake.known.push(...learned);
    return { status: 'learned', evidence: learned, message: '已将补充信息记入病历。' };
  }
  return { status: 'known', evidence: known, message: '这些信息已记入病历。' };
}

const API = { init, view, ask, formatTime };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.INTAKE = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
