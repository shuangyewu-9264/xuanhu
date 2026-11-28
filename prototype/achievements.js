/* ==========================================================================
 * 成就系统：解锁判定 + 本地持久化
 *  - 每例结束时调用 evaluate(S)，返回本次新解锁的成就 id 数组
 *  - 进度保存到 localStorage('life.ach')，刷新/重开不清空
 *  - 不依赖引擎内部公式，只读 S 上的公开状态；Node 环境自动退化为内存存储
 * ========================================================================== */
(function (root) {
'use strict';
const KEY = 'life.ach';

/* ---------- 存储 ---------- */
function fresh() {
  return {
    unlocked: {},
    stats: { total: 0, deaths: 0, failures: 0, streak: 0, prevDeath: false,
             dischargeCount: 0, discharges: {}, dischargeTags: {}, bestMin: null },
  };
}
function load() {
  try {
    const ls = root.localStorage;
    if (!ls) return fresh();
    const raw = ls.getItem(KEY);
    if (!raw) return fresh();
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return fresh();
    const st = Object.assign(fresh().stats, d.stats || {});
    if (!st.discharges || typeof st.discharges !== 'object') st.discharges = {};
    if (!st.dischargeTags || typeof st.dischargeTags !== 'object') st.dischargeTags = {};
    return { unlocked: d.unlocked || {}, stats: st };
  } catch (e) { return fresh(); }
}
let ST = load();
function save() {
  try {
    const ls = root.localStorage;
    if (ls) ls.setItem(KEY, JSON.stringify(ST));
  } catch (e) {}
}

/* ---------- 上下文工具 ---------- */
const minutes = S => (S.t || 0) / 60;

function scoreOf(S) {
  if (S.finalScore != null) return S.finalScore;
  if (root.LIFE && typeof root.LIFE.finalScore === 'function') {
    try { return root.LIFE.finalScore(S); } catch (e) {}
  }
  return Math.round(S.score || 0);
}

/* 日志文本（兼容 [时间, 文本, 色调] 与 [文本, 色调] 两种格式） */
function logText(l) {
  return String((l && (l[1] != null ? l[1] : l[0])) || '');
}

/* 单例用过的不同药物名（从「给予 xxx」日志里抽） */
function givenNames(S) {
  const set = new Set();
  for (const l of (S.log || [])) {
    const t = logText(l);
    if (t.startsWith('给予 ')) set.add(t.slice(3).split(/[\s\d]/)[0]);
    else if (t.startsWith('给药')) set.add(t);
  }
  return set;
}

const PRESSORS = new Map([
  ['norepi', '去甲肾上腺素'], ['dopamine', '多巴胺'], ['epi', '肾上腺素'],
  ['phenylephrine', '去氧肾上腺素'], ['vasopressin', '血管加压素'],
]);
const PRESSOR_NAMES = new Set(PRESSORS.values());
const isPressor = order => PRESSORS.has(order?.id) || PRESSOR_NAMES.has(order?.n);

function pressorLog(entry) {
  const [label, text] = entry || [];
  if (label === '给药') return pressorOrderText(text);
  return [text, label].some(value => {
    const order = typeof value === 'string' && value.match(/^(?:给予|给药|开始\S+|调整|停止泵入)\s+(.+)$/);
    return order && pressorOrderText(order[1]);
  });
}

function pressorOrderText(text) {
  const [name, dose] = String(text || '').split(/[\s（(]+/);
  return PRESSOR_NAMES.has(name) && !(parseFloat(dose) <= 0);
}

function noPressorUsed(S) {
  if (S.given?.some(order => isPressor(order) && order.d > 0)) return false;
  if (Object.entries(S.pumps || {}).some(([id, pump]) => PRESSORS.has(id) && (pump?.rate > 0 || pump?.activity > 0))) return false;
  if (S.pk?.some(order => isPressor(order) && order.scale > 0)) return false;
  if (S.log?.some(pressorLog)) return false;

  // 旧档可能只有日志保留了部分医嘱。日志达到引擎的 600 条上限时，不能确认全程未用药。
  const legacy = !Array.isArray(S.given) || S.drugCost == null || S.drugCostPartial;
  return !(legacy && S.log?.length >= 600);
}

const SHOCK_TAGS = ['sepsis', 'bleed', 'pe'];

/* ---------- 成就清单 ---------- */
const list = [
  { id:'on_your_own', name:'自己扛', desc:'把指导强度调到「主治」或「专家」，独立治愈出院',
    check:(S) => !!S.discharged && (S._level === 'attending' || S._level === 'expert') },

  { id:'ward_full', name:'四张床的夜班', desc:'同时管到 4 张床，并成功送出一位患者',
    check:(S) => !!S.discharged && (S._beds || 1) >= 4 },

  { id:'nightmare', name:'地狱难度', desc:'病例难度 5 时治愈出院',
    check:(S) => !!S.discharged && (S.diff || 0) >= 5 },

  { id:'teaching_free', name:'全凭手感', desc:'专家模式下零提示完成一例抢救',
    check:(S) => !!S.discharged && S._level === 'expert' && !(S.penalties > 0) },



  { id:'first_discharge', name:'活着出去', desc:'第一位患者在你手上痊愈出院',
    check:(S, c) => !!S.discharged && c.stats.dischargeCount === 1 },

  { id:'clean_save', name:'教科书式', desc:'零带教扣分、零心脏骤停、零出院扣分',
    check:(S, c) => c.cleanDischarge && !(S.penalties > 0) && !(S.arrests > 0) },

  { id:'dual_dx', name:'一案两病', desc:'识别同一患者身上的两种病理并治愈出院',
    check:(S, c) => !!S.discharged && (c.tags || []).length >= 2 },

  { id:'three_specs', name:'三个科室', desc:'三种不同病理各治愈出院一次',
    check:(S, c) => !!S.discharged && Object.keys(c.stats.dischargeTags).length >= 3 },

  { id:'sub10', name:'十分钟', desc:'10 分钟内完成处置并出院',
    check:(S, c) => !!S.discharged && c.min <= 10 },

  { id:'no_pressor', name:'不用升压药', desc:'上消化道大出血、感染性休克或急性肺栓塞病例，全程未使用升压药并稳定出院',
    check:(S, c) => c.cleanDischarge && (c.tags || []).some(t => SHOCK_TAGS.includes(t)) && noPressorUsed(S) },

  { id:'streak3', name:'三连', desc:'连续三例患者成功出院',
    check:(S, c) => c.stats.streak >= 3 },

  { id:'perfect', name:'无可挑剔', desc:'治愈出院，零出院扣分，评分达到 100 分',
    check:(S, c) => c.cleanDischarge && c.score >= 100 },

  { id:'frugal', name:'三百块救回来', desc:'总费用不超过 300 元仍治愈出院',
    check:(S) => !!S.discharged && (S.cost || 0) <= 300 },

  { id:'polypharm', name:'行走的药典', desc:'单例使用 6 种以上不同药物并出院',
    check:(S, c) => !!S.discharged && c.givenCount >= 6 },

  { id:'collector', name:'病例收集者', desc:'累计 8 种不同病例治愈出院',
    check:(S, c) => !!S.discharged && Object.keys(c.stats.discharges).length >= 8 },

  { id:'veteran', name:'病房老兵', desc:'累计完成 20 例',
    check:(S, c) => c.stats.total >= 20 },

  { id:'first_lesson', name:'没救回来的那个', desc:'第一次送走患者——记住这个病例',
    check:(S, c) => !!S.death && c.stats.deaths === 1 },

  { id:'no_tests', name:'徒手诊断', desc:'不开任何检查，凭体征判断并治愈出院',
    check:(S, c) => !!S.discharged && c.testCount === 0 },

  { id:'comeback', name:'再站起来', desc:'上一例死亡后，下一例成功挽救',
    check:(S, c) => !!S.discharged && c.stats.prevDeath === true },
];

/* ---------- 对外接口 ---------- */
function unlocked() { return new Set(Object.keys(ST.unlocked)); }

function evaluate(S) {
  if (!S) return [];
  const st = ST.stats;
  const discharged = !!S.discharged;
  const death = !!S.death;
  const status = S.dischargeOutcome?.status;
  const failed = status === 'failed';
  if (!(discharged || death || failed)) return [];

  /* 先更新累计统计，再判定（这样「首例出院」等能算上本局） */
  st.total += 1;
  if (death) st.deaths += 1;
  if (failed) st.failures += 1;
  st.streak = discharged ? st.streak + 1 : 0;
  if (discharged) {
    const key = (S.cas && S.cas.name) || S.caseId || '未知病例';
    st.discharges[key] = (st.discharges[key] || 0) + 1;
    for (const t of (S.tags || [])) st.dischargeTags[t] = (st.dischargeTags[t] || 0) + 1;
    st.dischargeCount += 1;
    const m = minutes(S);
    if (st.bestMin == null || m < st.bestMin) st.bestMin = m;
  }

  const ctx = {
    stats: st,
    cleanDischarge: discharged && status !== 'penalized',
    min: minutes(S),
    score: scoreOf(S),
    tags: S.tags || [],
    testCount: Object.keys(S.tests || {}).length,
    givenCount: givenNames(S).size,
  };

  const out = [];
  for (const a of list) {
    if (ST.unlocked[a.id]) continue;
    let ok = false;
    try { ok = !!a.check(S, ctx); } catch (e) { ok = false; }
    if (ok) { ST.unlocked[a.id] = Date.now(); out.push(a.id); }
  }

  st.prevDeath = death;        // 留给下一例的「触底反弹」
  save();
  return out;
}

function reset() {
  ST = fresh();
  save();
}

const API = { list, evaluate, unlocked, reset };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.ACHIEVEMENTS = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
