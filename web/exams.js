/* 床旁检查、检验项目与报告所见。数值只从对应的模拟状态读取。 */
(function (root) {
'use strict';

const EXAM_GROUPS = [
  { id: 'neuro', name: '意识与神经' },
  { id: 'resp', name: '气道与呼吸' },
  { id: 'circ', name: '循环与灌注' },
  { id: 'abd', name: '腹部与泌尿' },
  { id: 'skin', name: '皮肤与外伤' },
];
const TEST_GROUPS = [
  { id: 'urgent', name: '快速床旁检查' },
  { id: 'blood', name: '常规化验' },
  { id: 'targeted', name: '定向化验' },
  { id: 'imaging', name: '影像与超声' },
];

const EXAMS = {
  neuro: { group: 'neuro', name: '意识与抽搐评估', desc: '评估意识水平，观察是否仍有抽搐。' },
  pupils: { group: 'neuro', name: '检查双侧瞳孔', desc: '比较两侧瞳孔大小与对光反应。' },
  airway: { group: 'resp', name: '观察气道与呼吸', desc: '观察胸廓起伏、呼吸频率及气道分泌物。' },
  lungs: { group: 'resp', name: '双肺听诊', desc: '比较双侧呼吸音与附加音。' },
  circulation: { group: 'circ', name: '循环与末梢灌注', desc: '检查脉搏、末梢灌注、颈静脉及心音，并复核模拟血管收缩驱动。' },
  legs: { group: 'circ', name: '比较双下肢', desc: '检查双下肢是否有不对称肿胀或水肿。' },
  abdomen: { group: 'abd', name: '腹部查体', desc: '检查腹部压痛及耻骨上区膨隆。' },
  urine: { group: 'abd', name: '复核导尿与尿量', desc: '留置导尿后记录当前尿量，结合膀胱充盈程度评估少尿。' },
  skin: { group: 'skin', name: '皮肤与伤口检查', desc: '观察皮色、皮肤湿度和外露伤口。' },
  temp: { group: 'skin', name: '测量体温', desc: '记录当时测得的体温。' },
};

const TESTS = {
  glucose: { group: 'urgent', name: '指尖血糖', min: 1, cost: 10, fields: ['glu'], desc: '快速筛查血糖异常，可复测变化。' },
  ketones: { group: 'urgent', name: '床旁血酮', min: 3, cost: 30, fields: [], desc: '记录模拟的定性血酮结果，结合血糖、血气与渗透压鉴别。' },
  ecg: { group: 'urgent', name: '12 导联心电图', min: 5, cost: 40, fields: ['ecg'], desc: '记录节律、传导和 ST–T 改变。' },
  abg: { group: 'blood', name: '动脉血气', min: 8, cost: 120, fields: ['ph', 'paco2', 'pao2', 'hco3', 'lac', 'k'], desc: '评估氧合、通气和酸碱状态。' },
  bmp: { group: 'blood', name: '电解质+肾功', min: 35, cost: 180, fields: ['k', 'na', 'cl', 'ca', 'cr', 'bun'], desc: '查电解质、肌酐和尿素氮。' },
  cbc: { group: 'blood', name: '血常规', min: 25, cost: 60, fields: ['hb', 'wbc', 'plt'], desc: '查血红蛋白、白细胞和血小板。' },
  lac: { group: 'blood', name: '乳酸', min: 10, cost: 50, fields: ['lac'], desc: '评估乳酸积累及复苏后的变化。' },
  coag: { group: 'targeted', name: '凝血功能', min: 25, cost: 110, fields: ['coag'], desc: '关注活动性出血或肝损伤时的凝血变化。' },
  troponin: { group: 'targeted', name: '高敏肌钙蛋白 I', min: 30, cost: 170, fields: ['troponin'], desc: '评估心肌损伤，可复查采样比较变化。' },
  coox: { group: 'targeted', name: '血液共氧测定', min: 10, cost: 150, fields: ['cohb'], desc: '测碳氧血红蛋白，辅助评估一氧化碳暴露。' },
  cholinesterase: { group: 'targeted', name: '胆碱酯酶活性', min: 30, cost: 110, fields: ['ache'], desc: '评估胆碱酯酶受抑程度。' },
  apap: { group: 'targeted', name: '对乙酰氨基酚暴露筛查', min: 30, cost: 110, fields: [], desc: '查看模拟的暴露证据，结合肝损伤与凝血结果解读。' },
  thyroid: { group: 'targeted', name: '甲状腺功能', min: 45, cost: 145, fields: [], desc: '以模拟定性结果比较促甲状腺激素与游离甲状腺素。' },
  liver: { group: 'targeted', name: '肝功能与凝血趋势', min: 30, cost: 135, fields: ['hepato', 'coag'], desc: '观察模拟肝损伤及凝血随时间的变化。' },
  metabolism: { group: 'targeted', name: '血糖与渗透压评估', min: 20, cost: 90, fields: ['glu', 'anionGap', 'effectiveOsmolality', 'osmolality'], desc: '测血糖，并计算阴离子间隙、有效渗透压和总渗透压。' },
  lipase: { group: 'targeted', name: '胰脂肪酶', min: 30, cost: 90, fields: [], desc: '辅助评估持续上腹痛伴呕吐。' },
  hcg: { group: 'targeted', name: '血妊娠试验（β-hCG）', min: 20, cost: 75, fields: [], desc: '确认有无妊娠证据，必要时结合超声定位。' },
  cxr: { group: 'imaging', name: '床旁胸片', min: 15, cost: 90, fields: [], desc: '查看肺实质阴影、肺水肿及胸腔积气征象。' },
  lungus: { group: 'imaging', name: '床旁肺超声', min: 3, cost: 100, fields: [], desc: '观察肺滑动和 B 线，辅助辨别气胸与肺间质水肿。' },
  echo: { group: 'imaging', name: '床旁心脏超声', min: 5, cost: 150, fields: [], desc: '观察心包积液和左右心室表现。' },
  fast: { group: 'imaging', name: '创伤床旁超声（FAST）', min: 5, cost: 150, fields: [], desc: '观察腹腔、盆腔有无游离液体。' },
  cthead: { group: 'imaging', name: '头颅 CT 平扫', min: 25, cost: 360, fields: [], desc: '评估颅内急性出血和占位效应。' },
  ctpa: { group: 'imaging', name: 'CT 肺动脉造影', min: 30, cost: 650, fields: [], desc: '检查肺动脉有无充盈缺损。' },
  pelvicus: { group: 'imaging', name: '妇产科盆腔超声', min: 15, cost: 130, fields: [], desc: '观察妊娠位置及盆腔游离液体。' },
  bladderus: { group: 'imaging', name: '床旁膀胱扫描', min: 3, cost: 75, fields: [], desc: '检查膀胱是否明显充盈。' },
};

const row = (label, value, flag) => flag ? { label, value, flag } : { label, value };
const abnormal = (label, value) => row(label, value, '异常');
const withTag = (S, tag) => S.tags?.includes(tag);
const pregnancyEvidence = S => withTag(S, 'ectopic') || withTag(S, 'preeclampsia');
const retention = S => withTag(S, 'bph') && !S.urineDrained;
const activeBleed = (S, site) => S.bleedingSites?.[site] > 0;
const recentHemostasis = (S, site) => Object.hasOwn(S.bleedingSites || {}, site) &&
  Number.isFinite(S.surgicalHemostasisAt) && S.t - S.surgicalHemostasisAt < 900;
const internalFluid = (S, site) => activeBleed(S, site) || recentHemostasis(S, site);
const cholinergic = S => (1 - (S.acheActivity ?? 1)) * (1 - (S.muscarinicBlock ?? 0));
const rounded = (n, digits = 0) => Number(n.toFixed(digits));

function bedside(S, type, E) {
  const values = {};
  let rows;
  switch (type) {
    case 'neuro': {
      values.gcs = S.gcs;
      const movement = E.convulsionSigns(S);
      const response = S.gcs === 15 ? '清醒，可交流' : S.gcs >= 13 ? '反应较慢，能应答'
        : S.gcs >= 9 ? '唤醒困难或答非所问' : '意识明显受损';
      rows = [row('意识反应', response, S.gcs < 15 && '异常'), row('GCS', S.gcs + ' 分'),
        row('肢体活动', movement || '检查时未见抽搐', movement && '异常')];
      break;
    }
    case 'pupils': {
      const antagonist = S.naloxoneUntil > S.t;
      const opioid = !antagonist && Math.max(S.opioidDepress || 0, (S._opioidTone || 0) / 4) >= 0.45;
      const miosis = opioid || cholinergic(S) >= 0.4;
      const brainCompression = S.hematoma > 0.25 && S.icp >= 0.6;
      const baseline = miosis ? '明显缩小' : '大小未见明显异常';
      rows = [row('左侧瞳孔', brainCompression ? '散大，对光反应迟钝' : baseline, (brainCompression || miosis) && '异常'),
        row('右侧瞳孔', baseline, miosis && '异常')];
      break;
    }
    case 'airway': {
      const obstruction = withTag(S, 'burn') && (S.burnAirwayResistance ?? S.airwayResistance) >= 0.45;
      const rate = rounded(S.rr);
      values.rr = rate;
      rows = [
        row('呼吸频率', rate + ' 次/分', (rate < 10 || rate >= 25) && '异常'),
        row('呼吸方式', S.vent ? '机械通气中' : obstruction ? '可闻吸气性喉鸣' :
          S.rr < 10 || S.vt < 250 ? '呼吸浅慢' : S.tensionPTX > 0.2 ? '左侧胸廓起伏减弱' :
          S.rr >= 25 ? '呼吸急促' : '胸廓起伏可见'),
        row('口咽分泌物', cholinergic(S) >= 0.25 ? '口腔分泌物明显增多' :
          withTag(S, 'burn') ? '口鼻周围可见烟灰' : '未见明显分泌物积聚'),
      ];
      break;
    }
    case 'circulation': {
      const { sys, dia, map } = E.bp(S);
      const perfused = S.rhythm === 'sinus';
      if (perfused) Object.assign(values, { hr: rounded(S.hr), sys, dia, map });
      rows = [
        row('脉搏', perfused ? values.hr + ' 次/分' : '未触及有效脉搏', !perfused && '异常'),
        row('血压', perfused ? `${sys}/${dia} mmHg` : '无可用的脉搏血压', (!perfused || sys < 90) && '异常'),
        row('末梢灌注', !perfused ? '明显受损' : map < 65 ? '再充盈延迟，脉搏弱' : '再充盈无明显延迟', (!perfused || map < 65) && '异常'),
        row('颈静脉', S.tamponade >= 0.35 || S.tensionPTX >= 0.65 || (S.cvp >= 10 && S.vol >= 4)
          ? '可见充盈' : '未见明显怒张'),
        row('心音', S.tamponade >= 0.35 ? '心音低弱' : perfused ? '心音可闻' : '无有效心搏音'),
      ];
      const tone = E.vascularTone?.(S);
      if (tone) {
        values.svrDrive = tone.value;
        rows.push(row('血管张力评估', tone.text, !tone.controlled && '偏高'));
      }
      break;
    }
    case 'legs': {
      const right = withTag(S, 'pe') && S.clot >= 0.25;
      const edema = S.interstitium >= 12.5 || (withTag(S, 'aki') && S.renalFactor < 0.2) ||
        (withTag(S, 'preeclampsia') && !S.delivered);
      rows = [row('双下肢对比', right ? '右下肢比左侧明显肿胀' : '未见明显不对称肿胀', right && '异常'),
        row('水肿', edema ? '可见双侧下肢水肿' : '未见明显双侧水肿', edema && '异常')];
      break;
    }
    case 'abdomen': {
      const tender = [];
      if (withTag(S, 'pancreatitis')) tender.push('上腹部');
      if (activeBleed(S, 'spleen')) tender.push('左上腹');
      if (activeBleed(S, 'ectopic')) tender.push('下腹部');
      if (retention(S)) tender.push('耻骨上区');
      rows = [row('压痛', S.gcs <= 8 ? '意识受损，压痛反应难以可靠评估' :
        tender.length ? tender.join('、') + '可见压痛' : '未引出明确局限性压痛',
      S.gcs > 8 && tender.length > 0 && '异常'),
      row('耻骨上区', retention(S) ? '膨隆，可触及充盈膀胱' : '未触及明显膀胱膨隆')];
      break;
    }
    case 'urine': {
      if (!S.urineDrained || !Number.isFinite(S.uo)) {
        rows = [row('尿量', '尚无导尿监测读数')];
        break;
      }
      values.uoHourly = rounded(S.uo * 60, 1);
      rows = [valueRow('uoHourly', values.uoHourly)];
      if (S.weight > 0) {
        values.uoPerKg = rounded(S.uo * 60 / S.weight, 2);
        rows.push(valueRow('uoPerKg', values.uoPerKg));
      }
      break;
    }
    case 'skin': {
      const injuries = [];
      if (withTag(S, 'trauma')) injuries.push(activeBleed(S, 'trauma') && S.externalBleed
        ? '右大腿开放性伤口，仍可见活动性出血' : '右大腿开放性伤口，当前未见活动性外出血');
      if (withTag(S, 'burn')) injuries.push('可见烧伤创面，口鼻周围有烟灰');
      if (withTag(S, 'tbi')) injuries.push('左颞部可见外伤痕迹');
      const signs = [];
      if (S.hb < 95 || E.bp(S).map < 65) signs.push('面色苍白，末梢湿冷');
      if (S.infection >= 0.5 && E.bp(S).map < 65) signs.push('四肢皮肤呈花斑');
      if (S.hepatotox >= 0.45 && withTag(S, 'liver')) signs.push('巩膜与皮肤黄染');
      if (S.myxedemaSeverity >= 0.45 && S.temp < 36) signs.push('面部浮肿，皮肤干冷');
      if (cholinergic(S) >= 0.35 || S.glu < 3.9) signs.push('出汗');
      if (S.temp >= 39) signs.push('皮肤热');
      rows = [row('皮色与湿度', signs.join('；') || '未见明显异常', signs.length > 0 && '异常'),
        row('外露皮肤', injuries.join('；') || '未见明显外露伤口', injuries.length > 0 && '异常')];
      break;
    }
    case 'temp':
      values.temp = Number.isFinite(S.temp) ? rounded(S.temp, 1) : null;
      rows = [valueRow('temp', values.temp)];
      break;
  }
  return { values, rows };
}

const METRICS = {
  ph: ['pH', '', 7.35, 7.45],
  paco2: ['PaCO₂', 'mmHg', 35, 45],
  pao2: ['PaO₂', 'mmHg', 80],
  hco3: ['HCO₃⁻', 'mmol/L', 22, 26],
  lac: ['乳酸', 'mmol/L', null, 2],
  k: ['血钾', 'mmol/L', 3.5, 5.5],
  na: ['血钠', 'mmol/L', 135, 145],
  cl: ['血氯', 'mmol/L', 98, 107],
  ca: ['离子钙', 'mmol/L', 1.12, 1.32],
  cr: ['肌酐', 'µmol/L'],
  bun: ['尿素氮', 'mmol/L'],
  hb: ['血红蛋白', 'g/L'],
  wbc: ['白细胞', '×10⁹/L', 4, 10],
  plt: ['血小板', '×10⁹/L', 100, 300],
  glu: ['血糖', 'mmol/L', 3.9],
  temp: ['体温', '℃', 36, 37.8],
  cohb: ['碳氧血红蛋白（COHb）', '%'],
  ache: ['胆碱酯酶相对活性', '（模拟值）', 0.75],
  coag: ['凝血功能指数', '（模拟值）', 0.8],
  hepato: ['肝损伤指数', '（模拟值）', null, 0.25],
  troponin: ['高敏肌钙蛋白 I', 'ng/L（模拟值）', null, 26],
  anionGap: ['阴离子间隙（计算）', 'mmol/L'],
  effectiveOsmolality: ['有效渗透压（计算）', 'mOsm/kg'],
  osmolality: ['总渗透压（计算）', 'mOsm/kg'],
  uoHourly: ['当前尿流率（按小时折算）', 'mL/h'],
  uoPerKg: ['按体重折算', 'mL/kg/h'],
};

function valueRow(field, value) {
  const [label, unit, low, high] = METRICS[field];
  if (!Number.isFinite(value)) return row(label, '未记录');
  const flag = low != null && value < low ? '偏低' : high != null && value > high ? '偏高' : null;
  return row(label, unit ? value + ' ' + unit : String(value), flag);
}

function labRows(type, sample, fields = TESTS[type].fields) {
  const rows = fields.filter(field => Object.hasOwn(METRICS, field)).map(field => valueRow(field, sample[field]));
  if (type === 'abg' && Number.isFinite(sample.fio2)) rows.unshift(row('采样时 FiO₂', rounded(sample.fio2 * 100) + '%'));
  if (type === 'abg' && sample.oxygenModelVersion == null) rows.push(row('氧合模型', '旧版存档结果，可复查血气'));
  return rows;
}

function ecgRows(sample) {
  const rhythms = { sinus: '窦性心律', vf: '心室颤动', asystole: '心静止' };
  const rows = [row('心律', rhythms[sample.rhythm] || '未记录', sample.rhythm && sample.rhythm !== 'sinus' && '异常')];
  if (sample.rhythm !== 'sinus') return rows;
  rows.push(row('心率', sample.hr + ' 次/分'));
  if (Number.isFinite(sample.qrsWide) && Number.isFinite(sample.stemi) && Number.isFinite(sample.tca)) {
    const wide = Math.max(sample.qrsWide, sample.tca, (sample.k - 6.2) / 2.6);
    const waves = [];
    if (sample.stemi >= 0.18) waves.push('相邻导联 ST 段抬高');
    if (sample.k >= 5.8) waves.push('T 波高尖');
    if (sample.tca >= 0.4) waves.push('aVR 导联可见突出的终末 R 波');
    rows.push(row('QRS 波群', wide >= 0.3 ? '增宽' : '无明显增宽', wide >= 0.3 && '异常'));
    rows.push(row('波形所见', waves.join('；') || '未见上述波形异常', waves.length > 0 && '异常'));
  }
  return rows;
}

/* 心肌肌钙蛋白为独立的可复查读数，再通后的损伤标志物仍然在血中。 */
function advanceTroponin(S, minutes) {
  const ischemia = S.stemi || 0;
  if (!(ischemia > 0.15 || S.troponin > 4 || withTag(S, 'stemi'))) return;
  const release = S.reperfused ? 0 : ischemia * 9;
  const baseline = S.troponin ?? (4 + ischemia * 18);
  S.troponin = Math.max(4, (baseline - 4) * Math.exp(-minutes / 720) + release * minutes + 4);
}

function targetedSample(S, type, sample, E) {
  switch (type) {
    case 'troponin':
      sample.troponin = rounded(S.troponin ?? (4 + (S.reperfused ? 0.18 : S.stemi || 0) * 18));
      return labRows(type, sample);
    case 'coox':
      sample.cohb = Number.isFinite(S.coHb) ? rounded(S.coHb * 100, 1) : null;
      return labRows(type, sample);
    case 'coag':
    case 'liver':
      sample.coag = Number.isFinite(S.coag) ? rounded(S.coag, 2) : null;
      return [...labRows(type, sample), row('结果说明', type === 'liver'
        ? '肝损伤指数升高提示损伤加重，凝血功能指数下降提示凝血异常加重。为便于复查，保留模拟指数。'
        : '凝血功能指数下降提示凝血异常加重。')];
    case 'apap': {
      const exposure = E.acetaminophenExposure(S);
      const result = exposure.known ? '存在暴露标志' :
        exposure.mg24h > 0 ? '近 24 小时有给药记录' : '当前模型未记录暴露';
      return [
        row('模拟暴露证据', result, (exposure.known || exposure.highRisk) && '需结合病史'),
        row('解读范围', '检验仅提供定性暴露线索，浓度和服药至采样间隔未纳入模型。'),
      ];
    }
    case 'thyroid': {
      // TSH 的变化晚于临床病情变化，短期复查以生命体征与意识为主。
      const thyroidDrive = S.cas?.init?.thyroidHeatDrive ?? S.thyroidHeatDrive ?? 0;
      const hypothyroid = S.cas?.init?.myxedemaSeverity ?? S.myxedemaSeverity ?? 0;
      const findings = thyroidDrive > 0 && hypothyroid > 0 ? [row('甲状腺功能', '结果需结合既往甲状腺病史复核')] :
        thyroidDrive > 0 ? [abnormal('TSH', '相对降低'), abnormal('游离 T₄', '相对升高')] :
        hypothyroid > 0 ? [abnormal('TSH', '相对升高'), abnormal('游离 T₄', '相对降低')] :
        [row('TSH', '未见明确升降'), row('游离 T₄', '未见明确升降')];
      return [...findings, row('结果说明', '定性支持线索，短期疗效以体温、心率和意识复查为主。')];
    }
    case 'ketones': {
      const burden = S.ketoneBurden;
      if (!Number.isFinite(burden)) return [row('血酮（模拟定性）', '未记录')];
      return [row('血酮（模拟定性）', burden >= 0.55 ? '明显升高' : burden >= 0.15 ? '轻度升高' : '未见明显升高',
        burden >= 0.15 && '异常')];
    }
    case 'metabolism':
      sample.anionGap = rounded(S.na - S.cl - S.hco3, 1);
      sample.effectiveOsmolality = rounded(2 * S.na + S.glu, 1);
      sample.osmolality = rounded(2 * S.na + S.glu + S.bun, 1);
      return labRows(type, sample);
    case 'lipase':
      return [withTag(S, 'pancreatitis') ? abnormal('脂肪酶', '明显升高') : row('脂肪酶', '未见明显升高'),
        row('结果说明', '模拟定性结果，用于鉴别上腹痛。观察病情变化时复查灌注和尿量。')];
    case 'hcg':
      sample.pregnant = Number(pregnancyEvidence(S));
      return [row('β-hCG', sample.pregnant ? '检出' : '未检出')];
    default:
      return labRows(type, sample);
  }
}

function imagingRows(S, type, sample) {
  switch (type) {
    case 'lungus':
      return [
        row('左侧肺滑动', S.tensionPTX >= 0.2 ? '受检区域未见肺滑动' : S.tensionPTX > 0 ? '局部肺滑动减弱' : '可见肺滑动', S.tensionPTX > 0 && '异常'),
        row('右侧肺滑动', '可见肺滑动'),
        row('B 线', S.lungWater >= 0.65 ? '多个受检肺区见密集 B 线' : S.lungWater >= 0.32
          ? '肺底 B 线增多' : '未见明显增多', S.lungWater >= 0.32 && '异常'),
      ];
    case 'echo':
      return [
        row('心包', S.tamponade >= 0.35 ? '心包积液伴右心腔受压' : S.tamponade > 0
          ? '可见少量积液，未见明显右心受压' : '未见明显心包积液', S.tamponade > 0 && '异常'),
        row('左室收缩', (S.cEff || S.contractility) < 0.6 ? '左室整体收缩减弱' : '左室整体收缩未见明显减弱'),
        row('右室', S.pvr >= 5.5 ? '右室压力负荷增高' : '未见明显右室压力负荷征象'),
      ];
    case 'fast': {
      const sites = [['脾肾间隙', 'spleen'], ['盆腔', 'ectopic']];
      return sites.map(([label, site]) => internalFluid(S, site) ? abnormal(label, '见游离液体') : row(label, '未见明确游离液体'));
    }
    case 'cthead':
      return [S.hematoma > 0.12 ? abnormal('颅内', '左颞部颅骨内板下见双凸形高密度影') : row('颅内', '未见明确急性出血影'),
        row('占位效应', S.hematoma > 0.3 && S.icp >= 0.6 ? '可见邻近脑组织受压' : '未见明显占位效应')];
    case 'ctpa':
      return [(S.clot || 0) > 0.08 ? abnormal('肺动脉', '可见肺动脉充盈缺损') : row('肺动脉', '未见明确充盈缺损')];
    case 'pelvicus': {
      const latePregnancy = withTag(S, 'preeclampsia') && !S.delivered;
      if (latePregnancy) Object.assign(sample, { pregnant: 1, gestationalWeeks: 34 });
      return [
        row('子宫及附件', activeBleed(S, 'ectopic') ? '宫内未见明确孕囊，附件区有异常回声' :
          latePregnancy ? '可见宫内妊娠，约 34 周' : '未见明确妊娠结构', activeBleed(S, 'ectopic') && '异常'),
        row('盆腔', internalFluid(S, 'ectopic') ? '见游离液体' : '未见明确游离液体', internalFluid(S, 'ectopic') && '异常'),
      ];
    }
    case 'bladderus':
      return [retention(S) ? abnormal('膀胱', '明显扩张，内见较多尿液') : row('膀胱', '未见明显过度充盈')];
    default:
      return [];
  }
}

const API = { EXAM_GROUPS, TEST_GROUPS, EXAMS, TESTS, bedside, labRows, ecgRows, targetedSample, imagingRows, advanceTroponin };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.LIFE_EXAMS = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
