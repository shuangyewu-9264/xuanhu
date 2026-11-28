/* ==========================================================================
 * 游戏层：把生理引擎接到界面上
 * 依赖：engine.js（全局 LIFE）、organs.js（交互式器官图谱）
 * ========================================================================== */
(function () {
'use strict';
const E = window.LIFE;
function isEDIntake(patient) { return (patient?.intake?.difficulty ?? patient?.diff ?? patient?.cas?.diff) === 6; }
const $ = s => document.querySelector(s);
const r1 = x => Math.round(x * 10) / 10;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/* ---------------- 状态 ---------------- */
let S = null;
/* 病房床位：同时最多 MAX_BEDS 个病例，时间同步流逝，可随时切换 */
const MAX_BEDS = 4;
let beds = [];
let activeIdx = 0;
let selected = 'heart';
let lastTs = 0, acc = 0, hudAcc = 0, saveAcc = 0, signsAcc = 0;
const ecg = new EcgMonitor();
let speed = 1, ff = false;
let observation = null;
const GLUCOSE_REVIEW_MINUTES = 30;
const MAX_OBSERVATION_SECONDS = 6 * 3600;
let lastCaseReview = false;
let paused = false;
let bigFont = false;
/* 白天 / 夜间：夜间难度显著提升（病情推进更快、提示更少、界面转暗） */
let nightMode = false;
const REALISM_RULES = {
  insurance: { name: '医保与自付', note: '按参保类型结算费用，追踪家庭自付负担。' },
  signedDischarge: { name: '真实出院', note: '自行判断出院时机。签字后结算，病情未达标扣分，重大问题直接判负。' },
  noPause: { name: '禁用暂停', note: '全病房持续推进，仍可调整倍速、快进或等病情变化。' },
};
const realismRules = { insurance: false, signedDischarge: false, noPause: false };
function enabledRules() {
  return Object.keys(REALISM_RULES).filter(key => realismRules[key]);
}
function ruleNames(keys) {
  return keys.map(key => REALISM_RULES[key]?.name).filter(Boolean).join('、') || '无';
}
/* 是否运行在网页版（http/https 且不是 APK 内的 localhost） */
const IS_WEB = (function () {
  try {
    return /^https?:/.test(location.protocol) &&
      !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  } catch (e) { return false; }
})();
/* 调试入口（强制移除患者等）：只有 ?debug=1 才出现，正式包与线上版本默认隐藏 */
const DEBUG_TOOLS = (function () {
  try {
    const q = new URLSearchParams(location.search);
    return q.get('debug') === '1';
  } catch (e) { return false; }
})();
/* 上级医师是否主动提示：默认关闭，改为"求助制"——只在点「问上级」时给提示，其余时候只做给药点评 */
let autoHint = false;   /* 无障碍：大字号模式（全局缩放 1.10） */   /* 暂停：所有床位都停止推进 */
let level = (function(){ try { return localStorage.getItem('life.level') || 'intern'; } catch(e){ return 'intern'; } })();
/* 1–5 级调节病情与交接详略，6 级沿用 5 级病情。指导强度单独选择。 */
let caseDiff = (function(){
  try { const v = Number(localStorage.getItem('life.caseDiff')); if (Number.isInteger(v) && v >= 1 && v <= 6) return v; } catch (e) {}
  return 3;
})();

const RESET_EPOCH_KEY = 'life.resetEpoch';
const saveEpoch = readSaveEpoch();
let wardRevision = null;
let pendingResetRecovery = null;
let reloadingForStorage = false;

/* ---------------- 人体 ---------------- */
function drawBody() {
  const svg = $('#anat'), sex = S.patient?.sex;
  svg.setAttribute('viewBox', WARD_ANATOMY.viewBox);
  svg.innerHTML = WARD_ANATOMY.render(sex);
  const groups = Array.from(svg.querySelectorAll('.org'));
  const picker = $('#opTitle');
  const ids = ['brain', 'lung', 'heart', 'liver', 'stomach', 'spleen', 'pancreas', 'kidney', 'gut', 'bladder',
    sex === '女' ? 'uterus' : 'prostate'];
  picker.replaceChildren(...ids.map(id => new Option(ORGAN_META[id].n, id)));
  for (const group of groups) {
    group.addEventListener('click', () => selectOrgan(group.dataset.o));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectOrgan(group.dataset.o);
      }
    });
  }
  selectOrgan('heart');
}

/* 总览界面左右滑动 → 切换床位（多张床时） */
function bindBedSwipe() {
  const host = document.querySelector('.stage') || document.body;
  if (!host || host.__bedSwipe) return;
  host.__bedSwipe = 1;
  let x0 = null, y0 = null, t0 = 0;
  const blocked = () => {
    const mask = document.getElementById('mask');
    const detail = document.getElementById('detail');
    const lobby = document.getElementById('lobby');
    return (mask && mask.classList.contains('on')) ||
           (detail && detail.classList.contains('on')) ||
           (lobby && getComputedStyle(lobby).display !== 'none');
  };
  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  host.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    x0 = null;
    if (dt > 800 || blocked()) return;
    if (beds.length < 2) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return;   // 竖向滑动交给页面
    const next = (activeIdx + (dx < 0 ? 1 : -1) + beds.length) % beds.length;
    switchBed(beds[next].S);
  }, { passive: true });
}

function selectOrgan(id) {
  selected = id;
  document.querySelectorAll('#anat .org').forEach(x => {
    const active = x.dataset.o === id;
    x.classList.toggle('sel', active);
    x.setAttribute('aria-pressed', active);
  });
  renderOrganPanel();
}

const ORGAN_META = {
  uterus: {n:'子宫 / 卵巢', f: (s, state) => [
    ['雌激素', (state.estrogen != null ? (state.estrogen * 100).toFixed(0) : '—'), '%'],
    ['绝经', (state.patient && state.patient.age >= 52) ? '是' : '否', ''],
    ['盆腔出血', bleedingStatus(state, 'ectopic'), ''],
    ...(state.tags.includes('preeclampsia') ? [['产科进程', deliveryStatus(state), '']] : [])]},
  prostate: {n:'前列腺', f: (s, state) => [
    ['睾酮', (state.testosterone != null ? (state.testosterone * 100).toFixed(0) : '—'), '%'],
    ['尿潴留', state.tags.includes('bph') ? (state.urineDrained ? '已行导尿' : '排尿受阻') : '病例未记录', ''],
    ['年龄风险', (state.patient && state.patient.age >= 55) ? '偏高' : '低', '']]},
  bladder: {n:'膀胱', f: (s, state) => [
    ['尿量', s.uoHourly, 'mL/h'], ['导尿管', state.urineDrained ? '已留置' : '未留置', '']]},
  brain:   {n:'脑',   f: (s, state) => [
    ['意识', s.gcs, 'GCS'], ['脑灌注', s.map < 60 ? '不足' : '正常', ''], ['瞳孔', s.gcs < 6 ? '散大' : '等大', ''],
    ['床旁观察', E.convulsionSigns(state) ?? '未见抽搐', '']]},
  lung:    {n:'肺',   f: s => [['SpO₂', s.spo2 ?? '无信号', s.spo2 == null ? '' : '%'], ['PaO₂', s.pao2, 'mmHg'], ['FiO₂', Math.round(s.fio2 * 100), '%'], ['PaCO₂', s.paco2, 'mmHg'], ['RR', s.rr, s.vent ? 'rpm · 机械通气' : 'rpm']]},
  heart:   {n:'心脏', f: s => [['HR', s.hr, 'bpm'], ['EF', s.rhythm === 'sinus' ? s.ef : '—', s.rhythm === 'sinus' ? '%' : ''], ['MAP', s.map, 'mmHg'], ['心律', s.rhythm === 'sinus' ? '窦性' : (s.rhythm === 'vf' ? '室颤' : '心静止'), '']]},
  liver:   {n:'肝脏', f: (s, state) => [['凝血系数', state.coag.toFixed(2), ''], ['肝损伤指数', s.hepato, '']]},
  stomach: {n:'胃',   f: (s, state) => [['上消化道出血', bleedingStatus(state, 'bleed'), '']]},
  spleen:  {n:'脾',   f: (s, state) => [['脾脏出血', bleedingStatus(state, 'spleen'), '']]},
  pancreas:{n:'胰腺', f: s => [['血糖', s.glu, 'mmol/L']]},
  kidney:  {n:'肾脏', f: s => [['血钾', s.k, 'mmol/L'], ['肌酐', s.cr, 'µmol/L'], ['尿量', s.uoHourly, 'mL/h'], ['GFR', s.gfr, 'mL/min']]},
  gut:     {n:'肠道与直肠', f: () => [['肠道功能', '无独立监测数据', '']]},
};

function bleedingStatus(state, site) {
  if (!(site in state.bleedingSites)) return '病例未记录';
  return state.bleedingSites[site] > 0 ? '活动性出血' : '已止血';
}

function organState(id, s) {
  if (id === 'heart') return s.rhythm !== 'sinus' ? 'crit' : (s.map < 65 || s.hr > 120 ? 'crit' : (s.hr > 100 ? 'warn' : 'ok'));
  if (id === 'lung')  return s.spo2 == null || s.spo2 < 92 ? 'warn' : 'ok';
  if (id === 'kidney')return s.k > 6.5 ? 'crit' : (s.k > 5.5 || s.uo < 0.5 ? 'warn' : 'ok');
  if (id === 'liver') return s.hepato >= 0.75 ? 'crit' : (s.hepato > 0.45 ? 'warn' : 'ok');
  if (id === 'brain') return s.gcs < 12 ? 'crit' : (s.gcs < 15 ? 'warn' : 'ok');
  if (id === 'pancreas') return s.glu > 11 ? 'warn' : 'ok';
  return 'ok';
}

function edSampleText(result) {
  if (!Number.isFinite(result.sampledAt)) return '记录于 ' + caseTime(result.reportedAt);
  return (result.kind === 'exam' ? '测量于 ' : '采样于 ') + caseTime(result.sampledAt);
}

function edReading(patient, known, field) {
  const result = known[field];
  if (result) {
    const report = E.getReport(patient, result.reportId);
    return { ...result, name: report?.name, kind: report?.kind };
  }
  if (field !== 'temp' && field !== 'gcs') return null;
  const { [field]: value, t } = patient.admissionVitals || {};
  return Number.isFinite(value) ? { value, sampledAt: t, name: '接诊首测', kind: 'exam' } : null;
}

function edOrganRows(id, s, patient) {
  const known = E.knownResults(patient);
  const measured = (label, field, unit) => {
    const result = edReading(patient, known, field);
    if (!result) return [label, '待查', ''];
    return [label, result.value, [unit, result.name, edSampleText(result)].filter(Boolean).join(' · ')];
  };
  const urine = ['尿量', patient.urineDrained ? s.uoHourly : '待观察', patient.urineDrained ? 'mL/h · 留置导尿' : ''];
  const tone = known.svrDrive;
  switch (id) {
    case 'heart': return [
      ['HR', s.hr, 'bpm'], ['MAP', s.map, 'mmHg'],
      ['心律', s.rhythm === 'sinus' ? '窦性' : s.rhythm === 'vf' ? '室颤' : '心静止', ''],
      tone ? ['张力评估', CASEGEN.vascularTone({ svrDrive: tone.value }).text, '测量于 ' + caseTime(tone.sampledAt)]
        : ['张力评估', '待查', '床旁查体 → 循环与末梢灌注'],
    ];
    case 'lung': return [
      ['SpO₂', s.spo2 ?? '无信号', s.spo2 == null ? '' : '%'],
      ['RR', s.rr, s.vent ? 'rpm · 机械通气' : 'rpm'],
      measured('PaO₂', 'pao2', 'mmHg'), measured('PaCO₂', 'paco2', 'mmHg'),
    ];
    case 'brain': return [
      measured('意识', 'gcs', 'GCS'),
      ['床旁观察', E.convulsionSigns(patient) ?? '未见抽搐', ''],
    ];
    case 'liver': return [measured('凝血功能', 'coag', '模拟值'), measured('肝损伤指数', 'hepato', '模拟值')];
    case 'pancreas': return [measured('血糖', 'glu', 'mmol/L')];
    case 'kidney': return [measured('血钾', 'k', 'mmol/L'), measured('肌酐', 'cr', 'µmol/L'), urine];
    case 'bladder': return [urine, ['导尿管', patient.urineDrained ? '已留置' : '未留置', '']];
    default: return [['床旁资料', '查体与检查所见见「报告」', '']];
  }
}

let organBuiltFor = null;
function renderOrganPanel() {
  const ed = isEDIntake(S);
  const key = ed ? 'ed:' + selected : selected;
  if (organBuiltFor !== key) {
    organBuiltFor = key;
    const panel = $('#opan');
    panel.classList.remove('hide');
    const s = E.snapshot(S);
    const rows = ed ? edOrganRows(selected, s, S) : ORGAN_META[selected].f(s, S);
    panel.innerHTML = rows.map(([k], i) =>
          `<div class="row"><span class="lab">${k}</span><span class="val" data-oi="${i}"></span></div>`).join('')
      + (selected === 'heart' ? '<div id="vascularTone" hidden></div><canvas id="miniEcg" title="最近 4 秒心电图 · 点击查看指标走势" aria-label="最近 4 秒单导联心电图"></canvas>' : '');
    if (selected === 'lung') {
      const flow = document.createElement('button');
      flow.type = 'button';
      flow.id = 'respiratoryFlow';
      flow.className = 'pill organ-action';
      flow.addEventListener('click', () => openRespiratoryFlow(S));
      panel.prepend(flow);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pill organ-action';
      button.textContent = '双肺听诊';
      button.addEventListener('click', examineLungs);
      panel.appendChild(button);
    }
    if (selected === 'pancreas' && !ed) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'glucoseWait';
      button.className = 'pill organ-action';
      button.addEventListener('click', startGlucoseReview);
      panel.appendChild(button);
      const result = document.createElement('div');
      result.id = 'glucoseReviewResult';
      result.setAttribute('role', 'status');
      panel.appendChild(result);
    }
    updateOrganValues();
    const canvas = $('#miniEcg');
    if (canvas) {
      canvas.addEventListener('click', () => openChart());
      if (ecg.patient === S) ecg.draw(canvas);
    }
  } else {
    updateOrganValues();
  }
}
function updateOrganValues() {
  const s = E.snapshot(S), ed = isEDIntake(S);
  const st = !ed || selected === 'heart' || selected === 'lung' ? organState(selected, s) : '';
  const t = $('#opTitle');
  if (t) { t.value = selected; t.dataset.state = st; }
  if (selected === 'lung') {
    const flow = $('#respiratoryFlow');
    const settings = S.vent ? E.ventilatorSettings(S) : E.oxygenSettings(S);
    const label = `${S.vent ? '呼吸机吸气' : '氧疗供氧'}流量 · ${settings.flow} L/min`;
    if (flow.textContent !== label) flow.textContent = label;
  }
  const waitButton = selected === 'pancreas' && $('#glucoseWait');
  if (waitButton) {
    const label = observation?.kind === 'glucose' ? '结束等待' : `等待血糖变化 · 最多 ${GLUCOSE_REVIEW_MINUTES} 分钟`;
    waitButton.disabled = !!observation && observation.kind !== 'glucose';
    if (waitButton.textContent !== label) waitButton.textContent = label;
    const result = $('#glucoseReviewResult');
    const message = S.lastGlucoseReview || '';
    result.hidden = !message;
    if (result.textContent !== message) result.textContent = message;
  }
  const tonePanel = selected === 'heart' && $('#vascularTone');
  if (tonePanel) {
    tonePanel.hidden = ed || !S.tags.includes('htn');
    if (!tonePanel.hidden) {
      const reading = CASEGEN.vascularTone(S).text;
      if (tonePanel.textContent !== reading) tonePanel.textContent = reading;
    }
  }
  const rows = ed ? edOrganRows(selected, s, S) : ORGAN_META[selected].f(s, S);
  rows.forEach(([k, v, u], i) => {
    const el = document.querySelector('[data-oi="' + i + '"]');
    if (el) el.innerHTML = `${escapeHtml(v)}${u ? `<span style="font-size:9px;color:#9a9a9a"> ${escapeHtml(u)}</span>` : ''}`;
  });
}
/* ---------------- 体征 / 状态 ---------------- */
function vitalList(S) {
  const s = E.snapshot(S);
  const sys = s.sys, dia = s.dia;
  const ed = isEDIntake(S);
  const known = ed ? E.knownResults(S) : null;
  const tempSource = ed ? edReading(S, known, 'temp') : null;
  const gcsSource = ed ? edReading(S, known, 'gcs') : null;
  const temp = ed ? tempSource?.value : s.temp;
  const gcs = ed ? gcsSource?.value : s.gcs;
  const suffix = source => source ? (source.reportId ? '（上次）' : '（首测）') : '';
  return [
    {k:'hr',   n:'心率', v:s.hr,  u:'bpm', st: s.hr > 120 || s.hr < 50 ? 'crit' : (s.hr > 100 ? 'warn' : '')},
    {k:'bp',   n:'血压', v:`${sys}|${dia}`, u:'', st: sys < 90 ? 'crit' : (sys < 100 ? 'warn' : '')},
    {k:'rr',   n:s.vent ? '机械通气' : '呼吸', v:s.rr, u:'rpm', st: s.rr < 8 ? 'crit' : (s.rr > 24 ? 'warn' : '')},
    {k:'spo2', n:'血氧', v:s.spo2 ?? '无信号', u:s.spo2 == null ? '' : '%',
     st: s.spo2 == null || s.spo2 < 92 ? 'crit' : (s.spo2 < 95 ? 'warn' : '')},
    {k:'temp', n:'体温' + suffix(tempSource), v:temp ?? (ed ? '待查' : '未测'), u:temp == null ? '' : '℃',
     source: tempSource, st: ed ? '' : E.temperatureStatus(S.temp)},
    {k:'gcs',  n:'意识' + suffix(gcsSource), v:gcs ?? '待查', u:gcs == null ? '' : 'GCS',
     source: gcsSource, st: ed ? '' : gcs < 12 ? 'crit' : (gcs < 15 ? 'warn' : '')},
  ];
}
function renderVitals() {
  const host = $('#vitals'), readings = vitalList(S);
  const ed = isEDIntake(S);
  if (!host.childElementCount) {
    host.innerHTML = readings.map(v => `<button type="button" class="vpill" data-v="${v.k}">
      <span class="dot"></span><span class="k">${v.n}</span><span class="v"></span><span class="u">${v.u}</span></button>`).join('');
    host.addEventListener('click', event => {
      const key = event.target.closest('[data-v]')?.dataset.v;
      const v = vitalList(S).find(x => x.k === key);
      if (!v) return;
      if (isEDIntake(S) && (key === 'temp' || key === 'gcs')) {
        openDetail(v.n, '', v.source ? [
          ['最近结果', `${v.v} ${v.u}`], ['来源', escapeHtml(v.source.name)], ['时间', edSampleText(v.source)],
        ] : [['状态', '待查，可在「检查」安排床旁查体。']], '');
        return;
      }
      openDetail(v.n + ' · 参考范围', v.u,
        [['参考', REF[v.k] || '—'], ['当前', v.u ? v.v + ' ' + v.u : v.v], ['趋势', trend(v.k)]], '');
    });
  }
  readings.forEach((v, index) => {
    const el = host.children[index];
    el.querySelector('.dot').hidden = ed && (v.k === 'temp' || v.k === 'gcs');
    el.classList.toggle('bad', v.st === 'crit');
    el.classList.toggle('warn', v.st === 'warn');
    el.querySelector('.k').textContent = v.n;
    el.querySelector('.v').textContent = v.v;
    el.querySelector('.u').textContent = v.u;
    if (v.source) el.title = v.source.name + ' · ' + edSampleText(v.source);
    else el.removeAttribute('title');
  });
}
const REF = {hr:'60–100 bpm', bp:'90–140 / 60–90 mmHg', rr:'12–20 rpm',
             spo2:'95–100 %', temp:'36.1–37.5 ℃', gcs:'15'};
function trend(k) {
  if (isEDIntake(S) && !['hr', 'bp', 'rr', 'spo2'].includes(k)) return '—';
  if (k === 'spo2' && S.rhythm !== 'sinus') return '—';
  let h = S.history.slice(-12);
  if (k === 'temp') h = h.filter(sample => Number.isFinite(sample.temp));
  if (h.length < 3) return '—';
  const key = k === 'bp' ? 'sys' : k;
  const a = h[0][key], b = h[h.length - 1][key];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const d = b - a;
  if (k === 'temp') {
    const change = r1(Math.abs(d));
    return change < 0.3 ? '平稳' : `${d > 0 ? '上升' : '下降'} ${change.toFixed(1)} ℃`;
  }
  return Math.abs(d) < 2 ? '平稳' : (d > 0 ? '上升 ' + r1(d) : '下降 ' + r1(Math.abs(d)));
}

function temperatureLabel(temp) {
  if (!Number.isFinite(temp)) return '体温未测';
  const status = E.temperatureStatus(temp);
  if (status === 'crit') return temp < 35 ? '低体温' : (temp > 40 ? '超高热' : '高热');
  if (status === 'warn') return temp < 36.1 ? '体温偏低' : '体温偏高';
  return '';
}

function renderStates() {
  const s = E.snapshot(S);
  const ed = isEDIntake(S);
  const out = [];
  if (s.rhythm === 'vf') out.push('心室颤动');
  else if (s.rhythm === 'asystole') out.push('心静止');
  if (!ed) {
    if (s.k > 5.5) out.push('高血钾');
    if (s.k < 3.5) out.push('低血钾');
    if (s.ph < 7.32) out.push('酸血症');
    if (s.glu > 11) out.push('高血糖');
    if (s.glu < 3.9) out.push('低血糖');
  }
  if (s.spo2 != null && s.spo2 < 92) out.push('低氧血症');
  if (s.sys < 90) out.push('低血压');
  if (ed) {
    const convulsions = E.convulsionSigns(S);
    if (convulsions) out.push(convulsions);
    if (S.bleedingSites?.trauma > 0) out.push('可见活动性外出血');
  } else {
    const tempLabel = temperatureLabel(S.temp);
    if (tempLabel) out.push(tempLabel);
    const pp = (s.sys || 0) - (s.dia || 0);
    if ((S.tamponade || 0) > 0.3 && pp < 25) out.push('奇脉（吸气收缩压 −' + Math.round(10 + 8 * (S.tamponade || 0)) + '）');
    if ((S.cvp || 0) > 9) out.push('颈静脉怒张');
    if ((S.ddimer || 0) > 3) out.push('D-二聚体 ' + S.ddimer.toFixed(1));
    if ((S.flush || 0) > 0.78) out.push('潮热');
    if ((S.stemi || 0) > 0.2) out.push('ST 段抬高');
    if ((S.stemi || 0) > 0.35) out.push('肌钙蛋白升高');
    if ((S.hematoma || 0) > 0.55) out.push('左侧瞳孔散大');
    if ((S.hematoma || 0) > 0.25) out.push('头部外伤');
    if ((S.airwayResistance || 0) > 0.75) out.push('气道水肿');
    if ((S.coHb || 0) > 0.10) out.push('碳氧血红蛋白升高');
    if ((S.tca || 0) > 0.2) out.push('QRS 增宽');
    if ((S.hematoma || 0) > 0.2) out.push('颅内压升高');
    const tox = S.tox || {};
    const benzo = E.benzodiazepineExposure(S);
    if (benzo.overdose) out.push('疑似苯二氮卓过量');
    else if (benzo.high) out.push('苯二氮卓镇静负荷偏高');
    if ((tox.op || 0) > 0) out.push('有机磷中毒');
    const apap = E.acetaminophenExposure(S);
    if (apap.known || apap.highRisk) out.push('对乙酰氨基酚过量');
    else if (apap.aboveLimit) out.push('对乙酰氨基酚用量超出参考上限');
    if ((S.withdraw || 0) > 0.15) out.push('戒断反应');
    if ((S.anaphyl || 0) > 0.15) out.push('过敏性休克');
    if ((S.bronchospasm || 0) > 0.25) out.push('支气管痉挛');
    if ((S.hemolysis || 0) > 0.15) out.push('溶血');
  }
  const env = S.env || {};
  if (env.heat) out.push('高温环境');
  if (env.cold) out.push('低温环境');
  if (env.exercise) out.push('运动中');
  if (env.sleep) out.push('睡眠');
  if (env.cooling) out.push('物理降温中');
  if (env.warming) out.push('被动保暖中');
  if (!out.length) out.push(ed ? '床旁监护中' : '生命体征平稳');
  const states = $('#states'), labels = out.join('|');
  if (states.dataset.labels === labels) return;
  states.dataset.labels = labels;
  states.innerHTML = out.map((t, i) =>
    `<button type="button" class="spill ${i === 0 && t === '生命体征平稳' ? 'ok' : ''}" data-state="${t}">${t}</button>`).join('');
  /* 点状态标签 → 术语卡 */
  document.querySelectorAll('#states .spill').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const name = el.dataset.state;
      const card = window.GLOSSARY && window.GLOSSARY.renderCard(name);
      if (card) openDetail(card.title, card.sub, card.kv, '');
      else if (window.GLOSSARY) openGlossary(name);
      else toast(name);
    });
  });
}

/* ---------------- 抽屉 ---------------- */
function isCurrentPatient(st) {
  return !!st?.running && st === S && beds[activeIdx]?.S === st;
}

function openSheet(title, sub, rows, patient) {
  stopObservation();
  const list = $('#sheetList');
  $('#sheetTitle').innerHTML = `${escapeHtml(title)} <small>${escapeHtml(sub)}</small>`;
  delete $('#sheetTitle').dataset.view;
  delete $('#sheetTitle').dataset.testGroup;
  delete $('#sheetTitle').dataset.eligible;
  delete $('#sheetTitle').dataset.observation;
  list.innerHTML = rows.map((r, i) => {
    if (r.sec) return `<div class="sec">${r.sec}</div>`;
    const button = `<button type="button" class="drow" data-i="${i}"><span class="nm">${r.n}</span>
        <span class="tag">${r.tag}</span><span class="amt">${r.amt}</span></button>`;
    return r.related ? `<div class="paired-actions">${button}<button type="button" class="related-action" data-i="${i}">${escapeHtml(r.related.label)}</button></div>` : button;
  }).join('');
  list.querySelectorAll('button[data-i]').forEach(el => {
    el.addEventListener('click', () => {
      if (!list.contains(el) || !$('#sheet').classList.contains('on')) return;
      if (!hasCurrentSaveEpoch()) return;
      if (patient && !isCurrentPatient(patient)) return;
      const row = rows[+el.dataset.i];
      if (el.classList.contains('related-action')) row.related.run();
      else row.run();
    });
  });
  $('#sheet').classList.add('on');
  $('#mask').classList.add('on');
}
let returnToLobby = false;
function closeSheet() {
  $('#sheet').classList.remove('on');
  $('#mask').classList.remove('on');
  returnToLobby = false;
}
function dismissSheet() {
  const showWard = returnToLobby;
  closeSheet();
  if (showWard) showLobby();
}

function closeDetail() {
  $('#detail').classList.remove('on');
  if (lastCaseReview || (returnToLobby && !$('#sheet').classList.contains('on'))) {
    lastCaseReview = false;
    returnToLobby = false;
    showLobby();
  }
}

function openDetail(name, sub, kv, warn) {
  stopObservation();
  const detail = $('#detail');
  delete detail.dataset.view;
  const fields = $('#dKv');
  fields.onclick = null;
  fields.removeAttribute('tabindex');
  detail.classList.remove('case-review', 'case-review-success', 'case-review-failure');
  detail.querySelector('.case-review-body')?.remove();
  detail.querySelector('.card').scrollTop = 0;
  $('#dName').textContent = name;
  $('#dSub').textContent = sub || '';
  fields.innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const w = $('#dWarn'); w.classList.remove('eligible'); w.textContent = warn || ''; w.style.display = warn ? 'block' : 'none';
  $('#detail').classList.add('on');
}

