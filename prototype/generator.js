/* ==========================================================================
 * 病例生成器：按难度随机组合「病理模块」生成病人
 *  - 难度决定：几个病理、病情严重度、是否有基础病
 *  - 每个模块声明自己的「负荷驱动量」、病程推进、目标、出院判据
 *  - 同一种病每次生成都有差异（年龄/体重/严重度/合并症）
 *
 * v0.3 重构（科学审查后）：
 *   advance() 不再直接改体征（"S.spo2 = min(...,cap)"、"S.hr = max(...,floor)"），
 *   而是改**负荷量**（气道阻力 / 胆碱酯酶活性 / 肺血管阻力 / 钠与水 / NAPQI-GSH /
 *   血管张力驱动），体征由 engine.js 的生理方程自然产生。
 *   每个模块里都注明「替代了原来的什么」。
 * ========================================================================== */
(function (root) {
'use strict';
const clamp = (x,a,b)=>Math.min(b,Math.max(a,x));
const VERSION = 4;
const traitsApi = root.TRAITS || (typeof module !== 'undefined' && module.exports ? require('./traits.js') : null);

/* 随机数（可复现） */
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

/* ---------- 病人身份 ---------- */
const SURNAMES = ['王','李','张','刘','陈','杨','赵','黄','周','吴','徐','孙','马','朱','胡','郭','何','高','林','罗','梁','宋','郑','谢','韩','唐','冯','于','董','萧'];
const MALE_GIVEN = ['建国','志强','伟','磊','军','洋','勇','杰','涛','鹏','浩','宇','斌','超','明','刚','辉','强','东','峰','立','建军','文博','嘉诚'];
const FEMALE_GIVEN = ['秀英','丽','敏','静','娟','芳','燕','娜','婷','雪','琳','悦','慧','倩','萍','梅','兰','霞','洁','颖','佳','思','若','诗'];
function makeName(sex, rnd) {
  const s = SURNAMES[Math.floor(rnd() * SURNAMES.length)];
  const pool = sex === '女' ? FEMALE_GIVEN : MALE_GIVEN;
  return s + pool[Math.floor(rnd() * pool.length)];
}
/* 身高体重：按性别与 BMI 抽样 */
function makeBody(sex, age, rnd) {
  const height = Math.round((sex === '男' ? 172 : 160) + (rnd() - 0.5) * 16 - Math.max(0, age - 50) * 0.06);
  const bmi = 19.5 + rnd() * 9;                 // 19.5–28.5
  const weight = Math.round(bmi * (height / 100) * (height / 100));
  return { height, weight };
}

/* 体内是否还有某物质的药效（pk 里 dur 未过） */
const active = (S, id) => !!(S && S.pk && S.pk.some(p => p.id === id));
const activeAny = (S, ids) => ids.some(id => active(S, id));

function vascularTone(S) {
  const limit = 2.5;
  const value = S.svrDrive || 0;
  const controlled = value <= limit;
  const rounded = value.toFixed(2);
  const display = Number(rounded) === limit && value !== limit
    ? (controlled ? '<' : '>') + limit
    : rounded;
  return { value, limit, controlled, text: `血管收缩驱动（模拟值）${display}，目标 ≤${limit}` };
}

/* ---------- 基础健康人 ---------- */
const BASE = {
  vol:4.55, k:4.2, na:140, cl:103, ca:1.18, hco3:24, lac:0.9, glu:5.3,
  cr:78, bun:5.0, hb:132, wbc:7.0, plt:240,
  temp:36.7, gcs:15,
  hr:76, sv:64, svr:16.5, cvp:4,
  rr:14, pao2:94, paco2:39, spo2:98,
  uo:0.9, kProd:0.068, lactProd:0.015, insulinBase:0.9, contractility:0.92,
  ecfVd:12, infection:0, bleedRate:0, opioidTox:false, ketoneProd:0,
  interstitium:11, lungWater:0.12, renalFactor:1, waterClear:1,
  airwayResistance:0.05, acheActivity:1, pvr:1.8, freeWater:0,
};
const PREECLAMPSIA_SVR_DRIVE = 8;

function glucoseGoal(hasDka) {
  const engine = root.LIFE || require('./engine.js');
  return `血糖 ${engine.glucoseDischargeTarget(hasDka)}`;
}

function potassiumGoal() {
  const engine = root.LIFE || require('./engine.js');
  return `血钾维持 ${engine.potassiumTarget}`;
}

/* 多个病种可以对同一读数提出不同要求。保留各自的阈值，并按指标合成一行。 */
function caseMeasureReasons(primary, S) {
  const failures = new Map();
  for (const m of primary) {
    for (const [key, rule] of Object.entries(m.measures || {})) {
      const reading = CASE_MEASURES[key](S, rule);
      if (!reading) continue;
      const { label, value, target } = reading;
      const metric = key === 'urinePerKg' ? 'uo' : key;
      if (!failures.has(metric)) failures.set(metric, { label, values: new Set(), targets: new Map() });
      const row = failures.get(metric);
      row.values.add(value);
      if (!row.targets.has(target)) row.targets.set(target, []);
      row.targets.get(target).push(m.name);
    }
  }
  return [...failures.values()].map(({ label, values, targets }) => {
    const goals = [...targets].map(([target, names]) =>
      targets.size === 1 ? target : `${names.join('、')}要求 ${target}`);
    return `${label} ${[...values].join(' / ')}，出院目标 ${goals.join('；')}`;
  });
}

const CASE_MEASURES = {
  cr: (S, max) => S.cr > max && { label: '肌酐', value: `${Math.round(S.cr)} µmol/L`, target: `≤${max} µmol/L` },
  coag: (S, min) => (S.coag || 1) < min && { label: '凝血功能', value: S.coag.toFixed(2), target: `≥${min.toFixed(2)}` },
  vol: (S, min) => S.vol < min && { label: '有效循环血量', value: `${S.vol.toFixed(1)} L`, target: `≥${min} L` },
  uo: (S, min) => S.uo < min && { label: '尿量', value: `${Math.round(S.uo * 60 * 100) / 100} mL/h`, target: `≥${min * 60} mL/h` },
  urinePerKg(S, min) {
    const rate = S.uo * 60 / (S.weight || 70);
    return rate <= min && { label: '尿量', value: `${rate.toFixed(2)} mL/kg/h`, target: `>${min} mL/kg/h` };
  },
};

/* 病例判据可在保留同一出院理由的同时，标记尚未解除的重大问题。 */
const dischargeReason = reason => reason;

function observeAfter(startTime, duration, reason, check) {
  const observation = S => {
    const start = startTime(S);
    if (start == null) return null;
    const endsAt = start + duration;
    return S.t < endsAt ? { endsAt, reason } : null;
  };
  return { observation, check: (S, issue) => {
    const reasons = check(S, issue);
    const waiting = observation(S);
    if (waiting) reasons.unshift(waiting.reason);
    return reasons;
  } };
}

/* ---------- 病理模块 ---------- */
const MODULES = [
  {
    id:'highK', name:'高钾血症', tag:'highK', weight:3, comorbidities:['慢性肾病'],
    init:{ k:6.8, cr:268, bun:18.2, contractility:0.74, vol:4.25, hco3:14, lac:3.4,
           hr:131, svr:13.6, rr:28, pao2:62, spo2:91, temp:37.8, gcs:13, uo:0.3,
           renalFactor:0.30 },
    drivers:{ kProd:0.16, lactProd:0.02, insulinBase:0.55 },
    history:[
      [2880, '病史回顾', '近两日尿量减少。'],
      [360, '病史回顾', '突发心悸、乏力，逐渐加重。'],
    ],
    get goal() { return [potassiumGoal(), '收缩压维持 ≥90', '避免心脏骤停']; },
    hint:'高钾的心电图改变先于症状。先保护心肌，再想办法把钾挪走。',
  },
  {
    id:'dka', name:'糖尿病酮症酸中毒', tag:'dka', weight:2, comorbidities:['1 型糖尿病'],
    init:{ vol:3.6, k:4.9, na:130, hco3:8, lac:2.6, glu:28.5, cr:156, bun:14.5,
           hr:118, svr:11.4, rr:30, pao2:88, paco2:27, spo2:96, gcs:12, uo:1.6,
           contractility:0.80 },
    drivers:{ kProd:0.072, lactProd:0.03, insulinBase:0.12, ketoneProd:0.25, glucoseIn:0.32 },
    history:[
      [null, '病史回顾', '近期停用胰岛素。', 'medications'],
      [4320, '病史回顾', '开始多饮、多尿。'],
      [1440, '病史回顾', '开始恶心、呕吐。'],
    ],
    get goal() { return [glucoseGoal(true), 'pH 升至 7.30 以上', potassiumGoal()]; },
    hint:'补液是第一位的。胰岛素要小剂量持续，补钾要跟得上。',
    /* 无 advance：酮体生成 → HCO₃ 消耗、渗透性利尿、胰岛素清除酮体，
       全部由引擎的机制方程表达（替代原来只覆盖 hco3Base 的做法） */
  },
  {
    id:'bleed', name:'上消化道大出血', tag:'bleed', weight:3, comorbidities:['消化性溃疡'],
    init:{ vol:3.9, hb:72, bun:24.5, hr:124, svr:9.6, lac:2.9, rr:26,
           pao2:78, paco2:37, spo2:94, gcs:14, uo:0.4, temp:36.6, contractility:0.85 },
    drivers:{ kProd:0.068, bleedRate:0.012 },
    history:[
      [1440, '病史回顾', '发现黑便。'],
      [null, '院前病史', '到院前呕血两次。'],
      [null, '院前病史', '起身时曾晕厥。'],
    ],
    medicationHistory:['长期服用阿司匹林'],
    goal:['收缩压 ≥90 且心率 <120','血红蛋白 ≥80 g/L','止血'],
    check:(S, issue = dischargeReason)=>[
      S.bleedingSites.bleed > 0 ? issue('消化道出血未止') : null,
      S.hb < 80 ? issue(`血红蛋白 ${Math.round(S.hb)}`, S.hb < 60) : null,
    ].filter(Boolean),
    hint:'先补容量再谈输血。升压药不能替代容量。',
    /* 失血只丢全血（容量+红细胞同比例），Hb 由 rbcMass/vol 导出，
       补液后自然稀释——替代原来 S.hb 每拍直接下降 */
  },
  {
    id:'sepsis', name:'感染性休克', tag:'sepsis', weight:2, comorbidities:['肺部感染'],
    init:{ vol:3.7, na:132, hco3:17, lac:5.8, glu:8.2, cr:186, bun:24, hb:108, wbc:19.5, plt:140,
           temp:39.2, hr:128, svr:9.2, rr:28, pao2:68, paco2:30, spo2:91, gcs:12, uo:0.25,
           contractility:0.80 },
    drivers:{ kProd:0.072, lactProd:0.06, insulinBase:0.8, infection:0.78 },
    history:[
      [4320, '病史回顾', '开始发热、咳嗽。'],
      [null, '家属转述', '送医前出现尿量减少、反应变慢。'],
      [null, '院前交接', '转运时皮肤可见花斑。'],
    ],
    goal:['平均动脉压 ≥65','乳酸下降','感染控制'],
    /* 去掉了 temp>38.0（全局出院标准已含 temp ≤37.8），只留感染控制 */
    check:(S, issue = dischargeReason)=> S.infection > 0.25 ? [issue('感染未控制', S.infection > 0.5)] : [],
    hint:'先补液，再上血管活性药；抗生素越早越好。',
  },
  {
    id:'opioid', name:'阿片类药物过量', tag:'opioid', weight:2,
    init:{ vol:4.3, hco3:26, glu:5.4, hb:128, temp:36.2, gcs:5, hr:58, svr:14,
           rr:8, pao2:45, paco2:64, spo2:78, uo:0.5, contractility:0.90 },
    drivers:{ kProd:0.068, lactProd:0.02 },
    preload:[['morphine',12]], opioidTox:true,
    history:[[null, '院前交接', '送医前曾呼之不应，呼吸浅慢，双侧瞳孔明显缩小。']],
    goal:['自主呼吸频率 ≥12','意识恢复','室内空气血氧 ≥94%','完成阿片暴露后的观察'],
    hint:'呼吸抑制是致命的。纳洛酮起效快但半衰期短。',
  },
  {
    id:'edema', name:'急性左心衰 / 肺水肿', tag:'edema', weight:2, comorbidities:['冠心病'],
    init:{ vol:5.1, hco3:22, lac:2.4, cr:120, hb:118, temp:36.6, gcs:13,
           hr:118, svr:22, rr:32, pao2:54, paco2:33, spo2:86, uo:0.35, contractility:0.50,
           lungWater:0.55, svrDrive:7.5, interstitium:12.2 },
    drivers:{ kProd:0.068, lactProd:0.03 },
    history:[[null, '院前病史', '到院前突发气促，平卧时加重，曾咳粉红色泡沫痰。']],
    medicalHistory:['高血压'],
    goal:['血氧 ≥94%','呼吸频率 ≤20','肺部湿啰音减轻'],
    /* spo2/rr 已由全局判据覆盖，这里只留"肺水"这一疾病特异证据 */
    check:S=>[ (S.lungWater||0) > 0.45 ? '肺部淤血仍需复查，建议双肺听诊' : null ].filter(Boolean),
    hint:'坐位、吸氧、利尿、扩血管。看血压决定用不用强心。',
    /* 神经体液血管收缩驱动：替代原来"只能靠 init.svr 一次性设定、随即被压力反射拉回"
       的写法。扩血管药（硝酸甘油/硝普钠/米力农）直接削减这个驱动 → 后负荷下降 →
       衰竭心肌每搏量上升（engine 的 afterloadF）→ CO 上升 → 心率回落。 */
    advance(S, dtMin) {
      const vaso = (active(S,'nitroglycerin') ? 0.55 : 0)
                 + (active(S,'nitroprusside') ? 0.95 : 0)
                 + (active(S,'hydralazine') ? 0.40 : 0)
                 + (active(S,'captopril') ? 0.25 : 0)
                 + (active(S,'milrinone') ? 0.45 : 0);
      S.svrDrive = clamp((S.svrDrive == null ? 7.5 : S.svrDrive) + (0.02 - vaso) * dtMin, 0, 13);
    },
  },
  {
    id:'thyroid', name:'甲状腺危象', tag:'thyroid', weight:1,
    init:{ vol:4.4, hco3:21, lac:2.2, glu:7.0, temp:39.8, gcs:12,
           hr:148, svr:12.5, rr:26, pao2:82, paco2:32, spo2:95, uo:1.2, contractility:0.90,
           thyroidHeatDrive:0.70, hrDrive:55 },
    drivers:{ kProd:0.072, lactProd:0.04 },
    history:[[2880, '病史回顾', '开始发热、心悸，伴烦躁。']],
    medicalHistory:['甲状腺功能亢进'],
    medicationHistory:['近期停用抗甲状腺药'],
    goal:['心率 <120','体温 ≤ 37.8','意识恢复'],
    /* temp 已由全局判据覆盖；用"甲状腺毒症控制度"替代原来的体温重复判据 */
    check:S=>[ (S.thyroidHeatDrive ?? 0.70) > 0.26 ? '甲状腺毒症尚未控制' : null ].filter(Boolean),
    hint:'β 阻滞剂压心率，抗甲状腺药阻断合成，激素抑制转化。',
    advance(S, dtMin) {
      const therapy = S.thyroidTherapyActivity || {};
      const beta = therapy.propranolol || 0;
      const treatment = 0.045 * (therapy.propylthiouracil || 0)
                      + 0.030 * (therapy.methimazole || 0)
                      + 0.020 * (therapy.hydrocortisone || 0)
                      + 0.015 * (therapy.dexamethasone || 0)
                      + 0.012 * beta;
      S.thyroidHeatDrive = clamp((S.thyroidHeatDrive ?? 0.70) + (0.0012 - treatment) * dtMin, 0, 1.5);
      S.hrDrive = clamp((S.hrDrive ?? 55) + (0.010 - 0.060 * beta) * dtMin, 0, 90);
    },
  },
  {
    id:'hypogly', name:'严重低血糖', tag:'hypogly', weight:2,
    init:{ vol:4.4, glu:2.1, hco3:23, temp:36.3, gcs:6,
           hr:104, svr:15, rr:16, pao2:90, spo2:97, uo:0.8,
           insulinLoad:6.0 },
    drivers:{ kProd:0.068, lactProd:0.02 },
    history:[
      [null, '院前病史', '注射胰岛素后未进食。', 'medications'],
      [null, '家属转述', '到院前出现大汗、反应变差。'],
    ],
    medicalHistory:['糖尿病'],
    goal:['血糖升至 4 以上','意识恢复'],
    /* glu 已由全局判据覆盖 */
    hint:'先推高浓度葡萄糖，再找原因。磺脲类过量要持续输注。',
    /* 不再硬把 glu 封在 2.8、gcs 封在 7：引擎用"胰岛素负荷高 → 摄取↑、肝糖输出被压制"
       的自然方程推进；低血糖损伤按剂量×时间积分判死（替代原来的 45 min 计时器） */
    advance(S, dtMin, E) {
      const sugar = activeAny(S, ['dextrose50','dextrose10','glucagon']);
      if (sugar) S.insulinLoad = Math.max(0, (S.insulinLoad || 0) - 0.12 * dtMin);
    },
  },

  /* ======================= 六个"改体征 → 改负荷"的模块 ======================= */

  /* 1) 急性哮喘 / COPD 加重：
     替代原来的 "spo2Cap / rrFloor 直接封顶" —— 现在只设气道阻力，
     低氧由 肺泡通气方程 + Hill + 分流 自然算出来 */
  {
    id:'asthma', name:'急性哮喘 / COPD 加重', tag:'asthma', weight:2,
    init:{ vol:4.35, k:4.0, na:139, hco3:26, lac:2.6, glu:7.1, cr:88, bun:5.6,
           hb:136, wbc:10.8, plt:250, temp:37.1, gcs:14,
           hr:124, svr:17.6, rr:32, pao2:56, paco2:38, spo2:86, uo:0.8,
           contractility:0.90,
           airwayResistance:0.85, vdvt:0.67 },
    drivers:{ kProd:0.068, lactProd:0.03 },
    history:[[360, '病史回顾', '开始喘鸣、胸闷，逐渐加重，发作时连贯说话困难。']],
    medicalHistory:['哮喘'],
    medicationHistory:['近两日停用吸入剂'],
    goal:['血氧 ≥94%','呼吸频率 ≤22','哮鸣音明显缓解'],
    /* spo2/rr 由全局判据覆盖，只留气道痉挛这一特异判据 */
    check(S) {
      const obstruction = S.asthmaResistance ?? S.airwayResistance ?? 0;
      return obstruction > 0.30 ? [`气道痉挛尚未缓解（${Math.round(obstruction * 100)}%）`] : [];
    },
    hint:'支气管痉挛要靠解痉药打开，吸氧只能买时间。激素要早给。',
    advance(S, dtMin, E) {
      const beta = activeAny(S, ['salbutamol','salmeterol','epi','isoproterenol','theophylline']);
      const betaEffect = beta ? 1 : Math.min(1, E.pumpEffect(S, 'isoproterenol'));
      const anti = active(S,'ipratropium');
      const steroid = activeAny(S, ['hydrocortisone','dexamethasone']);
      let rate = 0.004;                 // 未处理：气道痉挛持续加重
      rate -= 0.055 * betaEffect;      // β₂ 激动剂：解痉主力
      if (anti) rate -= 0.012;          // 抗胆碱能：协同
      if (steroid) rate -= 0.010;       // 激素：压基础炎症张力
      const field = S.burnAirwayResistance == null ? 'airwayResistance' : 'asthmaResistance';
      S[field] = clamp((S[field] ?? 0.85) + rate * dtMin, 0.02, 1);
      S.obstruct = S[field];  // 兼容 mentor.js / check() 的旧字段名
      /* 气道阻力 → 死腔↑（V/Q 失调）+ 分流↑（替代原来的 spo2 上限钳制） */
      S.vdvt = clamp(0.33 + 0.40 * S[field], 0.33, 0.75);
      S.shuntSrc.airway = clamp(0.32 * S[field], 0, 0.32);
    },
  },

  /* 2) 有机磷中毒：
     替代原来的 "hrCap / spo2Cap / rrFloor 三个封顶" —— 现在只设胆碱酯酶活性，
     乙酰胆碱堆积 → 心动过缓/分泌物/支气管痉挛由引擎从 acheActivity 算 */
  {
    id:'organophosphate', name:'有机磷中毒', tag:'op', weight:2,
    init:{ vol:4.35, k:4.1, na:136, hco3:22, lac:3.2, glu:6.8, cr:92, bun:6.0,
           hb:134, wbc:9.0, plt:230, temp:36.9, gcs:12,
           hr:48, svr:24.0, rr:24, pao2:58, paco2:44, spo2:85, uo:0.55,
           contractility:0.85, acheActivity:0.12, muscarinicBlock:0 },
    drivers:{ kProd:0.068, lactProd:0.035 },
    history:[
      [null, '现场人员转述', '发病前曾喷洒农药。', 'medications'],
      [null, '现场人员转述', '喷洒农药约两小时后出现大汗、流涎和呕吐。'],
      [null, '院前交接', '转运时可见分泌物增多、双侧瞳孔明显缩小。'],
    ],
    goal:['心率 ≥60','血氧 ≥94%','毒蕈碱样症状缓解'], minDischargeHR:60,
    check:S=>[ (1-(S.acheActivity==null?1:S.acheActivity))>0.25 ? '胆碱酯酶仍被抑制、分泌物多' : null ].filter(Boolean),
    hint:'阿托品对抗毒蕈碱样症状，碘解磷定复活胆碱酯酶。先给氧再解毒。',
    advance(S, dtMin, E) {
      const pra = active(S,'pralidoxime');
      const atro = active(S,'atropine');
      /* 胆碱酯酶活性：老化（不可逆）继续下降，解磷定复活；>6 h 后老化使复活效率大减 */
      const aging = S.t > 6 * 3600 ? 0.20 : 1;
      let react = (pra ? 0.030 * aging : 0) - 0.0016;
      S.acheActivity = clamp((S.acheActivity == null ? 0.12 : S.acheActivity) + react * dtMin, 0, 0.95);
      S.opTox = 1 - S.acheActivity;      // 兼容 mentor.js / check() 的旧字段名
      /* 阿托品只是阻断毒蕈碱受体，不恢复酶活性 */
      S.muscarinicBlock = clamp((S.muscarinicBlock || 0) + ((atro ? 0.22 : -0.020)) * dtMin, 0, 1);
      /* 堆积的 ACh 多少能作用到受体：由引擎换算成心率/分泌物/气道阻力 */
      S.cholinergic = clamp((1 - S.acheActivity) * (1 - S.muscarinicBlock), 0, 1);
      S.shuntSrc.op = clamp(0.30 * S.cholinergic, 0, 0.30);
    },
  },

  /* 3) 对乙酰氨基酚过量：
     替代原来的 "apapDamage 线性累积 + 直接写 cr/bun/coag" —— 现在只设 NAPQI 与 GSH
     的竞争消耗，肝损伤由 GSH 耗竭程度决定，肝肾/凝血/乳酸由引擎按肝损伤程度算 */
  {
    id:'apap', name:'对乙酰氨基酚过量', tag:'apap', weight:1,
    init:{ vol:4.45, k:4.0, na:140, hco3:24, lac:1.2, glu:5.6, cr:82, bun:5.0,
           hb:138, wbc:7.4, plt:245, temp:36.6, gcs:15,
           hr:82, svr:16.5, rr:15, pao2:95, paco2:39, spo2:98, uo:0.9,
           contractility:0.92, apapLoad:1.0, gsh:0.30, napqi:0.10, hepatotox:0 },
    drivers:{ kProd:0.068, lactProd:0.015 },
    history:[
      [240, '院前病史', '吞服约 20 片对乙酰氨基酚。', 'medications'],
      [null, '院前病史', '服药后出现恶心。'],
    ],
    goal:['尽早使用解毒剂','观察 2 小时无肝损证据','肌酐与乳酸正常'],
    measures: { cr: 130, coag: 0.60 },
    ...observeAfter(() => 0, 2 * 3600, '对乙酰氨基酚中毒需观察 2 小时（肝损窗口）', S => [
               S.lac>3.0 ? `乳酸 ${S.lac.toFixed(1)} mmol/L` : null ].filter(Boolean)),
    hint:'早期没有症状不等于安全。N-乙酰半胱氨酸越早给越有效，8 小时后疗效明显下降。',
    advance(S, dtMin, E) {
      const nac = active(S,'nacetylcysteine');
      /* NAPQI 生成（CYP 2E1）→ 与 GSH 结合解毒；GSH 耗竭后与肝细胞蛋白共价结合 */
      const form = 0.016 * (S.apapLoad == null ? 1 : S.apapLoad);
      const conj = 1.8 * (S.gsh || 0) * (S.napqi || 0) + (nac ? 0.8 : 0) * (S.napqi || 0);
      const hydr = 0.04 * (S.napqi || 0);
      S.napqi = clamp((S.napqi || 0) + (form - conj - hydr) * dtMin, 0, 3);
      const gshSyn = 0.0035 + (nac ? 0.020 : 0);         // NAC 是 GSH 前体
      S.gsh = clamp((S.gsh || 0) + (gshSyn - 2.4 * (S.gsh || 0) * (S.napqi || 0)) * dtMin, 0, 1.2);
      /* 只有 GSH 明显耗竭（<0.25）时 NAPQI 才造成肝细胞坏死 */
      const bind = 0.055 * (S.napqi || 0) * ((S.gsh || 0) < 0.25 ? (1 - (S.gsh || 0) / 0.25) : 0);
      S.hepatotox = clamp((S.hepatotox || 0) + bind * dtMin, 0, 1);
      S.apapDamage = S.hepatotox;   // 兼容旧字段名
    },
  },

  /* 4) 高血压急症：
     替代原来的 "svrFloor / hrFloor 直接钳制 S.svr、S.hr" —— 现在直接给
     血管张力驱动 S.svrDrive（引擎把它加进 SVR 目标），压力反射仍会与之对抗 */
  {
    id:'htnEmergency', name:'高血压急症', tag:'htn', weight:2,
    init:{ vol:4.6, k:3.7, na:141, hco3:24, lac:1.6, glu:6.2, cr:118, bun:7.2,
           hb:142, wbc:8.2, plt:250, temp:36.8, gcs:12,
           hr:104, svr:19.0, rr:18, pao2:90, paco2:38, spo2:96, uo:0.7,
           contractility:1.02, htn:1, svrDrive:7.0 },
    drivers:{ kProd:0.068, lactProd:0.02 },
    history:[
      [180, '病史回顾', '出现剧烈头痛、视物模糊和呕吐。'],
      [null, '病史回顾', '随后反应变慢。'],
    ],
    medicalHistory:['高血压'],
    medicationHistory:['一周前停用降压药'],
    goal:['收缩压降至 160 以下','意识恢复','避免脑出血'],
    /* sys>160 是上限（全局只有 sys≥90 的下限）；gcs 由全局覆盖 */
    check(S) {
      const tone = vascularTone(S);
      return [
        (S._sys || 0) > 160 ? `收缩压 ${Math.round(S._sys)} mmHg` : null,
        tone.controlled ? null : tone.text,
      ].filter(Boolean);
    },
    hint:'高血压急症要平稳降压。可持续静脉泵入尼卡地平，根据血压和心率调速。',
    advance(S, dtMin, E) {
      const potency = 0.12 * (E?.pumpEffect?.(S, 'nicardipine') || 0)
                    + (active(S,'nitroprusside') ? 0.95 : 0)
                    + (active(S,'labetalol') ? 0.35 : 0)
                    + (active(S,'nitroglycerin') ? 0.25 : 0)
                    + (active(S,'nifedipine') ? 0.18 : 0)
                    + (active(S,'hydralazine') ? 0.35 : 0)
                    + (active(S,'captopril') ? 0.15 : 0)
                    + (active(S,'enalapril') ? 0.15 : 0);
      S.svrDrive = clamp((S.svrDrive == null ? 7 : S.svrDrive) + (0.020 - potency) * dtMin, 0, 13);
      S.htn = clamp(S.svrDrive / 7, 0, 1.2);   // 兼容旧字段名
      const b = E && E.bp ? E.bp(S) : { sys: 0, dia: 0, map: 0 };
      S._sys = b.sys; S._dia = b.dia; S._map = b.map;   // 供 check() 读取
    },
  },

  /* 5) 严重低钠血症：
     替代原来的 "S.gcs = 封顶" —— 现在只设钠质量/游离水，脑水肿由引擎按
     "绝对低渗 + dNa/dt" 推进（dICP/dt ∝ dNa/dt） */
  {
    id:'hyponatremia', name:'严重低钠血症', tag:'hypona', weight:1,
    init:{ vol:4.7, k:4.3, na:122, hco3:23, lac:1.3, glu:5.4, cr:74, bun:3.8,
           hb:128, wbc:6.8, plt:240, temp:36.4, gcs:10,
           hr:86, svr:15.8, rr:18, pao2:92, paco2:40, spo2:96, uo:0.9,
           contractility:0.90, freeWater:0, waterClear:0.02, freeWaterRate:0.0008,
           icp:0.30 },
    drivers:{ kProd:0.068, lactProd:0.02 },
    history:[
      [2880, '病史回顾', '出现乏力、嗜睡。'],
      [null, '病史回顾', '近期饮水增多。'],
      [null, '院前病史', '送医前呕吐，随后反应明显变差。'],
    ],
    medicationHistory:['长期服用氢氯噻嗪'],
    goal:['血钠逐步恢复至 130–145 mmol/L','意识恢复','避免血钠纠正过快'],
    check:S=> S.hyponatremiaCauseControlled ? [] : ['需停止噻嗪并限制饮水'],
    hint:'低钠性脑病先用 3% 高渗盐水把血钠抬 4–6 mmol/L，再慢慢纠。抬得太快会脱髓鞘。',
    advance(S, dtMin, E) {
      /* SIADH 样持续游离水潴留（水多了 → 钠被稀释），钠由引擎 na = naMass/(ecfVd+freeWater) 导出 */
      S.freeWaterRate = S.hyponatremiaCauseControlled ? S.uo * 0.00035 : 0.0008;
      S.waterClear = 0.02;                 // 抗利尿 → 几乎不排自由水
    },
  },

  /* 6) 急性肺栓塞：
     替代原来的 "spo2Cap / svrCap / rrFloor" —— 现在只设肺血管阻力（由血栓负荷换算），
     右心后负荷 → 每搏量下降由引擎的 Frank-Starling + rvF 表达 */
  {
    id:'pe', name:'急性肺栓塞', tag:'pe', weight:2,
    init:{ vol:4.3, k:4.2, na:137, hco3:21, lac:3.6, glu:7.4, cr:96, bun:6.4,
           hb:131, wbc:11.0, plt:220, temp:36.7, gcs:13,
           hr:132, svr:15.0, rr:30, pao2:54, paco2:30, spo2:86, uo:0.5,
           contractility:0.85, clot:0.90, pvr:10.35, vdvt:0.65 },
    drivers:{ kProd:0.068, lactProd:0.045 },
    history:[
      [null, '病史回顾', '近期曾长时间久坐。'],
      [null, '院前病史', '到院前突发胸痛、呼吸困难，曾晕倒。'],
      [null, '院前交接', '急救人员发现右下肢肿胀。'],
    ],
    goal:['血氧 ≥94%','收缩压 ≥90','右心负荷减轻'],
    /* 血氧与心率由通用出院判据覆盖。 */
    check:S=>[ (S.clot||0)>0.25 ? '右心负荷仍未减轻（血栓未清除）' : null ].filter(Boolean),
    hint:'大面积肺栓塞先给氧、抗凝，血流动力学不稳时溶栓。补液要小心，右心已经撑不住了。',
    advance(S, dtMin, E) {
      const lysis = active(S,'alteplase') ? 0.050 : 0;
      const hep = active(S,'heparin') ? 0.012 : 0;
      S.clot = clamp((S.clot == null ? 0.90 : S.clot) + (0.003 - lysis - hep) * dtMin, 0, 1);
      /* 血栓负荷 → 肺血管阻力（替代原来的 svr 上限钳制） */
      S.pvr = 1.8 + 9.5 * S.clot;
      S.shuntSrc.clot = clamp(0.28 * S.clot, 0, 0.28);
      S.vdvt = clamp(0.33 + 0.35 * S.clot, 0.33, 0.68);   // 死腔↑ → 通气效率下降
    },
  },

  {
    id:'ptx', name:'张力性气胸', tag:'ptx', weight:2, comorbidities:['胸部外伤'],
    init:{ vol:4.30, k:4.0, na:138, hco3:23, lac:3.6, glu:7.4, cr:92, bun:5.2,
           hb:128, wbc:11.0, plt:230, temp:36.9, gcs:12,
           hr:138, sv:40, svr:19, rr:36, pao2:48, paco2:30, spo2:78,
           contractility:0.88, tensionPTX:0.85, pvr:7.5 },
    drivers:{ kProd:0.011, lactProd:0.035 },
    history:[
      [null, '院前病史', '受伤后出现左胸剧痛。'],
      [null, '院前交接', '转运时见患者明显气促，左侧呼吸音减弱。'],
    ],
    goal:['血氧 ≥ 94%','收缩压 ≥ 90','呼吸频率 ≤ 22'],
    check:(S, issue = dischargeReason)=>[
      S.tensionPTX > 0.20 ? issue(`胸腔内压仍高（${Math.round(S.tensionPTX*100)}%）`) : null,
      S.tensionPTX > 0 && !S.chestTubePlaced ? issue('仍需胸腔闭式引流') : null,
    ].filter(Boolean),
    hint:'张力性气胸是梗阻性休克：回心血量被压住，给升压药没用，必须先针刺减压。',
    advance(S, dtMin){
      const prev = S.tensionPTX == null ? 0 : S.tensionPTX;
      S.tensionPTX = S.chestTubePlaced ? 0 : Math.min(1, prev + 0.0018 * dtMin);
      /* 胸腔内压 → 肺血管阻力：减压后必须回落，否则右心后负荷永远高，血压升不上来 */
      S.pvr = 1.8 + 6.0 * S.tensionPTX;

      /* 复张性肺水肿：塌陷时间长 + 单次减压幅度大 → 肺毛细血管通透性骤增
         （真实多见于塌陷 > 数小时或快速大量引流；这里用 20 分钟 + 一次降 0.4 以上近似） */
      if (prev > 0.45) S._collapseSince = S._collapseSince || S.t;
      const dropped = prev - S.tensionPTX;
      if (dropped > 0) S._reDrop = (S._reDrop || 0) + dropped;
      if (S._collapseSince && S.t - S._collapseSince > 5400 && (S._reDrop || 0) > 0.35 && S.reExpand == null) {
        S.reExpand = 1;                       // 进入易感状态
        S.log.push(['体征', '肺复张后出现湿啰音——警惕复张性肺水肿', 'warn']);
      }
      if ((S.reExpand || 0) > 0) {
        S.lungWater = Math.min(1.6, (S.lungWater || 0.12) + 0.0022 * dtMin);
        const sh = S.shuntSrc = S.shuntSrc || { airway: 0, clot: 0, edema: 0, op: 0 };
        sh.edema = Math.min(0.30, (sh.edema || 0) + 0.00004 * dtMin);
      }
    },
  },
  {
    id:'trauma', name:'多发伤 / 失血性休克', tag:'trauma', weight:2, comorbidities:['骨盆骨折'],
    init:{ vol:3.20, k:4.6, na:136, hco3:19, lac:4.8, glu:9.5, cr:118, bun:7.5,
           hb:78, wbc:13.0, plt:150, temp:35.9, gcs:13,
           hr:142, sv:44, svr:15, rr:31, pao2:86, paco2:32, spo2:94,
           contractility:0.86, bleedRate:0.055, bleedPressDep:1, externalBleed:true, coag:0.85 },
    drivers:{ kProd:0.011, lactProd:0.05 },
    history:[[null, '院前交接', '右大腿开放性伤口、明显畸形及活动性出血，四肢湿冷。']],
    goal:['收缩压 ≥ 90','血红蛋白 ≥ 80','出血控制'],
    check:(S, issue = dischargeReason)=>[
      S.bleedingSites.trauma > 0 ? issue('创伤出血未控制') : null,
      S.hb < 80 ? issue(`血红蛋白 ${Math.round(S.hb)}`, S.hb < 60) : null,
    ].filter(Boolean),
    hint:'先压迫止血，同时补容量；升压药不能替代容量，也不能替代止血。',
  },

  {
    id:'pancreatitis', name:'急性胰腺炎', tag:'pancreatitis', weight:2, comorbidities:['胆石症'],
    init:{ vol:3.15, k:3.6, na:132, hco3:20, lac:4.2, glu:9.0, cr:130, bun:9.0,
           hb:140, wbc:15.5, plt:210, temp:38.6, gcs:14,
           hr:124, sv:54, svr:11.5, rr:26, pao2:82, paco2:32, spo2:94, uo:0.4,
           contractility:0.88, ca:1.05 },
    drivers:{ kProd:0.010, lactProd:0.055 },
    history:[[480, '病史回顾', '出现上腹剧痛并向背部放射，伴频繁呕吐，弯腰时疼痛稍缓。']],
    goal:['平均动脉压 ≥ 65','尿量 ≥ 30 mL/h','疼痛缓解'],
    measures: { vol: 3.9, uo: 0.5 },
    hint:'胰腺炎的头 24 小时死于第三间隙丢失，不是死于疼痛——先补液，再谈镇痛。',
    advance(S, dtMin){
      /* 炎症导致毛细血管渗漏：液体持续进入第三间隙，不补就低容量 */
      S.vol = Math.max(2.2, S.vol - 0.0045 * dtMin);
      S.interstitium = Math.min(24, (S.interstitium || 11) + 0.0032 * dtMin * 0.7);
      S.lactProd = 0.070;
      /* 第三间隙丢失到一定程度即为失代偿性低容量：直接累积休克损伤 */
      /* 重症胰腺炎的两个标志性机制：低钙（脂肪皂化）与早期 ARDS */
      S.ca = Math.max(0.75, (S.ca == null ? 1.05 : S.ca) - 0.00004 * dtMin);
      S.lungWater = Math.min(1.5, (S.lungWater || 0.12) + 0.0006 * dtMin);
      S.contractility = Math.max(0.55, (S.contractility || 0.88) - 0.00002 * dtMin);
    },
  },
  {
    id:'hhs', name:'高渗高血糖状态', tag:'hhs', weight:1, comorbidities:['2 型糖尿病'],
    init:{ vol:2.95, k:4.6, na:155, hco3:22, lac:2.2, glu:42.0, cr:158, bun:20.0,
           hb:145, wbc:9.5, plt:250, temp:36.6, gcs:11,
           hr:108, sv:58, svr:14, rr:22, pao2:92, paco2:38, spo2:97, uo:1.2,
           contractility:0.90, insulinBase:0.55 },
    drivers:{ kProd:0.011, lactProd:0.02 },
    history:[
      [null, '家属转述', '近几天饮水少。'],
      [null, '家属转述', '逐渐出现乏力、嗜睡，送医前反应明显变差。'],
    ],
    get goal() {
      return [glucoseGoal(false), '血钠 ≤145 mmol/L', '血清渗透压 <300 mOsm/kg', '尿量 >0.5 mL/kg/h', '意识恢复'];
    },
    measures: { urinePerKg: 0.5 },
    check(S) {
      const osmolality = 2 * S.na + S.glu + S.bun;
      return osmolality >= 300 ? [`血清渗透压 ${osmolality.toFixed(1)} mOsm/kg`] : [];
    },
    hint:'高渗状态先补液：血糖降太快会导致脑水肿，血钠也要慢慢降。',
    advance(S) {
      S.glucoseIn = 0.05;
      /* 意识与容量恢复后可恢复饮水，补足后续尿液自由水丢失。 */
      S.freeWaterRate = S.gcs >= 13 && S.vol >= 4.2 ? S.uo * 0.00035 : 0;
    },
  },
  {
    id:'co', name:'一氧化碳中毒', tag:'co', weight:1,
    init:{ vol:4.40, k:4.1, na:139, hco3:22, lac:3.4, glu:5.6, cr:88, bun:5.0,
           hb:140, wbc:8.0, plt:240, temp:36.5, gcs:12,
           hr:112, sv:62, svr:15, rr:20, pao2:95, paco2:36, spo2:98, uo:0.9,
           contractility:0.90, coHb:0.55 },
    drivers:{ kProd:0.010, lactProd:0.03 },
    history:[
      [null, '现场人员转述', '在通风不良的房间使用燃气热水器。', 'medications'],
      [null, '现场人员转述', '离开现场前，患者反应变慢。'],
    ],
    goal:['意识恢复','血氧饱和度与氧输送改善'],
    check:(S, issue = dischargeReason)=> S.coHb > 0.10 ?
      [issue(`碳氧血红蛋白 ${Math.round(S.coHb*100)}%`, S.coHb > 0.15)] : [],
    hint:'脉搏血氧仪会骗人——SpO₂ 看着正常，但携氧的血红蛋白被一氧化碳占住了。高流量氧是解药。',
  },

  {
    id:'aki', name:'急性肾损伤 / 尿毒症', tag:'aki', weight:2, comorbidities:['慢性肾病'],
    init:{ vol:4.55, k:6.15, na:130, hco3:13, lac:2.8, glu:7.2, cr:680, bun:42,
           hb:108, wbc:9.0, plt:180, temp:36.4, gcs:13,
           hr:98, sv:60, svr:20, rr:26, pao2:86, paco2:30, spo2:94, uo:0.15,
           contractility:0.86, renalFactor:0.08 },
    drivers:{ kProd:0.075, lactProd:0.03 },
    history:[[4320, '病史回顾', '开始恶心、呕吐，尿量明显减少，并出现眼睑及下肢水肿。']],
    get goal() { return [potassiumGoal(), '肌酐 ≤400 µmol/L 且趋势稳定', '持续恢复自身尿量，透析结束后复评']; },
    measures: { cr: 400 },
    hint:'先处理高钾和酸中毒，必要时安排血液透析。复评自身尿量与肌酐趋势，留意利尿药对尿量读数的影响。',
  },

  {
    id:'tamponade', name:'急性心包填塞', tag:'tamponade', weight:1, comorbidities:['胸部外伤'],
    init:{ vol:4.20, k:4.2, na:138, hco3:22, lac:3.2, glu:7.8, cr:96, bun:5.4,
           hb:118, wbc:11.0, plt:210, temp:36.6, gcs:13,
           hr:132, sv:44, svr:19, rr:28, pao2:84, paco2:32, spo2:93, uo:0.5,
           contractility:0.90, tamponade:0.80 },
    drivers:{ kProd:0.011, lactProd:0.04 },
    history:[[null, '院前交接', '急救人员到场时见患者烦躁、颈静脉怒张，心音低弱。']],
    goal:['收缩压 ≥ 90','心率 < 120','意识恢复'],
    check:(S, issue = dischargeReason)=> S.tamponade > 0.15 ?
      [issue(`心包内压仍高（${Math.round(S.tamponade*100)}%）`, S.tamponade > 0.25)] : [],
    hint:'三联征（低血压 + 颈静脉怒张 + 心音遥远）提示心包填塞：穿刺抽液，补液只是争取时间。',
    advance(S, dtMin){
      /* 凝血性心包积血会持续再填塞：约 1.5 h 回到压塞水平，除非留置引流 */
      if (!S.pericDrain) S.tamponade = Math.min(1, (S.tamponade == null ? 0 : S.tamponade) + 0.010 * dtMin);
      else S.tamponade = Math.max(0.05, (S.tamponade || 0) - 0.02 * dtMin);
    },
  },
  {
    id:'heatstroke', name:'热射病', tag:'heatstroke', weight:1,
    init:{ vol:3.85, k:4.4, na:146, hco3:19, lac:5.2, glu:7.5, cr:150, bun:9.5,
           hb:132, wbc:14.0, plt:190, temp:41.2, gcs:10,
           hr:138, sv:56, svr:9.5, rr:30, pao2:82, paco2:28, spo2:93, uo:0.4,
           contractility:0.84, heatstrokeDrive:1.30 },
    drivers:{ kProd:0.016, lactProd:0.08 },
    history:[
      [null, '现场人员转述', '晕倒前在高温环境中持续暴露约四小时。', 'medications'],
      [null, '现场人员转述', '现场有人目击患者晕倒。'],
    ],
    goal:['核心体温 ≤ 37.8','收缩压 ≥ 90','意识恢复'],
    hint:'热射病需尽快散热。在「环境 / 场景」开启物理降温，同时补液并监测血压。',
    advance(S, dtMin){
      const recovering = S.heatstrokeCooled && !S.env?.heat;
      const cooling = S.env?.cooling ? 0.05 : (recovering ? 0.04 : 0);
      if (cooling > 0) {
        S.heatstrokeDrive = Math.max(0, (S.heatstrokeDrive ?? 1.30) - cooling * dtMin);
      }
      /* 横纹肌溶解 → 高钾 + 凝血障碍（热射病的真实并发症） */
      if (S.temp > 40) { S.kProd = 0.020; S.coag = Math.max(0.35, (S.coag || 1) - 0.0015 * dtMin); }
      S.lactProd = 0.08;
    },
  },

  {
    id:'myxedema', name:'甲减危象', tag:'myxedema', weight:1, comorbidities:['甲状腺功能减退'],
    init:{ vol:4.20, k:3.9, na:128, hco3:22, lac:2.4, glu:3.6, cr:125, bun:8.5,
           hb:112, wbc:7.0, plt:180, temp:34.2, gcs:9,
           hr:46, sv:58, svr:21, rr:10, pao2:76, paco2:54, spo2:88, uo:0.6,
           contractility:0.76, myxedemaSeverity:1 },
    drivers:{ kProd:0.010, lactProd:0.03 },
    history:[[null, '院前交接', '被发现反应迟钝，伴面部浮肿、皮肤干冷。']],
    medicationHistory:['两个月前停用甲状腺激素替代药'],
    goal:['体温 ≥ 36.0','心率 ≥ 55','意识恢复'], minDischargeHR:55,
    check:S=>[ (S.myxedemaSeverity ?? 1) > 0.35 ? '甲状腺激素替代治疗尚未充分生效' : null ].filter(Boolean),
    hint:'左甲状腺素 + 氢化可的松，同时在「环境 / 场景」开启被动保暖，避免大剂量升压药。',
    advance(S, dtMin){
      const replacement = clamp(S.thyroidReplacement || 0, 0, 1);
      S.myxedemaSeverity = clamp((S.myxedemaSeverity ?? 1) + (0.001 - 0.018 * replacement) * dtMin, 0, 1);
    },
  },
  {
    id:'liverFailure', name:'急性肝衰竭', tag:'liver', weight:1, comorbidities:['慢性乙肝'],
    init:{ vol:4.60, k:4.1, na:132, hco3:20, lac:3.4, glu:3.2, cr:110, bun:8.0,
           hb:112, wbc:9.0, plt:95, temp:37.6, gcs:10,
           hr:104, sv:60, svr:12.5, rr:20, pao2:88, paco2:32, spo2:96, uo:0.5,
           contractility:0.88, hepatotox:0.85, coag:0.55 },
    drivers:{ kProd:0.012, lactProd:0.05 },
    history:[
      [10080, '家属转述', '近一周皮肤黄染加深。'],
      [null, '家属转述', '随后逐渐出现白天嗜睡、夜间烦躁。'],
    ],
    goal:['意识恢复','凝血功能改善','乳酸下降'],
    measures: { coag: 0.70 },
    hint:'肝性脑病是"氨"的问题：乳果糖降氨，同时处理诱因（感染、出血、低钾）。别用镇静药。',
    advance(S, dtMin){
      /* 肝细胞坏死继续、凝血因子合成下降；乳果糖降氨可减缓损伤 */
      const lact = (S.given || []).some(g => g && g.id === 'lactulose' && (S.t - g.t) < 21600);
      const rate = lact ? -0.0035 : 0.0012;
      S.hepatotox = Math.max(0.25, Math.min(1, (S.hepatotox == null ? 0.85 : S.hepatotox) + rate * dtMin));
      /* 凝血因子由肝细胞合成：随肝损程度而定，肝损好转则回升 */
      S.coag = Math.max(0.15, 1 - 0.75 * S.hepatotox);
      S.insult.hyperosmol = 0;   // 非高渗
      /* 肝衰竭的死亡交给引擎的肝衰竭通路（hepatotox + coag），不额外注入颅压 */
    },
  },

  {
    id:'tca', name:'三环类抗抑郁药过量', tag:'tca', weight:1, comorbidities:['抑郁症'],
    init:{ vol:4.35, k:4.2, na:138, hco3:20, lac:2.6, glu:6.4, cr:92, bun:5.2,
           hb:132, wbc:8.5, plt:230, temp:36.8, gcs:10,
           hr:132, sv:52, svr:11.5, rr:22, pao2:88, paco2:36, spo2:95, uo:0.7,
           contractility:0.86, tca:0.78 },
    drivers:{ kProd:0.010, lactProd:0.035 },
    history:[
      [null, '院前病史', '吞服约 20 片阿米替林。', 'medications'],
      [null, '院前病史', '服药约两小时后被发现反应迟钝。'],
      [null, '患者自述', '服药后口干。'],
    ],
    goal:['QRS 变窄','意识恢复','心率 < 120'],
    check:(S, issue = dischargeReason)=> S.tca > 0.25 ? [issue('三环类毒性仍高（QRS 增宽）', S.tca > 0.55)] : [],
    hint:'三环类过量的解药不是"洗胃"，而是碳酸氢钠——碱化血液能窄化 QRS、止住室性心律失常。',
    advance(S, dtMin){
      S.tca = Math.max(0, (S.tca == null ? 0.78 : S.tca) - 0.0006 * dtMin);   // 自身清除极慢
      S.qrsWide = Math.max(S.qrsWide || 0, S.tca);
      if (S.tca > 0.55) S._vfRisk = (S._vfRisk || 0) + 0.030 * dtMin;   // 三环类：QRS 增宽 → 室性心律失常
    },
  },

  {
    id:'tbi', name:'颅脑外伤 / 硬膜外血肿', tag:'tbi', weight:2, comorbidities:['头部外伤'],
    init:{ vol:4.30, k:4.1, na:139, hco3:23, lac:2.4, glu:8.2, cr:98, bun:5.6,
           hb:128, wbc:12.0, plt:220, temp:36.7, gcs:11,
           hr:56, sv:62, svr:22, rr:13, pao2:92, paco2:40, spo2:97, uo:0.7,
           contractility:0.90, hematoma:0.55, icp:0.62 },
    drivers:{ kProd:0.010, lactProd:0.03 },
    history:[
      [null, '现场人员转述', '左颞部撞伤后曾清醒，约一小时后逐渐出现嗜睡、呕吐。'],
    ],
    goal:['意识恢复','颅内压下降','血压心率回稳'],
    ...observeAfter(S => S.cranied ? (S.craniotomyAt ?? 0) : null, 900, '开颅术后观察未满 15 分钟', (S, issue = dischargeReason) =>
      S.hematoma > 0.12 ? [issue('颅内血肿未清除')] : []),
    hint:'硬膜外血肿有"中间清醒期"——意识变差就是再出血。甘露醇只是争取时间，必须开颅。',
    advance(S, dtMin){
      /* 动脉出血持续 → 血肿扩大；开颅后不再增长 */
      if (!S.cranied) S.hematoma = Math.min(1.2, (S.hematoma || 0) + 0.0014 * dtMin);
      /* Cushing 反应：颅压升高 → 血压升、心率降（脑疝前兆） */
      const icp = S.icp || 0;
      /* Cushing 反应已移入引擎的 hrTarget / toneTarget，模块里再改会被下一拍覆盖 */
    },
  },

  {
    id:'burn', name:'大面积烧伤 / 吸入性损伤', tag:'burn', weight:1, comorbidities:['密闭空间火灾'],
    init:{ vol:3.95, k:5.3, na:136, hco3:20, lac:4.0, glu:9.5, cr:120, bun:8.0,
           hb:158, wbc:16.0, plt:190, temp:36.3, gcs:13,
           hr:126, sv:54, svr:15, rr:26, pao2:76, paco2:36, spo2:91, uo:0.5,
           contractility:0.86, airwayResistance:0.75 },
    drivers:{ kProd:0.020, lactProd:0.055 },
    history:[
      [null, '院前交接', '从密闭空间火灾中救出。', 'medications'],
      [null, '院前交接', '转运时见面颈部烧伤、气促、声音嘶哑及炭末样痰，估计烧伤面积约 35%。'],
    ],
    goal:['血氧回升','血压稳定','尿量 ≥ 30 mL/h'],
    check:S=> (S.map || 100) < 68 ? ['平均动脉压不足'] : [],
    hint:'烧伤先看气道：声音嘶哑 + 炭末痰 = 吸入性损伤，气道会肿到堵死，宁可早插管。补液按体重×面积算。',
    advance(S, dtMin){
      /* 血浆渗漏到组织间隙（前 8 小时最快） */
      const rate = S.t < 8 * 3600 ? 0.0050 : 0.0014;
      S.vol = Math.max(2.4, S.vol - rate * dtMin);
      S.interstitium = Math.min(26, (S.interstitium || 11) + rate * dtMin * 0.8);
      /* 气道水肿充分消退后才进入恢复期，撤机不重启肿胀病程。 */
      const field = S.burnAirwayResistance == null ? 'airwayResistance' : 'burnAirwayResistance';
      if ((S[field] || 0) <= 0.12) S.burnAirwayResolved = true;
      if (S.vent || S.burnAirwayResolved) S[field] = Math.max(0.10, (S[field] || 0.45) - 0.0120 * dtMin);
      else S[field] = Math.min(2.4, (S[field] || 0.45) + 0.0090 * dtMin);
      /* 气道接近完全阻塞 → 低氧累积（这是吸入性损伤真正的死因） */
      if ((S[field] || 0) > 1.4) S.insult.hypox += 0.12 * dtMin;
      /* 肌红蛋白/溶血 → 血钾升高 */
      S.kProd = 0.020;
    },
  },

  {
    id:'stemi', name:'急性心肌梗死', tag:'stemi', weight:2, comorbidities:['高血压','吸烟'],
    init:{ vol:4.35, k:4.3, na:138, hco3:22, lac:2.6, glu:9.8, cr:105, bun:6.2,
           hb:138, wbc:12.5, plt:240, temp:36.9, gcs:14,
           hr:104, sv:54, svr:17, rr:22, pao2:90, paco2:33, spo2:96, uo:0.8,
           contractility:0.92, stemi:0.62 },
    drivers:{ kProd:0.011, lactProd:0.040 },
    history:[
      [60, '院前病史', '出现持续的胸骨后压榨样痛，向左肩放射，伴冷汗。'],
      [null, '院前病史', '曾含服硝酸甘油，疼痛持续。', 'prehospital'],
    ],
    goal:['胸痛缓解','血压心率稳定','ST 段回落'],
    ...observeAfter(S => S.reperfused ? (S.reperfusionAt ?? 0) : null, 900, 'PCI 后观察未满 15 分钟', (S, issue = dischargeReason) => [
      S.stemi > 0.15 ? issue('冠脉未再通（ST 仍抬高）') : null,
      (S.map || 100) < 68 ? '平均动脉压不足' : null,
    ].filter(Boolean)),
    hint:'ST 段抬高型心梗：抗血小板 + 抗凝 + 尽快再通。硝酸甘油只能缓解症状，救不了濒死心肌。',
    advance(S, dtMin){
      /* 未再通则坏死面积扩大；再通后不再进展 */
      if (!S.reperfused) S.stemi = Math.min(1, (S.stemi || 0) + 0.0012 * dtMin);
      /* 心梗后心源性休克：血压下降、乳酸上升 */
      if ((S.stemi || 0) > 0.7) { S.contractility = Math.max(0.45, (S.contractility || 0.92) - 0.00004 * dtMin); }
    },
  },

  {
    id:'seizure', name:'癫痫持续状态', tag:'seizure', weight:2, comorbidities:['癫痫病史'],
    init:{ vol:4.20, k:4.2, na:137, hco3:17, lac:7.5, glu:6.5, cr:110, bun:7.0,
           hb:136, wbc:11.0, plt:230, temp:38.8, gcs:7,
           hr:142, sv:58, svr:14, rr:30, pao2:78, paco2:30, spo2:90, uo:0.5,
           contractility:0.88, seizure:0.90 },
    drivers:{ kProd:0.014, lactProd:0.095 },
    history:[
      [20, '现场人员转述', '开始持续抽搐。'],
      [null, '院前交接', '急救人员到场时仍在抽搐，伴牙关紧闭和发绀。'],
    ],
    medicationHistory:['近期停用抗癫痫药'],
    goal:['抽搐停止','意识恢复','乳酸下降'],
    hint:'持续抽搐超过 5 分钟就要止惊。首选苯二氮卓，给药后仍持续发作可静滴左乙拉西坦。止惊后继续监测意识与呼吸。',
    advance(S, dtMin){
      /* 未止惊则持续放电：乳酸飙升、体温上升、缺氧 */
      if ((S.seizure || 0) > 0.2) {
        S.lactProd = 0.150;   // 持续抽搐的乳酸生成（高于初始 7.5 的稳态，才会继续升）
        S.insult.hypox += 0.10 * (S.seizure || 0) * dtMin;
      } else {
        S.lactProd = 0.030;
      }
      /* 抽搐自行终止很慢（每 10 分钟衰减 4%） */
      S.seizure = Math.max(0, (S.seizure || 0) - 0.0015 * dtMin);
    },
  },

  {
    id:'spleen', name:'脾破裂 / 腹腔内出血', tag:'spleen', weight:2, comorbidities:['腹部钝性外伤'],
    init:{ vol:3.40, k:4.0, na:135, hco3:21, lac:4.6, glu:8.0, cr:105, bun:7.5,
           hb:96, wbc:12.5, plt:210, temp:36.3, gcs:13,
           hr:132, sv:48, svr:17, rr:28, pao2:92, paco2:32, spo2:97, uo:0.25,
           contractility:0.90, bleedRate:0.034 },
    drivers:{ kProd:0.012, lactProd:0.055 },
    history:[
      [null, '院前病史', '左上腹受撞击后疼痛，向左肩放射。'],
      [null, '院前交接', '急救人员见患者面色苍白、出冷汗。'],
    ],
    goal:['血压稳定','乳酸下降','尿量 ≥ 30 mL/h'],
    measures: { vol: 3.6, uo: 0.5 },
    ...observeAfter(S => S.bleedingSites.spleen === 0 ? (S.surgicalHemostasisAt ?? 0) : null, 900, '止血术后观察未满 15 分钟', (S, issue = dischargeReason) => [
      S.bleedingSites.spleen > 0 ? issue('脾脏仍在出血') : null,
      (S.map || 100) < 68 ? '平均动脉压不足' : null,
    ].filter(Boolean)),
    hint:'钝性腹部外伤 + 失血性休克，要考虑脾破裂：液体复苏是争取时间，腹腔内出血不会自己停——该手术。',
    advance(S, dtMin, E){
      /* 包膜下出血：不手术就持续渗血；血压越高出得越快（压力依赖性） */
      if (S.bleedingSites.spleen > 0) {
        E.setBleedingRate(S, 'spleen', 0.026 + 0.012 * Math.max(0, Math.min(1, ((S.map || 90) - 70) / 40)));
      }
    },
  },

  {
    id:'ectopic', name:'宫外孕破裂', tag:'ectopic', weight:2, sexReq:'女', ageRange:[18,44],
    comorbidities:['早孕'],
    init:{ vol:3.45, k:3.9, na:136, hco3:20, lac:5.0, glu:5.6, cr:88, bun:4.6,
           hb:88, wbc:11.5, plt:210, temp:36.5, gcs:13,
           hr:134, sv:48, svr:17, rr:28, pao2:94, paco2:30, spo2:98, uo:0.2,
           contractility:0.92, bleedRate:0.032 },
    drivers:{ kProd:0.011, lactProd:0.06 },
    history:[
      [null, '患者自述', '已停经约七周。'],
      [null, '院前病史', '送医前突发下腹撕裂样痛、肛门坠胀，曾晕厥。'],
    ],
    goal:['血压稳定','尿量 ≥ 30 mL/h','腹腔出血已控制'],
    measures: { vol: 3.6, uo: 0.5 },
    ...observeAfter(S => S.bleedingSites.ectopic === 0 ? (S.surgicalHemostasisAt ?? 0) : null, 900, '止血术后观察未满 15 分钟', (S, issue = dischargeReason) => [
      S.bleedingSites.ectopic > 0 ? issue('盆腔仍在出血') : null,
      (S.map || 100) < 68 ? '平均动脉压不足' : null,
    ].filter(Boolean)),
    hint:'育龄女性 + 停经 + 突发下腹痛 + 休克 = 宫外孕破裂。补液是争取时间，必须立刻手术。',
    advance(S, dtMin, E){
      if (S.bleedingSites.ectopic > 0) {
        E.setBleedingRate(S, 'ectopic', 0.030 + 0.010 * Math.max(0, Math.min(1, ((S.map || 90) - 70) / 40)));
      }
    },
  },
  {
    id:'preeclampsia', name:'子痫前期（重度）', tag:'preeclampsia', weight:2, sexReq:'女', ageRange:[20,42],
    comorbidities:['妊娠 34 周'],
    init:{ vol:4.70, k:4.3, na:134, hco3:22, lac:2.6, glu:5.2, cr:120, bun:6.8,
           hb:118, wbc:12.0, plt:78, temp:36.8, gcs:14,
           hr:96, sv:60, svr:26, rr:20, pao2:92, paco2:32, spo2:97, uo:0.35,
           contractility:0.90, coag:0.82, svrDrive:PREECLAMPSIA_SVR_DRIVE },
    drivers:{ kProd:0.011, lactProd:0.035 },
    history:[[2880, '病史回顾', '开始头痛、视物模糊，伴双下肢水肿。']],
    goal:['血压下降','头痛缓解','尿量 ≥ 30 mL/h'],
    measures: { coag: 0.65 },
    ...observeAfter(S => S.delivered ? (S.deliveryAt ?? 0) : null, 900, '产后观察未满 15 分钟', (S, issue = dischargeReason) => [
      !S.delivered ? issue('重度子痫前期的产科病因尚未解除') : null,
      (S.map || 100) > 118 ? `平均动脉压 ${Math.round(S.map)}` : null,
      (S.plt || 200) < 100 ? `血小板 ${Math.round(S.plt)}` : null,
    ].filter(Boolean)),
    hint:'重度子痫前期：解痉（硫酸镁）比降压更优先，血压别降太猛——胎盘灌注会掉。根治只有终止妊娠。',
    advance(S, dtMin){
      /* 病因在胎盘：不终止妊娠，血管痉挛与血小板消耗都只会加重。
         注意：不能直接写 S.svr —— 引擎每拍会用 toneTarget 覆盖它，
         必须用引擎提供的 svrDrive（血管收缩驱动）才能真正抬高外周阻力。 */
      if (S.delivered) {
        S.svrDrive = Math.max(0, (S.svrDrive ?? PREECLAMPSIA_SVR_DRIVE) - 0.02 * dtMin);
        S.plt = Math.min(150, (S.plt || 78) + 0.45 * dtMin);
        S.coag = Math.min(1, (S.coag || 0.82) + 0.0006 * dtMin);
        return;
      }
      /* 旧种子在第一拍病程推进时才载入此驱动。 */
      if (S.genVersion < 3 && S.svrDrive === 0) S.svrDrive = PREECLAMPSIA_SVR_DRIVE;
      S.svrDrive = Math.min(16, (S.svrDrive ?? PREECLAMPSIA_SVR_DRIVE) + 0.012 * dtMin);
      if ((S.map || 100) > 125) S.insult.icp += 0.10 * dtMin;   // 高血压脑病 → 脑水肿 → 子痫
      S.plt = Math.max(20, (S.plt || 78) - 0.06 * dtMin);
      S.coag = Math.max(0.35, (S.coag || 0.82) - 0.0004 * dtMin);
    },
  },
  {
    id:'bph', name:'前列腺增生伴急性尿潴留', tag:'bph', weight:2, sexReq:'男', ageRange:[60,88],
    comorbidities:['前列腺增生'],
    init:{ vol:5.35, k:5.9, na:131, hco3:19, lac:2.8, glu:7.0, cr:310, bun:22,
           hb:122, wbc:9.5, plt:210, temp:36.8, gcs:14,
           hr:98, sv:60, svr:20, rr:24, pao2:88, paco2:34, spo2:94, uo:0.08,
           contractility:0.88, renalFactor:0.35 },
    drivers:{ kProd:0.020, lactProd:0.03 },
    history:[
      [2880, '病史回顾', '逐渐出现排尿困难、下腹胀痛。'],
      [null, '院前病史', '送医前已无法自行排尿。'],
    ],
    get goal() { return ['尿量恢复', potassiumGoal(), '肌酐下降']; },
    measures: { cr: 180 },
    check:S=> (S.vol || 5) > 5.7 ? ['容量负荷过重'] : [],
    hint:'急性尿潴留先导尿——膀胱减压后肾后性肾损伤才有机会恢复；高钾要同时处理。',
    advance(S, dtMin){
      if (!S.urineDrained) {
        S.vol = Math.min(6.6, (S.vol || 5.35) + 0.0040 * dtMin);   // 排尿不出 → 容量负荷
        S.k = Math.min(8.6, (S.k || 5.9) + 0.0090 * dtMin);        // 排钾减少（不导尿会走到高钾）
      }
    },
  },
];

/* 主诉只记录促使患者来诊的症状。补充症状、暴露及诱因留给问诊。 */
const CHIEF_COMPLAINTS = {
  highK: ['心悸、乏力约 6 小时', 360],
  dka: ['恶心、呕吐约 1 天', 1440],
  bleed: ['到院前呕血', null],
  sepsis: ['发热、咳嗽约 3 天', 4320],
  opioid: ['被发现呼之不应、呼吸浅慢', null],
  edema: ['突发气促', null],
  thyroid: ['发热、心悸约 2 天', 2880],
  hypogly: ['到院前大汗、反应变差', null],
  asthma: ['喘息、胸闷约 6 小时', 360],
  organophosphate: ['到院前大汗、呕吐', null],
  apap: ['到院前出现恶心', null],
  htnEmergency: ['剧烈头痛、视物模糊约 3 小时', 180],
  hyponatremia: ['乏力、嗜睡约 2 天', 2880],
  pe: ['突发胸痛、气促', null],
  ptx: ['胸部受伤后气促', null],
  trauma: ['受伤后右大腿出血', null],
  pancreatitis: ['上腹剧痛伴呕吐约 8 小时', 480],
  hhs: ['到院前嗜睡、反应变差', null],
  co: ['到院前反应变慢', null],
  aki: ['尿量减少伴恶心约 3 天', 4320],
  tamponade: ['胸部受伤后出现反应异常', null],
  heatstroke: ['到院前晕倒', null],
  myxedema: ['被发现反应迟钝', null],
  liverFailure: ['近一周皮肤发黄，随后逐渐嗜睡', 10080],
  tca: ['送诊前反应迟钝', null],
  tbi: ['头部撞伤后逐渐嗜睡', null],
  burn: ['烧伤后气促', null],
  stemi: ['持续胸骨后疼痛约 1 小时', 60],
  seizure: ['持续抽搐约 20 分钟', 20],
  spleen: ['左上腹受伤后疼痛', null],
  ectopic: ['突发下腹痛伴晕厥', null],
  preeclampsia: ['头痛、视物模糊约 2 天', 2880],
  bph: ['到院前无法自行排尿', null],
};
for (const m of MODULES) {
  m.complaint = m.history.map(([, , text]) => text).join('');
  [m.chief, m.chiefMinutesBefore] = CHIEF_COMPLAINTS[m.id];
}

/* ---------- 组合 ---------- */
function pick(rnd, arr, n) {
  const pool = arr.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  }
  return out;
}

/* 性别及年龄要求在同一患者身上必须有交集。 */
function demographicsFor(modules) {
  return {
    sexReq: modules.map(m => m.sexReq).find(Boolean),
    ageLo: modules.reduce((age, m) => m.ageRange ? Math.max(age, m.ageRange[0]) : age, 18),
    ageHi: modules.reduce((age, m) => m.ageRange ? Math.min(age, m.ageRange[1]) : age, 88),
  };
}

function fitsDemographics(module, { sexReq, ageLo, ageHi }) {
  if (sexReq && module.sexReq && sexReq !== module.sexReq) return false;
  return !module.ageRange || Math.max(ageLo, module.ageRange[0]) <= Math.min(ageHi, module.ageRange[1]);
}

/* 下列模块的初始病因或治疗目标无法同时成立。 */
const incompatible = [
  ['ectopic', 'preeclampsia'],
  ['thyroid', 'myxedema'],
  ['heatstroke', 'myxedema'],
  ['dka', 'hypogly'],
  ['dka', 'hhs'],
  ['hhs', 'hypogly'],
  ['hhs', 'hyponatremia'],
];

function fitsEpisode(module, selected) {
  const ids = new Set(selected.map(m => m.id));
  return !ids.has(module.id) && !incompatible.some(([a, b]) =>
    (a === module.id && ids.has(b)) || (b === module.id && ids.has(a)));
}

/* 按权重抽病理：weight 越大越常见 */
function weightedIndex(rnd, pool) {
  const total = pool.reduce((s, m) => s + (m.weight || 1), 0);
  let r = rnd() * total, k = 0;
  for (; k < pool.length; k++) { r -= (pool[k].weight || 1); if (r <= 0) break; }
  return Math.min(k, pool.length - 1);
}

function pickWeighted(rnd, arr, n, genVersion) {
  const pool = arr.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    let index = weightedIndex(rnd, pool);
    if (genVersion >= 2) {
      const demographics = demographicsFor(out);
      const eligibleModule = m => fitsDemographics(m, demographics)
        && (genVersion < 3 || fitsEpisode(m, out));
      if (!eligibleModule(pool[index])) {
        const eligible = pool.filter(eligibleModule);
        if (!eligible.length) throw new RangeError('没有符合当前病例背景的病理模块');
        index = pool.indexOf(eligible[weightedIndex(rnd, eligible)]);
      }
    }
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}

/* 休克、呼吸抑制和代谢异常的占优方向以同一个患者的初始数据体现。 */
const lowerAdmissionValues = new Set([
  'pao2', 'spo2', 'gcs', 'uo', 'sv', 'hco3', 'plt', 'ca',
  'contractility', 'renalFactor', 'insulinBase', 'waterClear', 'acheActivity', 'gsh', 'coag',
]);
const higherAdmissionValues = new Set([
  'cr', 'bun', 'lac', 'wbc', 'pvr', 'vdvt', 'kProd', 'lactProd', 'glucoseIn',
]);

function admissionPriority(key, value) {
  if (lowerAdmissionValues.has(key)) return -value;
  if (higherAdmissionValues.has(key)) return value;
  if (key === 'vol' && value < 4) return 6 - value;
  if (key === 'hr' && value <= 60) return (60 - value) * 2 + 40;
  if (key === 'rr' && value <= 10) return (10 - value) * 4 + 20;
  if (key === 'paco2' && value >= 50) return value - 20;
  if (key === 'glu' && value < 3.9) return (BASE.glu - value) * 12;
  return Math.abs(value - (BASE[key] ?? 0));
}

function mergeAdmission(target, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = target[key];
    if (typeof previous !== 'number' || typeof value !== 'number' ||
        admissionPriority(key, value) > admissionPriority(key, previous)) {
      target[key] = value;
    }
  }
}

