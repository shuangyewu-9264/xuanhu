/* =========================================================================
 * 行医手册 · handbook.js
 * 用途：玩家自己的「私人笔记本」——只记录他实际遇到过、实际做过的事。
 * 接口：
 *   HANDBOOK.record(entry)     一局结束时记录（按诊断名归并）
 *   HANDBOOK.entries()         全部条目（数组，最近更新在前）
 *   HANDBOOK.has(tagOrName)    是否见过某个诊断名 / 标签
 *   HANDBOOK.render()          返回可放进 #sheetList 的 HTML 字符串
 *   HANDBOOK.export()          导出 JSON 字符串
 *   HANDBOOK.import(json)      从导出的 JSON 恢复（整本替换）
 *   HANDBOOK.setNote(name,text) 写玩家备注
 *   HANDBOOK.fromCase(S, dx)   把一局状态整理成 record() 需要的条目
 *
 * 设计约束（重要）：
 *   1) 不生成任何推荐疗法 / 标准治疗 / 知识要点；只保存：
 *      - 玩家实际给过的药、做过的操作（来自 S.given / S.log）
 *      - 由数据算出的客观结果（诊断、证据指标、结局、耗时、评分）
 *      - 玩家自己写的备注
 *   2) 全局单一存储键 localStorage('life.handbook')，不按难度/等级/病例分叉；
 *   3) 不预置图鉴：没见过的东西不会建档；
 *   4) 导师点评只作为「发生过的事件」原样留存，不做整理、汇总或推荐化。
 * ========================================================================= */
(function (root) {
'use strict';

const KEY = 'life.handbook';
const VERSION = 1;
const MAX_THERAPIES = 40;
const MAX_MISTAKES = 60;
const MAX_EVIDENCE_HISTORY = 20;
const MAX_NOTE = 4000;

let memory = { version: VERSION, sessions: {}, entries: [] };
let sessionSeq = 0;

/* ---------------- 存储 ---------------- */
function safeLS() {
  try {
    const ls = root.localStorage;
    return (ls && typeof ls.getItem === 'function') ? ls : null;
  } catch (e) { return null; }
}
function emptyStore() { return { version: VERSION, sessions: {}, entries: [] }; }

function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const name = String(e.name || e.primary || e.诊断 || '').trim();
  if (!name) return null;
  const n = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : d;
  const arr = v => Array.isArray(v) ? v : [];
  const tags = arr(e.tags).map(String).filter(Boolean);
  const therapies = arr(e.therapies).filter(x => x && typeof x === 'object').slice(0, MAX_THERAPIES);
  const mistakes = arr(e.mistreatments).filter(x => x && typeof x === 'object').slice(0, MAX_MISTAKES);
  return {
    name,
    tags,
    firstSeen: e.firstSeen || new Date().toISOString(),
    lastSeen: e.lastSeen || e.firstSeen || new Date().toISOString(),
    encounters: n(e.encounters, 0),
    cured: n(e.cured, 0),
    died: n(e.died, 0),
    failed: n(e.failed, 0),
    unknown: n(e.unknown, 0),
    severity: e.severity || '',
    evidence: arr(e.evidence).map(String),
    evidenceHistory: arr(e.evidenceHistory).filter(x => x && typeof x === 'object').slice(-MAX_EVIDENCE_HISTORY),
    therapies,
    mistreatments: mistakes,
    note: typeof e.note === 'string' ? e.note.slice(0, MAX_NOTE) : '',
  };
}

function readStore() {
  const ls = safeLS();
  if (!ls) return clone(memory);
  try {
    const raw = ls.getItem(KEY);
    if (!raw) return emptyStore();
    const d = JSON.parse(raw);
    if (Array.isArray(d)) {
      return { version: VERSION, sessions: {}, entries: d.map(sanitizeEntry).filter(Boolean) };
    }
    if (!d || typeof d !== 'object') return emptyStore();
    const entries = Array.isArray(d.entries) ? d.entries.map(sanitizeEntry).filter(Boolean) : [];
    const sessions = (d.sessions && typeof d.sessions === 'object') ? d.sessions : {};
    return { version: VERSION, sessions, entries };
  } catch (e) { return emptyStore(); }
}

function writeStore(db) {
  memory = clone(db);
  const ls = safeLS();
  if (ls) {
    try { ls.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 配额满时仅保留内存副本 */ }
  }
  return db;
}

function clone(x) { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return x; } }