/* 给药面板按临床用途浏览，搜索保留全库范围。 */

/* 给药面板置顶：常用（补液、电解质、代谢）与急救（复苏、解毒） */
const PIN_DRUGS = {
  '常用': ['nacl', 'half_saline', 'dextrose50', 'dextrose10', 'ringer', 'kcl', 'insulin', 'calcium',
           'bicarb', 'furosemide', 'magnesium', 'hypertonic_saline', 'glucagon'],
  '急救': ['epi', 'norepi', 'atropine', 'amiodarone', 'lidocaine',
           'naloxone', 'flumazenil', 'dopamine', 'vasopressin', 'adenosine', 'isoproterenol', 'nicardipine', 'levetiracetam'],
};

const DRUG_SECTIONS = {
  '补液、电解质与血糖': ['扩容', '高渗液', '电解质', '碱性药', '酸化药', '升糖', '降糖'],
  '循环与心律': ['血管活性', '强心', '强心苷', '抗心律失常', '钙拮抗剂', 'β阻滞剂', 'ACEI', 'ARB', '硝酸酯'],
  '呼吸与过敏': ['祛痰', '平喘', '支气管扩张', '呼吸兴奋', '抗组胺'],
  '镇痛、镇静与麻醉': ['解热镇痛', 'NSAID', '阿片类', '阿片', '镇静', '肌松', '催眠药'],
  '止血与抗栓': ['止血药', '抗凝', '抗血小板', '溶栓'],
  '解毒与拮抗': ['阿片拮抗', '解毒', '解毒与拮抗'],
  '抗感染': ['抗生素', '抗菌药', '抗病毒', '抗真菌'],
  '利尿与脱水': ['袢利尿', '保钾利尿', '利尿', '利尿脱水'],
  '消化系统': ['止吐', '止泻', '抑酸'],
  '内分泌与激素': ['糖皮质激素', '甲状腺素', '抗甲状腺', '性激素', '激素拮抗'],
  '神经与精神': ['抗癫痫', '抗精神病', '抗精神病2', '心境稳定剂', '抗抑郁药', '抗帕金森', '抗胆碱能'],
  '其他精神活性物质': ['兴奋剂', '致幻剂'],
};
const drugSectionFor = new Map(Object.entries(DRUG_SECTIONS).flatMap(([section, classes]) =>
  classes.map(cls => [cls, section])));

function openDrugSheet({ tab = 'all', query = '', expanded = new Set(), scrollTop = 0, focusRow } = {}) {
  const SUB = window.SUBSTANCES;
  const patient = S;
  if (!isCurrentPatient(patient)) return;
  if (!SUB) { openSheet('给药', patient.patient.name, drugRows(), patient); return; }
  openSheet('给药', patient.patient.name + ' · 模拟药价', [], patient);
  const list = $('#sheetList');
  list.innerHTML = `
    <input id="drugSearch" type="search" aria-label="搜索全库" placeholder="搜索全库 · 药名、别名或类别">
    <div id="drugTabs" role="group" aria-label="药库范围"></div>
    <div id="drugList"></div>`;
  const input = list.querySelector('#drugSearch');
  const tabs = list.querySelector('#drugTabs');
  const host = list.querySelector('#drugList');
  const tabLabels = { all: '全部', drug: '药品', cell: '细胞·血制品', germ: '病毒·细菌', food: '食物' };
  const inTab = it => {
    if (tab === 'all') return true;
    if (tab === 'food') return it.kind === 'food';
    if (tab === 'cell') return it.cls === '血液成分' || it.cls === '扩容';
    const germ = it.cls === '病毒' || it.cls === '细菌';
    return tab === 'germ' ? germ : it.kind === 'drug' && !germ;
  };
  const drugName = name => {
    const aliases = SUB.aliasesFor(name).slice(0, 2);
    return escapeHtml(name) + (aliases.length ? `<small>（${escapeHtml(aliases.join('/'))}）</small>` : '');
  };
  const row = it => {
    const pump = it.routes?.[0]?.pumpHalfLife;
    const rate = pump ? E.pumpRate(patient, it.id) : 0;
    const dose = rate || it.dose;
    const amount = pump ? `${rate ? '当前' : '默认'} ${dose} ${it.unit}` : `${dose}${it.unit}`;
    const price = money(E.drugPrice(it, dose, patient.patient)) + (pump ? '/小时' : '');
    return `<button type="button" class="drow" data-id="${escapeHtml(it.id)}">
      <span class="nm">${drugName(it.n)}${it.note ? ' <small>· ' + escapeHtml(it.note) + '</small>' : ''}</span>
      <span class="tag">${escapeHtml(it.route)}${it.routes?.length > 1 ? ' 等' + it.routes.length + ' 途径' : ''}</span>
      <span class="amt">${escapeHtml(amount)}<br>${price}</span></button>`;
  };
  const section = (name, items) => `<details data-section="${escapeHtml(name)}"${expanded.has(name) ? ' open' : ''}>
    <summary>${escapeHtml(name)} <small>${items.length} 项</small></summary>${items.map(row).join('')}</details>`;
  const rememberGroups = () => {
    for (const group of host.querySelectorAll('details')) {
      if (group.open) expanded.add(group.dataset.section);
      else expanded.delete(group.dataset.section);
    }
  };
  function draw() {
    rememberGroups();
    const q = input.value.trim();
    if (q) {
      const matches = new Set(SUB.search(q));
      for (const it of SUB.ALL) {
        if (drugSectionFor.get(it.cls) === q) matches.add(it);
      }
      for (const [name, ids] of Object.entries(PIN_DRUGS)) {
        if (name === q) ids.map(SUB.byId).filter(Boolean).forEach(it => matches.add(it));
      }
      const unlisted = SUB.searchUnlistedDrugs(q).map(name =>
        `<div class="drow"><span class="nm">${drugName(name)}</span><span class="tag">游戏暂未收录</span></div>`).join('');
      host.innerHTML = [...matches].map(row).join('') + unlisted || '<p class="note">没有匹配的物质</p>';
      return;
    }
    const groups = new Map();
    for (const it of SUB.ALL.filter(inTab)) {
      const name = drugSectionFor.get(it.cls) || it.cls;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(it);
    }
    const pins = tab === 'all' || tab === 'drug'
      ? Object.entries(PIN_DRUGS).map(([name, ids]) => section(name, ids.map(SUB.byId).filter(Boolean))).join('') : '';
    const ordered = [...new Set([...Object.keys(DRUG_SECTIONS), ...groups.keys()])].filter(name => groups.has(name));
    host.innerHTML = pins + ordered.map(name => section(name, groups.get(name))).join('');
  }
  tabs.innerHTML = Object.entries(tabLabels).map(([id, name]) =>
    `<button type="button" class="pill" data-tab="${id}" aria-pressed="${id === tab}">${name}</button>`).join('');
  tabs.onclick = event => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    tab = button.dataset.tab;
    for (const item of tabs.children) item.setAttribute('aria-pressed', String(item === button));
    input.value = '';
    draw();
  };
  host.onclick = event => {
    const button = event.target.closest('button[data-id]');
    if (!button || !list.contains(button) || !$('#sheet').classList.contains('on') ||
        !hasCurrentSaveEpoch() || !isCurrentPatient(patient)) return;
    rememberGroups();
    const focusRow = { id: button.dataset.id, section: button.closest('details')?.dataset.section };
    const state = { tab, expanded, query: input.value, scrollTop: list.scrollTop, focusRow };
    openGiveConfig(SUB.byId(button.dataset.id), patient, () => openDrugSheet(state));
  };
  input.value = query;
  input.oninput = draw;
  draw();
  if (focusRow) {
    const buttons = host.querySelectorAll('button[data-id]');
    [...buttons].find(el => el.dataset.id === focusRow.id && el.closest('details')?.dataset.section === focusRow.section)
      ?.focus({ preventScroll: true });
  }
  list.scrollTop = scrollTop;
}

const EFF_NAME = { k:'血钾', na:'血钠', cl:'血氯', ca:'血钙', hco3:'HCO₃⁻', glu:'血糖', lac:'乳酸',
                   vol:'血容量', freeWater:'自由水', hb:'血红蛋白', hr:'心率', svr:'血管张力', sv:'心肌收缩力',
                   rr:'呼吸频率', spo2:'血氧', temp:'体温', gcs:'意识', uo:'尿量', infection:'感染负荷',
                   coag:'凝血能力', halfSaline:'低渗补液量', icp:'颅内压', estrogen:'雌激素',
                   testosterone:'睾酮', pao2:'动脉氧分压', seizure:'抽搐' };
function describeEff(eff) {
  const parts = [];
  for (const k in (eff || {})) {
    const v = eff[k];
    if (!v) continue;
    parts.push(`${EFF_NAME[k] || k}${v > 0 ? '↑' : '↓'}`);
  }
  return parts.join(' ');
}

let infusionPanel;
const infusionNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3, useGrouping: false });

function infusionAmount(dose, unit) {
  if (!Number.isFinite(dose)) return '未记录';
  return `${infusionNumber.format(dose)}${unit ? ' ' + escapeHtml(unit) : ''}`;
}

function infusionDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function infusionRecords(patient) {
  const knownOrder = order => order.infusionMinutes > 0 || /静滴|静脉滴注|输液|输注|输血|泵入|挂液/.test(order.route || '');
  const key = order => JSON.stringify([order.id || order.n, order.t, order.route]);
  const groups = new Map();
  const records = [];
  const byGivenIndex = new Map();
  (patient.given || []).forEach((given, i) => {
    if (!given || (!knownOrder(given) && !given.pumpAction)) return;
    const record = { ...given, dose: given.d, givenNumber: i + 1 };
    records.push(record);
    if (given.pumpAction) return;
    byGivenIndex.set(i, record);
    const id = key(given);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  });
  for (const pk of patient.pk || []) {
    if (!pk || !knownOrder(pk)) continue;
    const candidates = groups.get(key(pk));
    const matchesDose = record => !record.pk && (record.dose === pk.dose || pk.dose == null || record.dose == null);
    const match = pk.givenIndex != null ? byGivenIndex.get(pk.givenIndex) :
      candidates?.find(record => matchesDose(record) && (record.stoppedAt ?? null) === (pk.stoppedAt ?? null)) ||
      candidates?.find(matchesDose);
    if (!match) records.push({ ...pk, pk });
    else Object.assign(match, {
      pk, infusionMinutes: pk.infusionMinutes ?? match.infusionMinutes,
      dose: pk.dose ?? match.dose, unit: pk.unit ?? match.unit, stoppedAt: pk.stoppedAt ?? match.stoppedAt,
    });
  }
  return records;
}

function infusionSnapshot(patient) {
  const records = infusionRecords(patient);
  const timed = [], history = [], pumps = [];
  for (const record of records) {
    if (record.pumpAction && record.pumpAction !== 'stop') continue;
    const progress = E.infusionProgress(patient, record);
    if (record.pk && progress?.running) timed.push({ ...record, progress });
    else history.push({ ...record, progress, eventAt: progress?.stoppedAt ??
      (progress && !progress.running ? progress.completedAt : record.t) });
  }
  for (const [id, pump] of Object.entries(patient.pumps || {})) {
    if (!(pump?.rate > 0)) continue;
    const sub = window.SUBSTANCES?.byId(id);
    const route = sub?.routes?.find(rt => rt.pumpHalfLife);
    let startedAt, adjustedAt;
    for (let i = records.length - 1; i >= 0; i--) {
      const event = records[i];
      if (event.id !== id || !event.pumpAction) continue;
      if (event.pumpAction === 'stop') break;
      if (event.pumpAction === 'start') { startedAt = event.t; break; }
      if (event.pumpAction === 'adjust') adjustedAt ??= event.t;
    }
    pumps.push({ id, n: sub?.n || id, unit: sub?.unit, route, rate: pump.rate, startedAt, adjustedAt });
  }
  history.reverse().sort((a, b) => (b.eventAt ?? -1) - (a.eventAt ?? -1));
  return { timed, pumps, history: history.slice(0, 8) };
}

function infusionSection(label, content) {
  return `<div class="infusion-section"><dt>${label}</dt><dd>${content}</dd></div>`;
}

function infusionRow(name, status, body) {
  return `<article class="infusion-row">
    <div class="infusion-row-heading"><strong>${escapeHtml(name)}</strong><span class="infusion-status">${status}</span></div>
    ${body}
  </article>`;
}

