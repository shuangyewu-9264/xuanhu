# -*- coding: utf-8 -*-
# 【历史脚本归档】医保参保类型切换
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/patch_ins_switch.py`
G = r'.\prototype\game.js'
B = r'.\tools\bridge.js'
s = open(G, encoding='utf-8', newline='').read()
b = open(B, encoding='utf-8', newline='').read()
n = 0

def repS(a, x, tag):
    global s, n
    if a in s:
        s = s.replace(a, x, 1); n += 1; return True
    a2 = a.replace('\n', '\r\n'); x2 = x.replace('\n', '\r\n')
    if a2 in s:
        s = s.replace(a2, x2, 1); n += 1; return True
    print('MISS(game):', tag); return False

def repB(a, x, tag):
    global b, n
    if a in b:
        b = b.replace(a, x, 1); n += 1; return True
    print('MISS(bridge):', tag); return False

# ---------- ① 参保类型可切换 ----------
repS("""function initInsurance() {
  if (!realism || !S) return;
  const k = INSURANCE[Math.floor(Math.random() * INSURANCE.length)];""",
"""function initInsurance(forceType) {
  if (!realism || !S) return;
  let k;
  if (forceType != null) {
    const list = INSURANCE;
    k = forceType === 'random' ? list[Math.floor(Math.random() * list.length)] : (list.find(x => x.t === forceType) || list[0]);
  } else {
    k = INSURANCE[Math.floor(Math.random() * INSURANCE.length)];
  }""", 'init')

repS("""  S.ins = { ...k, income, oopCap: income * 3 };""",
"""  const keepIncome = (S.ins && S.ins.income) ? S.ins.income : income;
  S.ins = { ...k, income: keepIncome, oopCap: keepIncome * 3 };""", 'keep-income')

# 医保说明里加"切换参保类型"
repS("""    '<div style="padding:6px 14px 16px;font-size:12px;color:var(--ink-3);line-height:1.8">' +
      '不想被费用约束？主页「现实模式」按钮点一下就能关掉，随时可以再开。' +
    '</div>';""",
"""    '<div class="sec">切换参保类型</div>' +
    '<div style="display:flex;gap:6px;padding:0 14px 10px;flex-wrap:wrap">' +
      ['职工医保', '居民医保', '异地自费', 'random'].map(t =>
        '<button data-ins="' + t + '" class="pill" style="flex:1;min-width:80px;padding:9px;cursor:pointer;' +
        ((S && S.ins && (S.ins.t === t || (t === 'random' && false))) ? 'background:rgba(211,58,58,.12);color:#a33;font-weight:700' : '') +
        '">' + (t === 'random' ? '随机重抽' : t) + '</button>').join('') +
    '</div>' +
    '<div style="padding:6px 14px 16px;font-size:12px;color:var(--ink-3);line-height:1.8">' +
      '不想被费用约束？主页「现实模式」按钮点一下就能关掉，随时可以再开。' +
    '</div>';""", 'switch-ui')

repS("""function openInsuranceHelp() {
  openSheet('医保怎么算', '现实模式', []);
  const list = document.querySelector('#sheetList');
  if (!list) return;""",
"""function openInsuranceHelp() {
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
  };""", 'bind')

# 绑定（在 innerHTML 之后调用）
repS("""      '不想被费用约束？主页「现实模式」按钮点一下就能关掉，随时可以再开。' +
    '</div>';
}""",
"""      '不想被费用约束？主页「现实模式」按钮点一下就能关掉，随时可以再开。' +
    '</div>';
  bindSwitch();
}""", 'bind-call')

# 菜单直接加一行"切换医保"
repS("    {n:'医保说明', tag: realism ? '现实模式中' : '看看怎么算', amt:'查看', run: () => openInsuranceHelp()},",
     "    {n:'医保说明 / 切换', tag: realism ? ((S && S.ins ? S.ins.t : '未参保') + ' · 可切换') : '看看怎么算', amt:'查看', run: () => openInsuranceHelp()},", 'menu')

open(G, 'w', encoding='utf-8', newline='').write(s)
open(B, 'w', encoding='utf-8', newline='').write(b)
print('applied', n)