/* ---------------- 小工具 ---------------- */
function isoNow() { return new Date().toISOString(); }
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch (e) { return String(iso); }
}
function outcomeLabel(o) {
  if (o === 'cured') return '治好';
  if (o === 'died') return '死亡';
  if (o === 'failed') return '出院失败';
  return '未结';
}
function outcomeColor(o) {
  if (o === 'cured') return '#2f9e63';
  if (o === 'died' || o === 'failed') return '#c0392b';
  return '#8a7a7a';
}
const SEVERITY_LABEL = { critical: '危重', severe: '重症', moderate: '中度', mild: '轻度' };
function logText(l) {
  if (!l) return '';
  return String(l[1] != null ? l[1] : l[0] || '');
}

/* ---------------- 从一局状态提取「实际发生过的事」 ---------------- */
const ACTION_RE = /胸外按压|电除颤|除颤|血液透析|透析|高流量吸氧|吸氧|内镜|气管插管|机械通气|补液|洗胃|导尿|止血|电复律|起搏|手术|心肺复苏|CPR/;
function extractActions(log) {
  const out = [];
  for (const l of (Array.isArray(log) ? log : [])) {
    const text = logText(l).trim();
    if (!text) continue;
    if (text.startsWith('给予 ') || text.startsWith('带教点评') || text.startsWith('开出 ')
        || text.indexOf('结果已出') >= 0 || text.startsWith('患者')) continue;
    /* 引擎的报警日志（“室颤！立即除颤”“心静止”等）不是玩家操作 */
    if (text.startsWith('室颤') || text.startsWith('心静止') || text.indexOf('！') >= 0) continue;
    if (!ACTION_RE.test(text)) continue;
    const time = (l && l.length >= 3) ? String(l[0] || '') : '';
    out.push(time ? `${time} ${text}` : text);
    if (out.length >= 40) break;
  }
  return out;
}

function extractMistakes(log) {
  const out = [];
  for (const l of (Array.isArray(log) ? log : [])) {
    const text = logText(l);
    if (text.indexOf('带教点评：') < 0) continue;
    const tone = (l && l.length >= 2) ? String(l[l.length - 1]) : '';
    if (tone !== 'warn' && tone !== 'bad') continue;   // 只留被判为错误的点评
    out.push({
      text: text.replace(/^.*?带教点评：/, '').trim(),
      time: (l && l.length >= 3) ? String(l[0] || '') : '',
      tone,
      at: isoNow(),
    });
    if (out.length >= 20) break;
  }
  return out;
}

function makeSessionId(S) {
  sessionSeq += 1;
  const caseId = (S && (S.caseId || (S.cas && S.cas.id))) || 'case';
  return `${caseId}-${Date.now().toString(36)}-${sessionSeq}`;
}

function scoreOf(S) {
  if (!S) return 0;
  if (root.LIFE && typeof root.LIFE.finalScore === 'function') {
    try { return Math.round(root.LIFE.finalScore(S)); } catch (e) {}
  }
  return Math.round(S.finalScore != null ? S.finalScore : (S.score || 0));
}

