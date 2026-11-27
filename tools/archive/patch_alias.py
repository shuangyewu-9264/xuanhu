# -*- coding: utf-8 -*-
# 【历史脚本归档】药名别名表
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/patch_alias.py`
S = r'.\prototype\substances.js'
G = r'.\prototype\game.js'
s = open(S, encoding='utf-8', newline='').read()
g = open(G, encoding='utf-8', newline='').read()
n = 0

# ① 别名表：常用叫法 → 药库里的正式名
ALIAS = '''
/* 别名：同一种药在不同教材/科室里的叫法不同，搜索时都要能命中 */
const ALIASES = {
  '氢化可的松': '氢化皮质酮',
  '氢化考的松': '氢化皮质酮',
  '可的松': '氢化皮质酮',
  '速尿': '呋塞米',
  '呋喃苯胺酸': '呋塞米',
  '小苏打': '碳酸氢钠',
  '副肾素': '肾上腺素',
  '正肾上腺素': '去甲肾上腺素',
  '解磷定': '碘解磷定',
  '纳络酮': '纳洛酮',
  '鲁米那': '苯巴比妥',
  '安定': '地西泮',
  '杜冷丁': '哌替啶',
  '吗啡注射液': '吗啡',
  '硝普钠针': '硝普钠',
  '西地兰': '去乙酰毛花苷',
  '心律平': '普罗帕酮',
  '胺碘酮片': '胺碘酮',
  '阿托品针': '阿托品',
  '葡萄糖酸钙针': '葡萄糖酸钙',
  '氯化钾针': '氯化钾',
  '止血敏': '酚磺乙胺',
  '垂体后叶素': '血管加压素',
  '去甲肾': '去甲肾上腺素',
  '地塞米松针': '地塞米松',
  '甲强龙': '甲泼尼龙',
  '甲泼尼龙': '甲泼尼龙',
};
'''
if 'const ALIASES = {' not in s:
    s = s.replace('const ALL = build();', ALIAS + '\nconst ALL = build();', 1)
    n += 1

# ② search 支持别名（双向）
old_search = """function search(q) {
  q = (q || '').trim();
  if (!q) return ALL;
  return ALL.filter(s => s.n.includes(q) || s.cls.includes(q) || (s.note || '').includes(q));
}"""
new_search = """function search(q) {
  q = (q || '').trim();
  if (!q) return ALL;
  /* 别名：用户搜"氢化可的松"要能找到"氢化皮质酮" */
  const canon = ALIASES[q] || '';
  return ALL.filter(s =>
    s.n.includes(q) || s.cls.includes(q) || (s.note || '').includes(q) ||
    (canon && s.n === canon) ||
    Object.keys(ALIASES).some(a => s.n === ALIASES[a] && a.includes(q))
  );
}"""
if old_search in s:
    s = s.replace(old_search, new_search, 1); n += 1
else:
    print('MISS search')

# ③ API 暴露别名
s = s.replace("const API = { ALL, INTERACTIONS,", "const API = { ALL, INTERACTIONS, ALIASES,", 1)

open(S, 'w', encoding='utf-8', newline='').write(s)

# ④ 药物列表行里显示别名，方便认
old_row = """          <span class="nm">${it.n}${it.note ? `<span style="font-size:10px;color:#b3a6a6"> · ${it.note}</span>` : ''}</span>"""
new_row = """          <span class="nm">${it.n}${(window.SUBSTANCES.ALIASES && Object.keys(window.SUBSTANCES.ALIASES).some(a => window.SUBSTANCES.ALIASES[a] === it.n)) ? `<span style="font-size:10px;color:#c8a0a0">（${Object.keys(window.SUBSTANCES.ALIASES).filter(a => window.SUBSTANCES.ALIASES[a] === it.n).slice(0,2).join('/')}）</span>` : ''}${it.note ? `<span style="font-size:10px;color:#b3a6a6"> · ${it.note}</span>` : ''}</span>"""
if old_row in g:
    g = g.replace(old_row, new_row, 1); n += 1
else:
    print('MISS row')

open(G, 'w', encoding='utf-8', newline='').write(g)
print('applied', n)
