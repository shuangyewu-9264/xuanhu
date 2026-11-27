# -*- coding: utf-8 -*-
# 【历史脚本归档】补齐甲泼尼龙、西地兰等缺失药物
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/add_missing_drugs.py`
S = r'.\prototype\substances.js'
s = open(S, encoding='utf-8', newline='').read()
n = 0

# 在糖皮质激素一组后面补常用药（原来缺的药）
anchor = "  ['dexamethasone','地塞米松',  '糖皮质激素',8, 'mg',     24, { e:{glu:+1.8} }],"
ADD = """  ['methylprednisolone','甲泼尼龙','糖皮质激素',40, 'mg',  42, { e:{glu:+1.6, svr:+0.5, temp:-0.15}, note:'哮喘/COPD 急性加重常用' }],
  ['deslanoside','去乙酰毛花苷','强心苷',0.4,'mg',  46, { r:'静推', on:10, du:720, e:{sv:+0.12, hr:-6}, note:'西地兰；急性心衰伴快速房颤' }],
  ['propafenone','普罗帕酮',   '抗心律失常',70,'mg', 38, { r:'静推', on:5, du:180, e:{hr:-8, sv:-0.03}, note:'心律平；房颤/室上速转复' }],
  ['pethidine', '哌替啶',      '阿片类',   50,'mg',  26, { r:'肌注', on:15, du:180, e:{rr:-3, gcs:-1, svr:-0.2}, note:'杜冷丁；镇痛' }],
  ['etamsylate','酚磺乙胺',    '止血药',   0.5,'g',  32, { e:{coag:+0.06}, note:'止血敏' }],
  ['amoxicillin','阿莫西林',   '抗生素',   1, 'g',   14, { r:'口服', on:45, du:480, note:'社区获得性感染' }],"""
if "methylprednisolone" not in s:
    s = s.replace(anchor, anchor + "\n" + ADD, 1); n += 1
else:
    print('drugs already present')

# 修正指向不存在药物的别名
s = s.replace("  '西地兰': '去乙酰毛花苷',\n", "")
s = s.replace("  '心律平': '普罗帕酮',\n", "")
s = s.replace("  '甲强龙': '甲泼尼龙',\n", "")
s = s.replace("  '甲泼尼龙': '甲泼尼龙',\n", "")
# 重新加一遍（现在药存在了）
if "'西地兰'" not in s:
    s = s.replace("  '杜冷丁': '哌替啶',", "  '西地兰': '去乙酰毛花苷',\n  '心律平': '普罗帕酮',\n  '甲强龙': '甲泼尼龙',\n  '杜冷丁': '哌替啶',")

open(S, 'w', encoding='utf-8', newline='').write(s)
print('applied', n)