/* 把「这一局」整理成 record() 的输入 */
function fromCase(S, dx) {
  if (!S) return null;
  const d = dx || (root.DIAGNOSIS && typeof root.DIAGNOSIS.classify === 'function'
    ? root.DIAGNOSIS.classify(S) : null);
  const outcome = S.discharged ? 'cured' : S.death ? 'died'
    : S.dischargeOutcome?.status === 'failed' ? 'failed' : 'unknown';
  const drugs = [];
  /* 只保留玩家真正给过的药：S.given 里开局 preload 注入的院前用药没有对应日志，
     而玩家每次给药都会留下「给予 <药名> …」的日志。 */
  const logTexts = (Array.isArray(S.log) ? S.log : []).map(logText);
  const usedLog = new Set();
  for (const g of (Array.isArray(S.given) ? S.given : [])) {
    if (!g) continue;
    const nm = String(g.n || '');
    if (!nm) continue;
    const prefix = '给予 ' + nm + ' ';
    let hit = -1;
    for (let i = 0; i < logTexts.length; i++) {
      if (!usedLog.has(i) && logTexts[i].startsWith(prefix)) { hit = i; break; }
    }
    if (hit < 0) continue;              // 没有对应日志 → 院前预置，不是玩家操作
    usedLog.add(hit);
    drugs.push({
      name: String(g.n || g.id || ''),
      dose: (typeof g.d === 'number') ? g.d : (g.d == null ? '' : g.d),
      unit: String(g.unit || ''),
      route: String(g.route || ''),
    });
    if (drugs.length >= 80) break;
  }
  const therapy = {
    sessionId: makeSessionId(S),
    drugs,
    actions: extractActions(S.log),
    outcome,
    durationMin: Math.round((S.t || 0) / 60),
    score: scoreOf(S),
    timestamp: isoNow(),
    caseName: (S.cas && S.cas.name) || S.caseId || '',
    severity: d && d.severity,
    confidence: d && d.confidence,
    evidence: (d && Array.isArray(d.evidence)) ? d.evidence.slice(0, 6) : [],
  };
  /* 兼容任务书里的中文键名（导出 JSON 同时保留两种写法） */
  therapy['操作'] = therapy.actions;
  therapy['耗时'] = therapy.durationMin;
  therapy['评分'] = therapy.score;
  therapy['时间戳'] = therapy.timestamp;
  return {
    name: (d && d.primary) || '未分类',
    tags: (d && Array.isArray(d.tags)) ? d.tags : [],
    evidence: (d && Array.isArray(d.evidence)) ? d.evidence : [],
    severity: d && d.severity,
    outcome,
    caseName: therapy.caseName,
    sessionId: therapy.sessionId,
    therapy,
    mistreatments: extractMistakes(S.log),
  };
}