const traumaIds = new Set(['ptx', 'trauma', 'tamponade', 'spleen', 'tbi']);
const episodeNames = new Set(['肺部感染', '胸部外伤', '头部外伤', '腹部钝性外伤', '骨盆骨折', '密闭空间火灾']);
const pregnancyNotes = new Set(['早孕', '妊娠 34 周', '旧版产科记录与患者资料或孕周记录存在冲突']);
const diabetesTypes = new Set(['1 型糖尿病', '2 型糖尿病']);
const traumaScene = {
  ptx: '发生道路交通事故，胸部受伤。',
  trauma: '发生摩托车事故，右大腿受伤。',
  tamponade: '胸部遭刀刺伤。',
  spleen: '发生道路交通事故，左上腹受到撞击。',
  tbi: '骑车摔倒，左颞部撞伤。',
};

function makeAdmission(modules, patient, additionalHistory, diabetesType) {
  const demographics = { sexReq: patient.sex, ageLo: patient.age, ageHi: patient.age };
  const ids = new Set(modules.map(m => m.id));
  const trauma = modules.filter(m => traumaIds.has(m.id));
  const unclearPregnancy = (ids.has('ectopic') && ids.has('preeclampsia'))
    || modules.some(m => !fitsDemographics(m, demographics));
  const unclearDiabetes = ids.has('dka') && ids.has('hhs');
  const unclearThyroid = ids.has('thyroid') && ids.has('myxedema');
  const mixedIngestion = ids.has('apap') && ids.has('tca');
  const history = [];
  if (trauma.length) {
    const text = ids.has('burn') ? '火灾现场同时发生外伤。'
      : trauma.length === 1 ? traumaScene[trauma[0].id] : '发生道路交通事故，身体多处受伤。';
    const minutesBefore = ids.has('tamponade') && !ids.has('tbi') && !ids.has('burn') ? 40 : null;
    history.push({ moduleId: trauma[0].id, minutesBefore, source: '现场人员转述', text });
  }
  for (const m of modules) {
    for (const [minutesBefore, source, description, section] of m.history) {
      let text = description;
      if (section === 'medications') {
        if (m.id === 'co' && ids.has('burn')) text = '在密闭火场中吸入烟气。';
        if (m.id === 'heatstroke' && ids.has('burn')) text = '火场中有高温暴露。';
        if (m.id === 'tca' && mixedIngestion) continue;
        if (m.id === 'apap' && mixedIngestion) text = '同时吞服对乙酰氨基酚和阿米替林各约 20 片。';
        if (m.id === 'dka' && ids.has('hypogly')) text = '本次注射胰岛素前曾有一段时间停用。';
      }
      if (m.id === 'dka' && minutesBefore === 4320 && ids.has('aki')) {
        text = '开始明显口渴。';
      }
      if (m.id === 'ectopic' && unclearPregnancy && source === '患者自述') continue;
      if (m.id === 'hhs' && (unclearDiabetes || ids.has('hyponatremia')) && text === '近几天饮水少。') continue;
      if (m.id === 'myxedema' && (unclearThyroid || ids.has('heatstroke'))) text = text.replace('、皮肤干冷', '');
      history.push({ moduleId: m.id, minutesBefore, source, text, ...(section ? { section } : {}) });
    }
  }
  history.sort((a, b) => (b.minutesBefore ?? 0) - (a.minutesBefore ?? 0));
  const normalized = item => {
    if (unclearPregnancy && pregnancyNotes.has(item)) return '旧版产科记录与患者资料或孕周记录存在冲突';
    if (unclearDiabetes && diabetesTypes.has(item)) return '糖尿病（旧版记录分型不一致）';
    if (diabetesType && item === '糖尿病') return diabetesType;
    if (unclearThyroid && item.startsWith('甲状腺功能')) return '甲状腺疾病（旧版记录分型不一致）';
    if (unclearThyroid && (item === '近期停用抗甲状腺药' || item === '两个月前停用甲状腺激素替代药')) {
      return '旧版甲状腺用药记录有出入，停药经过待核实';
    }
    if (item === '一周前停用降压药' && ids.has('hyponatremia')) return '一周前停用其他降压药';
    return item;
  };
  const background = Array.from(new Set([
    ...modules.flatMap(m => [...(m.comorbidities || []), ...(m.medicalHistory || []), ...(m.medicationHistory || [])]),
    ...additionalHistory,
    ...(diabetesType ? [diabetesType] : []),
  ].filter(item => !episodeNames.has(item)).map(normalized)));
  const medicationHistory = Array.from(new Set(modules.flatMap(m => m.medicationHistory || []).map(normalized)));
  return { history, background, medicationHistory };
}

