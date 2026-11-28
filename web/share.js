/* ==========================================================================
 * 会诊码：把一个病例（病例种子 + 病人身份 + 处置记录 + 结局）压成一段文本，
 * 玩家之间复制粘贴即可共享，不需要服务器。
 *
 *   LIFE.SHARE.make(S)   → 会诊码字符串
 *   LIFE.SHARE.parse(str)→ { ok, data } / { ok:false, err }
 *   LIFE.SHARE.apply(data, E) → 重建出同一例（返回新的 S）
 *
 * 设计要点：
 *  - 只存"重放所需的最小信息"：病例标识、病人身份、处置时间轴、结局
 *  - 文本用 base64url（无 +/= ），可直接粘贴到聊天框
 *  - 带版本号与校验位，防止截断后还原出错
 * ========================================================================== */
(function (root) {
  'use strict';

  const V = 1;
  const b64 = {
    enc(str) {
      const bytes = new TextEncoder().encode(str);
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(b) {
      let s = b.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    },
  };

  /* 简单校验：FNV-1a 32 位，取 4 位 36 进制 */
  function check(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36).slice(-4);
  }

  function make(S) {
    if (!S || !S.cas) return null;
    const isGen = S.cas.id === 'gen' || S.caseId === 'gen';
    const difficulty = S.intake?.difficulty ?? S.diff ?? S.cas.diff ?? 3;
    const ed = difficulty === 6;
    const p = S.patient || {};
    const actions = [];
    for (const g of (S.given || [])) {
      const action = ['d', Math.round(g.t), g.id, +g.d];
      if (g.infusionMinutes) {
        const infusion = { minutes: g.infusionMinutes, unit: g.unit };
        if (g.route && g.route !== '泵入') infusion.route = g.route;
        action.push(infusion);
      } else if (g.pumpAction) action.push({ pumpAction: g.pumpAction, unit: g.unit });
      actions.push(action);
    }
    /* 操作记录：日志里的时间戳是 mm:ss 文本，转回秒 */
    const toSec = (t) => {
      const m = String(t || '').match(/(\d+):(\d+)/);
      return m ? (+m[1]) * 60 + (+m[2]) : 0;
    };
    for (const l of (ed ? [] : S.log || [])) {
      if (String(l[1]).startsWith('操作')) actions.push(['a', toSec(l[0]), String(l[1]).replace(/^操作\s*/, '').slice(0, 36), 0]);
    }
    actions.sort((x, y) => x[1] - y[1]);
    const review = S.dischargeOutcome;
    const failed = review?.status === 'failed';
    const reason = S.death?.reason || (failed ? review.majorReasons?.[0] : '');
    const score = review && typeof root.LIFE?.finalScore === 'function'
      ? root.LIFE.finalScore(S) : (S.finalScore ?? S.score ?? 100);
    const payload = {
      v: V,
      c: isGen ? 'gen' : (S.caseId || S.cas.id),
      s: isGen ? (S.seed != null ? S.seed : (S.cas.seed || 0)) : 0,
      g: isGen ? (S.cas.genVersion || 1) : undefined,
      d: difficulty,
      p: { n: p.name || '', x: p.sex || '男', a: p.age || 45, w: p.weight || 70, h: p.height || 170 },
      t: Math.round((S.t || 0) / 60),
      o: S.death ? 'death' : S.discharged ? 'discharge' : failed ? 'failed' : 'open',
      r: ed ? undefined : String(reason || '').slice(0, 20),
      sc: ed ? undefined : Math.round(score),
      a: actions.slice(0, 120),
    };
    const body = b64.enc(JSON.stringify(payload));
    return 'HX1-' + body + '-' + check(body);
  }

  function parse(str) {
    if (!str) return { ok: false, err: '空内容' };
    let s = String(str).trim().replace(/\s+/g, '');
    if (!s.startsWith('HX1-')) return { ok: false, err: '不是会诊码（应以 HX1- 开头）' };
    const body = s.slice(4);
    const dash = body.lastIndexOf('-');
    if (dash < 0) return { ok: false, err: '会诊码不完整' };
    const data = body.slice(0, dash);
    const sum = body.slice(dash + 1);
    if (check(data) !== sum) return { ok: false, err: '会诊码校验失败（可能被截断）' };
    try {
      const obj = JSON.parse(b64.dec(data));
      if (!obj || obj.v !== V) return { ok: false, err: '会诊码版本不支持' };
      return { ok: true, data: obj };
    } catch (e) {
      return { ok: false, err: '会诊码解析失败' };
    }
  }

  /* 重建同一例（不重放处置，玩家自己接手） */
  function rebuild(data, E) {
    if (!data) return null;
    let spec = data.c;
    if (data.c === 'gen') {
      if (!root.CASEGEN) return null;
      const gen = root.CASEGEN;
      if (data.g > gen.VERSION) return null;
      spec = gen.generateVersion(data.d || 3, data.s || 0, data.g || 1);
    }
    const p = data.p;
    const identity = p ? {
      name: p.n || '患者', sex: p.x || '男', age: p.a || 45, weight: p.w || 70, height: p.h || 170,
    } : undefined;
    return E.create(spec, identity);
  }

  root.SHARE = { make, parse, rebuild, V };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SHARE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