/* ---------------- 记录 ---------------- */
function record(entry) {
  const db = readStore();
  if (!entry || typeof entry !== 'object') return null;
  const primary = String(entry.name || entry.primary || '').trim();
  if (!primary) return null;

  const sessionId = entry.sessionId
    || (entry.therapy && entry.therapy.sessionId)
    || (entry.therapies && entry.therapies[0] && entry.therapies[0].sessionId)
    || '';

  /* 同一局重复调用时不重复计数（例如页面重入 / 补丁重复触发） */
  if (sessionId && db.sessions[sessionId]) {
    const found = db.entries.find(e => e.name === db.sessions[sessionId]);
    return found ? clone(found) : null;
  }

  let e = db.entries.find(x => x.name === primary);
  const now = isoNow();
  if (!e) {
    e = sanitizeEntry({
      name: primary, tags: entry.tags || [],
      firstSeen: now, lastSeen: now,
      encounters: 0, cured: 0, died: 0, failed: 0, unknown: 0,
      severity: entry.severity || '',
      evidence: entry.evidence || [],
      evidenceHistory: [], therapies: [], mistreatments: [], note: '',
    });
    db.entries.push(e);
  }

  e.encounters += 1;
  const therapy = entry.therapy || (Array.isArray(entry.therapies) ? entry.therapies[0] : null);
  const outcome = entry.outcome || (therapy && therapy.outcome) || 'unknown';
  if (outcome === 'cured') e.cured += 1;
  else if (outcome === 'died') e.died += 1;
  else if (outcome === 'failed') e.failed += 1;
  else e.unknown += 1;

  e.lastSeen = now;
  e.severity = entry.severity || e.severity || '';
  e.tags = e.tags || [];
  for (const t of (entry.tags || [])) if (t && e.tags.indexOf(t) < 0) e.tags.push(String(t));

  const evidence = Array.isArray(entry.evidence) ? entry.evidence.filter(Boolean).map(String) : [];
  if (evidence.length) {
    e.evidence = evidence.slice(0, 8);
    e.evidenceHistory = e.evidenceHistory || [];
    e.evidenceHistory.push({ at: now, evidence: evidence.slice(0, 8) });
    if (e.evidenceHistory.length > MAX_EVIDENCE_HISTORY) {
      e.evidenceHistory = e.evidenceHistory.slice(-MAX_EVIDENCE_HISTORY);
    }
  }

  if (therapy && typeof therapy === 'object') {
    const t = clone(therapy);
    t.sessionId = t.sessionId || sessionId || makeSessionId(null);
    if (!t.timestamp) t.timestamp = now;
    e.therapies = e.therapies || [];
    e.therapies.push(t);
    if (e.therapies.length > MAX_THERAPIES) e.therapies = e.therapies.slice(-MAX_THERAPIES);
    if (t.sessionId) db.sessions[t.sessionId] = primary;
  }

  const mistakes = Array.isArray(entry.mistreatments) ? entry.mistreatments : [];
  e.mistreatments = e.mistreatments || [];
  const seenMistake = new Set(e.mistreatments.map(m => `${m.text}|${m.time}|${m.at}`));
  for (const m of mistakes) {
    if (!m || typeof m !== 'object') continue;
    const mm = {
      text: String(m.text || ''),
      time: String(m.time || ''),
      tone: String(m.tone || ''),
      at: String(m.at || now),
    };
    if (!mm.text) continue;
    const key = `${mm.text}|${mm.time}|${mm.at}`;
    if (seenMistake.has(key)) continue;
    seenMistake.add(key);
    e.mistreatments.push(mm);
    if (e.mistreatments.length >= MAX_MISTAKES) break;
  }

  /* 玩家备注：一旦写过就不被后续记录覆盖 */
  if (typeof entry.note === 'string' && entry.note && !e.note) e.note = entry.note.slice(0, MAX_NOTE);

  writeStore(db);
  return clone(e);
}