function historyTime(minutes) {
  if (minutes == null) return '到院前（时间未详）';
  if (minutes % 1440 === 0) return `到院前约 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `到院前约 ${minutes / 60} 小时`;
  return `到院前约 ${minutes} 分钟`;
}

function admissionNarrative(spec) {
  const admission = spec?.admission;
  if (!admission) return spec?.complaint || '';
  const lines = admission.history.map(({ minutesBefore, source, text }) =>
    `${historyTime(minutesBefore)} · ${source} · ${text}`);
  const pregnancy = admission.background.filter(item => pregnancyNotes.has(item));
  const background = admission.background.filter(item => !pregnancyNotes.has(item));
  if (pregnancy.length) lines.push('本次妊娠情况 · ' + pregnancy.join('、'));
  if (background.length) lines.push('既往及用药史 · ' + background.join('、'));
  return lines.join('\n');
}

function generate(difficulty, seed, only) {
  return generateVersion(difficulty, seed, VERSION, only);
}

/* 旧存档与会诊码依赖原抽样序列。 */
function generateLegacy(difficulty, seed) {
  return generateVersion(difficulty, seed, 1);
}

function generateVersion(difficulty, seed, version, only) {
  if (!Number.isInteger(version) || version < 1 || version > VERSION) throw new RangeError('未知的病例生成版本');
  return generateCase(difficulty, seed, only, version);
}

function generateCase(difficulty, seed, only, genVersion) {
  const legacy = genVersion === 1;
  const unified = genVersion >= 3;
  const intakeDifficulty = clamp(difficulty || 2, 1, 6);
  const diff = Math.min(intakeDifficulty, 5);
  const actualSeed = seed == null ? (Date.now() & 0x7fffffff) : seed;
  const rnd = mulberry32(actualSeed);

  /* 难度重排：
     1 普通（原 1–2 合并）  2 重症（原 3–5 合并）
     3 危重 / 4 极危 / 5 噩梦（新增，叠加更多病理、更快恶化、更多基础病） */
  const nMods = diff <= 2 ? 1 : (diff === 3 ? 2 : 3);
  const severity = 0.75 + diff * 0.06;        // 保留（模块已自带严重度）
  const primary = (only && only.length)
    ? only.map(id => MODULES.find(m => m.id === id)).filter(Boolean).slice(0, nMods)
    : pickWeighted(rnd, MODULES, nMods, genVersion);

  if (!primary.length) throw new RangeError('缺少有效的病理模块');
  const demographics = demographicsFor(primary);
  if (!legacy && !primary.every(m => fitsDemographics(m, demographics))) {
    throw new RangeError('指定病理模块的性别或年龄要求冲突');
  }
  if (unified && !primary.every((m, index) => fitsEpisode(m, primary.slice(0, index)))) {
    throw new RangeError('指定病理模块的入院病情冲突');
  }
  const { sexReq, ageLo, ageHi } = demographics;

  const admissionValues = {};
  let admissionTemp = BASE.temp;
  const bleedingSites = {};
  const drivers = {};
  const preload = [];
  let opioidTox = false;
  const merge = unified ? mergeAdmission : Object.assign;

  for (const m of primary) {
    const rate = m.drivers?.bleedRate ?? m.init?.bleedRate;
    if (rate > 0) bleedingSites[m.id] = rate;
    if (!unified && m.id === 'preeclampsia') {
      const { svrDrive, ...previousInit } = m.init;
      merge(admissionValues, previousInit);
    } else {
      merge(admissionValues, m.init);
    }
    merge(drivers, m.drivers);
    const temp = m.init?.temp;
    if (Math.abs(temp - BASE.temp) > Math.abs(admissionTemp - BASE.temp)) admissionTemp = temp;
    if (m.preload) preload.push(...m.preload);
    if (m.opioidTox) opioidTox = true;
  }
  if (unified) mergeAdmission(admissionValues, drivers);
  const init = { ...BASE, ...admissionValues };
  if (genVersion === 2) init.temp = admissionTemp;
  init.mod = Object.assign({ hr:0, svr:0, sv:0, rr:0, spo2:0, temp:0, gcs:0 }, init.mod || {});
  if (!unified) Object.assign(init, drivers);
  const aki = primary.find(m => m.id === 'aki');
  if (aki) init.renalFactor = Math.min(init.renalFactor, aki.init.renalFactor);
  if (Object.keys(bleedingSites).length) init.bleedingSites = bleedingSites;
  if (preload.length) init.preload = preload;
  if (opioidTox) init.opioidTox = true;

  /* 个体差异 */
  const sex = sexReq || (rnd() < 0.5 ? '男' : '女');
  const age = ageLo + Math.floor(rnd() * Math.max(1, ageHi - ageLo + 1));
  const body = makeBody(sex, age, rnd);
  const weight = body.weight;
  const patient = { name: makeName(sex, rnd), sex, age, height: body.height, weight };
  /* 性别与年龄的基础生理差异（模块的 init 可覆盖） */
  if (sex === '女') {
    /* 只对"本来就正常"的血红蛋白做性别校正；病理性的低 Hb（失血/贫血）不再额外扣 */
    if ((init.hb || 132) >= 115) init.hb = clamp(init.hb - 12, 45, 175);
    init.ecfVd = (init.ecfVd || 12) * 0.94;            // 体脂比例高 → 总体水略少
  }
  if (age >= 65) { init.renalFactor = (init.renalFactor || 1) * 0.85; init.pao2 = clamp((init.pao2 || 94) - 3, 40, 96); }
  init.sex = sex; init.age = age; init.weight = weight; init.height = body.height;
  const hbJit = (rnd() - 0.5) * 14;
  init.hb = clamp(init.hb + hbJit, 45, 175);
  init.vol = clamp(init.vol + (rnd() - 0.5) * 0.25, 2.8, 6.0);
  init.creatJit = (rnd() - 0.5) * 30; init.cr = clamp(init.cr + init.creatJit, 40, 780);
  init.temp = +(init.temp + (rnd() - 0.5) * 0.4).toFixed(1);
  init.hr = Math.round(init.hr + (rnd() - 0.5) * 10);
  init.k = +(init.k + (rnd() - 0.5) * 0.2).toFixed(1);

  /* 难度=5 时加基础病 */
  const additionalHistory = [];
  if (!only && diff >= 2 && (diff >= 3 || rnd() < 0.5)) {
    const comorb = pick(rnd, ['ckd','copd','anemia'], 1)[0];
    if (comorb === 'ckd') {
      init.cr = clamp(init.cr * 1.5, 120, 700);
      init.k = +(init.k + 0.4).toFixed(1);
      init.renalFactor = unified || aki ? Math.min(init.renalFactor, 0.55) : 0.55;
      additionalHistory.push('慢性肾病');
    }
    if (comorb === 'copd') {
      init.pao2 = clamp(init.pao2 - 8, 40, 90);
      init.paco2 = init.paco2 + 6;
      init.vdvt = unified ? Math.max(init.vdvt || 0, 0.42) : 0.42;
      additionalHistory.push('慢性阻塞性肺疾病');
    }
    if (comorb === 'anemia') {
      init.hb = clamp(init.hb - 25, 55, 150);
      additionalHistory.push('慢性贫血');
    }
  }

  const comorbidities = Array.from(new Set(primary.flatMap(m => m.comorbidities || [])));
  const traits = [];
  if (traitsApi) {
    const pool = genVersion < 4 ? traitsApi.TRAITS.slice()
      : traitsApi.forPatient(traitsApi.TRAITS, patient, comorbidities);
    const nT = only ? 0 : diff <= 1 ? 0 : (diff === 2 ? (rnd() < 0.7 ? 1 : 0) : (diff === 3 ? (rnd() < 0.5 ? 1 : 2) : 2));
    for (let i = 0; i < nT && pool.length; i++) {
      traits.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
  }
  const diabetesType = genVersion >= 4
    ? (comorbidities.find(name => diabetesTypes.has(name)) || traits.find(t => t.id === 't2dm')?.n)
    : undefined;
  if (diabetesType && !comorbidities.includes(diabetesType)) comorbidities.push(diabetesType);

  const tags = primary.map(m => m.tag);
  const cases = primary.map(m => m.id);
  const combined = unified && cases.length > 1;
  const combinedAirway = combined && cases.includes('asthma') && cases.includes('burn');
  const combinedPvr = combined && cases.includes('pe') && cases.includes('ptx');
  if (combinedAirway) {
    init.asthmaResistance = primary.find(m => m.id === 'asthma').init.airwayResistance;
    init.burnAirwayResistance = primary.find(m => m.id === 'burn').init.airwayResistance;
  }
  if (combinedPvr) init.pvr = 1.8 + 9.5 * init.clot + 6.0 * init.tensionPTX;
  const names = primary.map(m => m.name).join(' + ');
  const admission = makeAdmission(primary, patient, additionalHistory, diabetesType);
  const complaint = admissionNarrative({ admission });

  /* 并发病程共享同一体征，分别推进后合并共同的病理负荷。 */
  const deadSpaceBackground = additionalHistory.includes('慢性阻塞性肺疾病') ? 0.42 : 0.33;
  const combinedDeadSpace = combined && (cases.includes('asthma') || cases.includes('pe'));
  const advance = function (S, dtMin, E) {
    let deadSpace = deadSpaceBackground;
    for (const m of primary) {
      if (!m.advance) continue;
      m.advance(S, dtMin, E);
      if (combinedDeadSpace && (m.id === 'asthma' || m.id === 'pe')) deadSpace = Math.max(deadSpace, S.vdvt);
    }
    if (combinedDeadSpace) S.vdvt = deadSpace;
    if (combinedAirway) S.airwayResistance = Math.max(S.asthmaResistance, S.burnAirwayResistance);
    if (combinedPvr) S.pvr = 1.8 + 9.5 * S.clot + 6.0 * S.tensionPTX;
  };

  init.seed = actualSeed;
  init.diff = intakeDifficulty;
  init.genVersion = genVersion;
  /* 整体上调：病例推进速度随难度提高（原来所有难度都是 1.0） */
  init.hardScale = diff <= 2 ? (1.05 + diff * 0.10) : (1.30 + (diff - 2) * 0.22);   /* 1.15 / 1.25 / 1.52 / 1.74 / 1.96 */

  return {
    id: 'gen', name: names, tags, diff: intakeDifficulty, genVersion,
    age, sex, weight, patient, bloodType: ['A','B','O','AB'][Math.floor(rnd()*4)],
    complaint,
    /* 主诉 = 主要症状 + 持续时间；并发病史只进现病史 */
    chief: primary[0].chief,
    admission, traits,
    comorbidities,
    init,
    goals: Array.from(new Set(primary.flatMap(m => m.goal))),
    minDischargeHR: Math.max(...primary.map(m => m.minDischargeHR ?? 50)),
    hint: primary[0].hint,
    extra: (S, issue) => [...primary.flatMap(m => m.check?.(S, issue) ?? []), ...caseMeasureReasons(primary, S)],
    observations: S => primary.map(m => m.observation?.(S)).filter(Boolean),
    advance,
    cases,
    seed: actualSeed,
  };
}

/* 界面上每 tick 之后调用：让病程钩子与引擎同步推进 */
function step(S, dtSec, E) {
  if (!S || !S.running) return;
  const C = S.cas;
  if (C && typeof C.advance === 'function') {
    const k = S.hardScale || 1;
    C.advance(S, (dtSec / 60) * k, E || root.LIFE);
  }
}

const API = { generate, generateVersion, generateLegacy, admissionNarrative, vascularTone, step, MODULES, BASE, VERSION };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.CASEGEN = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
