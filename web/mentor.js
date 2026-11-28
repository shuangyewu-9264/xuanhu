/* ==========================================================================
 * 上级医师：规则引擎（离线，不调用任何模型）
 *  - hints(S)   按当前状态给出建议，按难度裁剪详略
 *  - evaluate() 对刚执行的操作给出评价（多了/少了/有更合适的）
 * ========================================================================== */
(function (root) {
'use strict';

/* 体内是否还有某物质的药效（与 generator.js 的 active() 保持一致） */
const active = (S, id) => !!(S && S.pk && S.pk.some(p => p.id === id));
const insulinActivity = S => root.LIFE?.insulinActivity?.(S) ?? S.eff.insulin;
const SEIZURE_RESCUE_DOSE = { diazepam: 10, lorazepam: 4, midazolam: 10 };
const triedSeizureRescue = S => (S.given || []).some(({ id, d, route }) =>
  d >= SEIZURE_RESCUE_DOSE[id] && (route === '静推' || (id === 'midazolam' && route === '肌注')));

const LEVELS = {
  learning:  { name:'学习',   detail: 3, auto: true,  note:'直接给答案，不计分、不解锁成就' },
  intern:    { name:'实习',   detail: 3, auto: true,  note:'主动提示，含具体步骤' },
  resident:  { name:'住院医', detail: 2, auto: false, note:'问了才答，只给方向' },
  attending: { name:'主治',   detail: 1, auto: false, note:'只给结论' },
  expert:    { name:'专家',   detail: 0, auto: false, note:'无提示，正常值隐藏' },
};

/* ---------- 各病例的规则 ---------- */
const RULES = {
  highK: [
    { id:'ca', when: S => S.k >= 6.3 && S.t > S.caProtectUntil,
      c:'血钾已到危急值，心肌随时可能出问题',
      d:'先保护心肌，别急着降钾',
      s:'给葡萄糖酸钙 10 mL 缓慢静推' },
    { id:'insulin', when: S => S.k > 5.5 && insulinActivity(S) < 0.4,
      c:'钾还在高位',
      d:'把钾挪进细胞',
      s:'胰岛素 10 U + 50% 葡萄糖 25 mL 静推' },
    { id:'dialysis', when: S => S.k > 5.2 && !(S.dialysisUntil > S.t),
      c:'钾总量仍然过高，光靠转移不够',
      d:'需要真正清除',
      s:'血液透析' },
    { id:'acid', when: S => S.ph < 7.28 && S.hco3 < 18,
      c:'同时存在代谢性酸中毒',
      d:'纠酸能帮助降钾',
      s:'碳酸氢钠 100–150 mL 静滴' },
    { id:'vol', when: S => S.vol < 4.3 || S.map < 70,
      c:'容量偏少，血压靠代偿撑着',
      d:'先把容量补起来',
      s:'生理盐水 500 mL' },
  ],
  dka: [
    { id:'fluid', when: S => S.vol < 4.0 || S.map < 70,
      c:'脱水是第一位的问题',
      d:'先补容量，再谈胰岛素',
      s:'生理盐水 1000 mL 快速静滴' },
    { id:'insulin', when: S => S.glu > 11 && insulinActivity(S) < 0.5,
      c:'血糖和酮体都还没压下去',
      d:'小剂量胰岛素持续',
      s:'胰岛素 10 U 静推，必要时每小时追加' },
    { id:'k', when: S => S.k < 3.8,
      c:'血钾开始往下掉了',
      d:'补钾要跟上',
      s:'氯化钾 20 mmol（口服或稀释后静滴）' },
    { id:'acid', when: S => S.ph < 7.05,
      c:'酸中毒很重',
      d:'关键还是补液+胰岛素，补碱要谨慎',
      s:'一般 pH<6.9 才考虑碳酸氢钠' },
  ],
  bleed: [
    { id:'vol', when: S => S.map < 70 || S.vol < 4.2,
      c:'循环不稳',
      d:'先扩容',
      s:'生理盐水 1000 mL' },
    { id:'blood', when: S => S.hb < 85,
      c:'贫血已经影响携氧',
      d:'该输血了',
      s:'浓缩红细胞 2 U' },
    { id:'scope', when: S => S.bleedingSites.bleed > 0 && S.map >= 65,
      c:'血压勉强够做内镜了',
      d:'止血才是根治',
      s:'急诊内镜止血（需要血压支撑）' },
    { id:'ppi', when: S => S.eff.ppi < 0.3,
      c:'抑酸能稳定血凝块',
      d:'基础用药别漏',
      s:'PPI 80 mg 静推' },
  ],
  sepsis: [
    { id:'fluid', when: S => S.vol < 4.1 || S.map < 65,
      c:'容量明显不足',
      d:'先快速补液',
      s:'生理盐水 1000 mL 快速静滴，评估后再补' },
    { id:'abx', when: S => (S.infection || 0) > 0.5 && !S._abxGiven,
      c:'感染灶还没控制',
      d:'抗生素每拖一小时都在涨病死率',
      s:'头孢曲松 2 g 静滴（或按药敏）' },
    { id:'pressor', when: S => S.map < 65,
      c:'补液后血压仍不达目标',
      d:'需要血管活性药',
      s:'去甲肾上腺素 8 μg/min 泵入' },
  ],
  opioid: [
    { id:'naloxone', when: S => S.rr < 10 || S.gcs < 10,
      c:'呼吸抑制是致命的',
      d:'立即拮抗阿片',
      s:'纳洛酮 0.4 mg 静推，必要时重复' },
    { id:'o2', when: S => S.spo2 < 92,
      c:'存在低氧',
      d:'先给氧',
      s:'高流量吸氧 15 L/min' },
    { id:'observe', when: S => S.naloxoneGiven && S.rr >= 10,
      c:'纳洛酮药效消退后，呼吸抑制可能复发',
      d:'继续观察自主呼吸和意识',
      s:'通常至少观察至末次纳洛酮后 4 小时、暴露后 6 小时' },
  ],
  edema: [
    { id: 'inotrope', when: S => root.LIFE.bp(S).sys < 95 && (S.sv || 0) < 45 && (S.contractility || 1) < 0.6,
      c: '每搏量太低，光扩血管会把血压打下去',
      d: '需要正性肌力药',
      s: '多巴酚丁胺 5 μg/kg/min 泵入（血压更低时加去甲肾上腺素）' },
    { id:'o2', when: S => S.spo2 < 92,
      c:'氧合不足',
      d:'先坐位吸氧',
      s:'高流量吸氧，必要时无创通气' },
    { id:'furo', when: S => S.vol > 4.6,
      c:'容量负荷过重',
      d:'利尿减容',
      s:'呋塞米 20–40 mg 静推' },
    { id:'ntg', when: S => root.LIFE.bp(S).sys > 100 && S.spo2 < 94,
      c:'心脏后负荷高',
      d:'扩血管降低前负荷',
      s:'硝酸甘油 0.5 mg 舌下 / 泵入' },
  ],
  thyroid: [
    { id:'bb', when: S => S.hr > 120,
      c:'心率过快，心脏耗氧大',
      d:'先用 β 阻滞剂压住',
      s:'普萘洛尔 20–40 mg 口服 / 静推' },
    { id:'ptu', when: S => S.temp > 38.5,
      c:'甲状腺激素还在大量合成',
      d:'阻断合成与转化',
      s:'丙硫氧嘧啶 200 mg 口服 + 氢化可的松' },
  ],
  hypogly: [
    { id:'d50', when: S => S.glu < 4,
      c:'低血糖已经影响意识',
      d:'立即补糖',
      s:'50% 葡萄糖 25 mL 静推，随后持续输注' },
    { id:'brain', when: S => S.gcs <= 10,
      c:'意识障碍提示低血糖脑病',
      d:'先推糖，再找原因',
      s:'50% 葡萄糖 25 mL 静推，之后 10% 葡萄糖维持' },
  ],

  /* ===== 新增病理的提示规则 ===== */
  ectopic: [
    { id:'fluidLoss', when: S => (S.vol || 4) < 3.9 || (S.hb || 120) < 100,
      c:'腹腔内出血导致失血性休克', d:'补液争取时间', s:'乳酸林格液 1000 mL 快速静滴；备血后输浓缩红细胞（给药 → 浓缩红细胞）' },
    { id:'surgery', when: S => S.bleedingSites.ectopic > 0,
      c:'输卵管破裂不会自己止血', d:'必须手术', s:'急诊腹腔镜/开腹止血（操作 → 急诊手术止血）' },
  ],
  preeclampsia: [
    { id:'mgso4', when: S => S.svr > 24 || S.gcs < 15,
      c:'血管痉挛与中枢兴奋', d:'硫酸镁解痉优先于降压', s:'硫酸镁 4 g 缓慢静推，维持 1 g/h' },
    { id:'bp', when: S => (S.map || 100) > 120,
      c:'重度高血压有脑出血风险', d:'降压但要平稳', s:'拉贝洛尔或硝苯地平，避免血压骤降' },
    { id:'deliver', when: S => S.svr > 28,
      c:'病因是胎盘，药物只能控制', d:'终止妊娠是唯一根治', s:'评估终止妊娠时机' },
  ],
  bph: [
    { id:'catheter', when: S => (S.cr || 0) > 200 || S.uo < 0.5,
      c:'急性尿潴留，膀胱高压已传到肾脏', d:'先导尿减压', s:'留置导尿（操作 → 导尿）' },
    { id:'k', when: S => S.k > 5.5,
      c:'排钾受阻导致高钾', d:'先保护心肌', s:'葡萄糖酸钙 10 mL 静推 + 胰岛素葡萄糖' },
  ],

  spleen: [
    { id:'shock', when: S => S.hb < 100 || S.uo < 0.5,
      c:'失血性休克，腹腔内出血未止', d:'补液升压只是争取时间', s:'乳酸林格液 1000 mL 快速静滴，必要时输血' },
    { id:'surgery', when: S => S.bleedingSites.spleen > 0,
      c:'实质脏器破裂不会自己停', d:'手术止血才是确定性治疗', s:'急诊剖腹探查 / 脾切除（操作 → 急诊手术止血）' },
    { id:'avoid', when: S => (S.map || 90) > 100 && S.hb < 105,
      c:'血压越高，腹腔内出血越快', d:'不要追求"正常血压"', s:'允许性低血压：收缩压 80–90 即可，直到止血' },
  ],

  seizure: [
    { id:'benzo', when: S => (S.seizure || 0) > 0.2 && !triedSeizureRescue(S),
      c:'抽搐超过 5 分钟不会自己停', d:'首选苯二氮卓止惊', s:'地西泮 10 mg 缓慢静推（或劳拉西泮 4 mg）' },
    { id:'levetiracetam', when: S => S.seizure > 0.2 && triedSeizureRescue(S) && !active(S, 'levetiracetam'),
      c:'一线止惊后仍有抽搐', d:'考虑加用二线抗癫痫药',
      s:'左乙拉西坦 2000 mg 静滴 15 分钟，继续监测呼吸和意识' },
    { id:'oxygen', when: S => S.spo2 < 93 || (S.seizure || 0) > 0.3,
      c:'抽搐时呼吸做功与耗氧都剧增', d:'同时给氧', s:'高流量吸氧，必要时气管插管' },
    { id:'glucose', when: S => S.glu < 4,
      c:'低血糖也可致抽搐', d:'先查血糖', s:'50% 葡萄糖 25 mL 静推' },
  ],

  stemi: [
    { id:'antiplatelet', when: S => (S.stemi || 0) > 0.1,
      c:'冠脉内血栓形成', d:'双联抗血小板 + 抗凝', s:'阿司匹林 300 mg 嚼服 + 氯吡格雷 300 mg + 肝素' },
    { id:'reperf', when: S => (S.stemi || 0) > 0.15,
      c:'ST 段抬高提示透壁缺血', d:'再通是唯一能救心肌的办法', s:'急诊 PCI（操作），争取 90 分钟内开通' },
    { id:'nitro', when: S => S.map > 95 && (S.stemi || 0) > 0.2,
      c:'胸痛明显', d:'硝酸甘油缓解症状但不改善预后', s:'硝酸甘油 0.5 mg 舌下；血压偏低时禁用' },
  ],

  burn: [
    { id:'airway', when: S => (S.airwayResistance || 0) > 0.6 || S.spo2 < 93,
      c:'吸入性损伤：气道正在肿', d:'先保气道，再谈补液', s:'气管插管（操作） + 高流量吸氧' },
    { id:'fluid', when: S => S.uo < 0.6 || S.vol < 4.2,
      c:'烧伤后大量血浆渗漏', d:'按体重与面积补液', s:'乳酸林格液：约 4 mL × 体重(kg) × 烧伤面积(%)，前 8 小时给一半' },
    { id:'k', when: S => S.k > 5.5,
      c:'肌肉与红细胞破坏释放钾', d:'先保护心肌', s:'葡萄糖酸钙 10 mL 静推，随后胰岛素 + 葡萄糖' },
  ],

  tbi: [
    { id:'mannitol', when: S => (S.icp || 0) > 0.6,
      c:'颅内压升高，脑疝风险', d:'先脱水降颅压', s:'20% 甘露醇 250 mL 快速静滴（或 3% 高渗盐水 150 mL）' },
    { id:'craniotomy', when: S => (S.hematoma || 0) > 0.1,
      c:'血肿占位不会自己消失', d:'必须开颅清除', s:'开颅血肿清除（操作）' },
    { id:'cushing', when: S => S.hr < 60 && root.LIFE.bp(S).sys > 150,
      c:'Cushing 反应：血压高、心率慢', d:'是颅内压极高的信号，不是高血压病', s:'立即降颅压并准备手术，不要单纯降压' },
  ],

  tca: [
    { id:'bicarb', when: S => (S.tca || 0) > 0.3,
      c:'QRS 增宽提示三环类毒性', d:'碳酸氢钠是解药', s:'碳酸氢钠 150 mL 静滴，目标 QRS < 120 ms' },
    { id:'airway', when: S => S.gcs <= 11,
      c:'意识抑制，气道风险', d:'必要时插管', s:'高流量吸氧，GCS≤8 考虑气管插管' },
  ],

  myxedema: [
    { id:'thyroxine', when: S => S.hr < 60 || S.temp < 35.5,
      c:'甲状腺素严重不足', d:'评估激素替代与呼吸支持', s:'在给药面板选择左甲状腺素的静脉途径，随访意识、体温和通气。体温偏低时，在「菜单 → 环境 / 场景」开启「被动保暖」' },
    { id:'steroid', when: S => S.svr < 20,
      c:'可能合并肾上腺皮质功能不全', d:'激素要同时给', s:'氢化可的松 100 mg 静推' },
    { id:'warm', when: S => Number.isFinite(S.temp) && S.temp < 36.1 && !S.env?.warming,
      c:'体温偏低会减慢药物代谢并抑制心肌收缩', d:'开启被动保暖', s:'打开「菜单 → 环境 / 场景」，开启「被动保暖」并监测体温' },
  ],
  liver: [
    { id:'lactulose', when: S => S.gcs < 13,
      c:'肝性脑病，血氨升高', d:'降氨治疗', s:'乳果糖 30 mL 口服/鼻饲，保持每日 2–3 次软便' },
    { id:'avoid', when: S => S.gcs < 13,
      c:'镇静药会加重肝性脑病', d:'避免镇静', s:'不要用地西泮等苯二氮卓类' },
    { id:'coag', when: S => (S.coag || 1) < 0.7,
      c:'凝血因子合成不足', d:'补充凝血因子', s:'新鲜冷冻血浆 2 U' },
  ],

  tamponade: [
    { id:'peric', when: S => (S.tamponade||0) > 0.2,
      c:'心包填塞，心室舒张不了', d:'穿刺抽液是唯一的确定性处理', s:'心包穿刺引流（操作 → 心包穿刺）' },
    { id:'fluid', when: S => S.vol < 4.5,
      c:'前负荷不足', d:'补液争取时间，但不能替代穿刺', s:'生理盐水 1000 mL 快速静滴' },
  ],
  heatstroke: [
    { id:'cool', when: S => S.temp > 38.5 && !S.env?.cooling,
      c:'核心体温过高，可能造成多器官损伤', d:'先物理降温', s:'打开「菜单 → 环境 / 场景」，开启「物理降温」，体温降到 38.5℃ 时自动停止' },
    { id:'fluid', when: S => S.vol < 4.2,
      c:'大量出汗与血管扩张导致容量不足', d:'降温同时补液', s:'生理盐水 1000 mL 快速静滴' },
  ],

  aki: [
    { id:'ca', when: S => S.k > 6.0,
      c:'血钾已到危急值', d:'先保护心肌', s:'葡萄糖酸钙 10 mL 缓慢静推' },
    { id:'dialysis', when: S => S.k > 5.5 || (S.cr || 0) > 500,
      c:'肾衰本身不会靠药物好转', d:'该透析了', s:'血液透析（操作 → 血液透析）' },
    { id:'insulin', when: S => S.k > 5.5,
      c:'把钾暂时挪进细胞', d:'过渡措施，不能替代透析', s:'胰岛素 10 U + 50% 葡萄糖 25 mL' },
  ],

  pancreatitis: [
    { id:'fluid', when: S => S.vol < 4.0,
      c:'第三间隙丢失，有效循环血量不足', d:'先补液', s:'生理盐水 1000 mL 快速静滴，留置导尿看尿量' },
    { id:'pain', when: S => S.hr > 110,
      c:'疼痛与低容量都在推心率', d:'补容量的同时镇痛', s:'吗啡 5 mg 静推（注意呼吸抑制）' },
  ],
  hhs: [
    { id:'fluid', when: S => S.vol < 4.1,
      c:'严重脱水是高渗状态的核心', d:'先补液再降糖', s:'生理盐水 1000 mL 静滴，第一小时快速补' },
    { id:'insulin', when: S => S.glu > 25,
      c:'血糖极高', d:'小剂量胰岛素泵入，别快降', s:'胰岛素 0.05–0.1 U/kg/h，每小时血糖降幅 ≤ 4' },
    { id:'na', when: S => S.na > 148,
      c:'血钠仍高', d:'逐步纠正并复查渗透压', s:'血钠 24 小时内下降不超过 10 mmol/L' },
    { id:'osm', when: S => S.vol >= 4.2 && 2 * S.na + S.glu + S.bun >= 300,
      c:'高渗仍未纠正', d:'继续复查血钠和血清渗透压',
      s:'容量复苏和胰岛素治疗充分后，若渗透压下降不足，可考虑 0.45% 氯化钠' },
  ],
  co: [
    { id:'obs', when: S => S.gcs < 14,
      c:'意识障碍提示脑缺氧', d:'复查碳氧血红蛋白，警惕迟发性脑病', s:'持续高流量氧；意识差时气管插管 + 机械通气' },
    { id:'o2', when: S => (S.coHb || 0) > 0.05,
      c:'一氧化碳占据血红蛋白，血氧读数不可靠', d:'高流量吸氧是解药', s:'高流量吸氧（操作 → 高流量吸氧）；意识差时气管插管' },
  ],

  ptx: [
    { id:'needle', when: S => (S.tensionPTX||0) > 0.2,
      c:'张力性气胸，回心血量被压住',
      d:'先减压，升压药救不了',
      s:'针刺减压（锁骨中线第二肋间），随后胸腔闭式引流' },
    { id:'o2', when: S => S.spo2 < 92 && !S.o2,
      c:'严重低氧', d:'减压的同时给氧', s:'高流量吸氧 15 L/min' },
  ],
  trauma: [
    { id:'tour', when: S => S.bleedingSites.trauma > 0 && S.externalBleed && !S.tourniquetApplied,
      c:'外出血还在继续', d:'先压迫止血', s:'止血带 / 加压包扎，记录时间' },
    { id:'fluid', when: S => S.vol < 4.0,
      c:'失血性休克，容量不足', d:'限制性液体复苏', s:'生理盐水 1000 mL 快速静滴，维持收缩压 80–90' },
    { id:'blood', when: S => S.hb < 90,
      c:'血红蛋白低，携氧不足', d:'输血', s:'浓缩红细胞 2 U' },
    { id:'surgery', when: S => S.bleedingSites.trauma > 0 && S.t > 900,
      c:'出血没止住，靠补液撑不住', d:'确定性止血', s:'急诊手术止血' },
  ],

  asthma: [
    { id:'o2', when: S => S.spo2 < 92 && !S.o2,
      c:'低氧是当前最紧迫的问题',
      d:'先坐位给氧，把氧储备托住',
      s:'高流量吸氧 15 L/min' },
    { id:'beta', when: S => (S.obstruct||0) > 0.35 && !active(S,'salbutamol'),
      c:'气道痉挛还没打开，哮鸣音明显',
      d:'β₂ 激动剂是解痉主力，可以重复',
      s:'沙丁胺醇 2.5 mg 雾化，20 分钟后可重复' },
    { id:'anti', when: S => (S.obstruct||0) > 0.35 && !active(S,'ipratropium'),
      c:'单用 β₂ 激动剂效果不够',
      d:'联合抗胆碱能药',
      s:'异丙托溴铵 0.5 mg 雾化' },
    { id:'steroid', when: S => !active(S,'hydrocortisone') && !active(S,'dexamethasone'),
      c:'气道炎症需要时间消退',
      d:'全身激素要早给，别等病情恶化',
      s:'氢化可的松 100 mg 静推' },
  ],
  op: [
    { id:'atropine', when: S => S.hr < 55 || S.cholinergic > 0.5,
      c:'当前心率或胆碱能负荷提示仍需评估毒蕈碱样症状',
      d:'阿托品对抗毒蕈碱样症状，可重复',
      s:'阿托品 1 mg 静推，每 5–10 分钟重复至分泌物干燥' },
    { id:'pra', when: S => !active(S,'pralidoxime'),
      c:'胆碱酯酶被抑制，烟碱样和中枢症状不会自己好',
      d:'要复活胆碱酯酶',
      s:'碘解磷定 1 g 静滴' },
    { id:'o2', when: S => S.spo2 < 92,
      c:'支气管分泌物造成低氧',
      d:'先给氧，再解毒',
      s:'高流量吸氧，必要时吸痰' },
  ],
  apap: [
    { id:'nac', when: S => !active(S,'nacetylcysteine') && S.t < 8 * 3600,
      c:'对乙酰氨基酚已吸收，肝毒性正在启动',
      d:'解毒剂越早越好，8 小时后疗效明显下降',
      s:'N-乙酰半胱氨酸 150 mg/kg 静滴' },
    { id:'obs', when: S => S.t < 2 * 3600,
      c:'现在没有症状，但肝损窗口还没过',
      d:'需要观察，不能直接放走',
      s:'留观 2 小时，复查肌酐、乳酸与凝血' },
    { id:'liver', when: S => S.cr > 130 || S.lac > 3,
      c:'已经出现肝肾综合征/乳酸升高',
      d:'按肝衰竭处理，别只盯着转氨酶',
      s:'继续 NAC，纠正低血糖与凝血，必要时转 ICU' },
  ],
  htn: [
    { id:'sbp', when: S => (S.htn||0) > 0.6,
      c:'血压已达高血压急症水平，脑灌注随时出事',
      d:'需要静脉降压，平稳而不是骤降',
      s:'尼卡地平从 5 mg/h 持续静脉泵入，监测血压与心率后再调速' },
    { id:'target', when: S => (S.htn||0) > 0.35,
      c:'收缩压还没降到目标',
      d:'第一小时降幅别超过 25%',
      s:'继续泵入并每 5–10 分钟评估血压' },
    { id:'brain', when: S => S.gcs < 13,
      c:'意识下降提示高血压脑病',
      d:'降压同时保护脑灌注',
      s:'控制血压、头高位、必要时请神经科' },
  ],
  hypona: [
    { id:'odsrate', when: S => (S.odsRisk || 0) >= 0.8,
      c:'血钠升幅接近或超过限额',
      d:'首个 24 小时升幅不超过 10 mmol/L，随后每 24 小时不超过 8 mmol/L',
      s:'停止追加高渗盐水，复查血钠后再决定' },
    { id:'hss', when: S => S.na < 120 && S.na - (S.na0 ?? S.na) < 4,
      c:'重度低钠，脑水肿随时可能抽搐',
      d:'先用高渗盐水把血钠抬 4–6 mmol/L',
      s:'3% 高渗盐水 150 mL 静滴，10–20 分钟后评估' },
    { id:'brain', when: S => S.gcs < 13,
      c:'意识改变已经是低钠性脑病的表现',
      d:'先稳血钠，再查病因',
      s:'高渗盐水 + 头高位，抽搐时止痉' },
    { id:'cause', when: S => !S.hyponatremiaCauseControlled,
      c:'噻嗪和过量饮水会继续加重低钠',
      d:'处理诱因并监测血钠',
      s:'操作 → 停用噻嗪并限制饮水' },
    { id:'follow', when: S => S.na < 130 && S.na - (S.na0 ?? S.na) >= 4,
      c:'初始升钠目标已达到，血钠尚待恢复',
      d:'按每日限额分阶段纠正',
      s:'复查血钠及神经状态，避免短时间重复追加高渗盐水' },
    { id:'fast', when: S => S.na > 145,
      c:'血钠已超出恢复区间',
      d:'停止追加高渗盐水并复查',
      s:'评估游离水与近期血钠升幅，监测神经症状' },
  ],
  pe: [
    { id:'o2', when: S => S.spo2 < 92,
      c:'大面积肺栓塞的氧合很差',
      d:'先给氧，必要时无创通气',
      s:'高流量吸氧 15 L/min' },
    { id:'anti', when: S => !active(S,'heparin') && !active(S,'alteplase'),
      c:'血栓还在，右心负荷持续加重',
      d:'抗凝是基础，血流动力学不稳要溶栓',
      s:'肝素 5000 U 静推；血压不稳时阿替普酶溶栓' },
    { id:'flow', when: S => root.LIFE.bp(S).sys < 90 || S.map < 65,
      c:'梗阻性休克，血压靠代偿撑着',
      d:'谨慎补液，必要时去甲肾上腺素',
      s:'生理盐水 500 mL 小量试补，血压仍低则泵入去甲肾上腺素' },
  ],
};

/* ---------- 提示 ---------- */
function hints(S) {
  const keys = (S.tags && S.tags.length) ? S.tags : [S.caseId];
  const list = [];
  if (S.rhythm === 'asystole') {
    list.push({ id:'asystole_cpr', c:'心静止，立即复苏',
      d:'继续胸外按压并支持通气', s:'静推肾上腺素，同时处理可逆病因' });
  }
  for (const k of keys) {
    for (const r of (RULES[k] || [])) {
      let on = false;
      try { on = r.when(S); } catch (e) { on = false; }
      if (on) list.push(r);
    }
  }
  return list;
}

function advise(S, level) {
  const L = LEVELS[level] || LEVELS.intern;
  if (L.detail === 0) return { empty: true, text: '上级医师不在。自己判断。' };
  const hs = hints(S);
  if (!hs.length) return { empty: true, text: '目前没有需要特别处理的问题。' };
  const h = hs[0];
  const text = L.detail >= 3 ? `${h.c}。${h.d}——${h.s}`
             : L.detail === 2 ? `${h.c}。${h.d}。`
             : `${h.c}。`;
  return { empty: false, id: h.id, text, count: hs.length };
}

/* ---------- 操作评价 ---------- */
/* 用标签判断病种：随机生成的病例 caseId 永远是 'gen'，不能用 caseId 判断 */
function hasTag(S, t) { return !!(S && S.tags && S.tags.indexOf(t) >= 0); }

function evaluate(S, kind, id, payload) {
  const s = S;
  const say = (ok, msg) => ({ ok, msg });

  if (kind === 'drug') {
    switch (id) {
      case 'kcl':
        if (s.k > 5.0) return say(false, '当前血钾偏高，继续补钾会加重风险');
        return say(true, '已给予补钾，请复查血钾');
      case 'calcium':
        if (!hasTag(s, 'highK') && s.k < 5.5) return say(false, '没有高钾时钙剂没有适应证');
        if (s.t < s.caProtectUntil - 45 * 60 + 60) return say(true, '钙剂已给，保护窗口内不必重复');
        return say(true, '时机正确：先保护心肌，再降钾');
      case 'insulin':
        if (hasTag(s, 'highK') && s.glu < 6) return say(false, '血糖不高，胰岛素必须配伍葡萄糖，小心低血糖');
        if (insulinActivity(s) > 2.5) return say(false, '胰岛素已经给得偏多，注意监测血糖和血钾');
        if (hasTag(s, 'dka') && s.glu < 12) return say(false, '血糖已接近目标，继续给会有低血糖风险');
        return say(true, '剂量在常规范围');
      case 'bicarb':
        if (s.ph > 7.20) return say(false, 'pH 还可以，此时纠酸收益不大，反而可能碱中毒');
        return say(true, '酸中毒明显，纠酸合理');
      case 'saline':
        if (s.vol > 5.0) return say(false, '容量已经补足，继续大量补液有肺水肿风险');
        return say(true, '扩容合理');
      case 'prbc':
        if (s.hb > 90) return say(false, '血红蛋白还不至于要输血');
        return say(true, '输血指征明确');
      case 'norepi':
        if (s.vol < 4.0) return say(false, '容量没补足就上升压药，会掩盖问题');
        return say(true, '血管活性药使用合理');
      case 'nicardipine':
        if (!hasTag(s, 'htn') || root.LIFE.bp(s).sys <= 160) return say(false, '请先确认持续高血压及急性靶器官受损，再考虑静脉降压');
        return say(true, '可用尼卡地平平稳降压，连续监测血压和心率');
      case 'levetiracetam':
        if (!hasTag(s, 'seizure') || s.seizure <= 0.2) return say(false, '请先确认仍有惊厥发作，再评估二线负荷治疗');
        if (!triedSeizureRescue(s)) return say(false, '持续惊厥应先给予足量苯二氮卓，并监测呼吸');
        return say(true, '一线治疗后仍有抽搐，可以加用二线止惊药');
      default:
        return say(true, '已执行');
    }
  }

  if (kind === 'action') {
    if (id === 'defib') {
      if (s.rhythm === 'vf') return say(true, '室颤，除颤时机正确');
      if (s.rhythm === 'asystole') return say(false, '心静止无需除颤，请继续按压、静推肾上腺素并处理可逆病因');
      return say(false, '现在不是室颤，除颤没有适应证');
    }
    if (id === 'dialysis') {
      if (!hasTag(s, 'highK') && !hasTag(s, 'aki')) return say(false, '本例没有透析指征');
      if (s.k < 5.0) return say(false, '血钾已经不高，透析收益有限');
      return say(true, '透析指征明确');
    }
    if (id === 'endoscopy') {
      if (!(s.bleedingSites.bleed > 0)) return say(false, '当前没有活动性消化道出血');
      if (s.map < 65) return say(false, '血压太低，内镜风险过高');
      return say(true, '时机合适');
    }
    return say(true, '');
  }
  return say(true, '');
}

root.MENTOR = { LEVELS, RULES, hints, advise, evaluate };
})(typeof globalThis !== 'undefined' ? globalThis : this);



