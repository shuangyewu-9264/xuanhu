# -*- coding: utf-8 -*-
# 【历史脚本归档】测试脚本适配新判定
# 记录某条机制当年是怎么改出来的，仅供追溯，不参与构建与运行。
# 原脚本里的本机绝对路径已替换为相对路径（以仓库根为基准）。
# 用法：在仓库根目录执行 `python tools/archive/update_content_scripts2.py`
"""继续修正 content-test：肺水肿过度利尿、CO 撤氧时机、烧伤插管、有机磷阿托品剂量、低钠纠正速度。"""
P = r'.\tools\content-test.js'
raw = open(P, encoding='utf-8', newline='').read()
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')
n = 0


def rep(old, new, tag):
    global s, n
    if old in s:
        s = s.replace(old, new, 1); n += 1; return True
    print('MISS:', tag)
    return False


# ---------- 肺水肿：利尿要看容量，别把人脱成低血容量 ----------
rep("""    /* 肺水没降下来就继续利尿（间隔 10 min，避免过量脱容量） */
    if ((S.lungWater || 0) > 0.42 && t >= (S._fuAt || 0) + 600) { E.give(S, 'furosemide', 40); S._fuAt = t; }""",
"""    /* 利尿要盯着容量：容量已经不高时再利尿会脱成休克 */
    if ((S.lungWater || 0) > 0.42 && S.vol > 4.3 && t >= (S._fuAt || 0) + 900) {
      E.give(S, 'furosemide', 40); S._fuAt = t;
    }
    if (bp(S).map < 62 && !has(S, 'norepi')) E.give(S, 'norepi', 8);""", 'edema-diuresis')

# ---------- 一氧化碳：按碳氧血红蛋白撤氧，而不是按血氧 ----------
rep("""  co(S) {
    if (!S.o2) E.ACTIONS.oxygen.apply(S);
  },""",
"""  co(S) {
    /* CO 中毒时脉搏血氧是"假正常"，不能靠 SpO₂ 决定撤氧 —— 看 COHb */
    if ((S.coHb || 0) > 0.12) {
      if (!(S.o2 || S.vent) || (S.fio2 || 0.21) < 0.9) E.ACTIONS.oxygen.apply(S);
      return;
    }
    o2(S);
  },""", 'co')

# ---------- 烧伤：吸入性损伤要插管 + 纠酸 ----------
rep("""  burn(S) {""",
"""  burn(S, t) {
    if (!S.vent && ((S.spo2 || 100) < 94 || (S.airwayResistance || 0) > 0.35 || S.gcs < 10)) {
      E.ACTIONS.intubate.apply(S);
    }
    if (S.ph < 7.20 && !has(S, 'bicarb') && t >= 600) E.give(S, 'bicarb', 150);
    if (S.vol < 4.4 && !has(S, 'nacl')) E.give(S, 'nacl', 1000);""", 'burn')

# ---------- 有机磷：阿托品减量、解磷定加密 ----------
rep("""    if (!S._p) { S._p = 1; E.give(S, 'atropine', 2); E.give(S, 'pralidoxime', 1); S._aAt = t; S._pAt = t; }
    /* 阿托品"达到阿托品化"：心率不足或有分泌物就加量 */
    if ((S.hr < 80 || (1 - (S.acheActivity == null ? 1 : S.acheActivity)) > 0.25) && t >= (S._aAt || 0) + 300) {
      E.give(S, 'atropine', 2); S._aAt = t;
    }
    if (t >= (S._pAt || 0) + 1800) { E.give(S, 'pralidoxime', 1); S._pAt = t; }""",
"""    if (!S._p) { S._p = 1; E.give(S, 'atropine', 1); E.give(S, 'pralidoxime', 1); S._aAt = t; S._pAt = t; }
    /* 阿托品只滴定到"心率上来、分泌物减少"，过量会高热/谵妄 */
    if (S.hr < 75 && t >= (S._aAt || 0) + 600) { E.give(S, 'atropine', 0.5); S._aAt = t; }
    if (t >= (S._pAt || 0) + 900) { E.give(S, 'pralidoxime', 1); S._pAt = t; }""", 'op-atropine')

# ---------- 低钠：更积极地把钠抬到 130，同时控制速度 ----------
rep("""    const rise = S.na - (S.na0 == null ? S.na : S.na0);
    if (S.na < 124 && rise < 12 && (S._hN || 0) < 3 && (S.t - (S._hAt || 0)) >= 1800) {
      E.give(S, 'hypertonic_saline', 150); S._hAt = S.t; S._hN = (S._hN || 0) + 1;
    }""",
"""    const rise = S.na - (S.na0 == null ? S.na : S.na0);
    /* 目标：6 h 内从重度低钠抬到 130 上下，总升幅控制在 ~10，避免脱髓鞘 */
    if (S.na < 130 && rise < 10 && (S._hN || 0) < 6 && (S.t - (S._hAt || 0)) >= 1200) {
      E.give(S, 'hypertonic_saline', 100); S._hAt = S.t; S._hN = (S._hN || 0) + 1;
    }""", 'hypona-rate')

if crlf:
    s = s.replace('\n', '\r\n')
open(P, 'w', encoding='utf-8', newline='').write(s)
print('applied', n)
