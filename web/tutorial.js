/* ==========================================================================
 * 教程（纯手动查阅，不主动弹出、不限制操作）
 * 入口：菜单 → 教程 · 怎么玩
 * 原则：教程是说明书，不是关卡
 * ========================================================================== */
(function (root) {
'use strict';

const PAGES = [
  {
    id: 'basics', title: '三个动作', html: `
      <div class="tut-h">先记住三件事</div>
      <div class="tut-row"><b>点器官</b><span>中间的器官图，点哪个就看哪个的参数</span></div>
      <div class="tut-row"><b>给药</b><span>在底栏点「给药」，核对患者后选择药物、途径和剂量</span></div>
      <div class="tut-row"><b>时间控制</b><span>顶部可以暂停或选倍速。「等病情变化」会快进，遇到变化后恢复 1×。</span></div>
      <div class="tut-note">看数据 → 做处理 → 看变化。这就是全部。</div>`,
  },
  {
    id: 'layout', title: '屏幕上是什么', html: `
      <div class="tut-h">六个区域</div>
      <div class="tut-row"><b>患者信息</b><span>点姓名旁的「病例说明」，查看主诉、现病史和接诊首测。</span></div>
      <div class="tut-row"><b>生命体征</b><span>查看心率、血压、呼吸、血氧、体温和意识</span></div>
      <div class="tut-row"><b>人体视图</b><span>点选器官，与旁边的器官参数对照</span></div>
      <div class="tut-row"><b>临床状态</b><span>点击状态标签可查阅相关解释</span></div>
      <div class="tut-row"><b>器官参数</b><span>随选中的器官切换，选中心脏可查看心电图</span></div>
      <div class="tut-row"><b>底部操作</b><span>在「检查」问病史、查体或开单，在「报告」复阅结果。出院在「菜单」第一项，降温和保暖位于「操作 → 体温处置」。</span></div>`,
  },
  {
    id: 'vitals', title: '指标怎么看', html: `
      <div class="tut-h">正常范围与含义</div>
      <table class="tut-tb">
        <tr><th>指标</th><th>正常</th><th>意义</th></tr>
        <tr><td>HR 心率</td><td>60–100</td><td>太快泵血效率差，太慢输出不够</td></tr>
        <tr><td>MAP 平均动脉压</td><td>70–105</td><td>低于 65 器官灌注不足</td></tr>
        <tr><td>SpO₂ 血氧</td><td>≥94%</td><td>低于 90% 组织缺氧</td></tr>
        <tr><td>K 血钾</td><td>3.5–5.5</td><td>高于 6.5 可致心脏骤停</td></tr>
        <tr><td>pH</td><td>7.35–7.45</td><td>低于 7.2 重度酸中毒</td></tr>
        <tr><td>GCS 意识</td><td>15</td><td>≤8 需考虑气道保护</td></tr>
        <tr><td>Hb 血红蛋白</td><td>120–160</td><td>低于 70 携氧不足</td></tr>
      </table>`,
  },
  {
    id: 'drugs', title: '怎么给药', html: `
      <div class="tut-h">四步</div>
      <div class="tut-row"><b>1</b><span>点「给药」，展开「常用」「急救」或相应类别。也可直接搜索药名或别名。</span></div>
      <div class="tut-row"><b>2</b><span>点药名进详情，先看它的效应和注意事项</span></div>
      <div class="tut-row"><b>3</b><span>选给药途径（静推 / 口服 / 静滴…），不同途径起效和维持时间不同</span></div>
      <div class="tut-row"><b>4</b><span>调剂量（−/+ 或 0.5×/1×/2×/5×），然后给药</span></div>
      <div class="tut-note">剂量给多了会中毒，给少了没效果——游戏允许你给错，也允许你治死人。</div>`,
  },
  {
    id: 'tools', title: '随身工具', html: `
      <div class="tut-h">都在菜单里</div>
      <div class="tut-row"><b>行医手册</b><span>你自己遇到过的诊断、用过的疗法、结局和踩过的坑。系统不会替你补全。</span></div>
      <div class="tut-row"><b>指标走势</b><span>血压、心率、血钾、血糖等随时间的变化曲线，用来判断"在变好还是变坏"。</span></div>
      <div class="tut-row"><b>术语表</b><span>65 条医学名词的解释和正常范围。点击界面上的状态标签、生命体征标签，也能直接看解释。</span></div>
      <div class="tut-row"><b>病房床位</b><span>最多同时管 4 张床，时间同步流逝。底部胶囊显示床位状态，点一下就能切换；哪个床出院或死亡，床位就空出来。</span></div>
      <div class="tut-row"><b>现实模式</b><span>医保与自付、真实出院、禁用暂停可独立开启。真实出院由你评估并签字，判定理由在结算时公布。禁用暂停时仍可选倍速或等待病情变化。</span></div>
      <div class="tut-row"><b>统计</b><span>出院率、平均耗时费用、最常遇到的诊断与最常犯的错。</span></div>
      <div class="tut-row"><b>暂停</b><span>点击顶部倍速左侧的「暂停」，所有床位同时停表；点击「继续」恢复。</span></div>
      <div class="tut-note">可以随时从「病房」返回大厅查看床位。</div>`,
  },
  {
    id: 'critical', title: '危急情况', html: `
      <div class="tut-h">三种最常见的死法</div>
      <div class="tut-row"><b>室颤</b><span>立刻除颤（操作 → 电除颤）。越早成功率越高，拖久了会变成心静止</span></div>
      <div class="tut-row"><b>心跳停止</b><span>持续胸外按压，同时找可逆的原因（高钾？缺氧？失血？）</span></div>
      <div class="tut-row"><b>血压崩了</b><span>先补容量，容量补够还上不来再加升压药。顺序错了会越治越坏</span></div>
      <div class="tut-note">拿不准的时候，看右上角的异常状态，那是系统给出的线索。</div>`,
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