function timedInfusionRow(record, index, selected) {
  const name = record.n || record.id;
  const { progress } = record;
  const status = progress.stoppedAt != null ? '已停止' : progress.running ? '输注中' : '已完成';
  const controls = selected ? `${progress.running ? '<button type="button" class="pill infusion-manage" data-stop-infusion>停止输注</button>' : ''}
    <button type="button" class="pill infusion-manage" data-infusion-back>返回输液与泵药</button>` :
    `<button type="button" class="pill infusion-manage" data-infusion-id="${escapeHtml(record.id)}" data-infusion-index="${index}">查看输注</button>`;
  return infusionRow(name, status, `
    <p class="infusion-meta">${escapeHtml(record.route || '定时输注')} · 开始于 ${caseTime(record.t)}${record.givenNumber ? ` · 医嘱 #${record.givenNumber}` : ''}</p>
    <progress class="infusion-progress" aria-label="${escapeHtml(name)}输注进度" max="${record.infusionMinutes}" value="0"></progress>
    <p class="infusion-amounts"><span data-infused-amount></span><span data-infusion-remaining></span></p>
    ${controls}`);
}

function openInfusions(patient) {
  if (!isCurrentPatient(patient)) return;
  const fromBedsideMenu = $('#sheet').classList.contains('on') && $('#sheetTitle').dataset.view === 'menu';
  infusionPanel = { patient, fromBedsideMenu };
  showInfusionPanel(infusionPanel);
}

function showInfusionPanel(panel) {
  const { patient, selected } = panel;
  if (!isCurrentPatient(patient)) return;
  openDetail(selected ? selected.n || selected.id : '当前输液与泵药', `床位 ${activeIdx + 1} · ${patient.patient.name}`, [], '');
  $('#detail').dataset.view = 'infusions';
  const list = $('#dKv');
  list.tabIndex = 0;
  list.onclick = event => handleInfusionAction(event, panel);
  panel.markup = '';
  refreshInfusions(patient);
  const target = [...list.querySelectorAll('[data-pump-id], [data-infusion-index]')].find(button =>
    (panel.focusPump && button.dataset.pumpId === panel.focusPump) ||
    (panel.focusOrder && panel.timed[+button.dataset.infusionIndex]?.pk === panel.focusOrder));
  (target || list.querySelector('[data-infusion-back]') || $('#detailX')).focus({ preventScroll: true });
  if (!selected) {
    $('#detail .card').scrollTop = panel.cardTop || 0;
    list.scrollTop = panel.listTop || 0;
  }
  panel.focusOrder = panel.focusPump = null;
}

function handleInfusionAction(event, panel) {
  const { patient, selected } = panel;
  const button = event.target.closest('button');
  const list = $('#dKv'), detail = $('#detail');
  if (!button || !list.contains(button) || panel !== infusionPanel || !isCurrentPatient(patient) || !hasCurrentSaveEpoch() ||
      detail.dataset.view !== 'infusions' || !detail.classList.contains('on')) return;

  if (button.hasAttribute('data-stop-infusion')) {
    if (E.stopInfusion(patient, selected?.pk)) {
      const entry = patient.log.at(-1);
      markEvent(entry);
      saveGame();
      toast(escapeHtml(entry[1]));
      renderAll();
    }
    panel.selected = null;
    showInfusionPanel(panel);
    return;
  }
  if (button.hasAttribute('data-infusion-back')) {
    panel.focusOrder = selected?.pk;
    panel.selected = null;
    showInfusionPanel(panel);
    return;
  }

  panel.cardTop = detail.querySelector('.card').scrollTop;
  panel.listTop = list.scrollTop;
  if (button.hasAttribute('data-infusion-index')) {
    panel.selected = panel.timed[+button.dataset.infusionIndex];
    if (panel.selected) showInfusionPanel(panel);
    return;
  }
  const pumpId = button.dataset.pumpId;
  if (!pumpId || E.pumpRate(patient, pumpId) <= 0) return;
  const sub = window.SUBSTANCES?.byId(pumpId);
  if (!sub) return;
  panel.focusPump = pumpId;
  closeDetail();
  openSheet(sub.n, patient.patient.name, [], patient);
  openGiveConfig(sub, patient, () => {
    closeSheet();
    if (panel.fromBedsideMenu) openBedsideMenu();
    showInfusionPanel(panel);
  }, { backLabel: '返回输液与泵药', returnAfterApply: true });
}

function refreshInfusions(patient) {
  const detail = $('#detail');
  const panel = infusionPanel;
  if (!detail.classList.contains('on') || detail.dataset.view !== 'infusions' ||
      panel?.patient !== patient || !isCurrentPatient(patient)) return;
  const { timed, pumps, history } = infusionSnapshot(patient);
  const previousTimed = panel.timed;
  panel.timed = timed;
  const selected = panel.selected;
  const selectedRecord = selected && (timed.find(record => record.pk === selected.pk) || history.find(record => record.pk === selected.pk) ||
    { ...selected, progress: E.infusionProgress(patient, selected.pk) });
  const timedRows = selected ? (selectedRecord?.progress ? [selectedRecord] : []) : timed;
  const activeRows = timedRows.map((record, i) => timedInfusionRow(record, i, selected)).join('') + (selected ? '' : pumps.map(pump =>
    infusionRow(pump.n, '持续泵入', `
      <p class="infusion-meta">当前泵速 <strong>${infusionAmount(pump.rate, pump.unit)}</strong></p>
      <p class="infusion-meta">本轮启动 ${caseTime(pump.startedAt)} · 最近调速 ${pump.adjustedAt != null ?
        caseTime(pump.adjustedAt) : pump.startedAt != null ? '尚未调速' : '时间未记录'}</p>
      <p class="infusion-meta" data-pump-duration></p>
      ${pump.route ? `<button type="button" class="pill infusion-manage" data-pump-id="${escapeHtml(pump.id)}">调速或停用</button>` : ''}`)).join(''));
  const historyRows = selected ? '' : history.map(record => {
    const { progress } = record;
    const status = record.pumpAction === 'stop' ? '已停泵' : progress?.stoppedAt != null ? '已停止' :
      progress && !progress.running ? '已完成' : '单次医嘱';
    const amount = record.pumpAction === 'stop' ? `停泵前 ${infusionAmount(record.dose, record.unit)}` : progress && !progress.running
      ? `已输 ${infusionAmount(progress.deliveredDose, record.unit)} / ${infusionAmount(progress.totalDose, record.unit)}`
      : `${infusionAmount(record.dose, record.unit)} · ${progress ? '无在输记录' : '未记录输注时长'}`;
    return infusionRow(record.n || record.id, status,
      `<p class="infusion-meta">${caseTime(record.eventAt)} · ${escapeHtml(record.route || '输注')} · ${amount}${record.givenNumber ? ` · 医嘱 #${record.givenNumber}` : ''}</p>`);
  }).join('');
  const empty = selected ? '<p class="infusion-empty">这条输注已结束。</p><button type="button" class="pill infusion-manage" data-infusion-back>返回输液与泵药</button>' :
    '<p class="infusion-empty">本床暂无正在进行的输液或泵药。</p>';
  const markup = infusionSection(selected ? '输注详情' : '正在进行', activeRows || empty) +
    (historyRows ? infusionSection('近期输注相关记录', historyRows) : '');
  const list = $('#dKv');
  if (markup !== panel.markup) {
    const card = detail.querySelector('.card');
    const cardTop = card.scrollTop, listTop = list.scrollTop;
    const focus = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedPump = focus?.dataset.pumpId;
    const focusedOrder = previousTimed?.[+focus?.dataset.infusionIndex]?.pk;
    list.innerHTML = panel.markup = markup;
    if (focus && focus !== list) {
      const next = [...list.querySelectorAll('button')].find(button =>
        (focusedPump && button.dataset.pumpId === focusedPump) ||
        (focusedOrder && timed[+button.dataset.infusionIndex]?.pk === focusedOrder) ||
        (focus.hasAttribute('data-infusion-back') && button.hasAttribute('data-infusion-back')) ||
        (focus.hasAttribute('data-stop-infusion') && button.hasAttribute('data-stop-infusion')));
      (next || list.querySelector('[data-infusion-back]') || $('#detailX')).focus({ preventScroll: true });
    }
    card.scrollTop = cardTop;
    list.scrollTop = listTop;
  }
  const progressBars = list.querySelectorAll('.infusion-progress');
  timedRows.forEach((record, index) => {
    const progress = progressBars[index], data = record.progress;
    progress.value = data.elapsedMinutes;
    const amount = progress.parentElement.querySelector('[data-infused-amount]');
    amount.innerHTML = `已输 ${infusionAmount(data.deliveredDose, record.unit)} / ${infusionAmount(data.totalDose, record.unit)}`;
    const remaining = progress.parentElement.querySelector('[data-infusion-remaining]');
    remaining.textContent = data.stoppedAt != null ? `停于 ${caseTime(data.stoppedAt)}` :
      `剩余 ${infusionDuration(Math.ceil(data.remainingMinutes * 60 - 1e-8))}`;
  });
  if (!selected) list.querySelectorAll('[data-pump-duration]').forEach((el, i) => {
    const at = pumps[i].startedAt;
    el.textContent = `累计泵入 ${at == null ? '未记录' : infusionDuration(Math.max(0, Math.floor(patient.t - at)))}`;
  });
}


/* 选完药 → 选途径 + 调剂量（允许给错、给过量） */
function openGiveConfig(it, patient, back, { backLabel = '返回药物列表', returnAfterApply = false } = {}) {
  const routes = (it.routes && it.routes.length) ? it.routes : [{ r: it.route, d: it.dose, on: it.onset, du: it.dur }];
  let ri = 0;
  let dose = E.pumpRate(patient, it.id) || routes[0].d;
  const fmt = v => (Math.round(v * 100) / 100).toString();

  const render = () => {
    if (!isCurrentPatient(patient)) return;
    const rt = routes[ri];
    const infusion = rt.infusionMinutes;
    const pump = rt.pumpHalfLife;
    const minimum = rt.pumpStep ?? 0.01;
    const precision = String(minimum).split('.')[1]?.length ?? 0;
    const roundDose = value => +value.toFixed(precision);
    const currentRate = pump ? E.pumpRate(patient, it.id) : 0;
    const sameRate = pump && currentRate === dose;
    const order = pump ? (sameRate ? '维持当前泵速' : E.pumpOrder(it.n, currentRate ? 'adjust' : 'start', dose, it.unit))
      : infusion ? `开始${rt.r} ${it.n}（${E.infusionDetails(dose, it.unit, infusion)}）`
        : `给予 ${it.n} ${fmt(dose)}${it.unit}`;
    const hi = rt.maxDose ?? it.doseRange?.[1] ?? rt.d * 10;
    const over = dose > (rt.maxDose ?? rt.d * 2.5), under = dose < rt.d * 0.4;
    const doseLabel = pump ? '泵速' : '剂量';
    const price = E.drugPrice(it, dose, patient.patient);
    const quote = pump ? '按此泵速每小时' : '本次';
    const feeLabel = it.kind === 'food' ? '饮食费' : it.cls === '血液成分' || rt.r === '输血' ? '血液成分费用'
      : it.kind === 'virus' ? '模拟暴露费用' : '药费';
    const selfPay = realismRules.insurance && patient.ins
      ? costSummary(patient, price).selfPay - costSummary(patient).selfPay : null;
    const warn = over ? `⚠ ${doseLabel}明显高于常规，注意中毒风险`
                : under ? `⚠ ${doseLabel}偏低，可能达不到治疗浓度` : '';
    $('#sheetTitle').innerHTML = `${it.n} <small>${escapeHtml(patient.patient.name)} · ${it.cls}</small>`;
    $('#sheetList').innerHTML = `
      <div style="padding:2px 14px 14px">
        <button type="button" id="drugBack" class="pill">${backLabel}</button>
        ${routes.length > 1 ? `<div class="sec">给药途径</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;padding:0 0 14px">
            ${routes.map((x, i) => `<span class="pill" data-ri="${i}" style="cursor:pointer;${i === ri ? 'background:#f7e6e6;color:#a33;font-weight:700' : ''}">${x.r}</span>`).join('')}
          </div>` : ''}
        ${pump ? `<div class="sec">${rt.r} · ${currentRate ? `当前泵速 ${currentRate} ${it.unit}` : '未泵入'}</div>` : ''}
        <div class="sec">${pump ? (currentRate ? '调整泵速' : '起始泵速') : infusion ? '输注总量' : '剂量'}</div>
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0 10px">
          <button id="dMinus" class="pill" style="width:46px;height:46px;font-size:22px;cursor:pointer">−</button>
          <div style="flex:1;text-align:center">
            <span style="font-family:var(--mono);font-size:28px;font-weight:600">${pump ? dose : fmt(dose)}</span>
            <span style="font-size:13px;color:#9a9a9a"> ${it.unit}</span>
          </div>
          <button id="dPlus" class="pill" ${dose >= hi ? 'disabled' : ''} style="width:46px;height:46px;font-size:22px;cursor:pointer">+</button>
        </div>
        <div style="display:flex;gap:6px;justify-content:center;padding-bottom:10px">
          ${[0.5, 1, 2, 5].filter(f => !rt.maxDose || rt.d * f <= hi).map(f => `<button type="button" class="pill" data-mul="${f}" style="cursor:pointer;${Math.abs(dose - rt.d * f) < 1e-6 ? 'font-weight:700;color:#a33' : ''}">${f === 1 ? '常规' : f + '×'}</button>`).join('')}
        </div>
        ${warn ? `<div class="note" style="margin-bottom:10px;color:#a33;background:#fdf3f2">${warn}</div>` : ''}
        <div class="note" style="margin-bottom:12px;font-size:11.5px">
          ${quote}${feeLabel} ${money(price)}${selfPay == null ? '' : ' · 预计新增自付 ' + money(selfPay)}<br>
          ${rt.maxDose ? `本方案${doseLabel}上限 ${rt.maxDose} ${it.unit}<br>` : ''}
          ${infusion ? `${rt.r} · 输注时长 ${infusion} 分钟<br>` : ''}
          ${pump ? `持续至手动停泵 · 模拟血药浓度半衰期约 ${pump} 分钟`
            : `起效 ${rt.on} min · ${infusion ? '药效' : ''}维持 ${rt.du} min`} · 效应 ${describeEff(it.eff) || '—'}
          ${it.note ? '<br>' + it.note : ''}
        </div>
        <button id="dGo" class="pill" ${sameRate ? 'disabled' : ''} style="width:100%;padding:14px;font-size:16px;font-weight:700;cursor:${sameRate ? 'default' : 'pointer'};background:${over ? '#f7e6e6' : '#fff'}">
          ${order}
        </button>
        ${currentRate ? '<button type="button" id="dStop" class="pill" style="width:100%;margin-top:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer">停止泵入</button>' : ''}
      </div>`;

    $('#drugBack').onclick = () => { if (isCurrentPatient(patient)) back(); };
    $('#sheetList').querySelectorAll('[data-ri]').forEach(el => {
      el.addEventListener('click', () => { ri = +el.dataset.ri; dose = routes[ri].d; render(); });
    });
    $('#sheetList').querySelectorAll('[data-mul]').forEach(el => {
      el.addEventListener('click', () => { dose = Math.max(minimum, roundDose(rt.d * +el.dataset.mul)); render(); });
    });
    const step = rt.pumpStep ?? Math.max(minimum, roundDose(rt.d / 4));
    const mi = $('#sheetList').querySelector('#dMinus'), pl = $('#sheetList').querySelector('#dPlus');
    if (mi) mi.addEventListener('click', () => { dose = Math.max(Math.min(dose, minimum), roundDose(dose - step)); render(); });
    if (pl) pl.addEventListener('click', () => { dose = Math.min(hi, roundDose(dose + step)); render(); });
    const execute = (event, stop) => {
      if (!$('#sheetList').contains(event.currentTarget) || !$('#sheet').classList.contains('on') || !isCurrentPatient(patient)) return;
      const result = stop ? E.stopPump(patient, it.id) : E.give(patient, it.id, dose, rt.r);
      if (result == null) return;
      const entry = patient.log[patient.log.length - 1];
      checkBudget();
      if (window.SOUND && !stop) SOUND.drug();
      if (currentRate) markEvent(entry);
      else judge('drug', it.id, null, entry);
      saveGame();
      closeSheet();
      toast(pump || infusion ? entry[1] : `已${order}（${rt.r}）`);
      renderAll();
      if (returnAfterApply) back();
    };
    $('#sheetList').querySelector('#dGo').addEventListener('click', event => execute(event, false));
    $('#sheetList').querySelector('#dStop')?.addEventListener('click', event => execute(event, true));
  };
  render();
}

function syncEnvSheet() {
  if ($('#sheetTitle').dataset.view !== 'env' || !$('#sheet').classList.contains('on')) return;
  for (const button of $('#sheetList').querySelectorAll('[data-env]')) {
    const on = !!S.env?.[button.dataset.env];
    if (button.getAttribute('aria-pressed') === String(on)) continue;
    button.setAttribute('aria-pressed', String(on));
    button.querySelector('.tag').textContent = on ? '开' : '关';
  }
}

function openEnvControls(patient, title, controls, allowReset = false) {
  if (!isCurrentPatient(patient)) return;
  const update = label => {
    patient.log.push([E.fmt(patient.t), label, 'info', patient.t, null, true]);
    saveGame();
    renderStates();
    syncEnvSheet();
  };
  const rows = controls.map(([key, n, amt = '', unavailable = '']) => ({
    key, n, tag: '', amt,
    run: () => {
      const on = !patient.env?.[key];
      const env = E.setEnv(patient, key, on);
      if (on && !env[key]) return toast(unavailable);
      update((on ? '开启' : '关闭') + n);
    },
  }));
  if (allowReset) rows.push({ n: '恢复正常', tag: '', amt: '', run: () => {
    const active = controls.filter(([key]) => patient.env?.[key]);
    if (!active.length) return;
    for (const [key] of active) E.setEnv(patient, key, false);
    update('恢复正常环境与活动');
  }});
  openSheet(title, patient.patient.name, rows, patient);
  for (const button of $('#sheetList').querySelectorAll('.drow')) {
    const key = rows[+button.dataset.i].key;
    if (key) button.dataset.env = key;
  }
  $('#sheetTitle').dataset.view = 'env';
  syncEnvSheet();
}

function openTemperatureSheet(patient) {
  openEnvControls(patient, '体温处置', [
    ['cooling', '物理降温', '降至 38.5℃ 自动停止', '体温高于 38.5℃ 时可开启物理降温'],
    ['warming', '被动保暖', '回升至 36.1℃ 自动停止', '体温低于 36.1℃ 时可开启被动保暖'],
  ]);
}

function openEnvSheet(patient) {
  openEnvControls(patient, '环境 / 场景', [
    ['heat', '炎热环境'],
    ['cold', '寒冷环境'],
    ['exercise', '运动'],
    ['sleep', '睡眠'],
  ], true);
}

/* 给药列表（旧接口，保留给不支持 SUBSTANCES 的场合） */
function drugRows() {
  return Object.entries(E.DRUGS).map(([id, d]) => ({
    n: d.name, tag: d.routes?.[0] || '', amt: d.defaultDose + ' ' + d.unit + ' · ' + money(E.drugPrice(d, d.defaultDose, S.patient)),
    run: () => {
      const route = (d.routes && d.routes[0]) || '';
      E.give(S, id, d.defaultDose, route);
      checkBudget();
      if (window.SOUND) SOUND.drug();
      judge('drug', id);
      saveGame();
      closeSheet();
      toast(`已给予 ${d.name} ${d.defaultDose}${d.unit}（${route}）`);
      openDetail(d.name, `${d.defaultDose} ${d.unit} · ${route}`, [['说明', d.desc]], '');
      renderAll();
    },
  }));
}
function deliveryStatus(patient) {
  if (patient.delivered) return patient.deliveryAt == null ? '已分娩' : '产后 ' + caseTime(patient.t - patient.deliveryAt);
  if (patient.deliveryStartedAt == null) return '待评估';
  const seconds = Math.max(0, patient.deliveryStartedAt + E.DELIVERY_DURATION - patient.t);
  return '分娩进行中 · 剩余 ' + caseTime(seconds);
}

function reviewDelivery(patient) {
  const s = E.snapshot(patient);
  const ongoing = patient.delivered || patient.deliveryStartedAt != null;
  const rows = [
    { sec: patient.delivered ? '产后观察 · 重度子痫前期' : '病例情况 · 孕 34 周，重度子痫前期' },
    { sec: `母体当前 · 血压 ${s.sys}/${s.dia} mmHg，SpO₂ ${s.spo2 == null ? '无信号' : s.spo2 + '%'}，FiO₂ ${Math.round(s.fio2 * 100)}%` },
    ...(patient.delivered ? [
      { sec: '分娩记录 · ' + (patient.deliveryRecord ? escapeHtml(patient.deliveryRecord.maternal) : '旧病历仅记录了分娩完成') },
      { sec: '新生儿 · ' + (patient.deliveryRecord ? escapeHtml(patient.deliveryRecord.newborn) : '旧病历未记录去向') },
    ] : [
      { sec: '胎儿 · 当前病例未提供胎心监护。分娩后由新生儿科接手观察。' },
      { sec: '产科团队接手后，分娩方式和产程合并模拟。经过 ' + E.DELIVERY_DURATION / 60 + ' 分钟模拟时间完成分娩，胎盘娩出后开始产后观察。' },
    ]),
    { n: ongoing ? '返回操作' : '暂缓分娩', tag: deliveryStatus(patient), amt: '返回', run: () => openSheet('操作', patient.patient.name, actionRows(), patient) },
  ];
  if (!ongoing) rows.push({ n: '确认启动分娩', tag: '启动后持续至分娩完成', amt: '¥' + E.ACTIONS.delivery.cost,
    run: () => performAction('delivery', E.ACTIONS.delivery) });
  openSheet('产科分娩评估', patient.patient.name, rows, patient);
}

function openRespiratoryFlow(patient) {
  if (!isCurrentPatient(patient)) return;
  const ventilated = !!patient.vent;
  const settings = ventilated ? E.ventilatorSettings(patient) : E.oxygenSettings(patient);
  const name = ventilated ? '呼吸机吸气流量' : '氧疗供氧流量';
  openSheet(name, patient.patient.name, [], patient);
  const list = $('#sheetList');
  const info = ventilated
    ? `机械通气 · 当前送气量 ${Math.round(settings.deliveredTidalVolume)} mL · 送气时间 ${settings.deliveryTime.toFixed(2)} 秒`
    : '自主呼吸 · 0 L/min 停止吸氧，实际吸入氧浓度随呼吸需求变化';
  list.innerHTML = `<form class="flow-settings">
    <label for="respFlowInput">${name} <output for="respFlowInput">${settings.flow}</output> L/min</label>
    <input id="respFlowInput" type="range" min="${settings.minFlow}" max="${settings.maxFlow}" step="${ventilated ? 1 : 0.1}" value="${settings.flow}">
    <div class="flow-scale" aria-hidden="true"><span>${settings.minFlow}</span><span>${settings.maxFlow} L/min</span></div>
    <p>${info}</p>
    <button class="pill" type="submit">应用流量</button>
  </form>`;
  const form = list.querySelector('form');
  const slider = form.querySelector('input');
  const output = form.querySelector('output');
  function showValue() {
    output.value = slider.value;
    slider.setAttribute('aria-valuetext', slider.value + ' L/min');
  }
  showValue();
  slider.addEventListener('input', showValue);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!list.contains(form) || !$('#sheet').classList.contains('on') || !hasCurrentSaveEpoch() || !isCurrentPatient(patient)) return;
    if (!!patient.vent !== ventilated) { openRespiratoryFlow(patient); return; }
    const setFlow = ventilated ? E.setVentilatorFlow : E.setOxygenFlow;
    if (setFlow(patient, slider.valueAsNumber)) {
      const entry = patient.log.at(-1);
      markEvent(entry);
      entry[5] = true;
      window.SOUND?.click();
      saveGame();
      toast(entry[1]);
    }
    closeSheet();
    renderAll();
  });
}

function actionRows() {
  const patient = S;
  const ed = isEDIntake(patient);
  const canRequestObstetrics = ed ? patient.patient.sex === '女' : patient.tags.includes('preeclampsia');
  const actions = Object.entries(E.ACTIONS).filter(([id]) => id !== 'delivery' || canRequestObstetrics).map(([id, a]) => {
    if (ed && id === 'delivery') return {
      n: '产科会诊', tag: '', amt: '评估', run: () => {
        const weeks = E.knownResults(patient).gestationalWeeks?.value;
        if (patient.deliveryStartedAt != null || patient.delivered || (weeks >= 28 && patient.tags.includes('preeclampsia'))) {
          reviewDelivery(patient);
        } else {
          openDetail('产科会诊', patient.patient.name, [['资料', '请结合妊娠病史、床旁情况和盆腔超声评估分娩指征。']], '');
        }
      },
    };
    if (id === 'delivery') return {
      n: S.delivered || S.deliveryStartedAt != null ? '查看产科进程' : a.name,
      tag: deliveryStatus(S), amt: '查看', run: () => reviewDelivery(S),
    };
    if (id === 'intubate' && patient.vent) return { n: '调节呼吸机吸气流量',
      tag: `${E.ventilatorSettings(patient).flow} L/min`, amt: '调节', run: () => openRespiratoryFlow(patient) };
    if (id === 'oxygen' && !patient.vent) return { n: '调节氧疗供氧流量',
      tag: `${E.oxygenSettings(patient).flow} L/min`, amt: '调节', run: () => openRespiratoryFlow(patient),
      related: { label: a.name, run: () => performAction(id, a) } };
    const name = id === 'oxygen_off' && S.vent ? '将呼吸机 FiO₂ 调至 21%' :
      id === 'oxygen' && S.vent ? '将呼吸机 FiO₂ 调至 100%' : a.name;
    return { n: name, tag: '', amt: a.cost ? '¥' + a.cost : '—', run: () => performAction(id, a) };
  });
  return [{ n: '体温处置', tag: '物理降温 · 被动保暖', amt: '查看', run: () => openTemperatureSheet(patient) }, ...actions];
}

function performAction(id, a) {
  const assessment = MENTOR.evaluate(S, 'action', id);
  const last = S.log.length;
  a.apply(S);
  const result = S.log.length > last ? S.log[S.log.length - 1] : null;
  if (!result) { toast('当前处置状态没有变化'); return; }
  if (a.cost && result[2] === 'good') S.cost += a.cost;
  checkBudget();
  if (window.SOUND) SOUND.click();
  const feedback = result[2] === 'good' ? { ...assessment, msg: assessment.msg || result[1] } : {
    ok: (id === 'defib' && assessment.ok) || result[2] === 'info',
    msg: result[1],
  };
  closeSheet();
  judge('action', id, feedback, result);
  if (isEDIntake(S)) {
    const visibleResult = ['defib', 'cpr', 'oxygen', 'oxygen_off', 'intubate', 'extubate', 'pace', 'catheter'].includes(id);
    const message = visibleResult || result[2] === 'good' ? result[1] : `${a.name} · 处置未执行，请复评`;
    result[5] = message; // 保留首诊当时实际展示的处置回执。
    toast(message, result[2] === 'bad');
  } else if (level === 'expert') toast(result[1], result[2] === 'warn' || result[2] === 'bad');
  saveGame();
  renderAll();
}
function caseTime(time) {
  return Number.isFinite(time) ? E.fmt(time) + ':' + String(Math.floor(time % 60)).padStart(2, '0') : '时间未记录';
}

function reportRows(report, previous) {
  const label = { exam: '查体时间', procedure: '操作时间' }[report.kind] || '采集时间';
  const times = [[label, caseTime(report.sampledAt)]];
  if (report.kind !== 'exam' && report.kind !== 'procedure') times.push(['回报时间', caseTime(report.reportedAt)]);
  if (previous) times.push(['上次对照', caseTime(previous.sampledAt) + '（上次 → 本次）']);
  const values = report.rows.map(({ label, value, flag }) => {
    const before = previous?.rows.find(row => row.label === label);
    const reading = before && before.value !== value ? before.value + ' → ' + value : value;
    return [escapeHtml(label), escapeHtml(reading + (flag ? ' ' + flag : ''))];
  });
  return [...times, ...values];
}

function reportDetails(report, title = report.name, previous) {
  const fields = reportRows(report, previous).map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
  return `<details data-report-id="${escapeHtml(report.id)}"><summary>${escapeHtml(title)}</summary><dl>${fields}</dl></details>`;
}

function openReportType(patient, type) {
  const reports = E.reports(patient, type);
  const latest = reports.at(-1);
  if (!latest) return;
  const rows = reportRows(latest, reports.at(-2));
  if (reports.length > 1) rows.push(['此前记录', reports.slice(0, -1).reverse()
    .map(report => reportDetails(report, report.name + ' · ' + caseTime(report.sampledAt))).join('')]);
  openDetail(latest.name, patient.patient.name, rows, '');
}

function performExam(patient, id) {
  if (!isCurrentPatient(patient)) return;
  if (!E.examine(patient, id)) return;
  saveGame();
  if ($('#sheet').classList.contains('on') && $('#sheetTitle').dataset.view === 'exams') openExamList(patient);
  openReportType(patient, id);
}

function examineLungs() {
  performExam(S, 'lungs');
}

function openChecks(patient) {
  if (!isCurrentPatient(patient)) return;
  const rows = [
    { n: '问诊与院前资料', tag: '患者、陪同者与既有记录', amt: '选择来源', run: () => openHistorySources(patient) },
    { n: '床旁查体', tag: '选部位观察、触诊或听诊', amt: '选择项目', run: () => openExamList(patient) },
    { sec: '辅助检查' },
    ...E.TEST_GROUPS.map(group => {
      const tests = Object.values(E.TESTS).filter(test => test.group === group.id);
      return { n: group.name, tag: '', amt: tests.length + ' 项', run: () => openTestGroup(patient, group.id) };
    }),
  ];
  openSheet('检查', patient.patient.name, rows, patient);
}

function openExamList(patient) {
  const rows = [];
  for (const group of E.EXAM_GROUPS) {
    const exams = Object.entries(E.EXAMS).filter(([, exam]) => exam.group === group.id);
    if (!exams.length) continue;
    rows.push({ sec: group.name });
    for (const [id, exam] of exams) {
      rows.push({ n: exam.name, tag: '', amt: '查体', run: () => performExam(patient, id),
        related: E.reports(patient, id).length ? { label: '上次记录', run: () => openReportType(patient, id) } : null });
    }
  }
  rows.push({ n: '返回检查', tag: '', amt: '返回', run: () => openChecks(patient) });
  openSheet('床旁查体', patient.patient.name, rows, patient);
  $('#sheetTitle').dataset.view = 'exams';
}

function openTestGroup(patient, id) {
  const group = E.TEST_GROUPS.find(item => item.id === id);
  if (!group) return;
  const rows = testRows(patient, id);
  rows.push({ n: '返回检查', tag: '', amt: '返回', run: () => openChecks(patient) });
  openSheet(group.name, patient.patient.name, rows, patient);
  $('#sheetTitle').dataset.testGroup = id;
}

function dischargeMenuRows(patient) {
  if (!isCurrentPatient(patient)) return [];
  if (realismRules.signedDischarge) {
    return [{ n: '办理出院', tag: '', amt: '签字', run: () => confirmSignedDischarge(patient) }];
  }
  const assessment = E.dischargeCheck(patient);
  const rows = [{
    n: assessment.ok ? '办理出院' : '出院评估', tag: '', amt: assessment.ok ? '办理' : '查看',
    run: () => {
      if (!isCurrentPatient(patient) || !hasCurrentWard()) return;
      const current = E.dischargeCheck(patient);
      if (assessment.ok && current.ok) {
        E.endCase(patient, 'discharge', '达到出院标准');
        settleBeds();
        return;
      }
      if (isEDIntake(patient)) {
        openDetail('出院评估', patient.patient.name, [['评估结果', current.ok ? '已达到出院标准，可返回菜单办理。' : '暂未达到出院标准，请结合床旁查体和已回报的检查复评。']], '');
        return;
      }
      const rows = [
        ['本例治疗目标', escapeHtml(patient.cas.goals.join('；'))],
        ['出院心率范围', current.heartRateTarget],
        ['当前心率', '<span id="dischargeHr"></span>'],
        ['当前血压', '<span id="dischargeBp"></span>'],
      ];
      if (patient.tags.includes('htn')) {
        rows.push(['循环指标', '<span id="assessmentTone"></span> <button type="button" class="pill" id="inspectTone">查看心脏面板</button>']);
      }
      if (patient.tags.includes('preeclampsia')) rows.push(['产科进程', deliveryStatus(patient)]);
      openDetail('出院评估', patient.patient.name, rows, current.reasons.join('\n'));
      $('#detail').dataset.view = 'discharge';
      refreshDischargeAssessment(patient, current);
      $('#inspectTone')?.addEventListener('click', () => {
        if (!isCurrentPatient(patient)) return;
        closeSheet();
        closeDetail();
        selectOrgan('heart');
        $('#vascularTone').scrollIntoView({ block: 'nearest' });
        $('#opTitle').focus({ preventScroll: true });
      });

    },
  }];
  if (!isEDIntake(patient) && canStartObservation(patient, assessment)) {
    rows.push({ n: '稳定期留观快进', tag: '达到观察目标、遇重症或报告回报时停止', amt: '最多 6 小时', run: startObservation });
  }
  return rows;
}

function confirmSignedDischarge(patient) {
  openSheet('是否签字出院？', patient.patient.name, [
    { n: '取消', tag: '', amt: '', run: openBedsideMenu },
    { n: '确认签字出院', tag: '', amt: '', run: () => {
      if (!hasCurrentWard() || !realismRules.signedDischarge) return;
      if (E.signDischarge(patient)) settleBeds();
    } },
  ], patient);
}

function refreshDischargeAssessment(patient, assessment) {
  const pressure = E.bp(patient);
  $('#dischargeHr').textContent = Math.round(patient.hr) + ' 次/分';
  $('#dischargeBp').textContent = `${pressure.sys}/${pressure.dia} mmHg · MAP ${pressure.map} mmHg`;
  const tone = $('#assessmentTone');
  if (tone) {
    const reading = CASEGEN.vascularTone(patient);
    tone.textContent = reading.controlled ? reading.text : '';
  }
  const warning = $('#dWarn');
  warning.classList.toggle('eligible', assessment.ok);
  const message = assessment.ok ? '已达到出院标准，可返回菜单办理出院。' : assessment.reasons.join('\n');
  if (message !== warning.textContent) warning.textContent = message;
  warning.style.display = 'block';
}

function testRows(patient, group) {
  return Object.entries(E.TESTS).filter(([, test]) => test.group === group).map(([id, t]) => ({
    n: t.name, tag: patient.tests[id] && !patient.tests[id].done ? '待出报告' : t.min + ' min',
    related: E.reports(patient, id).length
      ? { label: '查看上次报告', run: () => openReportType(patient, id) } : null,
    amt: patient.tests[id] && !patient.tests[id].done ? '预计 ' + caseTime(patient.tests[id].readyAt) : '¥' + t.cost,
    run: () => {
      const order = patient.tests[id];
      if (order && !order.done) {
        toast(t.name + '已开单，预计 ' + caseTime(order.readyAt) + ' 出报告');
        return;
      }
      E.orderTest(patient, id);
      checkBudget();
      saveGame();
      closeSheet();
      toast(`已开 ${t.name}，${t.min} 分钟后出结果`);
      renderAll();
    },
  }));
}


/* ---------------- 上级医师 ---------------- */
const MENTOR = window.MENTOR;
let mentorBar = null;
function ensureMentorDOM() {
  if (mentorBar) return;
  const wrap = document.createElement('div');
  const slot = document.getElementById('mentorSlot');
  wrap.id = 'mentorWrap';
  if (!slot) wrap.style.cssText = 'position:fixed;left:14px;bottom:78px;max-width:330px;z-index:15';
  wrap.innerHTML = `<div id="mentorCard" style="background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:10px 13px;
      box-shadow:0 6px 24px rgba(0,0,0,.10);font-size:12.5px;line-height:1.55;display:none">
      <div style="font-size:10px;letter-spacing:1.2px;color:var(--ink-3);margin-bottom:4px">
        上级医师 · <span id="mLevel"></span></div>
      <div id="mText"></div></div>`;
  (slot || document.body).appendChild(wrap);
  mentorBar = wrap;
  const pill = document.createElement('span');
  pill.id = 'levelPill';
  pill.className = 'pill';
  pill.style.cssText = 'cursor:pointer;font-size:11.5px;color:#8a7a7a';
  pill.textContent = '上级医生：实习';
  pill.addEventListener('click', () => openSheet('难度', '影响提示详略与计分', levelRows()));
  document.querySelector('.top').insertBefore(pill, document.querySelector('.top .sp'));
  const ask = document.createElement('span');
  ask.id = 'btnAsk';
  ask.className = 'pill';
  ask.style.cssText = 'cursor:pointer;font-size:11.5px;margin-left:6px';
  ask.textContent = '问上级';
  ask.addEventListener('click', () => showAdvice(true));
  document.querySelector('.top').insertBefore(ask, document.querySelector('.top .sp'));
}

function levelRows() {
  return Object.entries(MENTOR.LEVELS).map(([id, L]) => ({
    n: L.name, tag: L.note, amt: id === level ? '当前' : '',
    run: () => { level = id; try { localStorage.setItem('life.level', id); } catch (e) {} syncLevel(); dismissSheet(); if (S) showAdvice(true); },
  }));
}
function syncLevel() {
  const p = document.getElementById('levelPill');
  if (p) p.textContent = '上级医生：' + (MENTOR.LEVELS[level] || MENTOR.LEVELS.intern).name;
  const l = document.getElementById('mLevel');
  if (l) l.textContent = (MENTOR.LEVELS[level] || {}).name || '';
}
function showAdvice(force) {
  if (!MENTOR) return;
  const card = document.getElementById('mentorCard');
  const txt = document.getElementById('mText');
  if (!card || !S) return;
  if (isEDIntake(S)) {
    if (!force) {
      card.style.display = 'none';
      return;
    }
    const reason = edAttentionReason(S);
    const pending = Object.values(S.tests).some(order => !order.done);
    txt.textContent = reason ? `监护或床旁观察提示${reason}。先评估气道、呼吸和循环，再选择检查。` :
      pending ? '已有检查待回报。可继续问诊、查体，结合报告复评。' :
        '先看生命体征和接诊资料，再按主诉补充问诊、查体和检查。复评时留意各次检查的采样时间。';
    card.style.display = 'block';
    syncLevel();
    return;
  }
  if (!force && !autoHint) {
    /* 求助制：不问就不显示；点评后保留 20 秒让玩家看清 */
    if (S._lastJudgeAt != null && (S.t - S._lastJudgeAt) < 20) {
      const lastJudge = S.log.slice().reverse().find(row => typeof row[1] === 'string' && row[1].startsWith('带教点评：'));
      if (lastJudge) {
        txt.textContent = (lastJudge[2] === 'good' ? '✓ ' : '⚠ ') + lastJudge[1].slice('带教点评：'.length);
        card.style.display = 'block';
        return;
      }
    }
    card.style.display = 'none';
    return;
  }
  const a = MENTOR.advise(S, level);
  txt.textContent = a.empty ? a.text : a.text + (a.count > 1 ? `（还有 ${a.count - 1} 项待处理）` : '');
  card.style.display = 'block';
  syncLevel();
}

/* ---------------- 操作评价 ---------------- */
function markEvent(entry) {
  try {
    S.tl = S.tl || [];
    const b = E.snapshot(S);
    entry[3] = S.t;
    S.tl.push({ t: S.t, label: String(entry[1] || ''),
                sys: b.sys, dia: b.dia, hr: b.hr, spo2: b.spo2,
                k: +S.k.toFixed(1), glu: +S.glu.toFixed(1), ph: +S.ph.toFixed(2),
                gcs: S.gcs, lac: +S.lac.toFixed(1), temp: +S.temp.toFixed(1) });
    if (S.tl.length > 120) S.tl.shift();
  } catch (e) {}
}

function judge(kind, id, assessment, entry) {
  try {
    const last = entry || S.log?.[S.log.length - 1];
    if (last) markEvent(last);
  } catch (e) {}
  if (!MENTOR || level === 'expert') return;
  const r = assessment || MENTOR.evaluate(S, kind, id);
  if (!r || !r.msg) return;
  if (!r.ok) {
    S.penalties = (S.penalties || 0) + 1;
    S.penaltyReasons = S.penaltyReasons || [];
    const reason = S.penaltyReasons.find(item => item.label === r.msg);
    if (reason) reason.count++;
    else S.penaltyReasons.push({ label: r.msg, count: 1 });
  }
  if (isEDIntake(S)) return;
  S.log.push([E.fmt(S.t), '带教点评：' + r.msg, r.ok ? 'good' : 'warn']);
  S._lastJudgeAt = S.t;
  toast((r.ok ? '✓ ' : '⚠ ') + r.msg, !r.ok);
  /* 点评同时写进上级医师卡，方便回看 */
  try {
    const card = document.getElementById('mentorCard');
    const txt = document.getElementById('mText');
    if (card && txt) { txt.textContent = (r.ok ? '✓ ' : '⚠ ') + r.msg; card.style.display = 'block'; }
  } catch (e) {}
}

/* ---------------- 存档 ---------------- */
const GAME_STORAGE_KEYS = [
  'life.save', 'life.records', 'life.handbook', 'life.ach', 'life.signs',
  'life.level', 'life.caseDiff', 'life.autoHint', 'life.night', 'life.realism', 'life.realismRules',
  'life.insHelpShown', 'life.sound', 'life.soundVolume', 'life.contact',
  'life.updateBase', 'life.downloadPage', 'life.remoteBase',
];

function readSaveEpoch() {
  try { return localStorage.getItem(RESET_EPOCH_KEY); } catch (e) { return null; }
}

function newStorageRevision() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function reloadForStorage() {
  if (reloadingForStorage) return;
  reloadingForStorage = true;
  silenceMonitor();
  location.reload();
}

function hasCurrentSaveEpoch() {
  const storedEpoch = readSaveEpoch();
  if (storedEpoch?.startsWith('pending:')) {
    if (pendingResetRecovery !== storedEpoch) {
      pendingResetRecovery = storedEpoch;
      setTimeout(() => {
        if (readSaveEpoch() !== storedEpoch) return;
        try { finishSaveReset(storedEpoch); }
        catch (e) { toast('清空存档未完成，请刷新重试', true); }
      }, 250);
    }
    return false;
  }
  if (storedEpoch !== saveEpoch) reloadForStorage();
  return !reloadingForStorage;
}

function readWardSave() {
  try { return JSON.parse(localStorage.getItem('life.save')); } catch (e) { return null; }
}

function hasCurrentWard() {
  if (!hasCurrentSaveEpoch()) return false;
  const stored = readWardSave();
  const revision = (stored?.resetEpoch ?? null) === saveEpoch ? (stored?.wardRevision ?? null) : null;
  if (revision !== wardRevision) reloadForStorage();
  return !reloadingForStorage;
}

function finishSaveReset(pendingEpoch) {
  for (const key of GAME_STORAGE_KEYS) {
    if (readSaveEpoch() !== pendingEpoch) return;
    localStorage.removeItem(key);
  }
  if (readSaveEpoch() !== pendingEpoch) return;
  localStorage.setItem(RESET_EPOCH_KEY, pendingEpoch.slice('pending:'.length));
  reloadForStorage();
}

function confirmSaveReset() {
  openSheet('重置游戏存档', '此操作无法撤销', [
    { sec: '清空所有床位、病历档案、行医手册、成就和已见体征，并恢复游戏设置。' },
    { n: '取消', tag: '保留游戏数据', amt: '', run: dismissSheet },
    { n: '确认清空游戏数据', tag: '重置后返回空病房大厅', amt: '', run: () => {
      const pendingEpoch = 'pending:' + newStorageRevision();
      try {
        // 清理期间先暂停旧标签页的存档，设置全部删除后再让它们重载。
        localStorage.setItem(RESET_EPOCH_KEY, pendingEpoch);
        finishSaveReset(pendingEpoch);
      } catch (e) {
        toast('清空存档失败，请检查本地存储权限', true);
      }
    } },
  ]);
}

function wardRecordId(st) {
  if (!st._wardRecordId) st._wardRecordId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  return st._wardRecordId;
}

function serState(st) {
  wardRecordId(st);
  const copy = {};
  for (const k of Object.keys(st)) if (k !== 'cas') copy[k] = st[k];
  return { s: copy, caseId: st.caseId, seed: st.seed, diff: st.diff, genVersion: st.cas.genVersion };
}

function writeWard(nextBeds, index, revision) {
  try {
    const snapshot = JSON.stringify({
      v: 3, resetEpoch: saveEpoch, wardRevision: revision, level, caseDiff, activeIdx: index,
      realismRules: { ...realismRules }, beds: nextBeds.map(b => serState(b.S)),
    });
    if (!hasCurrentWard()) return false;
    // 同一次写入公布床位及版本，其他标签页会一起读取两者。
    localStorage.setItem('life.save', snapshot);
    wardRevision = revision;
    return true;
  } catch (e) { return false; }
}

function saveGame({ empty = false } = {}) {
  if (beds.length || empty) writeWard(beds, activeIdx, wardRevision);
}

function loadGame() {
  try {
    const d = readWardSave();
    if (!d || !Array.isArray(d.beds) || (d.resetEpoch ?? null) !== saveEpoch) return false;
    if (d.v !== 3) { try { localStorage.removeItem('life.save'); } catch (err) {} window.__saveDiscarded = true; return false; }
    wardRevision = d.wardRevision ?? null;
    if (d.realismRules) restoreRealismRules(d.realismRules);
    if (!d.beds.length) return true;

    const rebuilt = [];
    const savedActive = Math.min(Math.max(0, d.activeIdx | 0), d.beds.length - 1);
    let rebuiltActive = 0;
    for (const [i, item] of d.beds.entries()) {
      if (!item || !item.s) continue;
      let base;
      if (item.caseId === 'gen' && window.CASEGEN && item.seed != null) {
        base = E.create(CASEGEN.generateVersion(item.diff || 3, item.seed, item.genVersion || 1));
      } else {
        base = E.create(item.caseId);
      }
      const cas = base.cas;
      const st = Object.assign(base, item.s, { cas });
      E.restorePatient(st);
      E.restoreDrugCost(st, item.s);
      INTAKE.init(st);
      E.restoreBenzodiazepines(st, item.s);
      E.restoreBleeding(st, item.s);
      E.restoreCardiorespiratory(st, item.s);
      E.restoreTemperature(st, item.s);
      E.restoreDischargeObservation(st, item.s);
      E.restoreChestXrayReports(st);
      if (st.death || st.discharged || st.dischargeOutcome?.status === 'failed') st.running = false;
      if (!Array.isArray(st.usedRealismRules)) {
        st.usedRealismRules = [...new Set([...(st.admissionSettings?.realism ? ['insurance'] : []), ...enabledRules()])];
      }
      if (i <= savedActive) rebuiltActive = rebuilt.length;
      rebuilt.push({ S: st });
    }
    if (!rebuilt.length) return false;
    beds = rebuilt;
    activeIdx = rebuiltActive;
    S = beds[activeIdx].S;
    if (d.level) level = d.level;
    if (d.caseDiff) caseDiff = d.caseDiff;
    return true;
  } catch (e) { return false; }
}

/* ---------------- 病历档案 ---------------- */
const REC_KEY = 'life.records';
function loadRecords() {
  try { const v = JSON.parse(localStorage.getItem(REC_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function pushRecord(rec) {
  try {
    const list = loadRecords();
    if (list.some(row => row.recordId === rec.recordId)) return;
    list.unshift(rec);
    list.length = Math.min(list.length, 30);
    for (;;) {
      try {
        localStorage.setItem(REC_KEY, JSON.stringify(list));
        break;
      } catch (err) {
        if (err.name !== 'QuotaExceededError') throw err;
        // 优先保留每份病历的结局和评分；空间不足时从最旧的日志开始腾空间。
        const oldest = list.slice().reverse().find(r => r.操作日志?.length || r.检查报告?.length || r.胸片报告?.length);
        if (!oldest) throw err;
        const i = list.indexOf(oldest);
        list[i] = oldest.操作日志?.length
          ? { ...oldest, 操作日志: null, 日志已清理: true }
          : { ...oldest, 检查报告: null, 胸片报告: null };
      }
    }
  } catch (e) {}
}
function openRecords() {
  const list = loadRecords();
  const rows = [];
  if (!list.length) rows.push({ n:'还没有病历', tag:'完成一例后自动归档', amt:'', run: () => {} });
  for (const r of list) {
    rows.push({
      n: escapeHtml(r.病例名), tag: `${escapeHtml(r.结局)} · ${escapeHtml(r.耗时)} 分钟`, amt: escapeHtml(r.评分 ?? '—') + ' 分',
      run: () => openCaseRecord(r),
    });
  }
  openSheet('病历档案', `最近 ${list.length} / 30 例`, rows);
}

/* ---------------- 成就 ---------------- */
function openAchievements() {
  const A = window.ACHIEVEMENTS;
  if (!A) { openDetail('成就', '', [['状态', '成就模块未加载']], ''); return; }
  const un = A.unlocked();
  const rows = A.list.map(a => ({
    n: (un.has(a.id) ? '🏆 ' : '· ') + a.name,
    tag: a.desc, amt: un.has(a.id) ? '已解锁' : '未解锁', run: () => {},
  }));
  openSheet('成就', `${un.size} / ${A.list.length} 已解锁`, rows);
}
/* ---------------- 本床检查报告 ---------------- */
function openReports() {
  if (!isCurrentPatient(S)) return;
  const reports = E.reports(S);
  const rows = [];
  for (const [id, order] of Object.entries(S.tests)) {
    if (!order.done && E.TESTS[id]) rows.push([E.TESTS[id].name + ' · 待回报', '预计 ' + caseTime(order.readyAt)]);
  }
  const byType = new Map();
  for (const report of reports.slice().reverse()) {
    if (!byType.has(report.type)) byType.set(report.type, []);
    byType.get(report.type).push(report);
  }
  for (const group of byType.values()) {
    const latest = group[0];
    rows.push([escapeHtml(latest.name), group.map((report, i) => reportDetails(report,
      (i ? '此前 · ' : '查看本次 · ') + caseTime(report.reportedAt), group[i + 1])).join('')]);
  }
  const monitor = !isEDIntake(S) && isSevere(S) ? E.snapshot(S) : null;
  if (monitor) rows.push(...monitorReportRows(monitor));
  if (!rows.length) rows.push(['暂无报告', '在「检查」查体或开单，结果回报后可在这里复阅。']);
  const potassium = E.knownResults(S).k?.value;
  openDetail('报告', S.patient.name + ' · ' + reports.length + ' 份已记录', rows,
    monitor?.k > 6.5 || potassium > 6.5 ? '最近的血钾读数达到游戏危急值。' : '');
  $('#detail').dataset.view = 'reports';
}

function refreshOpenReports() {
  const card = $('#detail .card');
  const scroll = card.scrollTop;
  const expanded = new Set([...card.querySelectorAll('details[open]')].map(item => item.dataset.reportId));
  const focused = document.activeElement?.closest('details')?.dataset.reportId;
  openReports();
  for (const item of card.querySelectorAll('details[data-report-id]')) {
    item.open = expanded.has(item.dataset.reportId);
    if (focused === item.dataset.reportId) item.querySelector('summary').focus({ preventScroll: true });
  }
  card.scrollTop = scroll;
}

function monitorReportRows(monitor) {
  const metrics = {
    ph: ['pH', '', value => value < 7.35 ? ' ↓' : ''],
    paco2: ['PaCO₂', 'mmHg'],
    pao2: ['PaO₂', 'mmHg'],
    hco3: ['HCO₃⁻', 'mmol/L'],
    lac: ['乳酸', 'mmol/L', value => value > 2 ? ' ↑' : ''],
    k: ['血钾', 'mmol/L', value => value > 5.5 ? ' ↑' : value < 3.5 ? ' ↓' : ''],
    na: ['血钠', 'mmol/L'],
    cl: ['血氯', 'mmol/L'],
    ca: ['血钙', 'mmol/L'],
    glu: ['血糖', 'mmol/L'],
    cr: ['肌酐', 'µmol/L'],
    bun: ['尿素氮', 'mmol/L'],
    hb: ['血红蛋白', 'g/L'],
    wbc: ['白细胞', '×10⁹/L'],
    plt: ['血小板', '×10⁹/L'],
  };
  const metricRow = (field, value) => {
    const [label, unit, flag] = metrics[field];
    if (!Number.isFinite(value)) return [label, '未记录'];
    return [label, `${value}${unit ? ` ${unit}` : ''}${flag?.(value) || ''}`];
  };
  const rows = [['<strong>重症监护快照</strong>', '打开时 · ' + caseTime(S.t)]];
  for (const field of ['k', 'na', 'cl', 'ph', 'hco3', 'lac', 'glu', 'cr', 'hb']) rows.push(metricRow(field, monitor[field]));
  return rows;
}

/* ---------------- 时钟 / 主循环 ---------------- */
function loop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.5, (ts - lastTs) / 1000);
  lastTs = ts;
  if (paused || !beds.length) { ecg.pause(); silenceMonitor(); requestAnimationFrame(loop); return; }
  if (beds.length) {
    const billedBeds = realismRules.insurance ? beds.filter(b => b.S.running).map(({ S: patient }) => ({
      patient, from: patient.t, hourlyRate: isSevere(patient) ? 80 : 25,
    })) : [];
    let observationEnd = observationStopReason();
    const adv = observationEnd ? 0 : !observation
      ? dt * (ff ? 20 : speed) * (nightMode ? 1.3 : 1)
      : Math.min(dt * 1200, 20);
    acc += adv;
    while (acc >= 0.2 && !observationEnd) {
      for (const b of beds) {
        if (!b.S.running) continue;
        E.tick(b.S, 0.2);
        if (window.CASEGEN) CASEGEN.step(b.S, 0.2, E);   // 病理模块的病程推进
      }
      acc -= 0.2;
      if (observation) observationEnd = observationStopReason();
    }
    for (const { patient, from, hourlyRate } of billedBeds) {
      if (!patient.ins) initInsurance(undefined, patient);
      patient.bedCost = (patient.bedCost || 0) + hourlyRate * (patient.t - from) / 3600;
      if (patient.t > from) checkBudget(patient);
    }
    const checkGroup = $('#sheet').classList.contains('on') && $('#sheetTitle').dataset.testGroup;
    const reportsOpen = $('#detail').classList.contains('on') && $('#detail').dataset.view === 'reports';
    const pending = checkGroup || reportsOpen ? Object.values(S.tests).filter(order => !order.done) : [];
    for (const b of beds) { try { E.pollTests(b.S); } catch (e) {} }
    if (pending.some(order => order.done) && isCurrentPatient(S)) {
      if (checkGroup) openTestGroup(S, checkGroup);
      if (reportsOpen) refreshOpenReports();
    }
    let reviewMessage = '';
    if (observation && (observationEnd || (observation.kind === 'steady' && E.dischargeCheck(S).ok))) {
      if (observation.kind !== 'steady') {
        reviewMessage = finishReview(observationEnd);
      } else {
        stopObservation();
        saveGame();
        toast(observationEnd?.message ?? '已达到出院标准，留观快进已结束', observationEnd?.urgent);
      }
    }
    settleBeds();
    if (!beds.length) {
      if (reviewMessage) toast(reviewMessage, observationEnd?.urgent);
      ecg.pause(); silenceMonitor(); requestAnimationFrame(loop); return;
    }
    const warnings = new Set();
    hudAcc += dt;
    if (hudAcc >= 0.25) { hudAcc = 0; renderHUD(); }
    saveAcc += dt;
    if (saveAcc >= 8) { saveAcc = 0; saveGame(); showAdvice(false); }

    /* 首次体征提示：每 ~2 秒检查一次（非阻断；危急才用醒目 toast） */
    signsAcc += dt;
    if (signsAcc >= 2) { signsAcc = 0; if (checkSigns()) warnings.add(S); }
    /* 所有床位都记录危急状态，后台床位另有文字提醒。 */
    for (const b of beds) {
      const st = b.S;
      const crit = st.rhythm !== 'sinus' ? st.rhythm :
        (st.spo2 < 80 || (!isEDIntake(st) && st.k > 7) || E.bp(st).sys < 70 ? 'vitals' : null);
      if (crit && crit !== b.crit) {
        if (st !== S) {
          const reason = crit === 'vf' ? '室颤' : crit === 'asystole' ? '心静止' : '生命体征';
          toast('⚠ 床位 ' + (beds.indexOf(b) + 1) + ' 危急：' + reason, true);
        }
        if (crit === 'vitals') warnings.add(st);
      }
      b.crit = crit;
    }

    /* 进入重症：弹窗提醒（每例只弹一次，回到轻症后可再次触发） */
    try {
      const nowSevere = isEDIntake(S) ? !!edAttentionReason(S) : isSevere(S);
      if (nowSevere && !S._wasSevere) {
        /* 只在"由轻转重"那一刻弹；开局即重症不弹（_ready 之前也不弹） */
        if (S._ready && !severePopup && !lobbyIsActive()) { showSeverePopup(); warnings.add(S); }
        S._wasSevere = 1;
      } else if (!nowSevere) {
        S._wasSevere = 0;
      }
    } catch (e) {}
    const inLobby = lobbyIsActive();
    let rPeak = false;
    if (!document.hidden) {
      rPeak = ecg.update(S, ts);
      const canvas = !inLobby && selected === 'heart' && $('#miniEcg');
      if (canvas) ecg.draw(canvas);
    }
    pumpSound(ts, warnings, rPeak, inLobby);
    if (reviewMessage) {
      renderHUD();
      toast(reviewMessage, observationEnd?.urgent);
    }
  }
  requestAnimationFrame(loop);
}

/* ---------------- 音效调度 ---------------- */
function silenceMonitor() {
  window.SOUND?.stopMonitorAlarm();
  for (const bed of beds) bed.nextVfAlarmAt = 0;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { ecg.pause(); silenceMonitor(); } });
window.addEventListener('pagehide', silenceMonitor);

function pumpSound(ts, warnings, rPeak, inLobby) {
  if (!window.SOUND?.enabled || document.hidden) { silenceMonitor(); return; }
  for (const [i, bed] of beds.entries()) {
    const patient = bed.S;
    const bedIndex = beds.length > 1 ? i : undefined;
    if (patient.rhythm === 'vf') {
      if (ts >= (bed.nextVfAlarmAt ?? 0)) {
        SOUND.alarm(patient, bedIndex);
        bed.nextVfAlarmAt = ts + 1500;
      }
    } else if (patient.rhythm === 'asystole') {
      if (!SOUND.flatlinePlaying(patient)) SOUND.flatline(patient, bedIndex);
      bed.nextVfAlarmAt = 0;
    } else {
      if (bed.nextVfAlarmAt || SOUND.flatlinePlaying(patient)) SOUND.stopMonitorAlarm(patient);
      bed.nextVfAlarmAt = 0;
      if (!inLobby && warnings.has(patient)) SOUND.critical(patient, bedIndex);
    }
  }
  if (!inLobby && rPeak) SOUND.beat();
}

function renderHUD() {
  try {
    /* 兜底：现实模式下任何时候发现没参保，补一份（开局/读档/切床都覆盖） */
    if (realismRules.insurance && S && !S.ins) initInsurance();
    let el = document.getElementById('budgetChip');
    if (realismRules.insurance && S && S.ins) {
      if (!el) {
        el = document.createElement('span');
        el.id = 'budgetChip';
        el.className = 'pill num';
        const host = document.querySelector('.top .seg') || document.querySelector('.top');
        if (host) host.parentNode.insertBefore(el, host);
        el.title = '家庭自付 / 可承受上限';
      }
      const cs = costSummary();
      if ($('#detail').dataset.view === 'cost' && $('#detail').classList.contains('on')) updateCostSheet(cs);
      const over = cs.selfPay > cs.cap;
      el.textContent = '自付 ¥' + Math.round(cs.selfPay) + '/' + cs.cap;
      el.style.color = over ? '#c0392b' : '';
      el.style.display = '';
    } else if (el) {
      el.style.display = 'none';
    }
  } catch (e) {}
  renderBedBar();
  $('#clock').textContent = E.fmt(S.t);
  renderVitals();
  renderStates();
  syncEnvSheet();
  if ($('#detail').classList.contains('on')) {
    if ($('#detail').dataset.view === 'operation-log') refreshOperationLog(S);
    if ($('#detail').dataset.view === 'infusions') refreshInfusions(S);
  }
  if ($('#sheetTitle').dataset.view === 'menu' && !realismRules.signedDischarge && $('#sheet').classList.contains('on')) {
    const assessment = E.dischargeCheck(S);
    if ($('#sheetTitle').dataset.eligible !== String(assessment.ok) ||
        $('#sheetTitle').dataset.observation !== String(!isEDIntake(S) && canStartObservation(S, assessment))) openBedsideMenu();
    if ($('#detail').dataset.view === 'discharge' && $('#detail').classList.contains('on')) refreshDischargeAssessment(S, assessment);
  }
  syncBedSeverity();
  if (selected) renderOrganPanel();
  checkCrucial();
}

let lastCrit = '';
function checkCrucial() {
  const s = E.snapshot(S);
  const key = isEDIntake(S) ? s.rhythm : `${s.rhythm}|${s.k > 7.2}|${s.sys < 70}`;
  if (key !== lastCrit) {
    lastCrit = key;
    if (s.rhythm === 'vf') { ff = false; speed = 1; syncSpeedUI(); toast('室颤！立即除颤', true); }
    else if (s.rhythm === 'asystole') { ff = false; speed = 1; syncSpeedUI(); toast('心静止', true); }
  }
}
function syncSpeedUI() {
  if (!ff && observation) {
    observation = null;
    acc = 0;
  }
  $('#speed').querySelectorAll('.pill[data-s]').forEach(x => {
    const active = !paused && !ff && +x.dataset.s === speed;
    x.classList.toggle('on', active);
    x.setAttribute('aria-pressed', active);
  });
  const pauseButton = $('#pause');
  pauseButton.style.display = realismRules.noPause ? 'none' : '';
  pauseButton.disabled = realismRules.noPause;
  pauseButton.textContent = paused ? '继续' : '暂停';
  pauseButton.classList.toggle('on', paused);
  pauseButton.setAttribute('aria-pressed', String(paused));
  const f = $('#ff');
  f.classList.toggle('on', ff && !paused);
  f.setAttribute('aria-pressed', String(ff && !paused));
  f.textContent = observation?.kind === 'steady' ? '结束留观' :
    observation ? '结束等待' : ff && !paused ? '20× 快进中' : '快进 20×';
  const wardWait = $('#conditionWait');
  const waiting = observation?.kind === 'ward';
  wardWait.textContent = waiting ? '结束等待' : '等病情变化';
  wardWait.disabled = !!observation && !waiting;
  wardWait.setAttribute('aria-pressed', String(waiting));
  wardWait.classList.toggle('on', waiting);
  if (S && selected === 'pancreas' && $('#glucoseWait')) updateOrganValues();
}

function stopObservation() {
  if (!observation) return;
  if (observation.kind !== 'steady') {
    toast(finishReview({ message: '已手动结束等待' }));
    return;
  }
  ff = false;
  speed = 1;
  syncSpeedUI();
}

function edAttentionReason(st) {
  const s = E.snapshot(st);
  if (s.rhythm !== 'sinus') return s.rhythm === 'vf' ? '室颤' : '心静止';
  if (s.sys < 70 || s.map < 65) return '血压过低';
  if (s.spo2 != null && s.spo2 < 90) return '血氧过低';
  if (s.hr > 130 || s.hr < 45) return '心率异常';
  if (s.rr < 10 || s.rr > 30) return '呼吸频率异常';
  if (E.convulsionSigns(st)) return '可见抽搐';
  return '';
}

function edReviewReadings(patient) {
  const { hr, rr, sys, spo2, rhythm } = E.snapshot(patient);
  return { hr, rr, sys, spo2, rhythm, convulsions: E.convulsionSigns(patient),
    externalBleeding: patient.bleedingSites?.trauma > 0 };
}

function edReviewChange(patient, start) {
  const current = edReviewReadings(patient);
  if (current.rhythm !== start.rhythm) return '监护心律变化，请复评';
  if (current.convulsions !== start.convulsions) return current.convulsions ?? '未再见抽搐';
  if (current.externalBleeding !== start.externalBleeding) return current.externalBleeding ? '可见活动性外出血' : '未再见活动性外出血';
  for (const [field, label, unit, delta] of [
    ['hr', '心率', '次/分', 15], ['rr', '呼吸频率', '次/分', 5],
    ['sys', '收缩压', 'mmHg', 15], ['spo2', '血氧 SpO₂', '%', 4],
  ]) {
    if (Number.isFinite(start[field]) && Number.isFinite(current[field]) &&
      Math.abs(current[field] - start[field]) >= delta) {
      return `${label} ${start[field]} → ${current[field]} ${unit}`;
    }
  }
  return '';
}

function attentionReason(st, wardReview = false) {
  if (!st.running) return '病例已结束';
  if (isEDIntake(st)) return edAttentionReason(st);
  const pressure = E.bp(st);
  const severe = severeCondition(st, pressure, !wardReview);
  if (severe) return severe;
  if (pressure.sys < 70) return '收缩压过低';
  if (st.glu < 3.9) return '低血糖';
  if (st.k < 3) return '低血钾';
  if (st.rr < 10 || st.rr > 30) return '呼吸频率异常';
  if (st.ph < 7.2) return '严重酸中毒';
  return '';
}

function canStartObservation(patient, assessment) {
  return !assessment.ok && (assessment.observationEndsAt != null || patient.opioidTox ||
    patient.tags.some(tag => ['hhs', 'hypona', 'sepsis'].includes(tag)));
}

function observationStopReason() {
  if (!observation) return null;
  const wardReview = observation.kind === 'ward';
  const danger = beds.findIndex(b => attentionReason(b.S, wardReview));
  if (danger >= 0) {
    return { message: attentionMessage(danger, wardReview), patient: beds[danger].S, urgent: true };
  }
  for (const [index, bed] of beds.entries()) {
    for (const [id, test] of Object.entries(bed.S.tests)) {
      if (!test.done && bed.S.t >= test.readyAt) return { message: `床位 ${index + 1} 的${E.TESTS[id]?.name ?? '检查'}已回报`, patient: bed.S };
    }
  }
  if (observation.kind === 'ward') {
    const reassess = S.t >= observation.nextAssessment;
    if (reassess) observation.nextAssessment = S.t + 5;
    for (const [index, bed] of beds.entries()) {
      const previous = observation.baselines.get(bed.S);
      if (!previous) return { patient: bed.S, message: `床位 ${index + 1} 新收患者，请复评` };
      const ed = isEDIntake(bed.S);
      const change = ed ? edReviewChange(bed.S, previous.vitals) : E.conditionReviewChange(bed.S, previous.vitals);
      if (change) return { patient: bed.S, message: `床位 ${index + 1}：${change}` };
      if (previous.deadline != null && bed.S.t + 1e-7 >= previous.deadline) {
        return { patient: bed.S, message: `床位 ${index + 1} 已到预定复评时间` };
      }
      if (reassess && !ed && !realismRules.signedDischarge) {
        const assessment = E.dischargeCheck(bed.S);
        if (!previous.ready && assessment.ok) return { patient: bed.S, message: `床位 ${index + 1} 已达到出院条件` };
        previous.ready = assessment.ok;
        previous.deadline = assessment.observationEndsAt;
      }
    }
    if (S.t + 1e-7 >= observation.until) return { message: '已满 6 个模拟小时，未见明显病情变化' };
  } else if (observation.kind === 'glucose') {
    const { reason } = E.glucoseReviewStatus(S, observation.glucose);
    if (reason === 'target') return { message: '血糖已进入本病例目标范围' };
    if (reason === 'worse') return { message: '血糖进一步偏离本病例目标，请复评', urgent: true };
    if (reason === 'missing') return { message: '血糖读数缺失，请复测', urgent: true };
    if (S.t + 1e-7 >= observation.until) return { message: '已到复评时间，血糖仍未达标' };
  } else if (S.t + 1e-7 >= observation.until) return { message: '留观快进已结束，请复查病情' };
  return null;
}

function attentionMessage(index, wardReview = false) {
  return `床位 ${index + 1}：${attentionReason(beds[index].S, wardReview)}`;
}

function finishReview(event) {
  const minutes = Math.round((S.t - observation.startedAt) / 6) / 10;
  let patient = S;
  let message;
  if (observation.kind === 'glucose') {
    const glucose = E.glucoseReviewStatus(S, observation.glucose).glucose;
    const change = `${observation.glucose.toFixed(1)} → ${glucose == null ? '缺测' : glucose.toFixed(1)} mmol/L`;
    message = `床位 ${activeIdx + 1} 血糖复评 · 已过 ${minutes} 分钟，${change}。${event.message}`;
    S.lastGlucoseReview = message;
  } else {
    patient = event.patient ?? S;
    message = `病情复评 · 已过 ${minutes} 分钟。${event.message}`;
    const result = $('#conditionReviewResult');
    result.hidden = false;
    result.textContent = message;
  }
  patient.log.push([E.fmt(patient.t), message, event.urgent ? 'warn' : 'info', patient.t, null, true]);
  paused = false;
  ff = false;
  speed = 1;
  syncSpeedUI();
  saveGame();
  return message;
}

function startGlucoseReview() {
  if (!isCurrentPatient(S) || isEDIntake(S)) return;
  if (observation) { stopObservation(); return; }
  const danger = beds.findIndex(b => attentionReason(b.S));
  if (danger >= 0) { toast(attentionMessage(danger) + '，请先处理', true); return; }
  const status = E.glucoseReviewStatus(S);
  if (status.glucose == null) { toast('血糖读数缺失，请先复测', true); return; }
  if (status.inTarget) { toast(`当前血糖已在本病例目标范围（${status.target}）`); return; }
  beginObservation({ kind: 'glucose', glucose: status.glucose, startedAt: S.t, until: S.t + GLUCOSE_REVIEW_MINUTES * 60 });
  toast(`等待血糖变化，目标 ${status.target}，最多 ${GLUCOSE_REVIEW_MINUTES} 个模拟分钟`);
}

function startConditionReview() {
  if (!isCurrentPatient(S)) return;
  if (observation) { stopObservation(); return; }
  const danger = beds.findIndex(b => attentionReason(b.S, true));
  if (danger >= 0) { toast(attentionMessage(danger, true) + '，请先处理', true); return; }
  const baselines = new Map(beds.map(({ S: patient }) => {
    const ed = isEDIntake(patient);
    const assessment = ed || realismRules.signedDischarge ? null : E.dischargeCheck(patient);
    const vitals = ed ? edReviewReadings(patient) : E.conditionReviewBaseline(patient);
    return [patient, { vitals, deadline: assessment?.observationEndsAt, ready: assessment?.ok }];
  }));
  beginObservation({ kind: 'ward', startedAt: S.t, until: S.t + MAX_OBSERVATION_SECONDS, baselines, nextAssessment: S.t + 5 });
  toast('全病房等待病情变化，最多 6 个模拟小时');
}

function startObservation() {
  if (!isCurrentPatient(S)) return;
  const assessment = E.dischargeCheck(S);
  if (!canStartObservation(S, assessment)) return;
  if (beds.some(b => attentionReason(b.S))) { toast('有床位需要连续处置，请先稳定病情', true); return; }
  beginObservation({ kind: 'steady', until: Math.min(S.t + MAX_OBSERVATION_SECONDS, assessment.observationEndsAt ?? Infinity) });
  toast('全病房留观快进中，可随时点「结束留观」');
}

function beginObservation(config) {
  observation = config;
  acc = 0;
  ff = true;
  paused = false;
  closeSheet();
  syncSpeedUI();
}

let toastTimer = null;
function toast(msg, urgent) {
  const t = $('#toast');
  t.innerHTML = msg;
  t.style.background = urgent ? '#9b2c2c' : '#2a2320';
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// 老存档没有床旁回执标记，仅从能辨认的医嘱、查体及报告回执恢复首诊记录。
function bedsideLogMessage(entry, ed) {
  const [stamp, text, status, , reportId, receipt] = entry;
  if (!ed || receipt === true) return text;
  if (receipt === false) return null;
  if (typeof receipt === 'string') return receipt;
  if (reportId || stamp === '给药' || /^(给予 |开出 |开始持续静脉泵入 |调整 .+ 泵速至 |停止泵入 |开始(?:静滴|泵入) )/.test(text) ||
      /(?:静滴|泵入)完成（总量 | · 补录/.test(text)) return text;
  if (stamp === '操作') return status === 'good' ? text : '床旁处置已记录，详情未留存';
  return null;
}

let lastBedsideLogEntry, lastBedsideLogSize;
function refreshOperationLog(patient, force = false) {
  if (!isCurrentPatient(patient)) return;
  const entries = patient.log || [];
  if (!force && entries.length === lastBedsideLogSize && entries.at(-1) === lastBedsideLogEntry) return;
  lastBedsideLogEntry = entries.at(-1);
  lastBedsideLogSize = entries.length;
  const list = $('#dKv');
  const top = list.scrollTop;
  const height = list.scrollHeight;
  const ed = isEDIntake(patient);
  const rows = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = bedsideLogMessage(entry, ed);
    if (!message) continue;
    const time = Number.isFinite(entry[3]) ? caseTime(entry[3]) : /^\d+:\d\d$/.test(entry[0]) ? entry[0] : '时间未记';
    rows.push(`<dt>${escapeHtml(time)}</dt><dd>${escapeHtml(message)}</dd>`);
  }
  $('#dSub').textContent = patient.patient.name + ' · ' + rows.length + ' 条 · 最近在前';
  list.innerHTML = rows.join('') || '<dt>暂无记录</dt><dd>给药、处置或检查后可在这里回看。</dd>';
  list.scrollTop = top > 0 ? Math.max(0, top + list.scrollHeight - height) : 0;
}

function openOperationLog(patient) {
  if (!isCurrentPatient(patient)) return;
  openDetail('操作日志', patient.patient.name, [], '');
  $('#detail').dataset.view = 'operation-log';
  $('#dKv').tabIndex = 0;
  $('#dKv').scrollTop = 0;
  refreshOperationLog(patient, true);
  $('#dKv').focus({ preventScroll: true });
}

/* ---------------- 结束 / 复盘 ---------------- */
function buildTimeline(st) {
  const events = st.tl || [];
  const vitals = e => `血压 ${e.sys}/${e.dia} · 心率 ${e.hr} · SpO₂ ${e.spo2 == null ? '无信号' : e.spo2 + '%'} · 血钾 ${e.k} · pH ${e.ph}`;
  if (!st.log?.length) return events.map(e => [E.fmt(e.t), e.label, vitals(e)]);
  const byLabel = new Map();
  for (const e of events) {
    const samples = byLabel.get(e.label) || [];
    samples.push(e);
    byLabel.set(e.label, samples);
  }
  // 时间轴仅保留最近的处置快照，从最新日志向前匹配同名操作。
  return st.log.slice().reverse().map(([stamp, message, , seconds, reportId]) => {
    const samples = byLabel.get(message) || byLabel.get(String(message).slice(0, 40));
    const e = samples?.[samples.length - 1];
    const matched = e && (seconds == null || e.t === seconds) ? samples.pop() : null;
    const time = seconds ?? matched?.t;
    const row = [time == null ? stamp : E.fmt(time), message];
    if (matched) row.push(vitals(matched));
    if (reportId) row[3] = reportId;
    return row;
  }).reverse();
}

function closePatientOverlays() {
  lastCaseReview = false;
  closeSheet();
  $('#detail').classList.remove('on');
  if (severePopup) { severePopup.remove(); severePopup = null; }
}

function focusBed(i) {
  stopObservation();
  activeIdx = i;
  S = beds[i].S;
  lastCrit = '';
  organBuiltFor = null;
  closePatientOverlays();
  if (realismRules.insurance && !S.ins) initInsurance();
  drawBody();
  renderAll();
  showAdvice(false);
  flashBedBar(4200);
}

function clearActiveBed() {
  stopObservation();
  activeIdx = 0;
  S = null;
  ecg.clear();
  silenceMonitor();
  paused = false;
  ff = false;
  speed = 1;
  syncSpeedUI();
  closePatientOverlays();
  renderAll();
}

function switchBed(patient) {
  const index = beds.findIndex(b => b.S === patient && b.S.running);
  if (index < 0) return false;
  if (patient === S) {
    closeSheet();
    return true;
  }
  focusBed(index);
  saveGame();
  toast(`已切换到床位 ${index + 1}`);
  return true;
}

function settleBeds() {
  const finished = beds.filter(b => !b.S.running);
  if (!finished.length || !hasCurrentWard()) return;

  const inLobby = lobbyIsActive();
  const wardCount = beds.length;
  let review;
  for (const b of finished) {
    const st = b.S;
    window.SOUND?.stopMonitorAlarm(st);
    const recap = archiveCase(st, wardCount);
    if (st === S) {
      review = { st, ...recap };
    } else {
      toast(`床位 ${beds.indexOf(b) + 1} · ${escapeHtml(st.patient.name)} · ${caseOutcomeLabel(st)}`, !st.discharged);
    }
  }
  const nextBed = beds.slice(activeIdx + 1).find(b => b.S.running);
  beds = beds.filter(b => b.S.running);
  if (review) {
    if (beds.length) {
      focusBed(nextBed ? beds.indexOf(nextBed) : beds.length - 1);
    } else {
      clearActiveBed();
    }
    if (inLobby) {
      showLobby();
    } else {
      lastCaseReview = !beds.length;
      showCaseReview(review.st, review);
    }
  } else {
    activeIdx = beds.findIndex(b => b.S === S);
    renderBedBar();
    if ($('#sheet').classList.contains('on') && $('#sheetTitle').dataset.view === 'beds') openBeds();
    if ($('#lobby').style.display === 'flex') showLobby();
  }
  writeWard(beds, activeIdx, newStorageRevision());
}

/* ---------------- 统计面板 ---------------- */
function openStats() {
  let recs = [];
  try { recs = JSON.parse(localStorage.getItem('life.records') || '[]') || []; } catch (e) {}
  let hb = { entries: [] };
  try { hb = JSON.parse(localStorage.getItem('life.handbook') || 'null') || { entries: [] }; } catch (e) {}
  let ach = [];
  try { ach = JSON.parse(localStorage.getItem('life.ach') || '[]') || []; } catch (e) {}

  const total = recs.length;
  const cured = recs.filter(r => r.结局 === '出院').length;
  const died = recs.filter(r => r.结局 === '死亡').length;
  const rate = total ? Math.round(cured / total * 100) : 0;
  const avg = k => {
    const v = recs.map(r => Number(r[k]) || 0);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
  };

  /* 最常见的诊断 */
  const dxCount = {};
  for (const e of (hb.entries || [])) dxCount[e.name] = e.encounters || 0;
  const topDx = Object.entries(dxCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  /* 最常见的误治 */
  const misCount = {};
  for (const e of (hb.entries || [])) {
    for (const m of (e.mistreatments || [])) {
      const k = String(m.text || '').slice(0, 24);
      misCount[k] = (misCount[k] || 0) + 1;
    }
  }
  const topMis = Object.entries(misCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  let html = '';
  html += '<div class="sec">总体</div>';
  html += '<div style="padding:0 12px 10px">';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  const row = (k, v) => '<tr><td style="padding:6px 4px;color:#8a8078">' + k + '</td>' +
    '<td style="padding:6px 4px;text-align:right;font-weight:600">' + v + '</td></tr>';
  html += row('总局数', total);
  html += row('出院', cured);
  html += row('出院判定失败', recs.filter(r => r.结局 === '出院判定失败').length);
  html += row('死亡', died);
  html += row('出院率', rate + '%');
  html += row('平均耗时', avg('耗时') + ' min');
  html += row('平均费用', '¥' + avg('费用'));
  html += row('平均评分', avg('评分'));
  html += row('解锁成就', (Array.isArray(ach) ? ach.length : Object.keys(ach).length) + ' 个');
  html += '</table></div>';

  html += '<div class="sec">最常遇到的诊断</div><div style="padding:0 12px 10px">';
  if (topDx.length) html += topDx.map(([n, c]) => row(n, c + ' 次')).join('');
  else html += '<div style="color:#9a9a9a;font-size:13px;padding:6px">还没有记录</div>';
  html += '</div>';

  html += '<div class="sec">最常犯的错</div><div style="padding:0 12px 14px">';
  if (topMis.length) html += topMis.map(([n, c]) => row(n, c + ' 次')).join('');
  else html += '<div style="color:#9a9a9a;font-size:13px;padding:6px">暂时没有——保持住</div>';
  html += '</div>';

  /* 近 10 局走势 */
  const last = recs.slice(0, 10).reverse();
  if (last.length) {
    html += '<div class="sec">最近 ' + last.length + ' 局评分</div><div style="padding:0 12px 14px">';
    html += last.map(r => {
      const sc = Number(r.评分) || 0;
      const w = Math.max(4, Math.round(sc * 1.6));
      const col = r.结局 === '出院' ? '#7fb069' : '#c0392b';
      return '<div style="display:flex;align-items:center;gap:8px;margin:4px 0">' +
        '<span style="flex:0 0 96px;font-size:11px;color:#8a8078;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        String(r.病例名 || '') + '</span>' +
        '<span style="display:inline-block;height:10px;border-radius:5px;background:' + col + ';width:' + w + 'px"></span>' +
        '<span style="font-size:11px;color:#6b625d">' + sc + '</span></div>';
    }).join('');
    html += '</div>';
  }

  openSheet('统计', '从病历档案与手册汇总', []);
  const list = document.querySelector('#sheetList');
  if (list) list.innerHTML = html;
}

function applyFontScale() {
  try {
    document.documentElement.style.zoom = bigFont ? '1.10' : '';
    document.documentElement.style.setProperty('--life-zoom', bigFont ? '1.10' : '1');
  } catch (e) {}
}

let bedBarHideAt = 0;
function flashBedBar(ms) {
  bedBarHideAt = Date.now() + (ms || 4000);
  renderBedBar();
}

function mountBedBar() {
  if (document.getElementById('bedBar')) return;
  const el = document.createElement('div');
  el.id = 'bedBar';
  el.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)',
    'bottom:calc(env(safe-area-inset-bottom, 0px) + 64px)',
    'display:none', 'align-items:center', 'gap:6px',
    'padding:5px 10px', 'border-radius:999px',
    'background:rgba(255,255,255,.92)', 'box-shadow:0 2px 10px rgba(0,0,0,.10)',
    'font-size:12px', 'color:#6b625d', 'z-index:21', 'cursor:pointer',
    'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
    'transition:opacity .45s ease',
  ].join(';');
  el.addEventListener('click', () => openBeds());
  /* 窄屏时把胶囊挪到右下，避免压住导师提示卡 */
  if (!document.getElementById('bedBarStyle')) {
    const st2 = document.createElement('style');
    st2.id = 'bedBarStyle';
    st2.textContent = '@media (max-width: 560px){ #bedBar{ left:auto !important; right:12px !important; transform:none !important; } #mentorCard{ padding-right:118px !important; } }';
    document.head.appendChild(st2);
  }
  document.body.appendChild(el);
}
function renderBedBar() {
  const el = document.getElementById('bedBar');
  if (!el) return;
  if (!beds.length) { el.style.display = 'none'; return; }
  /* 抽屉或详情打开时让位 */
  const maskOn = document.getElementById('mask');
  const detailOn = document.getElementById('detail');
  if ((maskOn && maskOn.classList.contains('on')) || (detailOn && detailOn.classList.contains('on'))) {
    el.style.opacity = '0'; el.style.pointerEvents = 'none'; return;
  }
  /* 淡出：只在切换床位后的几秒内显示 */
  el.style.display = 'flex';
  const show = Date.now() < bedBarHideAt;
  el.style.opacity = show ? '1' : '0';
  el.style.pointerEvents = show ? 'auto' : 'none';
  let html = '<span style="font-weight:600">床位 </span>';
  for (let i = 0; i < beds.length; i++) {
    const b = beds[i];
    const cur = b.S === S;
    const crit = b.crit ? '#c0392b' : (cur ? '#cf7b86' : '#d8d0ca');
    html += '<span style="display:inline-block;min-width:18px;height:18px;line-height:18px;text-align:center;' +
      'border-radius:9px;font-size:11px;color:#fff;background:' + crit + '">' + (i + 1) + '</span>';
  }
  html += '<span style="opacity:.55">' + beds.length + '/' + MAX_BEDS + '</span>';
  el.innerHTML = html;
}

function bedSeverity(patient) {
  if (!patient?.running) return '';
  if (isEDIntake(patient)) return edAttentionReason(patient) ? ' · 监护告警' : '';
  return isSevere(patient) ? ' · 重症' : '';
}

function syncBedSeverity() {
  for (const marker of document.querySelectorAll('[data-bed-severity]')) {
    const label = bedSeverity(beds[+marker.dataset.bedSeverity]?.S);
    if (marker.textContent !== label) marker.textContent = label;
  }
}

function openBeds() {
  const rows = beds.map((b, i) => {
    const st = b.S;
    const tag = st.running ? `${Math.round(st.t / 60)} min` : caseOutcomeLabel(st);
    return {
      n: `床位 ${i + 1}`,
      tag: `${b.S === S ? '当前 · ' : ''}${tag}<span data-bed-severity="${i}">${bedSeverity(st)}</span>`,
      amt: b.S === S ? '—' : '切换',
      run: () => switchBed(st),
    };
  });
  rows.push({ sec: '操作' });
  rows.push({ n: '开一个新病例（占用空床）', tag: `${beds.length}/${MAX_BEDS}`, amt: '新建',
              run: () => { closeSheet(); startCase(window.CASEGEN.generate(diffFromLevel())); } });
  openSheet('病房床位', `${beds.length} / ${MAX_BEDS} 张在用`, rows);
  $('#sheetTitle').dataset.view = 'beds';
}

function recordDiagnosis(st, dx, suffix = '', outcome) {
  const rec = window.HANDBOOK.fromCase(st, dx);
  if (!rec) return;
  rec.sessionId = wardRecordId(st) + suffix;
  if (rec.therapy) rec.therapy.sessionId = rec.sessionId;
  if (outcome) {
    rec.outcome = outcome;
    if (rec.therapy) rec.therapy.outcome = outcome;
  }
  window.HANDBOOK.record(rec);
}

function caseOutcomeLabel(st) {
  if (st.dischargeOutcome?.status === 'failed') return '出院判定失败';
  if (st.discharged) return '出院';
  return st.death ? '死亡' : '进行中';
}

function archiveCase(st, wardCount) {
  st._level = level;
  st._beds = wardCount;
  const breakdown = E.scoreBreakdown(st);
  const min = Math.round(st.t / 60);
  const name = (st.cas && st.cas.name) || st.caseId;
  const rules = enabledRules();
  const chart = INTAKE.view(st);
  const settings = {
    admission: st.admissionSettings,
    level, realism: rules.length > 0, rules,
    usedRules: st.usedRealismRules ?? rules,
    difficulty: st.diff ?? st.cas?.diff ?? null,
    intakeDifficulty: st.intake.difficulty,
    fixed: st.caseId !== 'gen' && st.diff == null && st.cas?.diff == null,
  };

  /* === HANDBOOK PATCH: 诊断分类 + 行医手册（只记录本局实际发生的事） === */
  try {
    if (window.DIAGNOSIS && window.HANDBOOK) {
      const endDx = window.DIAGNOSIS.classify(st);
      /* 出院时异常已被纠正，此时分类会给出"残留下游诊断"（例如高钾治好后只剩急性肾损伤）。
         优先采用入院时的诊断，除非结束时诊断更严重且证据更强。 */
      const dx = (st.dx0 && (endDx.confidence || 0) <= (st.dx0.confidence || 0)) ? st.dx0 : endDx;
      recordDiagnosis(st, dx);
      /* 合并诊断（如 高钾 + DKA）分别建档 */
      try {
        const all = window.DIAGNOSIS.classifyAll ? window.DIAGNOSIS.classifyAll(st, 0.70) : [];
        let k = 0;
        for (const dx2 of all) {
          if (!dx2 || dx2.name === dx.primary) continue;
          const pTags = new Set(dx.tags || []);
          const t2 = dx2.tags || [];
          if (t2.length && t2.every(x => pTags.has(x))) continue;  // 只是主诊断的组分，不单独建档
          k++;   /* 不再限制个数：每个独立诊断各记一笔 */
          recordDiagnosis(st, dx2, '#' + k);
        }
      } catch (e2) { console.warn('[handbook] 合并诊断记录失败：', e2); }
      /* 合并症（慢性肾病、糖尿病…）：这些是真诊断，但不会作为"主诊断"出现，单独记一笔 */
      try {
        const comorb = (st.cas && st.cas.comorbidities) || [];
        comorb.forEach((name, ci) => {
          if (!name || name === dx.primary) return;
          recordDiagnosis(st, { primary: name, name, confidence: 0.9,
                                evidence: ['既往史'], severity: 'moderate', tags: ['comorbid'] }, '#c' + ci, 'unknown');
        });
      } catch (e3) { console.warn('[handbook] 合并症记录失败：', e3); }
    }
  } catch (e) {
    console.warn('[handbook] 本局记录失败：', e);
  }
  /* === /HANDBOOK PATCH === */

  /* 病历归档：每例结束追加一条，只留最近 30 条 */
  if (realismRules.insurance && !st.ins) initInsurance(undefined, st);
  const bill = costSummary(st);
  const record = {
    recordId: wardRecordId(st),
    时间: new Date().toLocaleString('zh-CN', { hour12: false }),
    病例名: name,
    患者: st.patient.name,
    诊断: name,
    结局: caseOutcomeLabel(st),
    签字评估: st.dischargeOutcome,
    耗时: min,
    费用: bill.total,
    药费: Math.round((st.drugCost || 0) * 100) / 100,
    药费部分记录: !!st.drugCostPartial,
    床位费: Math.round((st.bedCost || 0) * 100) / 100,
    医保结算: realismRules.insurance ? { 类型: st.ins.t, 支付: bill.reimb, 自付: bill.selfPay } : null,
    评分: breakdown.score,
    计分明细: breakdown,
    检查报告: E.reports(st),
    入院记录: { chief: chart.chief, topics: chart.topics, known: chart.known, inquiries: chart.inquiries, vitals: st.admissionVitals },
    操作日志: buildTimeline(st),
    设置: settings,
  };
  if (st.death) {
    const s = E.snapshot(st);
    record.死因 = st.death.reason;
    record.终末血钾 = s.k;
    record.终末pH = s.ph;
  }

  /* 成就判定：只报新解锁的，避免刷屏；学习模式按说明不解锁成就 */
  const newAch = (window.ACHIEVEMENTS && level !== 'learning') ? window.ACHIEVEMENTS.evaluate(st) : [];
  const achNames = newAch.map(id => {
    const a = window.ACHIEVEMENTS.list.find(x => x.id === id);
    return a ? a.name : id;
  });

  if (achNames.length) record.新成就 = achNames;
  pushRecord(record);
  return { record };
}

function caseSettingsRows(settings) {
  if (!settings) return [['本局设置', '旧病历未记录']];
  const guidance = id => Object.hasOwn(MENTOR.LEVELS, id) ? MENTOR.LEVELS[id].name : '未记录';
  const mode = enabled => enabled === true ? '开启' : (enabled === false ? '关闭' : '未记录');
  function selection(key, label) {
    const end = label(settings[key]);
    const start = settings.admission?.[key];
    if (start == null) return end + '（结算时）';
    return start === settings[key] ? end : label(start) + '（接诊） → ' + end + '（结算）';
  }
  const difficulty = Number.isInteger(settings.difficulty) && CASE_DIFFICULTIES[settings.difficulty - 1];
  return [
    ['指导等级', selection('level', guidance)],
    ['病例难度', difficulty ? settings.difficulty + ' · ' + difficulty[0] : (settings.fixed ? '固定病例' : '未记录')],
    ...(settings.fixed && settings.intakeDifficulty ? [['病历难度', String(settings.intakeDifficulty)]] : []),
    ['现实模式', selection('realism', mode)],
    ...(Array.isArray(settings.rules) ? [
      ['结算时启用', ruleNames(settings.rules)],
      ...(settings.usedRules?.some(key => !settings.rules.includes(key)) ? [['本例曾启用', ruleNames(settings.usedRules)]] : []),
    ] : (typeof settings.realism === 'boolean' ? [['结算时启用', settings.realism ? '医保与自付' : '无']] : [])),
  ];
}

function openCaseRecord(r) {
  const ok = r.结局 === '出院';
  const summary = [['诊断', r.诊断 || r.病例名], ['住院用时', r.耗时 + ' 分钟'], ['诊疗费用', money(r.费用)]];
  if (r.药费 != null) summary.push([r.药费部分记录 ? '药费含血制品（更新后）' : '药费（含血液制品）', money(r.药费)]);
  if (r.床位费) summary.push(['其中床位费', money(r.床位费)]);
  if (r.医保结算) summary.push(['参保类型', r.医保结算.类型], ['医保支付', money(r.医保结算.支付)],
    ['家庭自付', money(r.医保结算.自付)]);
  if (r.死因) summary.push(['死因', r.死因]);
  if (r.终末血钾 != null) summary.push(['终末血钾', r.终末血钾 + ' mmol/L'], ['终末 pH', r.终末pH]);
  summary.push(...caseSettingsRows(r.设置));
  const signing = r.签字评估;
  if (signing) {
    const labels = { normal: '符合全部出院条件', penalized: '未完全达标，扣分出院', failed: '仍有重大问题，本例失败' };
    summary.push(['签字时评估', labels[signing.status]]);
    if (signing.majorReasons.length) summary.push(['重大问题', signing.majorReasons.join('；')]);
    const remaining = signing.reasons.filter(reason => !signing.majorReasons.includes(reason));
    if (remaining.length) summary.push(['未达标项', remaining.join('；')]);
  }
  if (r.新成就?.length) summary.push(['新成就', r.新成就.join('、')]);
  openDetail(ok ? '患者出院' : (r.结局 === '死亡' ? '患者死亡' : r.结局), [r.患者, r.时间].filter(Boolean).join(' · '), [], '');
  const detail = $('#detail');
  detail.classList.add('case-review', ok ? 'case-review-success' : 'case-review-failure');
  const body = document.createElement('div');
  body.className = 'case-review-body';
  const breakdown = r.计分明细;
  const points = delta => {
    const magnitude = Math.abs(delta);
    return (delta < 0 ? '−' : '+') + (magnitude < 0.01 && magnitude > 0 ? '<0.01' : String(+magnitude.toFixed(2)));
  };
  const scoreRows = breakdown ? [['基础分', breakdown.base], ...breakdown.items.map(x => [x.label, points(x.delta)])] : [];
  const log = r.操作日志;
  const reports = r.检查报告 || (r.胸片报告 || []).map(film => ({
    ...film, name: '床旁胸片', kind: 'imaging', rows: [{ label: '影像所见', value: film.findings }],
  }));
  const byId = new Map(reports.map(report => [report.id, report]));
  const renderLog = ([stamp, message, sample, reportId]) => {
    const report = byId.get(reportId);
    const receipt = report ? reportDetails(report, message) : escapeHtml(message);
    if (report) byId.delete(reportId);
    const oldReceipt = !report && message === '床旁胸片 结果已出' ? '<small>此回执未保存对应的报告正文。</small>' : '';
    return `<li><time>${escapeHtml(stamp)}</time><div>${receipt}${oldReceipt}${sample ? '<small>' + escapeHtml(sample) + '</small>' : ''}</div></li>`;
  };
  const empty = r.日志已清理 ? '存储空间不足，此病历的日志已清理。' : (log ? '本例没有操作记录。' : '旧病历未保存操作日志。');
  body.innerHTML = `
    <section class="case-review-section case-review-summary"><h5>病例摘要</h5><dl>
      ${summary.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></section>
    <section class="case-review-section case-review-score"><h5>评分明细</h5><table>
      <tbody>${scoreRows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">最终得分</th><td>${escapeHtml(r.评分 ?? '—')} / 100</td></tr></tfoot></table>
      ${breakdown ? '' : '<p>旧病历未保存加扣分明细。</p>'}</section>
    <section class="case-review-section case-review-log-panel"><h5 id="caseReviewLogHeading">操作日志${log?.length ? ' · ' + log.length + ' 条' : ''}</h5>
      <div class="case-review-log" tabindex="0" role="region" aria-labelledby="caseReviewLogHeading">${log?.length ?
        '<ol>' + log.map(renderLog).join('') + '</ol>'
        : '<p>' + empty + '</p>'}</div></section>
    ${byId.size ? '<section class="case-review-section"><h5>检查报告</h5>' +
      [...byId.values()].map(report => reportDetails(report, report.name + ' · ' + caseTime(report.reportedAt))).join('') + '</section>' : ''}
    ${r.入院记录 ? '<section class="case-review-section"><details><summary>接诊病历</summary><dl>' +
      admissionChartRows(r.入院记录, r.入院记录.vitals).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl></details></section>'
      : r.主诉 ? '<section class="case-review-section"><details><summary>接诊病历</summary><p>' + escapeHtml(r.主诉) + '</p>' +
      (r.接诊病历 || []).map(item => '<p>' + escapeHtml(caseTime(item.获取) + ' · ' + item.来源 + ' · ' + item.内容) + '</p>').join('') + '</details></section>' : ''}`;
  detail.querySelector('.card').appendChild(body);
}

function showCaseReview(st, { record }) {
  if (window.SOUND) { if (st.discharged) SOUND.success(); else SOUND.fail(); }
  openCaseRecord(record);
  if (record.新成就?.length) setTimeout(() => toast('🏆 解锁成就：' + escapeHtml(record.新成就.join('、'))), 500);
}
/* === HANDBOOK PATCH: 手册入口与首次体征提示 === */

/* ---------------- 指标走势图 ---------------- */
function openChart(gid) {
  if (!S) {
    openSheet('指标走势', '接诊患者后可查看指标走势', []);
    return;
  }
  if (!window.CHART) { openDetail('指标走势', '', [['状态', '图表模块未加载']], ''); return; }
  const patient = S;
  const ed = isEDIntake(patient);
  const groups = ed ? window.CHART.GROUPS.filter(group => ['bp', 'hr'].includes(group.id)) : window.CHART.GROUPS;
  const cur = groups.find(x => x.id === gid) || groups[0];
  openSheet('指标走势', '本局 · ' + cur.name, []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  list.innerHTML =
    '<div class="sec">选择指标</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 12px">' +
    groups.map(x => '<span class="pill" data-g="' + x.id + '" style="cursor:pointer;' +
      (x.id === cur.id ? 'background:#f7e6e6;color:#a33;font-weight:700' : '') + '">' + x.name + '</span>').join('') +
    '</div>' +
    '<canvas id="chartCv" style="width:100%;height:230px;display:block"></canvas>' +
    '<div class="note" style="margin:10px 12px;font-size:11.5px;color:#8a8078">' +
      (ed ? '图表使用床旁监护记录。血氧趋势可点床旁血氧，化验前后对照请看「报告」。'
        : '采样每 30 游戏秒一次，最多保留最近 720 个点。') +
    '</div>';
  const draw = (id) => {
    const history = patient.history || [];
    window.CHART.render(document.getElementById('chartCv'), ed
      ? history.map(({ t, sys, dia, map, hr, rr }) => ({ t, sys, dia, map, hr, rr }))
      : history, id);
  };
  draw(cur.id);
  list.querySelectorAll('[data-g]').forEach(el => {
    el.addEventListener('click', () => { openChart(el.dataset.g); });
  });
}

/* ---------------- 开局必定发病 ----------------
   有些病理的初始值落在正常范围（例如代谢类早期），玩家开局看到一切都正常，
   既没有紧张感也不知道从哪下手。这里在开局时做一次"预热"：
   如果生命体征与关键化验全部正常，就按病程推进几分钟，直到出现异常。
   间歇性发作的病理（癫痫、甲亢危象、低血糖等）因此会直接从发作中开始。 */
function isAllNormal(S) {
  const b = E.bp(S);
  const bad =
    S.spo2 < 94 || S.hr > 100 || S.hr < 60 || b.sys < 95 || b.sys > 150 ||
    S.rr > 22 || !Number.isFinite(S.temp) || E.temperatureStatus(S.temp) !== '' || S.gcs < 15 ||
    S.k < 3.5 || S.k > 5.3 || S.na < 135 || S.na > 145 ||
    S.glu < 3.9 || S.glu > 7.8 || S.hb < 110 || S.lac > 2.5 ||
    S.ph < 7.35 || S.ph > 7.45 || (S.plt && S.plt < 100) || (S.cr && S.cr > 130);
  return !bad;
}

function ensurePresentation(S) {
  if (!S || !S.cas) return S;
  if (!isAllNormal(S)) return S;
  /* 最多推进 45 分钟，每步 1 分钟；不致死（若会死就回退到能撑住的那一刻） */
  let guard = 0;
  const start = JSON.parse(JSON.stringify({
    k: S.k, na: S.na, glu: S.glu, vol: S.vol, hr: S.hr, gcs: S.gcs,
    lac: S.lac, temp: S.temp, t: S.t,
  }));
  while (guard < 45 && isAllNormal(S) && !S.death && S.running) {
    guard++;
    try { E.tick(S, 60); } catch (e) { break; }
    try { if (window.CASEGEN) CASEGEN.step(S, 60, E); } catch (e) { break; }
  }
  if (S.death) {
    /* 预热把病人推死了：退回初始值，改成小幅恶化（保证"已发病"但还救得回来） */
    S.death = null; S.running = true;
    S.k = start.k; S.na = start.na; S.glu = start.glu; S.vol = start.vol;
    S.hr = start.hr; S.gcs = Math.min(start.gcs, 14);
    S.lac = Math.max(start.lac, 2.8); S.temp = Math.max(start.temp, 37.9);
  }
  if (S.tl) S.tl.length = 0;   /* 预热过程不写时间轴，避免玩家看到"凭空"的记录 */
  S.log = [];
  /* 开局是否已是重症：决定要不要弹"转入重症"（开局即重症不弹） */
  try { S._wasSevere = (isEDIntake(S) ? edAttentionReason(S) : isSevere(S)) ? 1 : 0; } catch (e) { S._wasSevere = 0; }
  /* 给 1.5 秒缓冲，避免刚创建就弹 */
  try { setTimeout(() => { S._ready = 1; }, 1500); } catch (e) {}
  return S;
}

/* 重症弹窗 */
let severePopup = null;
function showSeverePopup() {
  if (severePopup) return;
  const ed = isEDIntake(S);
  const b = (E.bp ? E.bp(S) : {});
  const reasons = [];
  if (ed) {
    const reason = edAttentionReason(S);
    if (reason) reasons.push(reason);
  } else {
    if (S.gcs < 12) reasons.push('意识 GCS ' + S.gcs);
    if ((b.map ?? 90) < 65) reasons.push('MAP ' + Math.round(b.map));
    if (S.rhythm === 'sinus' && S.spo2 < 90) reasons.push('SpO₂ ' + Math.round(S.spo2) + '%');
    if (S.k > 6.5) reasons.push('血钾 ' + S.k.toFixed(1));
    if (E.temperatureStatus(S.temp) === 'crit') reasons.push(`${temperatureLabel(S.temp)} ${S.temp.toFixed(1)}℃`);
    if (S.rhythm !== 'sinus') reasons.push('心律异常');
    if (S.vent) reasons.push('已插管');
  }
  const el = document.createElement('div');
  el.id = 'severePopup';
  el.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42)';
  el.innerHTML =
    '<div style="width:min(420px,88vw);background:var(--card);color:var(--ink);border-radius:16px;padding:20px 20px 16px;box-shadow:0 20px 60px rgba(0,0,0,.35);border:1px solid rgba(211,58,58,.35)">' +
      '<div style="font-size:11px;letter-spacing:2px;color:#c0392b;margin-bottom:6px">⚠ 病情加重</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px">' + (ed ? '请立即复评' : '已转入重症') + '</div>' +
      '<div style="font-size:13px;line-height:1.7;color:var(--ink-2)">' + (reasons.length ? reasons.join(' · ') : '生命体征恶化') + '</div>' +
      '<div style="font-size:12.5px;line-height:1.7;color:var(--ink-3);margin-top:8px">' +
        (ed ? '结合床旁监护复评，按需安排检查。' : '从现在起血液指标改为实时监护；床位费按重症计。') + '</div>' +
      '<button id="sevOk" style="margin-top:14px;width:100%;padding:11px;border-radius:11px;border:1px solid rgba(211,58,58,.4);background:rgba(211,58,58,.10);color:#c0392b;font:inherit;font-weight:700;cursor:pointer">知道了</button>' +
    '</div>';
  document.body.appendChild(el);
  severePopup = el;
  const close = () => { el.remove(); severePopup = null; };
  el.querySelector('#sevOk').addEventListener('click', close);
  el.addEventListener('click', (ev) => { if (ev.target === el) close(); });
}

/* ---------------- 关于 / 隐私 ---------------- */
function openAbout() {
  openSheet('关于 · 隐私', 'v' + APP_VERSION, []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  list.innerHTML =
    '<div style="padding:12px 14px 6px;font-size:12.5px;line-height:1.9;color:var(--ink-2)">' +
      '<b style="color:var(--ink)">悬壶</b> · 一间病房，四位患者，时间不会等你。<br>' +
      '版本 v' + APP_VERSION + '（' + platformName + '）' +
    '</div>' +
    '<div class="sec">我们怎么处理你的数据</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '· <b>不收集</b>姓名、手机号、位置、设备标识<br>' +
      '· 游戏进度只存在你的设备上，不上传<br>' +
      '· 只有在你自己点「反馈问题」并提交时，才会发送版本、病例和体征数据' +
    '</div>' +
    '<div class="sec">权限</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '安卓版只申请网络权限（检查更新 / 在线版 / 反馈）。不申请存储、相机、麦克风、定位。' +
    '</div>' +
    '<div class="sec">医学免责</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9;color:#a33">' +
      '本作是教学模拟。所有病例、数值、处置均为教学演示，<b>不构成医疗建议</b>，不能用于真实诊疗。' +
    '</div>' +
    '<div style="display:flex;gap:8px;padding:6px 14px 10px">' +
      (releaseBase ? '<a href="' + escapeHtml(releaseBase) + '/privacy.html" target="_blank" class="pill" style="flex:1;padding:11px;text-align:center">完整隐私政策</a>' : '') +
      '<button id="abCopy" class="pill" style="flex:1;padding:11px;cursor:pointer;border-radius:12px">复制版本信息</button>' +
    '</div>' +
    '<div style="padding:0 14px 16px;font-size:11.5px;color:var(--ink-3);line-height:1.8">' +
      '建议 16 岁以上玩家使用。' +
    '</div>';
  list.querySelector('#abCopy').addEventListener('click', async () => {
    const t = '悬壶 v' + APP_VERSION + ' · ' + platformName;
    try { await navigator.clipboard.writeText(t); toast('已复制'); } catch (e) { toast(t, true); }
  });
}

/* ---------------- 问题反馈 ---------------- */
function buildFeedbackText() {
  const lines = [];
  lines.push('【悬壶 问题反馈】');
  lines.push('版本：v' + APP_VERSION + '（' + platformName + '）');
  try { lines.push('设备：' + navigator.userAgent.slice(0, 90)); } catch (e) {}
  if (S) {
    const ed = isEDIntake(S);
    lines.push(ed ? '病例难度：6 · 急诊首诊' : '病例编号：' + (S.caseId || '随机') + ' / 难度 ' + (S.diff || caseDiff));
    const p = S.patient || {};
    lines.push('病人：' + (p.name || '—') + ' ' + (p.sex || '') + ' ' + (p.age || '') + ' 岁');
    lines.push('游戏时间：' + Math.round((S.t || 0) / 60) + ' 分钟 · ' + caseOutcomeLabel(S));
    const vitals = E.snapshot(S);
    lines.push('体征：HR ' + vitals.hr + ' BP ' + vitals.sys + '/' + vitals.dia +
      ' SpO2 ' + (vitals.spo2 == null ? '无信号' : vitals.spo2 + '%') +
      (ed ? ' RR ' + vitals.rr : ' T ' + S.temp.toFixed(1) + ' K ' + S.k.toFixed(1) + ' GCS ' + S.gcs));
    if (!ed) {
      const tail = (S.log || []).slice(-12).map(l => '  ' + l[0] + ' ' + l[1]).join('\n');
      if (tail) lines.push('最近记录：\n' + tail);
    }
    const given = (S.given || []).slice(-10).map(g => {
      if (g.pumpAction) return '  ' + E.pumpOrder(g.n, g.pumpAction, g.d, g.unit);
      if (g.infusionMinutes) return `  ${g.n}（${g.route} · ${E.infusionDetails(g.d, g.unit, g.infusionMinutes)}）`;
      return '  ' + g.n + ' ' + g.d + (g.unit || '');
    });
    if (given.length) lines.push('最近用药：\n' + given.join('\n'));
    /* 会诊码：作者拿到可以原样复现这一例 */
    try {
      if (window.SHARE && window.SHARE.make) {
        const code = window.SHARE.make(S);
        if (code) {
          lines.push('会诊码（可复现本例）：');
          lines.push(code);
        }
      }
    } catch (e) {}
    const isGen = !!(S.cas && (S.cas.id === 'gen' || S.caseId === 'gen'));
    const sd = (S.seed != null) ? S.seed : (S.cas && S.cas.seed);
    if (!ed) lines.push('种子/难度：' + (isGen ? (sd != null ? sd : '随机') : '固定病例') + ' / ' + (S.diff || caseDiff));
  }
  lines.push('问题描述：（在这里写你遇到的情况）');
  return lines.join('\n');
}

function openFeedback() {
  const text = buildFeedbackText();
  openSheet('反馈问题', '复制后发作者即可', []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  list.innerHTML =
    '<div style="padding:10px 14px;font-size:12.5px;line-height:1.8;color:var(--ink-2)">' +
      '下面这段包含了版本、病例、最近的体征与操作记录，作者拿到就能定位问题。' +
      '把你在"问题描述"里补几句话，然后复制发过去。' +
    '</div>' +
    '<div style="padding:0 14px 10px">' +
      '<textarea id="fbText" style="width:100%;height:220px;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:11.5px/1.6 monospace;resize:vertical">' + text.replace(/</g, '&lt;') + '</textarea>' +
    '</div>' +
    '<div style="display:flex;gap:8px;padding:0 14px 14px">' +
      '<button id="fbCopy" class="pill" style="flex:1;padding:11px;cursor:pointer;background:rgba(211,58,58,.10);color:#a33;font-weight:700;border-radius:12px">复制报告</button>' +
      '<button id="fbSend" class="pill" style="flex:1;padding:11px;cursor:pointer;border-radius:12px">直接提交</button>' +
      '<button id="fbMail" class="pill" style="flex:1;padding:11px;cursor:pointer;border-radius:12px">邮件发送</button>' +
    '</div>' +
    '<div style="padding:0 14px 16px;font-size:12px;color:var(--ink-3);line-height:1.8">' +
      '"直接提交"在网页版可用（走站点的表单服务）；APK 里请用"复制报告"，发微信/QQ 给作者。' +
    '</div>';

  const ta = list.querySelector('#fbText');
  list.querySelector('#fbCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ta.value); toast('已复制，发给作者即可'); }
    catch (e) { ta.select(); toast('已选中，请手动复制', true); }
  });
  list.querySelector('#fbMail').addEventListener('click', () => {
    let to = '';
    try { to = (localStorage.getItem('life.contact') || '').trim(); } catch (e) {}
    const m = to.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (!m) { toast('先在「获取最新版」里填作者邮箱', true); return; }
    const subject = encodeURIComponent('悬壶 问题反馈 v' + APP_VERSION);
    const body = encodeURIComponent(ta.value);
    location.href = 'mailto:' + m[0] + '?subject=' + subject + '&body=' + body;
  });
  list.querySelector('#fbSend').addEventListener('click', async () => {
    if (!IS_WEB) { toast('APK 里请用"复制报告"', true); return; }
    try {
      const body = new URLSearchParams({ 'form-name': 'feedback', 'detail': ta.value });
      const r = await fetch('/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (r.ok) toast('已提交，谢谢！');
      else throw new Error('HTTP ' + r.status);
    } catch (e) {
      /* 站点没开表单功能时，自动复制，避免用户白填 */
      try { await navigator.clipboard.writeText(ta.value); toast('提交未开通，已复制报告，发给作者即可'); }
      catch (e2) { toast('提交未开通，请点「复制报告」', true); }
    }
  });
}

/* ---------------- 版本 / 更新检查 ---------------- */
const APP_VERSION = '1.55';
const releaseRoot = document.querySelector('meta[name="xuanhu-release-root"]')?.content;
const releaseBase = releaseRoot ? new URL(releaseRoot, location.href).href.replace(/\/$/, '') : '';
const platformName = location.protocol === 'file:' ? '离线 HTML' :
  (window.Capacitor?.isNativePlatform?.() ? '安卓版' : '网页版');

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* 更新 / 下载：优先用"当前站点"（网页版部署在哪就查哪），
   其次用玩家保存的地址，最后才是校园网服务器。
   这样校外/公网部署后不需要再连内网。 */
function updateBaseCandidates() {
  const list = [];
  try {
    const saved = localStorage.getItem('life.updateBase');
    if (saved) list.push(saved.replace(/\/$/, ''));
  } catch (e) {}
  if (releaseBase) list.push(releaseBase);
  if (/^https?:/.test(location.protocol) && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(location.origin)) {
    list.push(location.origin);
  }
  list.push('https://xuanhu.netlify.app');
  return Array.from(new Set(list.filter(Boolean)));
}

function downloadPageUrl(base) {
  try {
    const saved = localStorage.getItem('life.downloadPage');
    if (saved) return saved;
  } catch (e) {}
  return (base || releaseBase || 'https://xuanhu.netlify.app') + '/download.html';
}

function openGetLatest() {
  openSheet('获取最新版', '当前 v' + APP_VERSION, []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  let contact = '';
  try { contact = localStorage.getItem('life.contact') || ''; } catch (e) {}
  list.innerHTML =
    '<div style="padding:12px 14px;font-size:13px;line-height:1.9;color:var(--ink-2)">' +
      '下载页提供网页版和可离线打开的 HTML。发布者提供安卓安装包时，也会列在下载页。' +
    '</div>' +
    '<div class="sec">当前版本</div>' +
    '<div style="padding:0 14px 10px;display:flex;align-items:center;gap:10px">' +
      '<div style="font-size:22px;font-weight:800">v' + APP_VERSION + '</div>' +
      '<button id="glCopy" class="pill" style="padding:8px 14px;cursor:pointer">复制版本号</button>' +
      '</div>' +
      '<div style="padding:0 14px 12px">' +
      '<a id="glOpen" target="_blank" class="pill" style="display:block;padding:12px;text-align:center;text-decoration:none;background:var(--accent-soft);color:var(--accent);font-weight:700;border-radius:12px">打开下载页</a>' +
    '</div>' +
    '<div class="sec">联系方式</div>' +
    '<div style="padding:0 14px 10px">' +
      '<textarea id="glContact" placeholder="在这里写你的联系方式（微信 / QQ / 群号），会保存在本机" ' +
      'style="width:100%;height:70px;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-size:12.5px;resize:none"></textarea>' +
    '</div>' +
    '<div style="display:flex;gap:8px;padding:0 14px 14px">' +
      '<button id="glSave" class="pill" style="flex:1;padding:10px;cursor:pointer">保存</button>' +
    '</div>' +
    '<div style="padding:0 14px 16px;font-size:12px;line-height:1.8;color:var(--ink-3)">' +
      '提示：这个面板里的"联系方式"只存在你这台设备上，发给别人前请自己确认内容。' +
    '</div>';
  const ta = list.querySelector('#glContact');
  ta.value = contact;
  list.querySelector('#glOpen').href = downloadPageUrl();
  list.querySelector('#glSave').addEventListener('click', () => {
    try { localStorage.setItem('life.contact', ta.value.trim()); } catch (e) {}
    toast('已保存联系方式');
  });
  list.querySelector('#glCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('悬壶 v' + APP_VERSION); toast('已复制版本号'); }
    catch (e) { toast('复制失败', true); }
  });
}

async function checkUpdate() {
  openSheet('检查更新', '当前版本 ' + APP_VERSION, []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  list.innerHTML = '<div style="padding:16px 14px;font-size:13px;color:#8a8078">正在查找更新…</div>';
  const loading = list.firstElementChild;

  const cands = updateBaseCandidates();
  let info = null, usedBase = null;
  for (const b of cands) {
    try {
      const r = await fetch(b + '/version.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.version) { info = j; usedBase = b; break; }
    } catch (e) {}
  }

  /* 找不到服务器：给出"打开下载页 / 分享给朋友"的路径，而不是死胡同 */
  if (!list.contains(loading) || !$('#sheet').classList.contains('on')) return;
  if (!info) {
    const dl = downloadPageUrl(cands[0]);
    list.innerHTML =
      '<div style="padding:14px 14px 4px;font-size:13px;line-height:1.8">' +
        '<div style="color:#8a8078;margin-bottom:8px">没连上更新服务器（校外、或服务器没开）。可以直接打开下载页：</div>' +
      '</div>' +
      '<div style="padding:0 14px 12px">' +
        '<a href="' + dl + '" target="_blank" class="pill" style="display:block;padding:12px;text-align:center;text-decoration:none;background:rgba(211,58,58,.10);color:#a33;font-weight:700;border-radius:12px">打开下载页</a>' +
      '</div>' +
      '<div class="sec">下载页地址（可改）</div>' +
      '<div style="padding:0 14px 10px">' +
        '<input id="dlUrl" value="' + dl.replace(/"/g, '') + '" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-size:12.5px">' +
      '</div>' +
      '<div style="display:flex;gap:8px;padding:0 14px 14px">' +
        '<button id="dlSave" class="pill" style="flex:1;padding:10px;cursor:pointer">保存地址</button>' +
        '<button id="dlCopy" class="pill" style="flex:1;padding:10px;cursor:pointer">复制链接</button>' +
      '</div>' +
      '<div style="padding:0 14px 16px;font-size:12px;line-height:1.8;color:var(--ink-3)">' +
        '把网页版放到公网（Netlify Drop 拖一下即可）之后，把地址填在这里，' +
        '以后点"检查更新"就能直接下载新版，也能把同一个链接发给朋友。' +
      '</div>';
    const b1 = list.querySelector('#dlSave');
    if (b1) b1.addEventListener('click', () => {
      const v = list.querySelector('#dlUrl').value.trim();
      try { localStorage.setItem('life.downloadPage', v); } catch (e) {}
      toast('已保存下载页地址');
    });
    const b2 = list.querySelector('#dlCopy');
    if (b2) b2.addEventListener('click', async () => {
      const v = list.querySelector('#dlUrl').value.trim();
      try { await navigator.clipboard.writeText(v); toast('已复制，发给朋友即可'); }
      catch (e) { toast('复制失败，请手动选择', true); }
    });
    return;
  }

  const newer = cmpVer(info.version, APP_VERSION) > 0;
  const size = info.apkSize ? (info.apkSize / 1048576).toFixed(2) + ' MB' : '';
  const dl = downloadPageUrl(usedBase);
  list.innerHTML =
    '<div style="padding:14px;font-size:13px;line-height:1.8">' +
      '<div>当前版本：<b>' + APP_VERSION + '</b></div>' +
      '<div>服务器版本：<b>' + info.version + '</b>' +
        (newer ? ' <span style="color:#c0392b">（有新版本）</span>' : ' <span style="color:#27ae60">（已是最新）</span>') + '</div>' +
      (size ? '<div style="color:#8a8078">安装包：' + size + '</div>' : '') +
      '<div style="color:#8a8078;font-size:11.5px;margin-top:4px">来源：' + usedBase + '</div>' +
    '</div>' +
    '<div class="sec">获取新版本</div>' +
    '<div style="padding:0 14px 10px;display:flex;gap:8px">' +
      '<a href="' + dl + '" target="_blank" class="pill" style="flex:1;padding:11px;text-align:center;text-decoration:none;background:rgba(211,58,58,.10);color:#a33;font-weight:700;border-radius:12px">下载页</a>' +
      (info.apk ? '<a href="' + escapeHtml(usedBase + info.apk) + '" target="_blank" class="pill" style="flex:1;padding:11px;text-align:center;text-decoration:none;border-radius:12px">下载 APK</a>' : '') +
    '</div>' +
    '<div style="padding:0 14px 16px">' +
      '<a href="' + usedBase + '/web/" target="_blank" class="pill" style="display:block;padding:11px;text-align:center;text-decoration:none;border-radius:12px">打开在线版（永远最新）</a>' +
    '</div>';
}

/* ---------------- 医保说明（给玩家看的） ---------------- */
function openInsuranceHelp() {
  openSheet('医保怎么算', '现实模式', []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  const bindSwitch = () => {
    list.querySelectorAll('[data-ins]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!realismRules.insurance || !S) { toast('请先开启「医保与自付」并接诊患者', true); return; }
        initInsurance(btn.dataset.ins === 'random' ? 'random' : btn.dataset.ins);
        toast('已切换：' + (S.ins ? S.ins.t : ''));
        openInsuranceHelp();
      });
    });
  };
  const ins = realismRules.insurance && S?.ins;
  const c = ins ? costSummary() : null;
  list.innerHTML =
    '<div style="padding:12px 14px 6px;font-size:12.5px;line-height:1.85;color:var(--ink-2)">' +
      '开启「医保与自付」后，可查看医保报销和<b>患者家庭的自付金额</b>。' +
    '</div>' +
    '<div class="sec">三个数字</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '① <b>总费用</b>：药物、血液制品、检查、操作等费用，加床位费（普通 ¥25/小时，重症 ¥80/小时）。药库使用游戏模拟价，持续泵按实际泵速和时长计费。<br>' +
      '② <b>医保报销</b> = min(封顶线, max(0, 总费用 − 起付线) × 报销比例)<br>' +
      '③ <b>家庭自付</b> = 总费用 − 医保报销' +
    '</div>' +
    '<div class="sec">三条线</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '· <b>起付线</b>：先自己掏够这个数，医保才开始报（职工 ¥800 / 居民 ¥500）<br>' +
      '· <b>封顶线</b>：医保最多报到这个数（职工 ¥3 万 / 居民 ¥1.5 万）<br>' +
      '· <b>家庭承受力</b> = 家庭月收入 × 3（因病致贫的粗略线）' +
    '</div>' +
    '<div class="sec">什么时候算"出事"</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '· 自付 > 承受力：提醒<br>' +
      '· 自付 > 承受力 × 1.3：<b style="color:#c0392b">触发医保拒付提醒</b>' +
    '</div>' +
    (ins ? (
      '<div class="sec">本例</div>' +
      '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
        '参保：' + ins.t + '（报销 ' + Math.round(ins.rate * 100) + '%）<br>' +
        '月收入：¥' + ins.income + '　承受力：¥' + Math.round(ins.oopCap) + '<br>' +
        '当前：总费用 ¥' + c.total + '　报销 ¥' + c.reimb + '　<b>自付 ¥' + c.selfPay + '</b>' +
      '</div>'
    ) : '') +
    '<div class="sec">怎么省</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '· 先查再治：不必要的检查先不开<br>' +
      '· 早发现早处理：拖成重症，床位费翻三倍<br>' +
      '· 同类药选便宜的（昂丹司琼 vs 昂贵止吐）' +
    '</div>' +
    '<div class="sec">切换参保类型</div>' +
    '<div style="display:flex;gap:6px;padding:0 14px 10px;flex-wrap:wrap">' +
      ['职工医保', '居民医保', '异地自费', 'random'].map(t =>
        '<button data-ins="' + t + '" class="pill" style="flex:1;min-width:80px;padding:9px;cursor:pointer;' +
        ((S && S.ins && (S.ins.t === t || (t === 'random' && false))) ? 'background:rgba(211,58,58,.12);color:#a33;font-weight:700' : '') +
        '">' + (t === 'random' ? '随机重抽' : t) + '</button>').join('') +
    '</div>' +
    '<div style="padding:6px 14px 16px;font-size:12px;color:var(--ink-3);line-height:1.8">' +
      '可在大厅或菜单的「现实模式」中单独开关「医保与自付」。' +
    '</div>';
  bindSwitch();
}

/* ---------------- 在线版模式 ----------------
   安装包里是本地网页；如果把它指向一个"在线版"地址，之后所有更新都只是
   替换服务器上的文件，玩家不需要重新装 APK。 */
function openOnlineMode() {
  const cur0 = (function () { try { return localStorage.getItem('life.remoteBase') || ''; } catch (e) { return ''; } })();
  /* 旧版本可能存过 http://localhost/web/（那是 APK 自己），直接忽略并清掉 */
  const cur = /localhost|127\.0\.0\.1/.test(cur0) ? '' : cur0;
  if (!cur && cur0) { try { localStorage.setItem('life.remoteBase', ''); } catch (e) {} }
  const cand = updateBaseCandidates().filter(b => !/localhost|127\\.0\\.0\\.1/.test(b))[0];
  const def = cur || (cand ? cand + '/web/' : '');
  openSheet('在线版模式', '免安装更新', []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  list.innerHTML =
    '<div style="padding:12px 14px;font-size:12.5px;line-height:1.8;color:var(--ink-2)">' +
      '设置后，游戏启动会直接加载这个网址上的版本。以后更新只需要替换服务器上的文件，<b>不用再装 APK</b>。' +
      '<br>代价：必须联网；离线时请改用本地版。' +
    '</div>' +
    '<div style="padding:0 14px 10px">' +
      '<input id="olUrl" value="' + def.replace(/"/g, '') + '" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-size:12.5px">' +
    '</div>' +
    '<div style="display:flex;gap:8px;padding:0 14px 14px">' +
      '<button id="olGo" class="pill" style="flex:1;padding:10px;cursor:pointer">应用内加载</button>' +
      '<button id="olBrowser" class="pill" style="flex:1;padding:10px;cursor:pointer;background:rgba(211,58,58,.10);color:#a33;font-weight:700">浏览器打开</button>' +
      '<button id="olClear" class="pill" style="flex:1;padding:10px;cursor:pointer">清除</button>' +
    '</div>' +
    (cur ? '<div style="padding:0 14px 16px;font-size:12px;color:var(--ink-3)">当前：' + cur + '</div>' : '');
  const save = v => { try { localStorage.setItem('life.remoteBase', v); } catch (e) {} };
  list.querySelector('#olGo').addEventListener('click', () => {
    let v = list.querySelector('#olUrl').value.trim();
    if (!v) { toast('请输入网址', true); return; }
    if (!/^https?:\/\//.test(v)) { toast('需要以 http:// 或 https:// 开头', true); return; }
    save(v);
    toast('正在加载在线版…');
    setTimeout(() => { location.href = v; }, 400);
  });
  list.querySelector('#olBrowser').addEventListener('click', () => {
    let v = list.querySelector('#olUrl').value.trim();
    if (!v) { toast('请输入网址', true); return; }
    if (!/^https?:\/\//.test(v)) { toast('需要以 http:// 或 https:// 开头', true); return; }
    save(v);
    window.open(v, '_system');
    toast('已交给系统浏览器打开');
  });
  list.querySelector('#olClear').addEventListener('click', () => {
    save(''); toast('已清除，下次启动用本地版'); closeSheet();
  });
}

/* ---------------- 会诊（分享码） ---------------- */
function openConsult() {
  const patient = S;
  if (!window.SHARE) { openDetail('会诊', '', [['状态', '会诊模块未加载']], ''); return; }
  openSheet('会诊', '把这一例分享给别的医生，或接手别人的病例', []);
  const list = document.querySelector('#sheetList');
  if (!list) return;
  list.innerHTML =
    '<div class="sec">我要分享这一例</div>' +
    '<div style="padding:0 12px 12px">' +
      '<div style="font-size:12px;color:#8a8078;margin-bottom:8px">' +
        (isEDIntake(patient) ? '对方可用会诊码重建本例，从急诊首诊开始。' :
          '会诊码包含病例来源、病人身份、处置与结局。对方粘贴后可预览，也可以接手重来。') + '</div>' +
      '<textarea id="cShareOut" readonly style="width:100%;height:88px;padding:10px;border-radius:10px;border:1px solid #e8e4e2;font:12px/1.5 monospace;background:#faf9f8;resize:none"></textarea>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button id="cMake" class="pill" style="flex:1;padding:10px;cursor:pointer"' + (patient ? '' : ' disabled') + '>生成本例会诊码</button>' +
        '<button id="cCopy" class="pill" style="flex:1;padding:10px;cursor:pointer"' + (patient ? '' : ' disabled') + '>复制</button>' +
      '</div>' +
    '</div>' +
    '<div class="sec">我要接手别人的病例</div>' +
    '<div style="padding:0 12px 16px">' +
      '<textarea id="cIn" placeholder="粘贴对方发来的会诊码（HX1- 开头）" style="width:100%;height:88px;padding:10px;border-radius:10px;border:1px solid #e8e4e2;font:12px/1.5 monospace;background:#faf9f8;resize:none"></textarea>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button id="cParse" class="pill" style="flex:1;padding:10px;cursor:pointer">解析并查看</button>' +
      '</div>' +
      '<div id="cPreview" style="margin-top:10px"></div>' +
    '</div>';

  const out = list.querySelector('#cShareOut');
  list.querySelector('#cMake').addEventListener('click', () => {
    if (!isCurrentPatient(patient)) return;
    const code = window.SHARE.make(patient);
    if (!code) { toast('无法生成会诊码', true); return; }
    out.value = code;
    toast('会诊码已生成（' + code.length + ' 字）');
  });
  list.querySelector('#cCopy').addEventListener('click', async () => {
    if (!out.value) { toast('先生成会诊码', true); return; }
    try { await navigator.clipboard.writeText(out.value); toast('已复制'); }
    catch (e) { out.select(); document.execCommand && document.execCommand('copy'); toast('已选中，请手动复制'); }
  });

  list.querySelector('#cParse').addEventListener('click', () => {
    const raw = list.querySelector('#cIn').value;
    const r = window.SHARE.parse(raw);
    const pv = list.querySelector('#cPreview');
    if (!r.ok) { pv.innerHTML = '<div style="color:#c0392b;font-size:12.5px">' + escapeHtml(r.err) + '</div>'; return; }
    const d = r.data;
    const ed = isEDIntake({ diff: d.d });
    const p = d.p || {};
    const acts = (ed ? [] : d.a || []).map(([kind, , id, dose, infusion]) => {
      if (kind === 'd' && ['start', 'adjust', 'stop'].includes(infusion?.pumpAction)) {
        const name = window.SUBSTANCES?.byId(id)?.n || id;
        return E.pumpOrder(name, infusion.pumpAction, dose, infusion.unit);
      }
      if (kind === 'd' && Number.isFinite(infusion?.minutes) && infusion.minutes > 0) {
        const name = window.SUBSTANCES?.byId(id)?.n || id;
        return `开始${infusion.route || '泵入'} ${name}（${E.infusionDetails(dose, infusion.unit, infusion.minutes)}）`;
      }
      return (kind === 'd' ? '给药 ' : '操作 ') + id + (dose ? ' ' + dose : '');
    });
    const outcome = d.o === 'death' ? ('死亡' + (d.r ? '（' + d.r + '）' : ''))
      : d.o === 'failed' ? ('出院判定失败' + (d.r ? '（' + d.r + '）' : '')) : d.o === 'discharge' ? '出院' : '未结束';
    pv.innerHTML =
      '<div style="font-size:13px;line-height:1.7">' +
      '<div><b>会诊病例</b></div>' +
      '<div style="color:#8a8078">病人：' + escapeHtml(p.n || '—') + ' · ' + escapeHtml(p.x) + ' · ' + escapeHtml(p.a) + ' 岁 · ' + escapeHtml(p.w) + ' kg</div>' +
      (ed ? '<div style="color:#8a8078">第 6 级 · 急诊首诊</div>' :
        '<div style="color:#8a8078">结局：' + escapeHtml(outcome) + ' · 用时 ' + escapeHtml(d.t) + ' 分钟 · 评分 ' + escapeHtml(d.sc) + '</div>' +
        '<div style="margin-top:6px;color:#6b625d">处置 ' + acts.length + ' 条：' + escapeHtml(acts.slice(0, 6).join('；') || '无') + (acts.length > 6 ? ' …' : '') + '</div>') +
      '</div>' +
      '<button id="cTake" class="pill" style="margin-top:10px;padding:10px 16px;cursor:pointer;background:#f7e6e6;color:#a33;font-weight:700">接手这一例</button>';
    const take = pv.querySelector('#cTake');
    take.addEventListener('click', () => {
      if (patient !== S || !list.contains(take) || !$('#sheet').classList.contains('on')) return;
      const ns = window.SHARE.rebuild(d, E);
      if (!ns) { toast('无法重建该病例', true); return; }
      installCase(ns, true, d.d ?? 1);
      toast('已接手该会诊病例' + (p.n ? '：' + escapeHtml(p.n) : ''));
    });
  });
}

/* ---------------- 术语表 ---------------- */
function openGlossary(q) {
  if (!window.GLOSSARY) { openDetail('术语表', '', [['状态', '术语模块未加载']], ''); return; }
  const list = window.GLOSSARY.search(q || '');
  openSheet('术语表', '点任意名词看解释', []);
  const host = document.querySelector('#sheetList');
  if (!host) return;
  host.innerHTML =
    '<div style="padding:2px 12px 10px"><input id="glSearch" placeholder="搜索术语、缩写…" ' +
    'style="width:100%;padding:10px 12px;border-radius:11px;border:1px solid #e8e4e2;font:inherit;' +
    'font-size:14px;outline:none;background:#faf9f8" value="' + (q || '').replace(/"/g, '&quot;') + '"></div>' +
    '<div id="glList">' + list.map(t =>
      '<div class="drow" data-t="' + t.n + '"><span class="nm">' + t.n +
      (t.abbr ? '<span style="font-size:10px;color:#b3a6a6"> · ' + t.abbr + '</span>' : '') +
      '</span><span class="amt" style="font-size:11px;color:#9a8f89">' + (t.normal || '') + '</span></div>'
    ).join('') + '</div>' +
    (list.length ? '' : '<div style="padding:18px;color:#9a9a9a;font-size:13px">没有匹配的术语</div>');
  const inp = host.querySelector('#glSearch');
  if (inp) inp.addEventListener('input', () => openGlossary(inp.value));
  host.querySelectorAll('[data-t]').forEach(el => {
    el.addEventListener('click', () => {
      const card = window.GLOSSARY.renderCard(el.dataset.t);
      if (card) openDetail(card.title, card.sub, card.kv, '');
    });
  });
}

function openHandbook() {
  const H = window.HANDBOOK;
  if (!H) { openDetail('行医手册', '', [['状态', '手册模块未加载']], ''); return; }
  let html = '';
  try { html = H.render(); } catch (e) { html = '<div class="sec">手册渲染失败</div>'; }
  openSheet('行医手册', '我遇到过的诊断 · 疗法 · 误治 · 备注', []);
  const list = document.querySelector('#sheetList');
  if (list) {
    list.innerHTML = '<div style="padding:2px 12px 10px">' +
      '<input id="hbSearch" placeholder="搜索诊断 / 药名…" ' +
      'style="width:100%;padding:10px 12px;border-radius:11px;border:1px solid #e8e4e2;' +
      'font:inherit;font-size:14px;outline:none;background:#faf9f8"></div>' + html;
    const inp = list.querySelector('#hbSearch');
    if (inp) {
      inp.addEventListener('input', () => {
        const q = inp.value.trim();
        list.querySelectorAll('details').forEach(d => {
          d.style.display = (!q || d.textContent.indexOf(q) >= 0) ? '' : 'none';
        });
      });
    }
  }
}
function handbookTag() {
  try { return window.HANDBOOK ? window.HANDBOOK.entries().length + ' 种诊断' : '未加载'; }
  catch (e) { return '查看'; }
}
function checkSigns() {
  if (!isCurrentPatient(S) || !window.SIGNS) return;
  let list = [];
  try { list = window.SIGNS.detect(S) || []; } catch (e) { return; }
  if (isEDIntake(S)) {
    const monitored = ['ventricular_fibrillation', 'asystole', 'severe_hypoxemia', 'severe_hypotension',
      'hypoxemia', 'tachypnea', 'bradypnea', 'apnea', 'tachycardia', 'bradycardia', 'severe_bradycardia', 'hypotension', 'narrow_pulse_pressure'];
    list = list.filter(sign => monitored.includes(sign.id));
  }
  if (!list.length) return;
  let fresh = [];
  try { fresh = window.SIGNS.newOnes(list) || []; } catch (e) { return; }
  if (!fresh.length || !hasCurrentSaveEpoch()) return;
  try { window.SIGNS.markSeen(fresh); } catch (e) {}
  const critical = fresh.some(x => x.level === 'critical');
  const names = fresh.slice(0, 3).map(x => x.name).join('、')
    + (fresh.length > 3 ? ` 等 ${fresh.length} 项` : '');
  const brief = fresh[0].brief
    ? `<br><span style="font-size:11px;opacity:.85">${fresh[0].brief}</span>` : '';
  toast((critical ? '⚠ 危急体征：' : '新体征：') + names + brief, critical);
  if (critical) {
    try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) {}
  }
  return critical;
}
/* ---------------- 按钮 ---------------- */
function openSoundSettings() {
  openSheet('音效设置', '', []);
  const list = $('#sheetList');
  list.innerHTML = `<div class="sound-settings">
    <label for="soundVolume">音量</label><output for="soundVolume" id="soundPercent"></output>
    <input type="range" id="soundVolume" min="0" max="100" step="1">
    <button type="button" id="soundMute">静音</button>
  </div>`;
  const slider = $('#soundVolume'), mute = $('#soundMute');
  function sync() {
    const percent = SOUND.volume + '%';
    slider.value = SOUND.volume;
    slider.setAttribute('aria-valuetext', percent);
    $('#soundPercent').value = percent;
    mute.setAttribute('aria-pressed', String(!SOUND.enabled));
  }
  slider.addEventListener('input', () => { SOUND.volume = slider.valueAsNumber; sync(); });
  slider.addEventListener('change', () => SOUND.click());
  mute.addEventListener('click', () => { SOUND.enabled = !SOUND.enabled; sync(); SOUND.click(); });
  sync();
  slider.focus({ preventScroll: true });
}

function openBedsideMenu() {
  const patient = S;
  const rows = [
    ...dischargeMenuRows(patient),
    ...(isCurrentPatient(patient) ? [
      {n:'查看操作日志', tag:'当前床位', amt:'查看', run: () => openOperationLog(patient)},
      {n:'当前输液与泵药', tag:'输注进度与泵速', amt:'查看', run: () => openInfusions(patient)},
    ] : []),
    {n:'音效设置', tag:SOUND.enabled ? SOUND.volume + '%' : '静音', amt:'调节', run:openSoundSettings},
    {sec:'存档与测试'},
    {n:'重置游戏存档', tag:'清空游戏进度及设置', amt:'', run:confirmSaveReset},
    /* 仅调试模式可见：正式包不提供这个入口 */
    ...(DEBUG_TOOLS ? [{n:'强制移除当前患者（测试用）', tag:'释放当前床位', amt:'', run:confirmRemovePatient}] : []),
    {sec:'设置与工具'},
    {n:'会诊', tag:'分享 / 接手病例', amt:'查看', run: () => openConsult()},
    {n:'费用与医保', tag: realismRules.insurance ? '查看明细' : '医保规则已关闭', amt:'查看', run: () => openCostSheet()},
    {n:'检查更新', tag:'在线 · v' + APP_VERSION, amt:'查看', run: () => checkUpdate()},
    {n:'反馈问题', tag:'带上记录，一键复制', amt:'反馈', run: () => openFeedback()},
    {n:'关于 · 隐私', tag:'v' + APP_VERSION, amt:'查看', run: () => openAbout()},
    {n:'获取最新版', tag:'下载页 / 联系方式', amt:'查看', run: () => openGetLatest()},
    {n:'医保说明 / 切换', tag: realismRules.insurance ? ((S && S.ins ? S.ins.t : '未参保') + ' · 可切换') : '看看怎么算', amt:'查看', run: () => openInsuranceHelp()},
    {n:'在线版模式', tag:'免安装更新', amt:'设置', run: () => openOnlineMode()},
    ...(IS_WEB || releaseBase ? [{n:'下载离线版', tag:'查看可用版本', amt:'下载', run: openGetLatest}] : []),
    {n:'统计', tag:'出院率 · 常犯错', amt:'查看', run: () => openStats()},
    {n:'病历档案', tag:`最近 ${loadRecords().length} 例`, amt:'查看', run: () => openRecords()},
    {n:'行医手册', tag: handbookTag(), amt:'查看', run: () => openHandbook()},
    {n:'指标走势', tag:isEDIntake(patient) ? '床旁监护' : '血压·心率·血钾…', amt:'查看', run: () => openChart()},
    {n:'术语表', tag:(window.GLOSSARY?window.GLOSSARY.TERMS.length:0)+' 条', amt:'查看', run: () => openGlossary()},
    {n:'成就', tag: (window.ACHIEVEMENTS ? `${window.ACHIEVEMENTS.unlocked().size} / ${window.ACHIEVEMENTS.list.length} 已解锁` : '未加载'), amt:'查看', run: () => openAchievements()},
    {n:'难度设置', tag:'病例难度 ' + caseDiff + ' · 指导 ' + ((MENTOR.LEVELS[level]||MENTOR.LEVELS.intern).name), amt:'', run: () => openSheet('难度设置', '两轴独立', difficultyRows())},
    {n: nightMode ? '☀ 切回白天' : '🌙 夜间模式', tag: nightMode ? '病情推进 ×1.3 · 界面转暗' : '当前白天', amt:'切换', run: () => { closeSheet(); toggleNight(); }},
    {n:'现实模式', tag:ruleNames(enabledRules()), amt:'设置', run:openRealismSettings},
    {n: '环境 / 场景', tag: '环境与活动', amt: '', run: () => openEnvSheet(S)},
    {n: autoHint ? '主动提示：开' : '主动提示：关', tag: autoHint ? '自动显示提示' : '只在给药后点评', amt: '', run: () => {
      autoHint = !autoHint;
      try { localStorage.setItem('life.autoHint', autoHint ? '1' : '0'); } catch (e) {}
      closeSheet();
      showAdvice(false);
      toast(autoHint ? '已开启主动提示' : '已改为求助制：点「问上级」才给提示');
    }},
    {n:'返回大厅', tag:'床位 / 成就 / 手册', amt:'进入', run: () => { closeSheet(); showLobby(); }},
    {n:'病房床位', tag: beds.length + ' / ' + MAX_BEDS, amt:'切换', run: () => openBeds()},
    {n:'重新开始本病例', tag:'', amt:'', run: () => confirmRestart()},
    {n:'切换病例', tag:'', amt:'', run: () => pickCase()},
    {n:'教程 · 怎么玩', tag:(window.TUTORIAL?window.TUTORIAL.PAGES.length:6)+' 页', amt:'', run: () => { if (window.TUTORIAL) TUTORIAL.open(0); }},
  ];
  openSheet('菜单', patient?.patient.name || '', rows, patient);
  $('#sheetTitle').dataset.view = 'menu';
  if (isCurrentPatient(patient) && !realismRules.signedDischarge) {
    const assessment = E.dischargeCheck(patient);
    $('#sheetTitle').dataset.eligible = String(assessment.ok);
    $('#sheetTitle').dataset.observation = String(!isEDIntake(patient) && canStartObservation(patient, assessment));
  }
}

function bind() {
  bindLobby();
  $('#opTitle').addEventListener('change', event => selectOrgan(event.target.value));
  $('#btnLobby').addEventListener('click', showLobby);
  $('#btnAdmission').addEventListener('click', openAdmission);
  $('#sheetClose').addEventListener('click', dismissSheet);
  $('#btnDrug').addEventListener('click', () => openDrugSheet());
  $('#btnOps').addEventListener('click', () => {
    if (isCurrentPatient(S)) openSheet('操作', S.patient.name + ' · 急救与介入', actionRows(), S);
  });
  $('#btnBody').addEventListener('click', () => openChecks(S));
  $('#btnBlood').addEventListener('click', openReports);
  $('#btnMenu').addEventListener('click', openBedsideMenu);
  $('#mask').addEventListener('click', dismissSheet);
  $('#detailX').addEventListener('click', closeDetail);
  $('#detail').addEventListener('click', e => { if (e.target.id === 'detail') closeDetail(); });

  $('#speed').addEventListener('click', e => {
    const p = e.target.closest('.pill'); if (!p) return;
    if (p.id === 'pause') {
      if (realismRules.noPause) return;
      if (observation) stopObservation();
      paused = !paused;
      syncSpeedUI();
      return;
    }
    if (p.id === 'conditionWait') { startConditionReview(); return; }
    if (p.id === 'ff') {
      if (observation) { stopObservation(); return; }
      ff = paused || !ff;
      paused = false;
      syncSpeedUI(); return;
    }
    if (observation) stopObservation();
    paused = false;
    ff = false;
    speed = +p.dataset.s; syncSpeedUI();
  });
}

function setCaseDiff(v) {
  caseDiff = Math.max(1, Math.min(6, v | 0));
  try { localStorage.setItem('life.caseDiff', String(caseDiff)); } catch (e) {}
  dismissSheet();
  toast('病例难度：' + caseDiff);
}
const CASE_DIFFICULTIES = [
  ['普通', '单一病理（原 1–2 合并）'],
  ['重症', '单一病理 + 基础病（原 3–5 合并）'],
  ['危重', '双病理叠加 + 基础病'],
  ['极危', '三病理叠加 + 特殊体质'],
  ['噩梦', '三病理 + 双体质，交接线索有限'],
  ['急诊首诊', '沿用 5 级病情，主动问诊、查体和检查取证'],
];
function caseDiffRows() {
  return CASE_DIFFICULTIES.map(([name, desc], i) => ({
    n: (i + 1) + ' ' + name + ' · ' + desc, tag: (i + 1) === caseDiff ? '当前' : '', amt: '',
    run: () => setCaseDiff(i + 1),
  }));
}
function difficultyRows() {
  return [
    { n: '病例难度', tag: '第 ' + caseDiff + ' 级', amt: '调整',
      run: () => openSheet('病例难度', '病情复杂度与入院信息', caseDiffRows()) },
    { n: '指导强度', tag: (MENTOR.LEVELS[level] || MENTOR.LEVELS.intern).name, amt: '调整',
      run: () => openSheet('指导强度', '上级医师说多少', levelRows()) },
  ];
}
function diffFromLevel() {
  return caseDiff;
}
function prepareCase(st, intakeDifficulty = caseDiff) {
  const rules = enabledRules();
  st.admissionSettings = { level, realism: rules.length > 0, rules };
  st.usedRealismRules = [...rules];
  const { hr, sys, dia, temp, rr, spo2, gcs } = E.snapshot(st);
  st.admissionVitals = { t: st.t, hr, sys, dia, temp, rr, spo2, gcs, vent: !!st.vent, rhythm: st.rhythm };
  INTAKE.init(st, st.diff ?? intakeDifficulty);
  try { if (window.DIAGNOSIS) st.dx0 = window.DIAGNOSIS.classify(st); } catch (e) {}
  return st;
}

function evidenceText(item) {
  const timing = Number.isFinite(item.minutesBefore) ? INTAKE.formatTime(item.minutesBefore) + ' · ' : '';
  return escapeHtml(timing + item.text) + ` <small>（${escapeHtml(item.sourceLabel)} · ${caseTime(item.obtainedAt)} 记录）</small>`;
}

function admissionChartRows(chart, v) {
  const rows = [['主诉／来诊原因', escapeHtml(chart.chief.text)], ['陈述来源', escapeHtml(chart.chief.sourceLabel)]];
  for (const topic of chart.topics) {
    const notes = chart.known.filter(item => item.section === topic.id);
    const entries = notes.map(evidenceText);
    for (const inquiry of chart.inquiries.filter(item => item.section === topic.id)) {
      entries.push(escapeHtml(inquiry.sourceLabel + '未提供相关资料 · ' + caseTime(inquiry.obtainedAt) + ' 记录'));
    }
    rows.push([escapeHtml(topic.label), entries.join('<br>') || '尚未取得资料']);
  }
  if (v) {
    rows.push(['接诊首测', caseTime(v.t)],
      ['体温 / 心率', escapeHtml(`${v.temp ?? '—'} ℃ · ${v.hr} 次/分`)],
      ['血压 / 呼吸', escapeHtml(`${v.sys}/${v.dia} mmHg · ${v.rr} 次/分`)],
      ['SpO₂ / 意识', escapeHtml(`${v.spo2 == null ? '无信号' : v.spo2 + '%'} · GCS ${v.gcs}`)]);
  } else rows.push(['接诊首测', '旧存档未记录']);
  return rows;
}

function openAdmission() {
  if (!isCurrentPatient(S)) return;
  const rows = admissionChartRows(INTAKE.view(S), S.admissionVitals);
  const reports = E.reports(S);
  if (reports.length) rows.push(['已获查体与检查', reports.slice(-3).reverse().map(r => reportDetails(r, r.name + ' · ' + caseTime(r.reportedAt))).join('')]);
  rows.push(['继续采集', '<button class="pill" type="button" id="historySources">补问病史</button> <button class="pill" type="button" id="chartReports">查看报告</button>']);
  const patient = S;
  openDetail('入院记录', S.patient.name, rows, '');
  $('#historySources').onclick = () => { if (isCurrentPatient(patient)) { closeDetail(); openHistorySources(patient); } };
  $('#chartReports').onclick = () => { if (isCurrentPatient(patient)) { closeDetail(); openReports(); } };
}

function openHistorySources(patient) {
  const rows = INTAKE.view(patient).sources.map(source => ({
    n: escapeHtml(source.label), tag: source.available ? '' : escapeHtml(source.reason), amt: source.available ? '查看' : '暂不可用',
    run: () => {
      const current = INTAKE.view(patient).sources.find(s => s.id === source.id);
      if (current.available) openHistoryTopics(patient, current);
      else { toast(escapeHtml(current.reason)); openHistorySources(patient); }
    },
  }));
  rows.push({ n: '查看本床病历', tag: '', amt: '复阅', run: openAdmission },
    { n: '返回检查', tag: '', amt: '返回', run: () => openChecks(patient) });
  openSheet('问诊与院前资料', patient.patient.name, rows, patient);
}

function openHistoryTopics(patient, source) {
  const chart = INTAKE.view(patient);
  const rows = chart.topics.map(topic => ({
    n: escapeHtml(topic.label),
    tag: chart.inquiries.some(item => item.source === source.id && item.section === topic.id) ? '已询，未提供资料'
      : chart.known.some(item => item.source === source.id && item.section === topic.id) ? '已有该来源记录' : '',
    amt: '问询', run: () => {
      const result = INTAKE.ask(patient, source.id, topic.id);
      if (result.status === 'learned') {
        patient.log.push([E.fmt(patient.t), source.label + ' · 补录' + topic.label, 'info', patient.t, null, true]);
      }
      if (result.status === 'learned' || result.status === 'unknown') {
        saveGame();
        openHistoryTopics(patient, source);
      }
      const items = result.evidence.map(note => ['记录', evidenceText(note)]);
      openDetail(topic.label, patient.patient.name + ' · ' + source.label, items, result.message);
    },
  }));
  rows.push({ n: '更换来源', tag: '', amt: '返回', run: () => openHistorySources(patient) });
  openSheet(source.label, patient.patient.name, rows, patient);
}


/* 开局卡片：只讲患者主诉，几秒后自动淡出，不提供任何诊断线索 */
let admissionIntro = null;
function showAdmissionIntro(st) {
  if (admissionIntro) { admissionIntro.remove(); admissionIntro = null; }
  if (!st || !st.cas) return;
  const p = st.patient || {};
  const chart = INTAKE.view(st);
  const chief = chart.chief.text;
  const source = chart.chief.sourceLabel;
  const el = document.createElement('div');
  el.id = 'admissionIntro';
  el.style.cssText = 'position:fixed;inset:0;z-index:290;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.30);opacity:0;transition:opacity .35s ease';
  el.innerHTML =
    '<div style="width:min(430px,88vw);background:var(--card);color:var(--ink);border-radius:16px;padding:20px 20px 16px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.30);border:1px solid var(--line)">' +
      '<div style="font-size:11px;letter-spacing:2px;color:var(--ink-3);margin-bottom:6px">新患者入院</div>' +
      '<div style="font-size:19px;font-weight:700;margin-bottom:2px">' + escapeHtml(p.name || '患者') + '</div>' +
      '<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:12px">' +
        (p.age ? p.age + ' 岁 · ' : '') + (p.sex || '') + (p.weight ? ' · ' + p.weight + ' kg' : '') +
      '</div>' +
      '<div style="font-size:15px;font-weight:600;line-height:1.7;color:var(--ink);margin-bottom:10px">' +
        escapeHtml(chief) +
      '</div>' +
      (source
        ? '<div style="font-size:12.5px;line-height:1.75;color:var(--ink-2)">' +
            escapeHtml(source) +
          '</div>'
        : '') +
      '<div style="margin-top:14px;font-size:11.5px;color:var(--ink-3)">查体与化验请自行评估 · 点击关闭</div>' +
    '</div>';
  document.body.appendChild(el);
  admissionIntro = el;
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  let timer = null;
  const close = () => {
    if (!admissionIntro) return;
    if (timer) clearTimeout(timer);
    const node = admissionIntro;
    admissionIntro = null;
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 380);
  };
  el.addEventListener('click', close);
  /* 任意一次点击也立即关掉，避免遮挡操作 */
  window.addEventListener('pointerdown', close, { once: true, capture: true });
  timer = setTimeout(close, 5200);
}

function startCase(spec, replace, intakeDifficulty = caseDiff) {
  if (!replace && beds.length >= MAX_BEDS) {
    closeSheet();
    toast(`床位已满（最多 ${MAX_BEDS} 张），先处理或结束一个病例`, true);
    return;
  }
  const st = ensurePresentation(E.create(spec));
  installCase(st, replace, intakeDifficulty);
  showAdmissionIntro(st);
}

function installCase(st, replace, intakeDifficulty) {
  if (!hasCurrentWard()) return;
  prepareCase(st, intakeDifficulty);
  if (replace && isCurrentPatient(S)) {
    window.SOUND?.stopMonitorAlarm(S);
    try {
      if (!isEDIntake(S) && window.DIAGNOSIS && window.HANDBOOK) {
        recordDiagnosis(S, window.DIAGNOSIS.classify(S), '#unfinished');
      }
    } catch (e) { console.warn('[handbook] 未结记录失败：', e); }
    beds[activeIdx] = { S: st };
  } else {
    beds.push({ S: st });
    activeIdx = beds.length - 1;
  }
  focusBed(activeIdx);
  hideLobby();
  syncLevel();
  saveGame();
}

function confirmRestart() {
  const patient = S;
  if (!isCurrentPatient(patient)) return;
  openSheet('重新开始本病例', patient.patient.name + ' · 将重置该患者的处置和病程', [
    { n: '确认重新开始', tag: '', amt: '重启',
      run: () => startCase({ ...patient.cas, patient: patient.patient }, true, patient.intake.difficulty) },
    { n: '继续当前病例', tag: '', amt: '取消', run: closeSheet },
  ], patient);
}

function confirmRemovePatient() {
  const patient = S;
  if (!isCurrentPatient(patient)) return;
  openSheet('强制移除当前患者（测试用）', `床位 ${activeIdx + 1} · ${patient.patient.name}`, [
    { sec: '立即释放当前床位，保留其他患者。此操作跳过结算，病历、手册、成就和统计保持原样。' },
    { n: '取消', tag: '保留当前患者', amt: '', run: dismissSheet },
    { n: '确认移除当前患者', tag: '此操作无法撤销', amt: '', run: () => {
      const remaining = beds.filter(b => b.S !== patient);
      const next = Math.max(0, Math.min(activeIdx, remaining.length - 1));
      if (!writeWard(remaining, next, newStorageRevision())) {
        if (!reloadingForStorage) toast('保存床位变更失败，请检查本地存储权限', true);
        return;
      }
      window.SOUND?.stopMonitorAlarm(patient);
      beds = remaining;
      if (beds.length) {
        focusBed(next);
      } else {
        clearActiveBed();
        showLobby();
      }
      toast('已移除患者，床位已释放');
    } },
  ], patient);
}

function pickCase() {
  const rows = [
    { n: '🎲 随机生成新病例', tag: `难度 ${diffFromLevel()}`, amt: '推荐',
      run: () => startCase(window.CASEGEN.generate(diffFromLevel()), true) },
    { sec: '固定教学病例' },
  ];
  let idx = 0;
  for (const c of Object.values(E.CASES)) {
    idx += 1;
    /* 病名会剧透，这里只给年龄性别 */
    rows.push({ n: '教学病例 ' + idx, tag: c.age + '岁 ' + c.sex, amt: '',
                run: () => startCase(c.id, true) });
  }
  openSheet('选择病例', '随机生成 / 固定教学', rows, isCurrentPatient(S) ? S : null);
}

function applyTheme() {
  try { document.body.classList.toggle('night', !!nightMode); } catch (e) {}
}

function toggleNight() {
  nightMode = !nightMode;
  try { localStorage.setItem('life.night', nightMode ? '1' : '0'); } catch (e) {}
  applyTheme();
  toast(nightMode ? '🌙 夜间模式：病情推进加快，提示减少' : '☀ 白天模式');
  renderAll();
}

function restoreRealismRules(saved) {
  for (const key of Object.keys(REALISM_RULES)) realismRules[key] = saved?.[key] === true;
}

function openRealismSettings() {
  const entries = Object.entries(REALISM_RULES);
  openSheet('现实模式', '独立开关，即时应用到全病房及新接诊患者', entries.map(([key, rule]) => ({
    n: rule.name, tag: rule.note, amt: realismRules[key] ? '已开启' : '已关闭',
    run: () => {
      if (!hasCurrentWard()) return;
      realismRules[key] = !realismRules[key];
      if (key === 'noPause') {
        if (realismRules.noPause && paused) {
          paused = false;
          ff = false;
          speed = 1;
          acc = 0;
        }
        syncSpeedUI();
      }
      for (const { S: patient } of beds) {
        if (!patient.running) continue;
        patient.usedRealismRules ??= [];
        if (realismRules[key] && !patient.usedRealismRules.includes(key)) patient.usedRealismRules.push(key);
        patient.log.push([E.fmt(patient.t), (realismRules[key] ? '开启' : '关闭') + '规则 · ' + rule.name, 'info', patient.t, null, true]);
      }
      if (key === 'insurance' && realismRules.insurance && S && !S.ins) initInsurance();
      try { localStorage.setItem('life.realismRules', JSON.stringify(realismRules)); } catch (e) {}
      writeWard(beds, activeIdx, newStorageRevision());
      if (S) renderHUD();
      openRealismSettings();
      $('#sheetList [data-rule="' + key + '"]').focus({ preventScroll: true });
    },
  })));
  for (const button of $('#sheetList').querySelectorAll('.drow')) {
    const [key] = entries[Number(button.dataset.i)];
    button.dataset.rule = key;
    button.setAttribute('aria-pressed', String(realismRules[key]));
  }
}

/* ---------------- 医保与费用 ----------------
   现实模式下的"预算"不是医院限额，而是**家庭自付能力**：
     总费用 = 医药/操作费 + 床位费（重症更贵）
     报销   = min(封顶线, max(0, 总费用 − 起付线) × 报销比例)
     自付   = 总费用 − 报销
     家庭可承受自付 = 月收入 × 3（因病致贫的粗略线）
   自付超过承受力 130% 时记录医保拒付。 */
const INSURANCE = [
  { t: '职工医保', rate: 0.78, ded: 800, cap: 30000 },
  { t: '居民医保', rate: 0.58, ded: 500, cap: 15000 },
  { t: '异地自费', rate: 0.00, ded: 0, cap: 0 },
];

function initInsurance(forceType, patient = S) {
  if (!realismRules.insurance || !patient) return;
  let k;
  if (forceType != null) {
    const list = INSURANCE;
    k = forceType === 'random' ? list[Math.floor(Math.random() * list.length)] : (list.find(x => x.t === forceType) || list[0]);
  } else {
    k = INSURANCE[Math.floor(Math.random() * INSURANCE.length)];
  }
  const income = 3000 + Math.round(Math.random() * 9000);   // 家庭月收入
  const keepIncome = (patient.ins && patient.ins.income) ? patient.ins.income : income;
  patient.ins = { ...k, income: keepIncome, oopCap: keepIncome * 3 };
  patient.bedCost = patient.bedCost || 0;
  patient._overWarned = 0; patient._refused = 0;
}

function money(value) {
  return '¥' + (Math.round(value * 100) / 100).toFixed(2);
}

function costSummary(patient = S, additionalCost = 0) {
  const totalFen = Math.round(((patient.cost || 0) + (patient.bedCost || 0) + additionalCost) * 100);
  const ins = patient.ins;
  const reimbFen = ins ? Math.round(Math.min(ins.cap * 100, Math.max(0, totalFen - ins.ded * 100) * ins.rate)) : 0;
  return { total: totalFen / 100, reimb: reimbFen / 100, selfPay: (totalFen - reimbFen) / 100, cap: ins?.oopCap || 0 };
}

function checkBudget(patient = S) {
  if (!realismRules.insurance || !patient?.ins || patient._refused) return;
  const c = costSummary(patient);
  if (!patient._overWarned && c.selfPay > c.cap) {
    patient._overWarned = 1;
    toast(escapeHtml(patient.patient.name) + ' · 自付 ' + money(c.selfPay) + ' 已超过家庭承受能力', true);
  }
  if (c.selfPay > c.cap * 1.3) {
    patient._refused = 1;
    patient.score = Math.max(0, (patient.score ?? 100) - 40);
    patient.log.push([E.fmt(patient.t), '医保拒付：自付费用超过家庭承受力的 130%', 'bad']);
    toast(escapeHtml(patient.patient.name) + ' · 医保拒付：自付费用超过家庭承受力的 130%', true);
  }
}

function openCostSheet() {
  if (!realismRules.insurance || !S) {
    openDetail('费用与医保', '', [['医保与自付', '已关闭，可在「现实模式」中开启。']], '');
    return;
  }
  if (!S.ins) initInsurance();
  const c = costSummary();
  const ins = S.ins || { t: '未参保', rate: 0, ded: 0, cap: 0, income: 0 };
  openDetail('费用与医保', '医保与自付', [
    ['参保类型', ins.t + (ins.rate ? '（报销 ' + Math.round(ins.rate * 100) + '%）' : '')],
    ['总费用', '<span id="billTotal"></span>'],
    [S.drugCostPartial ? '药费含血制品（更新后）' : '药费（含血液制品）', '<span id="billDrugs"></span>'],
    ['其中床位费', '<span id="billBed"></span>'],
    ['医保支付', '<span id="billReimb"></span>'],
    ['家庭自付', '<span id="billSelf"></span>'],
    ['家庭承受力', '¥' + c.cap + (ins.income ? '（月收入 ¥' + ins.income + ' ×3）' : '')],
    ['起付线 / 封顶', '¥' + ins.ded + ' / ¥' + ins.cap],
  ], '');
  $('#detail').dataset.view = 'cost';
  updateCostSheet(c);
}

function updateCostSheet(c) {
  $('#billTotal').textContent = money(c.total);
  $('#billDrugs').textContent = money(S.drugCost || 0);
  $('#billBed').textContent = money(S.bedCost || 0);
  $('#billReimb').textContent = money(c.reimb);
  $('#billSelf').textContent = money(c.selfPay);
  const warn = $('#dWarn');
  warn.textContent = c.selfPay > c.cap ? '自付已超过家庭承受能力。' : '';
  warn.style.display = warn.textContent ? 'block' : 'none';
}

/* 重症判定：重症才给"实时监护"，轻症必须开检查才有新结果 */
function isSevere(S) {
  if (!S) return false;
  const b = (E.bp ? E.bp(S) : { map: S.map || 90 });
  return !!severeCondition(S, b);
}

function severeCondition(st, pressure, includeVentilation = true) {
  if (st.rhythm !== 'sinus') return st.rhythm === 'vf' ? '室颤' : st.rhythm === 'asystole' ? '心静止' : '心律异常';
  if (st.gcs < 12) return '意识障碍';
  if ((pressure.map ?? 90) < 65) return '平均动脉压过低';
  if (st.spo2 < 90) return '血氧过低';
  if (st.hr > 130 || st.hr < 45) return '心率异常';
  if (st.k > 6.5) return '严重高血钾';
  if (E.temperatureStatus(st.temp) === 'crit') return '体温危急';
  return includeVentilation && st.vent ? '机械通气中' : '';
}

function renderPatient() {
  const p = (S && S.patient) || {};
  const nEl = document.getElementById('pname');
  const mEl = document.getElementById('pmeta');
  if (nEl) nEl.textContent = p.name || '—';
  if (mEl) mEl.textContent = [p.age != null ? p.age + ' 岁' : '', p.sex || '', p.weight ? p.weight + ' kg' : '']
    .filter(Boolean).join(' · ');
  $('#btnAdmission').hidden = !isCurrentPatient(S);
}

function renderAll() {
  renderPatient();
  mountBedBar();
  renderBedBar();
  if (!S) {
    for (const id of ['#vitals', '#states', '#anat', '#opTitle', '#opan']) $(id).replaceChildren();
    delete $('#states').dataset.labels;
    $('#mentorCard').style.display = 'none';
    $('#clock').textContent = '—';
    return;
  }
  renderVitals();
  renderStates();
  renderOrganPanel();
  $('#clock').textContent = E.fmt(S.t);
}



/* 更新公告：每次发版在这里加一条（新的放最前面） */
const RELEASES = [
  { v: '1.55', notes: [
    '急性肾损伤病例需连续观察自身尿量和肌酐趋势 30 个模拟分钟，血液透析结束后重新计时',
    '「不靠药」更名为「不用升压药」，按本床整局用药记录判定，涵盖已停用的升压药泵',
  ] },
  { v: '1.54.3', notes: [
    '床旁菜单可滚动查看本床操作日志，给药、处置及检查回报按最近时间在前显示',
    '新增当前输液与泵药面板，可查看已输量、剩余时间和持续泵速，点进单笔医嘱可提前结束输注或停泵',
  ] },
  { v: '1.54.2', notes: [
    '给药列表按临床用途折叠，常用与急救药可直接展开，搜索支持药名、别名和类别',
    '新增尼卡地平持续泵入和左乙拉西坦定时静滴，可在高血压急症和癫痫持续状态病例中复评反应',
    '药库显示模拟参考价，药费随开单总量或实际泵入时长累计，医保模式可预估新增自付并在结算时复核',
  ] },
  { v: '1.54.1', notes: [
    '现实模式新增「禁用暂停」，可与医保、真实出院分别开关；结算记录本例启用过的规则',
    '补全病史中的暴露、用药与症状时间线，按患者、目击者和急救交接区分线索来源',
    '新增床旁血酮和导尿尿量复查，代谢评估可查有效渗透压，内镜止血后可复阅镜下所见',
    '急诊首诊可从循环查体取得血管收缩驱动，心脏面板显示上次测量值及时间',
    '报告页自动接收新结果并保留展开的报告；归档可按来源和时间复阅各项病史与首测体征',
  ] },
  { v: '1.54.0', notes: [
    '新增 6 级「急诊首诊」。同种子的病情与 5 级相同，病历随问诊、查体和检查逐步补全',
    '「检查」按取证方式分组，支持床旁查体与定向检验；出院移至床旁菜单第一项',
  ] },
  { v: '1.53.4', notes: [
    '现实模式可分别开启「医保与自付」和「真实出院」，原有医保设置自动保留',
    '真实出院由玩家签字决定，结算后可回看本例启用的规则、签字时的病情与扣分原因',
  ] },
  { v: '1.53.3', notes: [
    '「操作 → 体温处置」集中物理降温与被动保暖，病房顶部可直接查看本床病例说明',
    '肺面板和操作页新增流量计，自主呼吸时调节供氧流量，插管后调节呼吸机吸气流量，单位均为 L/min',
  ] },
  { v: '1.53.2', notes: [
    '全病房「等病情变化」：任一床明显变化、危情或检查回报时自动恢复 1×，最长 6 个模拟小时',
    '胰腺面板可定向等待血糖复评，最长 30 个模拟分钟，进入目标或再恶化 2 mmol/L 时恢复',
    '暂停按钮移到倍速左侧，可冻结全部床位并恢复此前倍速',
    '病例匿名化：入院只给主诉与现病史，病名在结算时揭晓；主诉按病历格式重写',
  ] },
  { v: '1.52.0', notes: [
    '床旁心电图按真实心率走纸，心搏音与 R 峰同步；大厅只播高优先级报警',
    '新增重置游戏存档，以及跳过结局统计的测试用患者移除功能',
    '修复常规对乙酰氨基酚给药触发过量提示和中毒诊断的问题',
    '修复常规镇静和止惊给药的苯二氮卓过量误报，分开计算苯巴比妥的药效',
  ] },
  { v: '1.51.0', notes: [
    '合并社区贡献：多出血点记账、撤机流程、器官图重绘、心音按实时心率',
    '低钠/高渗判定更严谨；操作增加适应症检查',
    '新增自由水通路（口服水可纠正高钠）',
  ] },
  { v: '1.50.1', notes: [
    '修复：现实模式下医保「自付」标签与时钟重叠（竖屏改独立一行）',
  ] },
  { v: '1.50.0', notes: [
    '新增「关于 · 隐私」页：数据说明、权限、医学免责',
    '隐私政策可在游戏内直接查看',
  ] },
  { v: '1.49.3', notes: [
    '反馈新增「邮件发送」（不依赖表单服务）',
    '表单补上 method/action，便于 Netlify 识别',
  ] },
  { v: '1.49.2', notes: [
    '反馈：提交失败时自动复制报告，不会白填',
  ] },
  { v: '1.49.1', notes: [
    '反馈问题时自动附上会诊码，作者可一键复现病例',
  ] },
  { v: '1.49.0', notes: [
    '网页版直接进游戏，另加「下载离线版」入口',
    '恢复离线版的在线更新（指向公网站点）',
    '新增「反馈问题」：一键生成可复制的报告',
    '药品别名补全：常用叫法都能搜到',
  ] },
  { v: '1.48.0', notes: [
    '公网版上线：https://xuanhu.netlify.app（网页版 + APK 下载）',
    '「获取最新版」直接打开公网下载页',
  ] },
  { v: '1.47.0', notes: [
    '药物补齐：新增甲泼尼龙、去乙酰毛花苷、普罗帕酮、哌替啶、酚磺乙胺、阿莫西林',
    '药名别名：搜「氢化可的松」「速尿」「西地兰」「甲强龙」都能找到对应药',
  ] },
  { v: '1.46.0', notes: [
    '修复在线版打不开：允许明文 HTTP、自动填对服务器地址（不再填 localhost）',
    '在线版新增「浏览器打开」按钮（最稳），应用内加载保留为实验',
  ] },
  { v: '1.45.0', notes: [
    '在线更新暂时关闭，改为「获取最新版 → 联系作者」',
    '医保可切换参保类型；下载页改用 ASCII 路由',
  ] },
  { v: '1.44.0', notes: [
    '医保可切换参保类型（职工 / 居民 / 自费 / 随机重抽）',
    '下载页改用 ASCII 路由：/download、/single、/apk',
  ] },
  { v: '1.43.0', notes: [
    '检查更新不再依赖校园网：自动识别当前站点，校外可直连下载页',
    '新增静态下载页（dist/下载页.html），发给朋友即可玩',
    '新增「医保说明」：三个数字、三条线、怎么省，进游戏就能看',
    '现实模式可随时关闭（主页按钮直接切换）',
  ] },
  { v: '1.42.0', notes: [
    '开局必定发病：不会再开局一切正常',
    '重症弹窗只在病程中"由轻转重"时出现，开局即重症不弹',
    '科学性修正：SpO₂/PaO₂ 下限、SVR 上限、Cushing 反应封顶',
    '新增单文件网页版（悬壶-单文件版.html）与在线版模式',
  ] },
  { v: '1.41.0', notes: [
    '难度重排：原 5 档合并为「普通 / 重症」，新增「危重 / 极危 / 噩梦」',
    '现实模式重做为医保与自付：医保报销、起付线、封顶线、家庭收入决定承受力',
    '床位费按小时累计，重症 ¥80/h、普通 ¥25/h',
    '新增：转入重症时弹窗提醒',
  ] },
  { v: '1.40.0', notes: [
    '现实模式改为预算制：每例有额度，超出 30% 医保拒付（扣 40 分）',
    '轻症需要开检查才有化验结果（全难度生效）',
    '整体上调病例难度：推进速度随难度 1.26–1.50×，基础病更常见',
  ] },
  { v: '1.39.1', notes: [
    '新增：白天 / 夜间模式（夜间病情推进 ×1.3，界面转暗）',
    '新增：现实模式（无提示、无参考范围、化验必须开检查）',
    '重症才持续监护，轻症需要开检查才有新化验结果',
    '心电图只在点击心脏时显示',
    '修复：更年期潮热导致体温发散；提示引用了不存在的功能',
  ] },
  { v: '1.38.0', notes: [
    '新增：会诊（分享码，可接手别人的病例）',
    '新增：网页版与检查更新',
  ] },
];

/* ---------------- 大厅（过渡页） ---------------- */
function bindLobby() {
  const lobby = $('#lobby');
  const release = RELEASES[0];
  lobby.querySelector('.lobby-release summary').textContent = '更新记录 · v' + release.v;
  lobby.querySelector('.lobby-release ul').innerHTML = release.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('');
  lobby.querySelector('[data-act="download"]').hidden = !IS_WEB && !releaseBase;
  const actions = {
    handbook: openHandbook, records: openRecords, stats: openStats, chart: openChart, consult: openConsult,
    ach: openAchievements, about: openAbout, download: openGetLatest, sound: openSoundSettings,
    diff: () => openSheet('难度设置', '病例与指导', difficultyRows()),
    tutorial: () => TUTORIAL.open(0),
    reset: confirmSaveReset,
  };
  lobby.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !hasCurrentSaveEpoch()) return;
    if (button.hasAttribute('data-new')) {
      startCase(CASEGEN.generate(diffFromLevel()));
    } else if (button.dataset.mode) {
      if (button.dataset.mode === 'night') toggleNight(); else openRealismSettings();
      if ($('#sheet').classList.contains('on')) {
        hideLobby({ keepMode: true });
        returnToLobby = true;
      } else {
        showLobby();
      }
    } else if (actions[button.dataset.act]) {
      hideLobby({ keepMode: true });
      returnToLobby = true;
      actions[button.dataset.act]();
    }
  });
}

function lobbyIsActive() {
  return returnToLobby || $('#lobby').style.display === 'flex';
}

function showLobby() {
  stopObservation();
  const lobby = $('#lobby');
  const full = beds.length >= MAX_BEDS;
  const list = lobby.querySelector('.bed-list');
  list.innerHTML = beds.map(({ S: patient }, i) => `
    <button type="button" class="bed" data-bed="${i}" aria-current="${patient === S}">
      <span class="no">${i + 1}</span>
      <span class="nm">${escapeHtml(patient.patient.name)}<span class="meta">${Math.floor(patient.t / 60)} 分钟<span data-bed-severity="${i}">${bedSeverity(patient)}</span></span></span>
      <span class="go">继续 →</span>
    </button>`).join('') + `
    <button type="button" class="bed empty" data-new="${full ? 0 : 1}" ${full ? 'disabled' : ''}>
      <span class="no">${full ? '满' : '+'}</span>
      <span class="nm">${full ? '床位已满' : '接诊新患者'}<span class="meta">${beds.length} / ${MAX_BEDS} 张床在用</span></span>
    </button>`;
  list.querySelectorAll('[data-bed]').forEach(row => {
    const patient = beds[+row.dataset.bed].S;
    row.addEventListener('click', () => { if (switchBed(patient)) hideLobby(); });
  });
  lobby.querySelector('[data-mode="night"]').setAttribute('aria-pressed', nightMode);
  const ruleButton = lobby.querySelector('[data-mode="realism"]');
  const rules = enabledRules();
  ruleButton.classList.toggle('active-rules', rules.length > 0);
  ruleButton.textContent = rules.length ? '现实模式 · ' + rules.length + ' 项' : '现实模式';
  const guidance = MENTOR.LEVELS[level] || MENTOR.LEVELS.intern;
  lobby.querySelector('.foot').textContent = `指导级别 · ${guidance.name}　 病例难度 · ${caseDiff}`;
  lobby.style.display = 'flex';
  window.SOUND?.setLobbyMode?.(true);
}

function hideLobby({ keepMode = false } = {}) {
  $('#lobby').style.display = 'none';
  if (!keepMode) window.SOUND?.setLobbyMode?.(false);
}

function bindDialogFocus() {
  const lobby = $('#lobby'), sheet = $('#sheet'), detail = $('#detail');
  const openers = new WeakMap();
  let current = null;
  function sync() {
    const next = $('#severePopup') || (lobby.style.display === 'flex' ? lobby :
      detail.classList.contains('on') ? detail : sheet.classList.contains('on') ? sheet : null);
    if (next === current) return;
    const previous = current;
    current = next;
    $('.screen').inert = $('.dock').inert = !!next;
    for (const el of [lobby, sheet, detail]) el.inert = el !== next;
    const restore = previous && openers.get(previous);
    if (restore?.isConnected && restore.getClientRects().length && !restore.closest('[inert]') &&
        (!next || next.contains(restore))) {
      restore.focus({ preventScroll: true });
      return;
    }
    if (next) {
      if (!next.contains(document.activeElement)) openers.set(next, document.activeElement);
      const first = next.querySelector('[aria-current="true"], #sevOk') ||
        next.querySelector('button:not(:disabled)');
      first?.focus({ preventScroll: true });
    } else {
      $('#btnLobby').focus({ preventScroll: true });
    }
  }
  const observer = new MutationObserver(sync);
  for (const el of [lobby, sheet, detail]) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.body, { childList: true });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !current) return;
    event.preventDefault();
    if (current === detail) closeDetail();
    else if (current === sheet) dismissSheet();
    else if (current.id === 'severePopup') current.querySelector('#sevOk').click();
    else if (beds.length) hideLobby();
  });
  sync();
}

/* ---------------- 启动 ---------------- */
window.addEventListener('storage', event => {
  if (event.key === RESET_EPOCH_KEY || event.key === null) hasCurrentSaveEpoch();
  else if (event.key === 'life.save') hasCurrentWard();
});
if (!hasCurrentSaveEpoch()) return;
ensureMentorDOM();
try { autoHint = localStorage.getItem('life.autoHint') === '1'; } catch (e) {}
try {
  nightMode = localStorage.getItem('life.night') === '1';
  const savedRules = localStorage.getItem('life.realismRules');
  restoreRealismRules(savedRules ? JSON.parse(savedRules) : { insurance: localStorage.getItem('life.realism') === '1' });
} catch (e) {}
applyTheme();
const _loaded = loadGame();
document.addEventListener('click', () => { if (window.SOUND) SOUND.unlock(); }, { once: true });
if (!_loaded && !saveEpoch) {
  const spec = window.CASEGEN ? CASEGEN.generate(diffFromLevel()) : 'hyperkalemia';
  S = prepareCase(ensurePresentation(E.create(spec)));
  activeIdx = 0;
  beds = [{ S }];
}
if (realismRules.insurance && S && !S.ins) initInsurance();
bind();
if (S) drawBody();
bindBedSwipe();
renderAll();
syncSpeedUI();
syncLevel();
if (S) showAdvice(false);
if (beds.length > 1) flashBedBar(3000);
showLobby();
bindDialogFocus();
settleBeds();
saveGame();
window.addEventListener('pagehide', saveGame);
/* 设置了在线版地址：启动时提示（不强制跳转，避免断网就进不去） */
try {
  const rb = localStorage.getItem('life.remoteBase');
  if (rb && location.href.indexOf(rb) !== 0) {
    setTimeout(() => toast('已设置在线版地址，可在菜单里加载：' + rb), 1800);
  }
} catch (e) {}
requestAnimationFrame(loop);
window.__showLobby = showLobby; window.__hideLobby = hideLobby; window.__checkBudget = checkBudget; window.openChart = openChart; window.openStats = openStats;
window.__LIFE_GAME = { get S() { return S; }, get beds() { return beds; }, get activeIdx() { return activeIdx; }, E, startCase, openAdmission, openBeds, switchBed, showAdmissionIntro };
})();