/* ---------------- 查询 / 备注 ---------------- */
function entries() {
  const db = readStore();
  return clone(db.entries).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

function has(tagOrName) {
  const q = String(tagOrName == null ? '' : tagOrName).trim();
  if (!q) return false;
  const ql = q.toLowerCase();
  return readStore().entries.some(e =>
    e.name === q || (e.tags || []).some(t => String(t).toLowerCase() === ql));
}

function setNote(name, text) {
  const db = readStore();
  const e = db.entries.find(x => x.name === String(name || '').trim());
  if (!e) return false;
  e.note = clip(text, MAX_NOTE);
  writeStore(db);
  return true;
}

function stats() {
  const list = readStore().entries;
  return list.reduce((acc, e) => {
    acc.diagnoses += 1;
    acc.encounters += e.encounters || 0;
    acc.cured += e.cured || 0;
    acc.died += e.died || 0;
    acc.failed += e.failed || 0;
    acc.unknown += e.unknown || 0;
    return acc;
  }, { diagnoses: 0, encounters: 0, cured: 0, died: 0, failed: 0, unknown: 0 });
}

/* ---------------- 渲染 ---------------- */
function renderEvidence(ev) {
  if (!Array.isArray(ev) || !ev.length) return '';
  const display = ev.map(x => esc(x).replace(/尿量 (\d+(?:\.\d+)?) mL\/min\b/g,
    (_, rate) => `尿量 ${Math.round(Number(rate) * 60 * 100) / 100} mL/h`));
  return '<div style="font-size:11.5px;color:#6b6b6b;margin-top:3px">证据：'
    + display.join('；') + '</div>';
}

function renderTherapy(t, idx) {
  if (!t) return '';
  const out = t.outcome || 'unknown';
  const head = `<div style="font-weight:600;margin-top:8px;color:${outcomeColor(out)}">`
    + `第 ${idx + 1} 次 · ${outcomeLabel(out)} · ${Math.round(t.durationMin || 0)} 分钟 · ${Math.round(t.score || 0)} 分`
    + `<span style="font-weight:400;color:#9a9a9a;font-size:11px"> · ${esc(fmtDate(t.timestamp))}</span></div>`;

  let drugs = '';
  if (Array.isArray(t.drugs) && t.drugs.length) {
    const parts = t.drugs.map(d => {
      const dose = (d.dose === '' || d.dose == null) ? '' : `${d.dose}${d.unit || ''}`;
      return `${esc(d.name)}${dose ? ' ' + esc(dose) : ''}${d.route ? '（' + esc(d.route) + '）' : ''}`;
    });
    const shown = parts.slice(0, 14).join('；') + (parts.length > 14 ? ` 等 ${parts.length} 项` : '');
    drugs = `<div style="font-size:12px;color:#4a4a4a;margin-top:2px">用药：${shown}</div>`;
  }
  let actions = '';
  if (Array.isArray(t.actions) && t.actions.length) {
    const shown = t.actions.slice(0, 10).map(a => esc(a)).join('；')
      + (t.actions.length > 10 ? ` 等 ${t.actions.length} 项` : '');
    actions = `<div style="font-size:12px;color:#4a4a4a;margin-top:2px">操作：${shown}</div>`;
  }
  const ev = renderEvidence(t.evidence);
  return `<div style="padding:2px 0 6px;border-bottom:1px dashed #eee">${head}${drugs}${actions}${ev}</div>`;
}

function renderEntry(e) {
  const counts = `遇到 ${e.encounters} 次 · 治好 ${e.cured} · 死亡 ${e.died}`
    + (e.failed ? ` · 出院失败 ${e.failed}` : '')
    + (e.unknown ? ` · 未结 ${e.unknown}` : '');
  const sev = e.severity ? `<span style="font-size:10px;color:#9a9a9a;margin-left:6px">${esc(SEVERITY_LABEL[e.severity] || e.severity)}</span>` : '';

  let therapies = '';
  if (Array.isArray(e.therapies) && e.therapies.length) {
    therapies = e.therapies.map((t, i) => renderTherapy(t, i)).join('');
  } else {
    therapies = '<div style="font-size:11.5px;color:#9a9a9a">还没有留下疗法记录。</div>';
  }

  let mistakes = '';
  if (Array.isArray(e.mistreatments) && e.mistreatments.length) {
    mistakes = e.mistreatments.map(m =>
      `<div style="font-size:11.5px;color:#a33;margin-top:2px">${m.time ? esc(m.time) + ' ' : ''}带教点评：${esc(m.text)}</div>`
    ).join('');
  }

  return `<details style="margin:0 4px 8px;background:#faf8f7;border-radius:12px;overflow:hidden">
    <summary style="list-style:none;padding:11px 10px;cursor:pointer;display:flex;align-items:center;gap:8px">
      <span style="flex:1;font-size:14px;font-weight:600">${esc(e.name)}${sev}</span>
      <span class="tag">${counts}</span>
    </summary>
    <div style="padding:0 12px 12px;font-size:12.5px;line-height:1.6;color:#333">
      <div style="color:#9a9a9a;font-size:11px;margin-bottom:4px">
        首次 ${esc(fmtDate(e.firstSeen))} · 最近 ${esc(fmtDate(e.lastSeen))}
      </div>
      ${renderEvidence(e.evidence)}
      <div class="sec" style="padding-left:0;padding-top:8px">疗法记录</div>
      ${therapies}
      ${mistakes ? `<div class="sec" style="padding-left:0;padding-top:8px">误治记录</div>${mistakes}` : ''}
      <div class="sec" style="padding-left:0;padding-top:8px">我的备注</div>
      <textarea data-hb-note="${esc(e.name)}"
        onchange="if(window.HANDBOOK)window.HANDBOOK.setNote(this.getAttribute('data-hb-note'),this.value)"
        placeholder="写下你自己的判断、疑问或复盘……"
        style="width:100%;min-height:64px;resize:vertical;border:1px solid #e8e4e2;border-radius:10px;
               padding:8px 10px;font:inherit;font-size:12px;line-height:1.5;background:#fff;color:#333;
               outline:none;box-sizing:border-box">${esc(e.note || '')}</textarea>
    </div>
  </details>`;
}

function render() {
  const db = readStore();
  const list = clone(db.entries).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  const st = stats();

  const header = `<div style="padding:2px 12px 10px">
    <div style="font-size:12px;line-height:1.6;color:#8a6a4a;background:#fdf7ef;border-radius:10px;padding:9px 11px">
      这是你自己的记录，系统不会替你补全。
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11.5px;color:#9a9a9a">
      <span style="flex:1">收录 ${st.diagnoses} 种诊断 · 共 ${st.encounters} 局 · 治好 ${st.cured} · 死亡 ${st.died}${st.failed ? ' · 出院失败 ' + st.failed : ''}${st.unknown ? ' · 未结 ' + st.unknown : ''}</span>
      <button class="pill" style="cursor:pointer;border:0"
        onclick="if(window.HANDBOOK)window.HANDBOOK.exportFile()">导出 JSON</button>
      <label class="pill" style="cursor:pointer;margin:0">
        导入 JSON
        <input type="file" accept="application/json,.json" style="display:none"
          onchange="if(window.HANDBOOK)window.HANDBOOK.importFile(this)">
      </label>
    </div>
  </div>`;

  if (!list.length) {
    return header + `<div style="padding:26px 16px;text-align:center;color:#9a9a9a;font-size:12.5px;line-height:1.8">
      还没有记录。<br>完成一例患者后，这里才会出现条目。
    </div>`;
  }

  return header + '<div class="sec">按诊断归并</div>' + list.map(renderEntry).join('');
}

/* ---------------- 导入 / 导出 ---------------- */
function exportJSON() {
  const db = readStore();
  return JSON.stringify({
    app: 'LIFE',
    kind: 'handbook',
    version: VERSION,
    exportedAt: isoNow(),
    sessions: db.sessions || {},
    entries: db.entries || [],
  }, null, 2);
}

function importJSON(json, opts) {
  let d;
  try {
    d = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败' };
  }
  if (!d || typeof d !== 'object') return { ok: false, error: '无效的手册数据' };
  const rawEntries = Array.isArray(d.entries) ? d.entries : (Array.isArray(d) ? d : null);
  if (!rawEntries) return { ok: false, error: '缺少 entries 数组' };

  const entries = rawEntries.map(sanitizeEntry).filter(Boolean);
  if (!entries.length) return { ok: false, error: '没有可导入的条目' };

  const sessions = {};
  for (const e of entries) {
    for (const t of (e.therapies || [])) {
      if (t && t.sessionId) sessions[t.sessionId] = e.name;
    }
  }
  const db = { version: VERSION, sessions, entries };
  writeStore(db);
  return { ok: true, count: entries.length };
}

function exportFile() {
  try {
    const text = exportJSON();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'life-handbook.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (e) { return false; }
}

function importFile(input) {
  try {
    const f = input && input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const r = importJSON(String(reader.result || ''));
      if (r.ok) {
        const list = document.querySelector('#sheetList');
        if (list) list.innerHTML = render();
        if (root.SOUND && root.SOUND.click) { try { root.SOUND.click(); } catch (e) {} }
      } else {
        alert('导入失败：' + (r.error || '未知错误'));
      }
    };
    reader.readAsText(f);
  } catch (e) { /* 浏览器不支持时静默失败 */ }
}

/* 测试/调试用：清空整本手册 */
function clear() {
  const db = emptyStore();
  writeStore(db);
  return true;
}

const API = {
  record, entries, has, render, export: exportJSON, import: importJSON,
  setNote, fromCase, stats, clear,
  exportFile, importFile,
  version: VERSION, key: KEY,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.HANDBOOK = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
