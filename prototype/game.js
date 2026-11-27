/* ==========================================================================
 * 游戏层：把生理引擎接到界面上
 * 依赖：engine.js（全局 LIFE）、organs.js（交互式器官图谱）
 * ========================================================================== */
(function () {
'use strict';
const E = window.LIFE;
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
let observationUntil = null;
let lastCaseReview = false;
let paused = false;
let bigFont = false;
/* 白天 / 夜间：夜间难度显著提升（病情推进更快、提示更少、界面转暗） */
let nightMode = false;
/* 现实模式：不给提示、不显示参考范围、化验必须开检查 */
let realism = false;
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
/* 病例难度（1–5）与指导强度（level）是两件事：
   难度决定病有多复杂，指导决定上级医师说多少。 */
let caseDiff = (function(){
  try { const v = parseInt(localStorage.getItem('life.caseDiff') || '0', 10); if (v >= 1 && v <= 5) return v; } catch (e) {}
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

let organBuiltFor = null;
function renderOrganPanel() {
  const meta = ORGAN_META[selected];
  if (organBuiltFor !== selected) {
    organBuiltFor = selected;
    const panel = $('#opan');
    panel.classList.remove('hide');
    panel.innerHTML = meta.f(E.snapshot(S), S).map(([k], i) =>
          `<div class="row"><span class="lab">${k}</span><span class="val" data-oi="${i}"></span></div>`).join('')
      + (selected === 'heart' ? '<div id="vascularTone" hidden></div><canvas id="miniEcg" title="最近 4 秒心电图 · 点击查看指标走势" aria-label="最近 4 秒单导联心电图"></canvas>' : '');
    if (selected === 'lung') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pill examine-lungs';
      button.textContent = '双肺听诊';
      button.addEventListener('click', examineLungs);
      panel.appendChild(button);
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
  const s = E.snapshot(S), meta = ORGAN_META[selected];
  const st = organState(selected, s);
  const t = $('#opTitle');
  if (t) { t.value = selected; t.dataset.state = st; }
  const tonePanel = selected === 'heart' && $('#vascularTone');
  if (tonePanel) {
    tonePanel.hidden = !S.tags.includes('htn');
    if (!tonePanel.hidden) {
      const reading = CASEGEN.vascularTone(S).text;
      if (tonePanel.textContent !== reading) tonePanel.textContent = reading;
    }
  }
  meta.f(s, S).forEach(([k, v, u], i) => {
    const el = document.querySelector('[data-oi="' + i + '"]');
    if (el) el.innerHTML = `${v}${u ? `<span style="font-size:9px;color:#9a9a9a"> ${u}</span>` : ''}`;
  });
}
/* ---------------- 体征 / 状态 ---------------- */
function vitalList(S) {
  const s = E.snapshot(S);
  const sys = s.sys, dia = s.dia;
  return [
    {k:'hr',   n:'心率', v:s.hr,  u:'bpm', st: s.hr > 120 || s.hr < 50 ? 'crit' : (s.hr > 100 ? 'warn' : '')},
    {k:'bp',   n:'血压', v:`${sys}|${dia}`, u:'', st: sys < 90 ? 'crit' : (sys < 100 ? 'warn' : '')},
    {k:'rr',   n:s.vent ? '机械通气' : '呼吸', v:s.rr, u:'rpm', st: s.rr < 8 ? 'crit' : (s.rr > 24 ? 'warn' : '')},
    {k:'spo2', n:'血氧', v:s.spo2 ?? '无信号', u:s.spo2 == null ? '' : '%',
     st: s.spo2 == null || s.spo2 < 92 ? 'crit' : (s.spo2 < 95 ? 'warn' : '')},
    {k:'temp', n:'体温', v:s.temp ?? '未测', u:s.temp == null ? '' : '℃',
     st: E.temperatureStatus(S.temp)},
    {k:'gcs',  n:'意识', v:s.gcs, u:'GCS', st: s.gcs < 12 ? 'crit' : (s.gcs < 15 ? 'warn' : '')},
  ];
}
function renderVitals() {
  const host = $('#vitals'), readings = vitalList(S);
  if (!host.childElementCount) {
    host.innerHTML = readings.map(v => `<button type="button" class="vpill" data-v="${v.k}">
      <span class="dot"></span><span class="k">${v.n}</span><span class="v"></span><span class="u">${v.u}</span></button>`).join('');
    host.addEventListener('click', event => {
      const key = event.target.closest('[data-v]')?.dataset.v;
      const v = vitalList(S).find(x => x.k === key);
      if (!v) return;
      openDetail(v.n + ' · 参考范围', v.u,
        [['参考', REF[v.k] || '—'], ['当前', v.u ? v.v + ' ' + v.u : v.v], ['趋势', trend(v.k)]], '');
    });
  }
  readings.forEach((v, index) => {
    const el = host.children[index];
    el.classList.toggle('bad', v.st === 'crit');
    el.classList.toggle('warn', v.st === 'warn');
    el.querySelector('.k').textContent = v.n;
    el.querySelector('.v').textContent = v.v;
    el.querySelector('.u').textContent = v.u;
  });
}
const REF = {hr:'60–100 bpm', bp:'90–140 / 60–90 mmHg', rr:'12–20 rpm',
             spo2:'95–100 %', temp:'36.1–37.5 ℃', gcs:'15'};
function trend(k) {
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
  const out = [];
  if (s.rhythm === 'vf') out.push('心室颤动');
  else if (s.rhythm === 'asystole') out.push('心静止');
  if (s.k > 5.5) out.push('高血钾');
  if (s.k < 3.5) out.push('低血钾');
  if (s.ph < 7.32) out.push('酸血症');
  if (s.glu > 11) out.push('高血糖');
  if (s.glu < 3.9) out.push('低血糖');
  if (s.spo2 != null && s.spo2 < 92) out.push('低氧血症');
  if (s.sys < 90) out.push('低血压');
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
  const env = S.env || {};
  if (env.heat) out.push('高温环境');
  if (env.cold) out.push('低温环境');
  if (env.exercise) out.push('运动中');
  if (env.sleep) out.push('睡眠');
  if (env.cooling) out.push('物理降温中');
  if (env.warming) out.push('被动保暖中');
  if (!out.length) out.push('生命体征平稳');
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
  detail.classList.remove('case-review', 'case-review-success', 'case-review-failure');
  detail.querySelector('.case-review-body')?.remove();
  detail.querySelector('.card').scrollTop = 0;
  $('#dName').textContent = name;
  $('#dSub').textContent = sub || '';
  $('#dKv').innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const w = $('#dWarn'); w.classList.remove('eligible'); w.textContent = warn || ''; w.style.display = warn ? 'block' : 'none';
  $('#detail').classList.add('on');
}

/* 给药列表：按类别分组 + 搜索（119 种物质） */

/* 给药面板置顶：常用（补液、电解质、代谢）与急救（复苏、解毒） */
const PIN_DRUGS = {
  '常用': ['nacl', 'half_saline', 'dextrose50', 'dextrose10', 'ringer', 'kcl', 'insulin', 'calcium',
           'bicarb', 'furosemide', 'magnesium', 'hypertonic_saline', 'glucagon'],
  '急救': ['epi', 'norepi', 'atropine', 'amiodarone', 'lidocaine',
           'naloxone', 'flumazenil', 'dopamine', 'vasopressin', 'adenosine', 'isoproterenol'],
};

function openDrugSheet() {
  const SUB = window.SUBSTANCES;
  const patient = S;
  if (!isCurrentPatient(patient)) return;
  if (!SUB) { openSheet('给药', patient.patient.name, drugRows(), patient); return; }
  $('#sheetTitle').innerHTML = `给药 <small>${escapeHtml(patient.patient.name)} · 搜索全库</small>`;
  delete $('#sheetTitle').dataset.view;
  const list = $('#sheetList');
  list.innerHTML = `
    <div style="padding:2px 10px 8px">
      <input id="drugSearch" placeholder="搜索药名 / 类别，跨药品·血制品·微生物·食物"
        style="width:100%;padding:11px 13px;border-radius:11px;border:1px solid #e8e4e2;
               font:inherit;font-size:14px;outline:none;background:#faf9f8">
    </div>
    <div id="drugTabs" style="display:flex;gap:6px;padding:0 10px 10px;overflow-x:auto;scrollbar-width:none"></div>
    <div id="drugList"></div>`;

  /* 分类：搜索时跨全库；空搜索时按标签过滤 */
  const TABS = [
    { id: 'all',  n: '全部' },
    { id: 'drug', n: '药品' },
    { id: 'cell', n: '细胞·血制品' },
    { id: 'germ', n: '病毒·细菌' },
    { id: 'food', n: '食物' },
  ];
  const inTab = (it, tab) => {
    if (!tab || tab === 'all') return true;
    if (tab === 'food') return it.kind === 'food';
    if (tab === 'germ') return it.cls === '病毒' || it.cls === '细菌';
    if (tab === 'cell') return it.cls === '血液成分' || it.cls === '扩容';
    return it.kind === 'drug' && it.cls !== '病毒' && it.cls !== '细菌';
  };

  let curTab = 'all';
  const drugName = (name) => {
    const aliases = SUB.aliasesFor(name).slice(0, 2);
    return `${escapeHtml(name)}${aliases.length ? `<span style="font-size:10px;color:#c8a0a0">（${escapeHtml(aliases.join('/'))}）</span>` : ''}`;
  };
  const rowOf = (it) => {
    const pump = it.routes?.[0]?.pumpHalfLife;
    const rate = pump ? E.pumpRate(patient, it.id) : 0;
    const amount = pump ? `${rate ? '当前' : '默认'} ${rate || it.dose} ${it.unit}` : `${it.dose}${it.unit}`;
    return `
        <button type="button" class="drow" data-id="${it.id}">
          <span class="nm">${drugName(it.n)}${it.note ? `<span style="font-size:10px;color:#b3a6a6"> · ${it.note}</span>` : ''}</span>
          <span class="tag">${it.route}${(it.routes && it.routes.length > 1) ? ' 等' + it.routes.length + ' 途径' : ''}</span>
          <span class="amt">${amount}</span>
        </button>`;
  };

  const drawTabs = () => {
    const host = list.querySelector('#drugTabs');
    host.innerHTML = TABS.map(t =>
      `<span class="pill" data-tab="${t.id}" style="flex:0 0 auto;cursor:pointer;padding:7px 13px;${
        t.id === curTab ? 'background:#f7e6e6;color:#a33;font-weight:700' : ''}">${t.n}</span>`).join('');
    host.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', () => { curTab = el.dataset.tab; drawTabs(); draw(inp.value); });
    });
  };

  const draw = (q) => {
    const searching = !!(q && q.trim());
    const items = SUB.search(q).filter(it => searching ? true : inTab(it, curTab));
    const groups = {};
    let pinnedHtml = '';

    /* 置顶只在「全部 + 空搜索」时出现 */
    if (!searching && curTab === 'all') {
      const used = {};
      for (const [title, ids] of Object.entries(PIN_DRUGS)) {
        const rows = ids.map(id => SUB.byId(id)).filter(Boolean);
        if (!rows.length) continue;
        for (const r of rows) used[r.id] = 1;
        pinnedHtml += `<div class="sec">${title} <span style="opacity:.6">${rows.length}</span></div>` +
          rows.map(rowOf).join('');
      }
      for (const it of items) if (!used[it.id]) (groups[it.cls] = groups[it.cls] || []).push(it);
    } else {
      for (const it of items) (groups[it.cls] = groups[it.cls] || []).push(it);
    }

    const order = Object.keys(groups).sort();
    const host = list.querySelector('#drugList');
    const body = order.map(cls => `
      <div class="sec">${cls} <span style="opacity:.6">${groups[cls].length}</span></div>
      ${groups[cls].map(rowOf).join('')}
    `).join('');
    const unlisted = SUB.searchUnlistedDrugs(q).map(name => `
      <div class="drow" style="cursor:default">
        <span class="nm">${drugName(name)}</span>
        <span class="tag">游戏暂未收录</span>
      </div>`).join('');
    host.innerHTML = (pinnedHtml + unlisted + body) ||
      `<div style="padding:18px;color:#9a9a9a;font-size:13px">没有匹配的物质</div>`;

    host.querySelectorAll('button.drow').forEach(el => {
      el.addEventListener('click', () => {
        if (!list.contains(el) || !$('#sheet').classList.contains('on') || !isCurrentPatient(patient)) return;
        openGiveConfig(SUB.byId(el.dataset.id), patient);
      });
    });
  };

  drawTabs();
  draw('');
  const inp = list.querySelector('#drugSearch');
  inp.addEventListener('input', e => draw(e.target.value));
  $('#sheet').classList.add('on');
  $('#mask').classList.add('on');
}

const EFF_NAME = { k:'血钾', na:'血钠', cl:'血氯', ca:'血钙', hco3:'HCO₃⁻', glu:'血糖', lac:'乳酸',
                   vol:'血容量', freeWater:'自由水', hb:'血红蛋白', hr:'心率', svr:'血管张力', sv:'心肌收缩力',
                   rr:'呼吸频率', spo2:'血氧', temp:'体温', gcs:'意识', uo:'尿量', infection:'感染负荷',
                   coag:'凝血能力', halfSaline:'低渗补液量', icp:'颅内压', estrogen:'雌激素',
                   testosterone:'睾酮', pao2:'动脉氧分压' };
function describeEff(eff) {
  const parts = [];
  for (const k in (eff || {})) {
    const v = eff[k];
    if (!v) continue;
    parts.push(`${EFF_NAME[k] || k}${v > 0 ? '↑' : '↓'}`);
  }
  return parts.join(' ');
}


/* 选完药 → 选途径 + 调剂量（允许给错、给过量） */
function openGiveConfig(it, patient) {
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
      : infusion ? `开始泵入 ${it.n}（${E.infusionDetails(dose, it.unit, infusion)}）`
        : `给予 ${it.n} ${fmt(dose)}${it.unit}`;
    const hi = it.doseRange ? it.doseRange[1] : rt.d * 10;
    const over = dose > rt.d * 2.5, under = dose < rt.d * 0.4;
    const doseLabel = pump ? '泵速' : '剂量';
    const warn = over ? `⚠ ${doseLabel}明显高于常规，注意中毒风险`
                : under ? `⚠ ${doseLabel}偏低，可能达不到治疗浓度` : '';
    $('#sheetTitle').innerHTML = `${it.n} <small>${escapeHtml(patient.patient.name)} · ${it.cls}</small>`;
    $('#sheetList').innerHTML = `
      <div style="padding:2px 14px 14px">
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
          <button id="dPlus" class="pill" style="width:46px;height:46px;font-size:22px;cursor:pointer">+</button>
        </div>
        <div style="display:flex;gap:6px;justify-content:center;padding-bottom:10px">
          ${[0.5, 1, 2, 5].map(f => `<span class="pill" data-mul="${f}" style="cursor:pointer;${Math.abs(dose - rt.d * f) < 1e-6 ? 'font-weight:700;color:#a33' : ''}">${f === 1 ? '常规' : f + '×'}</span>`).join('')}
        </div>
        ${warn ? `<div class="note" style="margin-bottom:10px;color:#a33;background:#fdf3f2">${warn}</div>` : ''}
        <div class="note" style="margin-bottom:12px;font-size:11.5px">
          ${infusion ? `输注时长 ${infusion} 分钟<br>` : ''}
          ${pump ? `持续至手动停泵 · 模拟血药浓度半衰期约 ${pump} 分钟`
            : `起效 ${rt.on} min · ${infusion ? '药效' : ''}维持 ${rt.du} min`} · 效应 ${describeEff(it.eff) || '—'}
          ${it.note ? '<br>' + it.note : ''}
        </div>
        <button id="dGo" class="pill" ${sameRate ? 'disabled' : ''} style="width:100%;padding:14px;font-size:16px;font-weight:700;cursor:${sameRate ? 'default' : 'pointer'};background:${over ? '#f7e6e6' : '#fff'}">
          ${order}
        </button>
        ${currentRate ? '<button type="button" id="dStop" class="pill" style="width:100%;margin-top:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer">停止泵入</button>' : ''}
      </div>`;

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

/* 环境 / 场景切换 */
function openEnvSheet() {
  if (!isCurrentPatient(S)) return;
  const change = key => {
    const before = { ...S.env };
    const on = !S.env?.[key];
    const env = E.setEnv(S, key, on);
    if (on && key === 'cooling' && !env.cooling) return toast('体温高于 38.5℃ 时可开启物理降温');
    if (on && key === 'warming' && !env.warming) return toast('体温低于 36.1℃ 时可开启被动保暖');
    if (Object.keys(env).some(k => !!env[k] !== !!before[k])) {
      const name = rows.find(row => row.key === key)?.n;
      const label = key === 'reset' ? '恢复正常环境与活动，结束体温处置' : (on ? '开启' : '关闭') + name;
      S.log.push([E.fmt(S.t), label, 'info']);
    }
    saveGame();
    renderStates();
    syncEnvSheet();
  };
  const toggle = (key, n, amt = '') => ({ key, n, tag: '', amt, run: () => change(key) });
  const rows = [
    { sec: '体温处置' },
    toggle('cooling', '物理降温', '降至 38.5℃ 自动停止'),
    toggle('warming', '被动保暖', '回升至 36.1℃ 自动停止'),
    { sec: '环境与活动' },
    toggle('heat', '炎热环境'),
    toggle('cold', '寒冷环境'),
    toggle('exercise', '运动'),
    toggle('sleep', '睡眠'),
    { n: '恢复正常', tag: '', amt: '', run: () => change('reset') },
  ];
  openSheet('环境 / 场景', S.patient.name, rows, S);
  for (const button of $('#sheetList').querySelectorAll('.drow')) {
    const key = rows[+button.dataset.i].key;
    if (key) button.dataset.env = key;
  }
  $('#sheetTitle').dataset.view = 'env';
  syncEnvSheet();
}

/* 给药列表（旧接口，保留给不支持 SUBSTANCES 的场合） */
function drugRows() {
  return Object.entries(E.DRUGS).map(([id, d]) => ({
    n: d.name, tag: (d.routes && d.routes[0]) || '', amt: d.defaultDose + ' ' + d.unit,
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

function actionRows() {
  return Object.entries(E.ACTIONS).filter(([id]) => id !== 'delivery' || S.tags.includes('preeclampsia')).map(([id, a]) => {
    if (id === 'delivery') return {
      n: S.delivered || S.deliveryStartedAt != null ? '查看产科进程' : a.name,
      tag: deliveryStatus(S), amt: '查看', run: () => reviewDelivery(S),
    };
    const name = id === 'oxygen_off' && S.vent ? '将呼吸机 FiO₂ 调至 21%' : a.name;
    return { n: name, tag: '', amt: a.cost ? '¥' + a.cost : '—', run: () => performAction(id, a) };
  });
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
  if (level === 'expert') toast(result[1], result[2] === 'warn' || result[2] === 'bad');
  saveGame();
  renderAll();
}
function caseTime(time) {
  return Number.isFinite(time) ? E.fmt(time) + ':' + String(Math.floor(time % 60)).padStart(2, '0') : '时间未记录';
}

function examineLungs() {
  const patient = S;
  if (!isCurrentPatient(patient)) return;
  const current = E.auscultate(patient);
  const previous = patient.lungExam.previous;
  const rows = [['本次听诊', caseTime(current.t)], ['左肺', escapeHtml(current.left)], ['右肺', escapeHtml(current.right)]];
  if (previous) rows.push(['上次听诊', caseTime(previous.t)], ['上次左肺', escapeHtml(previous.left)], ['上次右肺', escapeHtml(previous.right)]);
  saveGame();
  openDetail('双肺听诊', patient.patient.name, rows, '');
}

function chestXrayRows(report) {
  return [['采集时间', caseTime(report.sampledAt)], ['报告时间', caseTime(report.reportedAt)],
    ['影像所见', escapeHtml(report.findings)]];
}

function filmDetails(title, report) {
  const fields = chestXrayRows(report).map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('');
  return `<details><summary>${escapeHtml(title)}</summary><dl>${fields}</dl></details>`;
}

function openLatestFilm(patient) {
  const reports = E.chestXrayReports(patient);
  const latest = reports.pop();
  if (!latest) return;
  const rows = chestXrayRows(latest);
  if (reports.length) rows.push(['此前报告', reports.reverse()
    .map(report => filmDetails('床旁胸片 · ' + caseTime(report.reportedAt), report)).join('')]);
  openDetail('床旁胸片报告', patient.patient.name, rows, '');
}

function openChecks(patient) {
  if (!isCurrentPatient(patient)) return;
  const rows = [{ sec: '床旁查体' }, { n: '双肺听诊', tag: '床旁', amt: '立即查体', run: examineLungs },
    { sec: '检查开单' }, ...testRows(patient)];
  const d = E.dischargeCheck(patient);
  const canObserve = canStartObservation(patient, d);
  rows.push({ sec: '结局' });
  if (canObserve) {
    rows.push({ n: '稳定期留观快进', tag: '全病房 · 达到观察目标、遇重症或报告回报时停止', amt: '最多 6 小时', run: startObservation });
  }
  rows.push({
    n: d.ok ? '办理出院' : '出院评估', tag: d.ok ? '可出院' : '未达标',
    amt: d.ok ? '✓' : '—',
    run: () => {
      const current = E.dischargeCheck(patient);
      if (!current.ok || !d.ok) {
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
        return;
      }
      E.endCase(patient, 'discharge', '达到出院标准');
      settleBeds();
      try { if (navigator.vibrate) navigator.vibrate(200); } catch (e) {}
    },
  });
  openSheet('检查 / 结局', patient.patient.name + ' · 开单后出结果', rows, patient);
  $('#sheetTitle').dataset.view = 'checks';
  $('#sheetTitle').dataset.eligible = String(d.ok);
  $('#sheetTitle').dataset.observation = String(canObserve);
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
  const message = assessment.ok ? '已达到出院标准，可返回检查页办理出院。' : assessment.reasons.join('\n');
  if (message !== warning.textContent) warning.textContent = message;
  warning.style.display = 'block';
}

function testRows(patient) {
  return Object.entries(E.TESTS).map(([id, t]) => ({
    n: t.name, tag: patient.tests[id] && !patient.tests[id].done ? '待出报告' : t.min + ' min',
    related: id === 'cxr' && E.chestXrayReports(patient).length
      ? { label: '查看上次报告', run: () => openLatestFilm(patient) } : null,
    amt: patient.tests[id] && !patient.tests[id].done ? '预计 ' + caseTime(patient.tests[id].readyAt) : '¥' + t.cost,
    run: () => {
      const order = patient.tests[id];
      if (order && !order.done) {
        toast(t.name + '已开单，预计 ' + caseTime(order.readyAt) + ' 出报告');
        return;
      }
      E.orderTest(patient, id);
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
  const cardR = document.getElementById('mentorCard');
  const L = MENTOR.LEVELS[level] || MENTOR.LEVELS.intern;
  const card = document.getElementById('mentorCard');
  const txt = document.getElementById('mText');
  if (!card) return;
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
  'life.level', 'life.caseDiff', 'life.autoHint', 'life.night', 'life.realism',
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
      beds: nextBeds.map(b => serState(b.S)),
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
      E.restoreBenzodiazepines(st, item.s);
      E.restoreBleeding(st, item.s);
      E.restoreCardiorespiratory(st, item.s);
      E.restoreTemperature(st, item.s);
      E.restoreDischargeObservation(st, item.s);
      E.restoreChestXrayReports(st);
      if (st.death || st.discharged) st.running = false;
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
        const oldest = list.slice().reverse().find(r => r.操作日志?.length || r.胸片报告?.length);
        if (!oldest) throw err;
        const i = list.indexOf(oldest);
        list[i] = oldest.操作日志?.length
          ? { ...oldest, 操作日志: null, 日志已清理: true }
          : { ...oldest, 胸片报告: null };
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
  const isBloodField = field => Object.prototype.hasOwnProperty.call(metrics, field);
  const reports = [];
  for (const [id, test] of Object.entries(E.TESTS)) {
    const sample = S.labSnap?.[id];
    if (!sample?.s || !test.fields.some(isBloodField)) continue;
    const fields = (Array.isArray(sample.fields) ? sample.fields : test.fields).filter(isBloodField);
    if (!fields.length) continue;
    const time = Number.isFinite(sample.t) ? sample.t : -1;
    reports.push({ id, name: test.name, time, sample, values: sample.s, fields });
  }
  reports.sort((a, b) => b.time - a.time);
  const metricRow = (field, value) => {
    const [label, unit, flag] = metrics[field];
    if (!Number.isFinite(value)) return [label, '未记录'];
    return [label, `${value}${unit ? ` ${unit}` : ''}${flag?.(value) || ''}`];
  };
  const rows = [];
  for (const [id, order] of Object.entries(S.tests)) {
    const test = E.TESTS[id];
    if (test && !order.done) {
      rows.push([test.name + ' · 待回报', '预计 ' + caseTime(order.readyAt) + ' 出报告']);
    }
  }
  const films = E.chestXrayReports(S);
  if (films.length) rows.push(['床旁胸片', films.reverse().map(report =>
    filmDetails('查看报告 · ' + caseTime(report.reportedAt), report)).join('')]);
  const ecgReport = S.labSnap?.ecg;
  if (ecgReport?.s) {
    const { rhythm, hr } = ecgReport.s;
    const rhythmText = { sinus: '窦性心律', vf: '心室颤动', asystole: '心静止' }[rhythm] || '未记录';
    rows.push(['<strong>12 导联心电图</strong>', '记录于 ' + caseTime(ecgReport.t)],
      ['心律', rhythmText]);
    if (rhythm === 'sinus' && Number.isFinite(hr)) rows.push(['心率', hr + ' 次/分']);
  }
  const monitor = isSevere(S) ? E.snapshot(S) : null;
  if (monitor) {
    rows.push(['<strong>重症监护快照</strong>', `打开时 · 病例用时 ${caseTime(S.t)}`]);
    for (const field of ['k', 'na', 'cl', 'ph', 'hco3', 'lac', 'glu', 'cr', 'hb']) {
      rows.push(metricRow(field, monitor[field]));
    }
  }
  const sampleTime = sample => sample.sampledAtKnown === false || !Number.isFinite(sample.reportedAt)
    ? '记录于 ' + caseTime(sample.reportedAt ?? sample.t) : '采样于 ' + caseTime(sample.t);
  for (const { id, name, sample, values, fields } of reports) {
    const previous = S.labPrevious?.[id];
    rows.push([`<strong>${name}</strong>`, sampleTime(sample)]);
    if (previous) rows.push(['上次对照', sampleTime(previous) + '（以下为上次 → 本次）']);
    if (fields.includes('pao2') && Number.isFinite(values.fio2)) {
      const fio2 = value => Number.isFinite(value) ? Math.round(value * 100) + '%' : '未记录';
      rows.push(['采样时 FiO₂', (previous ? fio2(previous.s.fio2) + ' → ' : '') + fio2(values.fio2)]);
    }
    if (fields.includes('pao2') && values.oxygenModelVersion == null) rows.push(['旧版血气', '此结果来自旧版氧合模型，可复查动脉血气。']);
    for (const field of fields) {
      const row = metricRow(field, values[field]);
      if (previous) row[1] = metricRow(field, previous.s[field])[1] + ' → ' + row[1];
      rows.push(row);
    }
  }
  const reportCount = reports.length + films.length + (ecgReport?.s ? 1 : 0);
  if (!reportCount && !Object.values(S.tests).some(t => !t.done)) rows.push(['暂无报告', '在「检查」开单，结果回报后可在这里查看。']);
  const subtitle = S.patient.name + (reportCount ? ' · ' + reportCount + ' 份报告可查' : ' · 暂无已回报检查');
  const potassium = reports.find(({ values, fields }) => fields.includes('k') && Number.isFinite(values.k))?.values.k;
  const warning = monitor?.k > 6.5 ? '监护快照中的血钾达到危急值。' :
    potassium > 6.5 ? '最近一次血钾结果达到危急值。' : '';
  openDetail('报告', subtitle, rows, warning);
}

/* ---------------- 时钟 / 主循环 ---------------- */
function loop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.5, (ts - lastTs) / 1000);
  lastTs = ts;
  if (paused || !beds.length) { ecg.pause(); silenceMonitor(); requestAnimationFrame(loop); return; }
  if (beds.length) {
    const observationStartedAt = observationUntil == null ? null : S.t;
    const hourlyBedCost = realism && S.ins ? (isSevere(S) ? 80 : 25) : 0;
    let observationEnd = observationStopReason();
    const adv = observationEnd ? 0 : observationUntil == null
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
      if (observationUntil != null) observationEnd = observationStopReason();
    }
    if (hourlyBedCost) {
      const elapsed = observationStartedAt == null ? adv : S.t - observationStartedAt;
      S.bedCost = (S.bedCost || 0) + hourlyBedCost * elapsed / 3600;
    }
    const pendingFilm = S.tests.cxr && !S.tests.cxr.done;
    for (const b of beds) { try { E.pollTests(b.S); } catch (e) {} }
    if (pendingFilm && S.tests.cxr.done && $('#sheet').classList.contains('on') &&
        $('#sheetTitle').dataset.view === 'checks' && isCurrentPatient(S)) openChecks(S);
    if (observationUntil != null && (observationEnd || E.dischargeCheck(S).ok)) {
      stopObservation();
      saveGame();
      toast(observationEnd?.message ?? '已达到出院标准，留观快进已结束', observationEnd?.urgent);
    }
    settleBeds();
    if (!beds.length) { ecg.pause(); silenceMonitor(); requestAnimationFrame(loop); return; }
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
        (st.spo2 < 80 || st.k > 7 || E.bp(st).sys < 70 ? 'vitals' : null);
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
      const nowSevere = isSevere(S);
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
    if (realism && S && !S.ins) initInsurance();
    let el = document.getElementById('budgetChip');
    if (realism && S && S.ins) {
      if (!el) {
        el = document.createElement('span');
        el.id = 'budgetChip';
        el.className = 'pill num';
        const host = document.querySelector('.top .seg') || document.querySelector('.top');
        if (host) host.parentNode.insertBefore(el, host);
        el.title = '家庭自付 / 可承受上限';
      }
      const cs = costSummary();
      const over = cs.selfPay > cs.cap;
      el.textContent = '自付 ¥' + cs.selfPay + '/' + cs.cap;
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
  if ($('#sheetTitle').dataset.view === 'checks' && $('#sheet').classList.contains('on')) {
    const assessment = E.dischargeCheck(S);
    if ($('#sheetTitle').dataset.eligible !== String(assessment.ok) ||
        $('#sheetTitle').dataset.observation !== String(canStartObservation(S, assessment))) openChecks(S);
    if ($('#detail').dataset.view === 'discharge' && $('#detail').classList.contains('on')) refreshDischargeAssessment(S, assessment);
  }
  syncBedSeverity();
  if (selected) renderOrganPanel();
  checkCrucial();
}

let lastCrit = '';
function checkCrucial() {
  const s = E.snapshot(S);
  const key = `${s.rhythm}|${s.k > 7.2}|${s.sys < 70}`;
  if (key !== lastCrit) {
    lastCrit = key;
    if (s.rhythm === 'vf') { ff = false; speed = 1; syncSpeedUI(); toast('室颤！立即除颤', true); }
    else if (s.rhythm === 'asystole') { ff = false; speed = 1; syncSpeedUI(); toast('心静止', true); }
  }
}
function syncSpeedUI() {
  if (!ff && observationUntil != null) {
    observationUntil = null;
    acc = 0;
  }
  $('#speed').querySelectorAll('.pill[data-s]').forEach(x => {
    const active = !ff && +x.dataset.s === speed;
    x.classList.toggle('on', active);
    x.setAttribute('aria-pressed', active);
  });
  const f = $('#ff');
  f.classList.toggle('on', ff);
  f.setAttribute('aria-pressed', ff);
  f.textContent = observationUntil != null ? '结束留观' : ff ? '20× 快进中' : '快进 20×';
}

function stopObservation() {
  if (observationUntil == null) return;
  ff = false;
  speed = 1;
  syncSpeedUI();
}

function needsAttention(st) {
  return !st.running || isSevere(st) || E.bp(st).sys < 70 ||
    st.glu < 3.9 || st.k < 3 || st.rr < 10 || st.rr > 30 || st.ph < 7.2;
}

function canStartObservation(patient, assessment) {
  return !assessment.ok && (assessment.observationEndsAt != null || patient.opioidTox ||
    patient.tags.some(tag => ['hhs', 'hypona', 'sepsis'].includes(tag)));
}

function observationStopReason() {
  if (observationUntil == null) return null;
  if (beds.some(b => needsAttention(b.S))) {
    return { message: '有床位需要连续处置，留观快进已结束', urgent: true };
  }
  if (beds.some(({ S: patient }) => Object.values(patient.tests).some(test => !test.done && patient.t >= test.readyAt))) {
    return { message: '有检查报告已回报，留观快进已结束' };
  }
  if (S.t >= observationUntil) return { message: '留观快进已结束，请复查病情' };
  return null;
}

function startObservation() {
  if (!isCurrentPatient(S)) return;
  const assessment = E.dischargeCheck(S);
  if (!canStartObservation(S, assessment)) return;
  if (beds.some(b => needsAttention(b.S))) { toast('有床位需要连续处置，请先稳定病情', true); return; }
  observationUntil = Math.min(S.t + 6 * 3600, assessment.observationEndsAt ?? Infinity);
  acc = 0;
  ff = true;
  paused = false;
  closeSheet();
  syncSpeedUI();
  toast('全病房留观快进中，可随时点「结束留观」');
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
  if (realism && !S.ins) initInsurance();
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
      toast(`床位 ${beds.indexOf(b) + 1} · ${escapeHtml(st.patient.name)}${st.discharged ? '已出院' : '已死亡'}`, !st.discharged);
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
  saveGame({ empty: true });
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
  html += row('痊愈出院', cured);
  html += row('死亡', died);
  html += row('治愈率', rate + '%');
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
    'font-size:12px', 'color:#6b625d', 'z-index:60', 'cursor:pointer',
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
  return patient?.running && isSevere(patient) ? ' · 重症' : '';
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
    const tag = st.discharged ? '已出院' : (st.death ? '已死亡' : `${Math.round(st.t / 60)} min`);
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
  if (outcome) rec.outcome = outcome;
  window.HANDBOOK.record(rec);
}

function archiveCase(st, wardCount) {
  st._level = level;
  st._beds = wardCount;
  const ok = st.discharged;
  const breakdown = E.scoreBreakdown(st);
  const min = Math.round(st.t / 60);
  const name = (st.cas && st.cas.name) || st.caseId;
  const settings = {
    admission: st.admissionSettings,
    level, realism,
    difficulty: st.diff ?? st.cas?.diff ?? null,
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
  const record = {
    recordId: wardRecordId(st),
    时间: new Date().toLocaleString('zh-CN', { hour12: false }),
    病例名: name,
    患者: st.patient.name,
    诊断: name,
    结局: ok ? '出院' : '死亡',
    耗时: min,
    费用: Math.round(st.cost),
    评分: breakdown.score,
    计分明细: breakdown,
    胸片报告: E.chestXrayReports(st),
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
    ['现实模式', selection('realism', mode)],
  ];
}

function openCaseRecord(r) {
  const ok = r.结局 === '出院';
  const summary = [['诊断', r.诊断 || r.病例名], ['住院用时', r.耗时 + ' 分钟'], ['诊疗费用', '¥' + r.费用]];
  if (r.死因) summary.push(['死因', r.死因]);
  if (r.终末血钾 != null) summary.push(['终末血钾', r.终末血钾 + ' mmol/L'], ['终末 pH', r.终末pH]);
  summary.push(...caseSettingsRows(r.设置));
  if (r.新成就?.length) summary.push(['新成就', r.新成就.join('、')]);
  openDetail(ok ? '患者出院' : '患者死亡', [r.患者, r.时间].filter(Boolean).join(' · '), [], '');
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
  const films = new Map((r.胸片报告 || []).map(report => [report.id, report]));
  const renderLog = ([stamp, message, sample, reportId]) => {
    const report = films.get(reportId);
    const receipt = report ? filmDetails(message, report) : escapeHtml(message);
    if (report) films.delete(reportId);
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
    ${films.size ? '<section class="case-review-section"><h5>胸片报告</h5>' +
      [...films.values()].map(report => filmDetails('床旁胸片 · ' + caseTime(report.reportedAt), report)).join('') + '</section>' : ''}`;
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
  const groups = window.CHART.GROUPS;
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
      '采样每 ' + Math.round(30) + ' 游戏秒一次，最多保留最近 720 个点。' +
    '</div>';
  const draw = (id) => {
    window.CHART.render(document.getElementById('chartCv'), S.history || [], id);
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
  try { S._wasSevere = isSevere(S) ? 1 : 0; } catch (e) { S._wasSevere = 0; }
  /* 给 1.5 秒缓冲，避免刚创建就弹 */
  try { setTimeout(() => { S._ready = 1; }, 1500); } catch (e) {}
  return S;
}

/* 重症弹窗 */
let severePopup = null;
function showSeverePopup() {
  if (severePopup) return;
  const b = (E.bp ? E.bp(S) : {});
  const reasons = [];
  if (S.gcs < 12) reasons.push('意识 GCS ' + S.gcs);
  if ((b.map ?? 90) < 65) reasons.push('MAP ' + Math.round(b.map));
  if (S.rhythm === 'sinus' && S.spo2 < 90) reasons.push('SpO₂ ' + Math.round(S.spo2) + '%');
  if (S.k > 6.5) reasons.push('血钾 ' + S.k.toFixed(1));
  if (E.temperatureStatus(S.temp) === 'crit') reasons.push(`${temperatureLabel(S.temp)} ${S.temp.toFixed(1)}℃`);
  if (S.rhythm !== 'sinus') reasons.push('心律异常');
  if (S.vent) reasons.push('已插管');
  const el = document.createElement('div');
  el.id = 'severePopup';
  el.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42)';
  el.innerHTML =
    '<div style="width:min(420px,88vw);background:var(--card);color:var(--ink);border-radius:16px;padding:20px 20px 16px;box-shadow:0 20px 60px rgba(0,0,0,.35);border:1px solid rgba(211,58,58,.35)">' +
      '<div style="font-size:11px;letter-spacing:2px;color:#c0392b;margin-bottom:6px">⚠ 病情加重</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px">已转入重症</div>' +
      '<div style="font-size:13px;line-height:1.7;color:var(--ink-2)">' + (reasons.length ? reasons.join(' · ') : '生命体征恶化') + '</div>' +
      '<div style="font-size:12.5px;line-height:1.7;color:var(--ink-3);margin-top:8px">从现在起血液指标改为实时监护；床位费按重症计。</div>' +
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
    lines.push('病例编号：' + (S.caseId || '随机') + ' / 难度 ' + (S.diff || caseDiff));
    const p = S.patient || {};
    lines.push('病人：' + (p.name || '—') + ' ' + (p.sex || '') + ' ' + (p.age || '') + ' 岁');
    lines.push('游戏时间：' + Math.round((S.t || 0) / 60) + ' 分钟' + (S.death ? ' · 已死亡' : S.discharged ? ' · 已出院' : ' · 进行中'));
    const vitals = E.snapshot(S);
    lines.push('体征：HR ' + vitals.hr + ' BP ' + vitals.sys + '/' + vitals.dia +
      ' SpO2 ' + (vitals.spo2 == null ? '无信号' : vitals.spo2 + '%') + ' T ' + S.temp.toFixed(1) +
      ' K ' + S.k.toFixed(1) + ' GCS ' + S.gcs);
    const tail = (S.log || []).slice(-12).map(l => '  ' + l[0] + ' ' + l[1]).join('\n');
    if (tail) lines.push('最近记录：\n' + tail);
    const given = (S.given || []).slice(-10).map(g => {
      if (g.pumpAction) return '  ' + E.pumpOrder(g.n, g.pumpAction, g.d, g.unit);
      if (g.infusionMinutes) return `  ${g.n}（${g.route} · ${E.infusionDetails(g.d, g.unit, g.infusionMinutes)}）`;
      return '  ' + g.n + ' ' + g.d + (g.unit || '');
    });
    if (given.length) lines.push('最近用药：\n' + given.join('\n'));
    /* 会诊码：作者拿到可以原样复现这一例 */
    try {
      if (window.SHARE && window.SHARE.make) {
        const code = window.SHARE.make(patient);
        if (code) {
          lines.push('会诊码（可复现本例）：');
          lines.push(code);
        }
      }
    } catch (e) {}
    const isGen = !!(S.cas && (S.cas.id === 'gen' || S.caseId === 'gen'));
    const sd = (S.seed != null) ? S.seed : (S.cas && S.cas.seed);
    lines.push('种子/难度：' + (isGen ? (sd != null ? sd : '随机') : '固定病例') + ' / ' + (S.diff || caseDiff));
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
const APP_VERSION = '1.53.1';
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
        if (!realism) { toast('先开启现实模式', true); return; }
        initInsurance(btn.dataset.ins === 'random' ? 'random' : btn.dataset.ins);
        toast('已切换：' + (S.ins ? S.ins.t : ''));
        openInsuranceHelp();
      });
    });
  };
  const ins = (S && S.ins) ? S.ins : null;
  const c = (S && S.ins) ? costSummary() : null;
  list.innerHTML =
    '<div style="padding:12px 14px 6px;font-size:12.5px;line-height:1.85;color:var(--ink-2)">' +
      '现实模式会计费。你要盯的不是"医院花多少"，而是<b>病人家庭自己掏多少</b>。' +
    '</div>' +
    '<div class="sec">三个数字</div>' +
    '<div style="padding:0 14px 10px;font-size:12.5px;line-height:1.9">' +
      '① <b>总费用</b>：药费 + 操作费 + 床位费（普通 ¥25/小时，重症 ¥80/小时）<br>' +
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
      '不想被费用约束？主页「现实模式」按钮点一下就能关掉，随时可以再开。' +
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
      '<div style="font-size:12px;color:#8a8078;margin-bottom:8px">会诊码包含：病例来源、病人身份、全部处置与结局。对方粘贴后可以查看你的思路，也可以接手重来。</div>' +
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
    const caseName = d.c === 'gen' ? (window.CASEGEN ? (function () {
      try { const S2 = window.SHARE.rebuild(d, E); return S2 ? S2.cas.name : '随机病例'; } catch (e) { return '随机病例'; }
    })() : '随机病例') : ((E.CASES && E.CASES[d.c] && E.CASES[d.c].name) || d.c);
    const p = d.p || {};
    const acts = (d.a || []).map(([kind, , id, dose, infusion]) => {
      if (kind === 'd' && ['start', 'adjust', 'stop'].includes(infusion?.pumpAction)) {
        const name = window.SUBSTANCES?.byId(id)?.n || id;
        return E.pumpOrder(name, infusion.pumpAction, dose, infusion.unit);
      }
      if (kind === 'd' && Number.isFinite(infusion?.minutes) && infusion.minutes > 0) {
        const name = window.SUBSTANCES?.byId(id)?.n || id;
        return `开始泵入 ${name}（${E.infusionDetails(dose, infusion.unit, infusion.minutes)}）`;
      }
      return (kind === 'd' ? '给药 ' : '操作 ') + id + (dose ? ' ' + dose : '');
    });
    const outcome = d.o === 'death' ? ('死亡' + (d.r ? '（' + d.r + '）' : ''))
      : d.o === 'discharge' ? '出院' : '未结束';
    pv.innerHTML =
      '<div style="font-size:13px;line-height:1.7">' +
      '<div><b>会诊病例</b></div>' +
      '<div style="color:#8a8078">病人：' + escapeHtml(p.n || '—') + ' · ' + escapeHtml(p.x) + ' · ' + escapeHtml(p.a) + ' 岁 · ' + escapeHtml(p.w) + ' kg</div>' +
      '<div style="color:#8a8078">结局：' + escapeHtml(outcome) + ' · 用时 ' + escapeHtml(d.t) + ' 分钟 · 评分 ' + escapeHtml(d.sc) + '</div>' +
      '<div style="margin-top:6px;color:#6b625d">处置 ' + acts.length + ' 条：' + escapeHtml(acts.slice(0, 6).join('；') || '无') + (acts.length > 6 ? ' …' : '') + '</div>' +
      '</div>' +
      '<button id="cTake" class="pill" style="margin-top:10px;padding:10px 16px;cursor:pointer;background:#f7e6e6;color:#a33;font-weight:700">接手这一例</button>';
    const take = pv.querySelector('#cTake');
    take.addEventListener('click', () => {
      if (patient !== S || !list.contains(take) || !$('#sheet').classList.contains('on')) return;
      const ns = window.SHARE.rebuild(d, E);
      if (!ns) { toast('无法重建该病例', true); return; }
      installCase(ns, true);
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

function bind() {
  bindLobby();
  $('#opTitle').addEventListener('change', event => selectOrgan(event.target.value));
  $('#btnLobby').addEventListener('click', showLobby);
  $('#sheetClose').addEventListener('click', dismissSheet);
  $('#btnDrug').addEventListener('click', () => openDrugSheet());
  $('#btnOps').addEventListener('click', () => {
    if (isCurrentPatient(S)) openSheet('操作', S.patient.name + ' · 急救与介入', actionRows(), S);
  });
  $('#btnBody').addEventListener('click', () => openChecks(S));
  $('#btnBlood').addEventListener('click', openReports);
  $('#btnMenu').addEventListener('click', () => openSheet('菜单', '', [
    {n:'音效设置', tag:SOUND.enabled ? SOUND.volume + '%' : '静音', amt:'调节', run:openSoundSettings},
    {sec:'存档与测试'},
    {n:'重置游戏存档', tag:'清空游戏进度及设置', amt:'', run:confirmSaveReset},
    /* 仅调试模式可见：正式包不提供这个入口 */
    ...(DEBUG_TOOLS ? [{n:'强制移除当前患者（测试用）', tag:'释放当前床位', amt:'', run:confirmRemovePatient}] : []),
    {sec:'设置与工具'},
    {n:'会诊', tag:'分享 / 接手病例', amt:'查看', run: () => openConsult()},
    {n:'费用与医保', tag: realism ? '查看明细' : '现实模式才计费', amt:'查看', run: () => openCostSheet()},
    {n:'检查更新', tag:'在线 · v' + APP_VERSION, amt:'查看', run: () => checkUpdate()},
    {n:'反馈问题', tag:'带上记录，一键复制', amt:'反馈', run: () => openFeedback()},
    {n:'关于 · 隐私', tag:'v' + APP_VERSION, amt:'查看', run: () => openAbout()},
    {n:'获取最新版', tag:'下载页 / 联系方式', amt:'查看', run: () => openGetLatest()},
    {n:'医保说明 / 切换', tag: realism ? ((S && S.ins ? S.ins.t : '未参保') + ' · 可切换') : '看看怎么算', amt:'查看', run: () => openInsuranceHelp()},
    {n:'在线版模式', tag:'免安装更新', amt:'设置', run: () => openOnlineMode()},
    ...(IS_WEB || releaseBase ? [{n:'下载离线版', tag:'查看可用版本', amt:'下载', run: openGetLatest}] : []),
    {n:'统计', tag:'治愈率 · 常犯错', amt:'查看', run: () => openStats()},
    {n:'病历档案', tag:`最近 ${loadRecords().length} 例`, amt:'查看', run: () => openRecords()},
    {n:'行医手册', tag: handbookTag(), amt:'查看', run: () => openHandbook()},
    {n:'指标走势', tag:'血压·心率·血钾…', amt:'查看', run: () => openChart()},
    {n:'术语表', tag:(window.GLOSSARY?window.GLOSSARY.TERMS.length:0)+' 条', amt:'查看', run: () => openGlossary()},
    {n:'成就', tag: (window.ACHIEVEMENTS ? `${window.ACHIEVEMENTS.unlocked().size} / ${window.ACHIEVEMENTS.list.length} 已解锁` : '未加载'), amt:'查看', run: () => openAchievements()},
    {n:'难度设置', tag:'病例难度 ' + caseDiff + ' · 指导 ' + ((MENTOR.LEVELS[level]||MENTOR.LEVELS.intern).name), amt:'', run: () => openSheet('难度设置', '两轴独立', difficultyRows())},
    {n: nightMode ? '☀ 切回白天' : '🌙 夜间模式', tag: nightMode ? '病情推进 ×1.3 · 界面转暗' : '当前白天', amt:'切换', run: () => { closeSheet(); toggleNight(); }},
    {n: realism ? '关闭现实模式' : '现实模式（医保与自付）', tag: realism ? ((S && S.ins ? S.ins.t : '已参保') + ' · 点此关闭') : '开：计费，看家庭自付', amt:'切换', run: () => { closeSheet(); toggleRealism(); }},
    {n: '环境 / 场景', tag: '降温·保暖·环境', amt: '', run: () => openEnvSheet()},
    {n: autoHint ? '主动提示：开' : '主动提示：关', tag: autoHint ? '自动显示提示' : '只在给药后点评', amt: '', run: () => {
      autoHint = !autoHint;
      try { localStorage.setItem('life.autoHint', autoHint ? '1' : '0'); } catch (e) {}
      closeSheet();
      showAdvice(false);
      toast(autoHint ? '已开启主动提示' : '已改为求助制：点「问上级」才给提示');
    }},
    {n: paused ? '继续（已暂停）' : '暂停', tag:'', amt:'', run: () => { paused = !paused; closeSheet(); toast(paused ? '已暂停' : '继续'); }},
    {n:'返回大厅', tag:'床位 / 成就 / 手册', amt:'进入', run: () => { closeSheet(); showLobby(); }},
    {n:'病房床位', tag: beds.length + ' / ' + MAX_BEDS, amt:'切换', run: () => openBeds()},
    {n:'重新开始本病例', tag:'', amt:'', run: () => confirmRestart()},
    {n:'切换病例', tag:'', amt:'', run: () => pickCase()},
    {n:'教程 · 怎么玩', tag:(window.TUTORIAL?window.TUTORIAL.PAGES.length:6)+' 页', amt:'', run: () => { if (window.TUTORIAL) TUTORIAL.open(0); }},
    {n:'病例说明', tag:'入院记录', amt:'查看', run: openAdmission},
  ]));
  $('#mask').addEventListener('click', dismissSheet);
  $('#detailX').addEventListener('click', closeDetail);
  $('#detail').addEventListener('click', e => { if (e.target.id === 'detail') closeDetail(); });

  $('#speed').addEventListener('click', e => {
    const p = e.target.closest('.pill'); if (!p) return;
    if (p.id === 'ff') {
      if (observationUntil != null) { stopObservation(); return; }
      ff = !ff; syncSpeedUI(); return;
    }
    ff = false;
    speed = +p.dataset.s; syncSpeedUI();
  });
}

function setCaseDiff(v) {
  caseDiff = Math.max(1, Math.min(5, v | 0));
  try { localStorage.setItem('life.caseDiff', String(caseDiff)); } catch (e) {}
  dismissSheet();
  toast('病例难度：' + caseDiff);
}
const CASE_DIFFICULTIES = [
  ['普通', '单一病理（原 1–2 合并）'],
  ['重症', '单一病理 + 基础病（原 3–5 合并）'],
  ['危重', '双病理叠加 + 基础病'],
  ['极危', '三病理叠加 + 特殊体质'],
  ['噩梦', '三病理 + 双体质，恶化最快'],
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
      run: () => openSheet('病例难度', '病有多复杂', caseDiffRows()) },
    { n: '指导强度', tag: (MENTOR.LEVELS[level] || MENTOR.LEVELS.intern).name, amt: '调整',
      run: () => openSheet('指导强度', '上级医师说多少', levelRows()) },
  ];
}
function diffFromLevel() {
  return caseDiff;
}
function prepareCase(st) {
  st.admissionSettings = { level, realism };
  const { hr, sys, dia, temp, rr, spo2, gcs } = E.snapshot(st);
  st.admissionVitals = { t: st.t, hr, sys, dia, temp, rr, spo2, gcs };
  try { if (window.DIAGNOSIS) st.dx0 = window.DIAGNOSIS.classify(st); } catch (e) {}
  return st;
}

function openAdmission() {
  if (!isCurrentPatient(S)) return;
  const c = S.cas;
  const chief = c.chief || c.complaint || '';
  const history = c.admission ? CASEGEN.admissionNarrative(c) : c.complaint;
  const rows = [['主诉', escapeHtml(chief).replace(/\n/g, '<br>')]];
  if (history && history !== chief) {
    rows.push(['现病史', escapeHtml(history).replace(/\n/g, '<br>')]);
  }
  const v = S.admissionVitals;
  if (v) {
    rows.push(['接诊首测', caseTime(v.t)],
      ['体温 / 心率', `${v.temp ?? '—'} ℃ · ${v.hr} 次/分`],
      ['血压 / 呼吸', `${v.sys}/${v.dia} mmHg · ${v.rr} 次/分`],
      ['SpO₂ / 意识', `${v.spo2 == null ? '无信号' : v.spo2 + '%'} · GCS ${v.gcs}`]);
  } else rows.push(['接诊首测', '旧存档未记录']);
  /* 诊断、目标、体质、提示都属于"医生该自己想"的信息，入院记录里不再展示 */
  openDetail('入院记录', S.patient.name + ' · 主诉与首测', rows, '');
}

/* 开局卡片：只讲患者主诉，几秒后自动淡出，不提供任何诊断线索 */
let admissionIntro = null;
function showAdmissionIntro(st) {
  if (admissionIntro) { admissionIntro.remove(); admissionIntro = null; }
  if (!st || !st.cas) return;
  const p = st.patient || {};
  const chief = st.cas.chief || st.cas.complaint || '';
  const complaint = st.cas.admission ? CASEGEN.admissionNarrative(st.cas) : st.cas.complaint;
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
      (complaint && complaint !== chief
        ? '<div style="font-size:12.5px;line-height:1.75;color:var(--ink-2)">' +
            escapeHtml(complaint).replace(/\n/g, '<br>') +
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
  timer = setTimeout(close, 4600);
}

function startCase(spec, replace) {
  if (!replace && beds.length >= MAX_BEDS) {
    closeSheet();
    toast(`床位已满（最多 ${MAX_BEDS} 张），先处理或结束一个病例`, true);
    return;
  }
  const st = ensurePresentation(E.create(spec));
  installCase(st, replace);
  showAdmissionIntro(st);
}

function installCase(st, replace) {
  if (!hasCurrentWard()) return;
  prepareCase(st);
  if (replace && isCurrentPatient(S)) {
    window.SOUND?.stopMonitorAlarm(S);
    try {
      if (window.DIAGNOSIS && window.HANDBOOK) {
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
      run: () => startCase({ ...patient.cas, patient: patient.patient }, true) },
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

function toggleRealism() {
  realism = !realism;
  try { localStorage.setItem('life.realism', realism ? '1' : '0'); } catch (e) {}
  if (realism && S) {
    initInsurance();
    let first = true;
    try { first = localStorage.getItem('life.insHelpShown') !== '1'; } catch (e) {}
    if (first) {
      try { localStorage.setItem('life.insHelpShown', '1'); } catch (e) {}
      openInsuranceHelp();
    } else {
      toast('现实模式：' + (S.ins ? S.ins.t + '，家庭可承受自付 ¥' + Math.round(S.ins.oopCap) : '已参保'));
    }
  } else if (S) {
    S.ins = null;
    toast('已回到标准模式（不计费、不限费）');
  }
  renderAll();
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

function initInsurance(forceType) {
  if (!realism || !S) return;
  let k;
  if (forceType != null) {
    const list = INSURANCE;
    k = forceType === 'random' ? list[Math.floor(Math.random() * list.length)] : (list.find(x => x.t === forceType) || list[0]);
  } else {
    k = INSURANCE[Math.floor(Math.random() * INSURANCE.length)];
  }
  const income = 3000 + Math.round(Math.random() * 9000);   // 家庭月收入
  const keepIncome = (S.ins && S.ins.income) ? S.ins.income : income;
  S.ins = { ...k, income: keepIncome, oopCap: keepIncome * 3 };
  S.bedCost = S.bedCost || 0;
  S._overWarned = 0; S._refused = 0;
}

function costSummary() {
  const total = Math.round((S.cost || 0) + (S.bedCost || 0));
  const ins = S.ins || { rate: 0, ded: 0, cap: 0 };
  const reimbursable = ins.cap === 0 ? 0 : Math.min(ins.cap, Math.max(0, total - ins.ded) * ins.rate);
  const selfPay = Math.round(total - reimbursable);
  return { total, reimb: Math.round(reimbursable), selfPay, cap: S.ins ? S.ins.oopCap : 0 };
}

function checkBudget() {
  if (!realism || !S || !S.ins) return;
  const c = costSummary();
  if (!S._overWarned && c.selfPay > c.cap) {
    S._overWarned = 1;
    toast('⚠ 自付 ¥' + c.selfPay + ' 已超过家庭承受能力 ¥' + c.cap, true);
  }
  if (!S._refused && c.selfPay > c.cap * 1.3) {
    S._refused = 1;
    S.score = Math.max(0, (S.score || 100) - 40);
    S.log.push([E.fmt(S.t), '医保拒付：自付费用超过家庭承受力的 130%', 'bad']);
    toast('⛔ 医保拒付：自付费用超过家庭承受力的 130%', true);
  }
}

function openCostSheet() {
  const c = costSummary();
  const ins = S.ins || { t: '未参保', rate: 0, ded: 0, cap: 0, income: 0 };
  openDetail('费用与医保', realism ? '现实模式' : '标准模式（不计费）', [
    ['参保类型', ins.t + (ins.rate ? '（报销 ' + Math.round(ins.rate * 100) + '%）' : '')],
    ['总费用', '¥' + c.total + (S.bedCost ? '（含床位 ¥' + Math.round(S.bedCost) + '）' : '')],
    ['医保支付', '¥' + c.reimb],
    ['家庭自付', '¥' + c.selfPay],
    ['家庭承受力', '¥' + c.cap + (ins.income ? '（月收入 ¥' + ins.income + ' ×3）' : '')],
    ['起付线 / 封顶', '¥' + ins.ded + ' / ¥' + ins.cap],
  ], c.selfPay > c.cap ? '自付已超过家庭承受能力。' : '');
}

/* 重症判定：重症才给"实时监护"，轻症必须开检查才有新结果 */
function isSevere(S) {
  if (!S) return false;
  const b = (E.bp ? E.bp(S) : { map: S.map || 90 });
  return !!(S.rhythm !== 'sinus' || S.vent || S.gcs < 12 || (b.map ?? 90) < 65 ||
            S.spo2 < 90 || S.hr > 130 || S.hr < 45 || S.k > 6.5 || E.temperatureStatus(S.temp) === 'crit');
}

function renderPatient() {
  const p = (S && S.patient) || {};
  const nEl = document.getElementById('pname');
  const mEl = document.getElementById('pmeta');
  if (nEl) nEl.textContent = p.name || '—';
  if (mEl) mEl.textContent = [p.age != null ? p.age + ' 岁' : '', p.sex || '', p.weight ? p.weight + ' kg' : '']
    .filter(Boolean).join(' · ');
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
  { v: '1.53.1', notes: [
    '主诉按病历格式重写（症状 + 持续时间），现病史单独列出',
    '开局弹窗只给主诉与现病史，病名仍只在结算出现',
  ] },
  { v: '1.53.0', notes: [
    '病例不再提前揭晓病名：入院只给主诉与首测，病名在结算时出现',
    '动脉血气与肺面板按分流后的动脉血计算氧合，修正高浓度吸氧时的读数矛盾',
    '床旁新增物理降温与被动保暖，区分感染、热射病、甲状腺危象与抽搐产热',
    '出院评估按监护显示的整数判定心率，并显示该病例的实际目标范围',
    '结算与病历共用一页：指导等级、难度、现实模式、加扣分明细与可滚动日志',
    '床旁双肺听诊；血常规与血气可对照上次结果；报告页集中查看化验与影像',
    '分娩按模拟时间推进，记录母体体征与新生儿交接',
    '胰岛素按总量与时长输注；多巴酚丁胺、异丙肾上腺素、血管加压素支持持续泵入与调速',
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
      if (button.dataset.mode === 'night') toggleNight(); else toggleRealism();
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
  lobby.querySelector('[data-mode="realism"]').setAttribute('aria-pressed', realism);
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
  realism = localStorage.getItem('life.realism') === '1';
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
if (realism && S && !S.ins) initInsurance();
bind();
if (S) drawBody();
bindBedSwipe();
renderAll();
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








