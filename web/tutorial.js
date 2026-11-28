/* ==========================================================================
 * 教程（纯手动查阅，不主动弹出、不限制操作）
 * 入口：菜单 → 教程 · 怎么玩
 * 原则：教程是说明书，不是关卡
 * ========================================================================== */
(function (root) {
'use strict';

const PAGES = [
  {
    id: 'what', title: '这是什么', html: `
      <div class="tut-h">你是一名病房值班医生</div>
      <div class="tut-row"><b>目标</b><span>把病人治好、活着送出院。治不好或治死，都算这局结束。</span></div>
      <div class="tut-row"><b>方式</b><span>问病史 → 查体 → 开检查 → 处理 → 复查，循环直到达标。</span></div>
      <div class="tut-row"><b>难点</b><span>时间一直在走。血钾还没降下来，隔壁床血压又掉了。</span></div>
      <div class="tut-note">游戏不会直接告诉你病名。诊断要靠你自己问出来、查出来，结算时才揭晓。</div>`,
  },
  {
    id: 'flow', title: '一局的完整流程', html: `
      <div class="tut-h">七步</div>
      <div class="tut-row"><b>1 接诊</b><span>大厅点「接诊新患者」，或在一张空床上接一位。</span></div>
      <div class="tut-row"><b>2 看主诉</b><span>开局弹窗只给主诉。姓名旁「病例说明」可以再看一次。</span></div>
      <div class="tut-row"><b>3 问诊</b><span>「检查」页问患者、家属、目击者、急救人员或调阅既往病历。</span></div>
      <div class="tut-row"><b>4 查体</b><span>同页做床旁查体：瞳孔、双肺听诊、循环灌注、腹部压痛……</span></div>
      <div class="tut-row"><b>5 开检查</b><span>血气、电解质、血常规、心电图、床旁胸片等，有采样与回报时间。</span></div>
      <div class="tut-row"><b>6 处理</b><span>给药、操作（补液、吸氧、导尿、除颤……），然后等起效。</span></div>
      <div class="tut-row"><b>7 复评出院</b><span>复查关键指标，达标后在菜单首项「出院评估」办理出院。</span></div>
      <div class="tut-note">第一步永远是「先确认他会不会马上死」：气道、呼吸、循环。</div>`,
  },
  {
    id: 'screen', title: '屏幕导览', html: `
      <div class="tut-h">六个区域</div>
      <div class="tut-row"><b>顶栏</b><span>左上返回大厅；姓名旁「病例说明」；中间是时钟；右侧自付金额、暂停、倍速、等病情变化。</span></div>
      <div class="tut-row"><b>生命体征</b><span>心率、血压、呼吸、血氧、体温、意识。圆点变红就是异常。</span></div>
      <div class="tut-row"><b>人体图谱</b><span>点器官看对应参数。选心脏会显示最近 4 秒心电图。</span></div>
      <div class="tut-row"><b>临床状态</b><span>系统给的体征提示（如「酸血症」「低氧血症」），点击可查解释。</span></div>
      <div class="tut-row"><b>器官参数</b><span>随选中器官切换，是判断"哪个系统在崩"的地方。</span></div>
      <div class="tut-row"><b>底栏</b><span>报告 / 检查 / 操作 / 给药 / 菜单。出院、住院册、术语表都在菜单里。</span></div>`,
  },
  {
    id: 'intake', title: '怎么问病史', html: `
      <div class="tut-h">五个来源，五个主题</div>
      <div class="tut-row"><b>来源</b><span>患者自述、家属转述、现场目击、急救交接、既往病历。同一件事不同来源可能说法不同。</span></div>
      <div class="tut-row"><b>主题</b><span>现病史、既往史、用药与暴露、药物过敏、院前情况。</span></div>
      <div class="tut-row"><b>先问什么</b><span>起病时间、诱因、进展、伴随症状、用过什么药、有没有过敏。</span></div>
      <div class="tut-row"><b>急诊首诊</b><span>难度 6 时病历几乎空白，必须靠问诊+查体+检查自己取证。</span></div>
      <div class="tut-note">问诊不花时间也不花钱，是性价比最高的信息源。先把能问的都问了。</div>`,
  },
  {
    id: 'exam', title: '查体与开检查', html: `
      <div class="tut-h">先便宜、快、能定位的</div>
      <div class="tut-row"><b>床旁查体</b><span>10 项：意识与抽搐、双侧瞳孔、气道与呼吸、双肺听诊、循环灌注、双下肢、腹部、尿量等。立即出结果。</span></div>
      <div class="tut-row"><b>快速床旁</b><span>指尖血糖、床旁血酮、12 导联心电图。几分钟出结果。</span></div>
      <div class="tut-row"><b>常规化验</b><span>血气、电解质+肾功、血常规、乳酸、凝血。有采样与回报延迟。</span></div>
      <div class="tut-row"><b>影像</b><span>床旁胸片、床旁超声、CT。用来确认气胸、肺水、积液、出血。</span></div>
      <div class="tut-row"><b>复查</b><span>治疗后再抽一次，看趋势。单点值正常不代表在好转。</span></div>
      <div class="tut-note">在途检查会占用时间与费用。别一上来就把 25 项全开了。</div>`,
  },
  {
    id: 'read', title: '怎么读一个数字', html: `
      <div class="tut-h">三步</div>
      <div class="tut-row"><b>1 对标正常</b><span>先看它偏离正常多少。术语表里每条都写了正常范围。</span></div>
      <div class="tut-row"><b>2 看趋势</b><span>「指标走势」里比单点值更重要：在变好还是变坏。</span></div>
      <div class="tut-row"><b>3 找病因</b><span>同一个异常有多种原因。血钾高可能是肾衰、溶血、酸中毒、补钾过量。</span></div>
      <div class="tut-h" style="margin-top:14px">最先看这几个</div>
      <table class="tut-tb">
        <tr><th>指标</th><th>危险线</th><th>意味着</th></tr>
        <tr><td>MAP</td><td>&lt; 65</td><td>器官开始灌注不足</td></tr>
        <tr><td>SpO₂</td><td>&lt; 90%</td><td>组织缺氧</td></tr>
        <tr><td>血钾</td><td>&gt; 6.5</td><td>致命心律失常</td></tr>
        <tr><td>pH</td><td>&lt; 7.20</td><td>重度酸中毒，升压药失效</td></tr>
        <tr><td>GCS</td><td>≤ 8</td><td>需要气道保护</td></tr>
      </table>`,
  },
  {
    id: 'drug', title: '怎么给药', html: `
      <div class="tut-h">四步</div>
      <div class="tut-row"><b>1 选药</b><span>「给药」里按类别展开，或直接搜药名、别名（如"泰诺"能搜到对乙酰氨基酚）。</span></div>
      <div class="tut-row"><b>2 看详情</b><span>每味药都写了作用、适应与优点、风险与禁忌、用法要点。给之前看一眼。</span></div>
      <div class="tut-row"><b>3 选途径</b><span>静推起效快、维持短；口服起效慢；泵入要设速率。同一种药不同途径效果不同。</span></div>
      <div class="tut-row"><b>4 调剂量</b><span>按体重和病情调。剂量不足没效果，过量会中毒。</span></div>
      <div class="tut-h" style="margin-top:14px">泵入类</div>
      <div class="tut-row"><b>去甲肾上腺素</b><span>感染性休克首选升压药。补足容量后再上，按 µg/min 调。</span></div>
      <div class="tut-row"><b>多巴酚丁胺</b><span>血压还行但心排低时用。会致心动过速。</span></div>
      <div class="tut-row"><b>胰岛素</b><span>DKA/HHS 降糖、高钾转移。必须配葡萄糖，之后复查血钾。</span></div>
      <div class="tut-note">给药后记得回来复查：血压、心率、血钾、血糖，看它到底起没起效。</div>`,
  },
  {
    id: 'judge', title: '怎么判断有效', html: `
      <div class="tut-h">看对指标，给足时间</div>
      <div class="tut-row"><b>升压药</b><span>看 MAP 是否上升、乳酸是否下降。5–10 分钟评估一次。</span></div>
      <div class="tut-row"><b>补液</b><span>看血压、心率、尿量、CVP。补不够无效，补过头会肺水肿。</span></div>
      <div class="tut-row"><b>利尿</b><span>看尿量、肺水、体重（容量）。脱过头会低血压。</span></div>
      <div class="tut-row"><b>抗生素</b><span>看体温、白细胞、乳酸。起效要几小时，别急着换药。</span></div>
      <div class="tut-row"><b>止血</b><span>看血压、血红蛋白、出血部位是否还在渗。</span></div>
      <div class="tut-note">治疗无效时先问三个问题：诊断对吗？剂量够吗？还有别的原因没处理吗？</div>`,
  },
  {
    id: 'time', title: '时间与多床', html: `
      <div class="tut-h">时间是最贵的资源</div>
      <div class="tut-row"><b>倍速</b><span>1× 正常；4×、16× 加速；「快进 20×」最快，但病情也更快恶化。</span></div>
      <div class="tut-row"><b>等病情变化</b><span>全病房快进，任一床出现明显变化或危急就自动停下并恢复 1×。安全的等待方式。</span></div>
      <div class="tut-row"><b>暂停</b><span>冻结所有床位，用来思考或查术语表。「禁用暂停」规则下不可用。</span></div>
      <div class="tut-row"><b>多床</b><span>最多 4 张床同步流逝。底部胶囊切换；某床出院或死亡，床位自动空出。</span></div>
      <div class="tut-row"><b>取舍</b><span>两床同时危急时，先救"几分钟内会死"的那个。</span></div>
      <div class="tut-note">新手最常见的问题不是不会治，而是"一直在看一张床"。</div>`,
  },
  {
    id: 'discharge', title: '出院与签字', html: `
      <div class="tut-h">两种出院</div>
      <div class="tut-row"><b>正常出院</b><span>菜单首项「出院评估」，全部达标才能办理。</span></div>
      <div class="tut-row"><b>签字出院</b><span>开启「真实出院」后，你可以不达标也放人，但要承担后果。</span></div>
      <div class="tut-h" style="margin-top:14px">签字的三种结果</div>
      <table class="tut-tb">
        <tr><th>情况</th><th>结果</th></tr>
        <tr><td>全部达标</td><td>正常结算</td></tr>
        <tr><td>只有一般问题</td><td>扣 30 分，没有用时奖励</td></tr>
        <tr><td>有重大问题</td><td>本例失败，0 分</td></tr>
      </table>
      <div class="tut-note">重大问题的判定看生命体征、治疗依赖和病例专属规则——不是你想签就能签。</div>`,
  },
  {
    id: 'trap', title: '新手十个坑', html: `
      <div class="tut-h">踩过的人都懂</div>
      <div class="tut-row"><b>1</b><span>血压低就上升压药，不补容量。顺序反了会越治越坏。</span></div>
      <div class="tut-row"><b>2</b><span>只看 SpO₂ 不看 PaCO₂。呼吸变浅时血氧可能还行，二氧化碳已经爆表。</span></div>
      <div class="tut-row"><b>3</b><span>血钾高只想着排钾，忘了先给钙保护心脏。</span></div>
      <div class="tut-row"><b>4</b><span>低钠纠正太快。24 小时升幅超过 10 mmol/L 会脱髓鞘。</span></div>
      <div class="tut-row"><b>5</b><span>胰岛素给了不补葡萄糖，治成低血糖。</span></div>
      <div class="tut-row"><b>6</b><span>利尿过头，肺水肿治成了低血容量休克。</span></div>
      <div class="tut-row"><b>7</b><span>过敏体质给了头孢，直接过敏性休克。</span></div>
      <div class="tut-row"><b>8</b><span>血氧 100% 就撤氧，忘了看他是不是还在分流。</span></div>
      <div class="tut-row"><b>9</b><span>一直盯着最危的那床，另一床悄悄恶化。</span></div>
      <div class="tut-row"><b>10</b><span>不复查。给完药就当治好了。</span></div>`,
  },
  {
    id: 'mode', title: '难度与现实规则', html: `
      <div class="tut-h">六档难度</div>
      <div class="tut-row"><b>1–2</b><span>单一病理，病史完整。适合熟悉操作。</span></div>
      <div class="tut-row"><b>3</b><span>两种病理叠加，开始互相影响。</span></div>
      <div class="tut-row"><b>4–5</b><span>三种病理 + 基础病 + 特殊体质，初始病史逐级减少。</span></div>
      <div class="tut-row"><b>6 急诊首诊</b><span>病情同 5 级，但病历几乎空白，全靠自己取证。</span></div>
      <div class="tut-h" style="margin-top:14px">三个现实规则（可独立开关）</div>
      <div class="tut-row"><b>医保与自付</b><span>计床位费与药费，自付超上限影响评分。</span></div>
      <div class="tut-row"><b>真实出院</b><span>允许签字放人，但可能扣分或判失败。</span></div>
      <div class="tut-row"><b>禁用暂停</b><span>不能停表，必须在流动的时间里决策。</span></div>`,
  },
  {
    id: 'tools', title: '随身工具', html: `
      <div class="tut-h">都在菜单里</div>
      <div class="tut-row"><b>术语表</b><span>320+ 条：症状体征、药物利弊（覆盖药库全部 183 种药）、操作疗法、异常指标、玩法说明。可分类筛选与搜索。</span></div>
      <div class="tut-row"><b>行医手册</b><span>记录你遇到过的诊断、用过的疗法、踩过的坑。没遇到过就不会有。</span></div>
      <div class="tut-row"><b>指标走势</b><span>血压、心率、血钾、血糖等随时间变化。判断趋势靠它。</span></div>
      <div class="tut-row"><b>病历档案</b><span>已结束病例的归档，可回看诊断与处置。病名在这里出现。</span></div>
      <div class="tut-row"><b>会诊</b><span>把病例导出成会诊码，交给别人接手或复盘。</span></div>
      <div class="tut-row"><b>统计 / 成就</b><span>出院率、平均耗时费用、最常犯的错。</span></div>`,
  },
  {
    id: 'demo', title: '一局示例：血钾 6.8', html: `
      <div class="tut-h">从接诊到出院</div>
      <div class="tut-row"><b>① 主诉</b><span>「少尿伴心悸、乏力 2 天」。有心律问题风险，先看监护。</span></div>
      <div class="tut-row"><b>② 体征</b><span>HR 131、血压偏低、SpO₂ 91%、GCS 13。先判断：循环不稳 + 可能高钾。</span></div>
      <div class="tut-row"><b>③ 问诊</b><span>问出「慢性肾病 3 期、近期尿量减少」→ 排钾能力下降。</span></div>
      <div class="tut-row"><b>④ 检查</b><span>心电图（看 T 波高尖、QRS 增宽）+ 电解质。确认血钾。</span></div>
      <div class="tut-row"><b>⑤ 处理</b><span>先静推葡萄糖酸钙保护心肌 → 胰岛素+葡萄糖把钾推进细胞 → 严重时透析。</span></div>
      <div class="tut-row"><b>⑥ 复查</b><span>20–30 分钟后复测血钾与心电图，看钾是否下降、QRS 是否变窄。</span></div>
      <div class="tut-row"><b>⑦ 出院</b><span>血钾回到 3.5–5.5、血压心率稳定、无心律失常，评估后出院。</span></div>
      <div class="tut-note">注意：给钙只是"保护心脏"，不降钾；真正把钾弄走要靠胰岛素+葡萄糖或透析。</div>`,
  },
];

const CSS = `
.tut-h{font-size:15px;font-weight:700;margin:6px 0 12px;}
.tut-row{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f2eeec;font-size:13.5px;line-height:1.55;}
.tut-row b{flex:0 0 84px;color:#a33;font-weight:600;}
.tut-row span{flex:1;color:var(--ink);}
.tut-note{margin-top:14px;padding:11px 13px;background:#faf7f5;border-radius:10px;font-size:12.5px;color:#6b625d;line-height:1.6;}
.tut-tb{width:100%;border-collapse:collapse;font-size:12.5px;}
.tut-tb th{text-align:left;color:#9a8f89;font-weight:500;padding:7px 6px;border-bottom:1px solid #ece7e4;}
.tut-tb td{padding:8px 6px;border-bottom:1px solid var(--line);color:var(--ink);}
.tut-tb td:first-child{font-weight:600;}
.tut-pager{display:flex;gap:7px;justify-content:center;padding:14px 0 4px;}
.tut-pager i{width:6px;height:6px;border-radius:50%;background:#ded7d3;display:block;}
.tut-pager i.on{background:#a33;}
`;

function injectCSS() {
  if (document.getElementById('tut-css')) return;
  const st = document.createElement('style');
  st.id = 'tut-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* 打开教程（第 i 页） */
function open(i) {
  injectCSS();
  const p = PAGES[i] || PAGES[0];
  const list = document.querySelector('#sheetList');
  document.querySelector('#sheetTitle').innerHTML = `教程 <small>${p.title} · ${i + 1}/${PAGES.length}</small>`;
  list.innerHTML = p.html + `
    <div class="tut-pager">${PAGES.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
    <div style="display:flex;gap:8px;padding:10px 0 4px">
      <button type="button" class="drow" data-pg="${i - 1}" style="flex:1;justify-content:center" ${i === 0 ? 'disabled' : ''}>上一页</button>
      <button type="button" class="drow" data-pg="${i + 1}" style="flex:1;justify-content:center" ${i === PAGES.length - 1 ? 'disabled' : ''}>下一页</button>
    </div>`;
  list.querySelectorAll('[data-pg]').forEach(el => {
    el.addEventListener('click', () => open(+el.dataset.pg));
  });
  document.querySelector('#sheet').classList.add('on');
  document.querySelector('#mask').classList.add('on');
}

const API = { PAGES, open };
root.TUTORIAL = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
