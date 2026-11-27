const { launchBrowser, gameUrl, enterWard } = require('./browser');
(async()=>{
  const b = await launchBrowser();
  const p = await b.newPage({ viewport:{width:1600,height:1000} });
  const errs=[]; p.on('pageerror', e=>errs.push(e.message));
  await p.goto(gameUrl);
  await p.evaluate(()=>{ try{localStorage.clear();}catch(e){} });
  await p.reload(); await enterWard(p); await p.waitForTimeout(1400);
  // 暂停
  await p.getByRole('button', { name: '暂停', exact: true }).click();
  await p.waitForTimeout(300);
  const t1 = await p.evaluate(()=>window.__LIFE_GAME.S.t);
  await p.waitForTimeout(2000);
  const t2 = await p.evaluate(()=>window.__LIFE_GAME.S.t);
  console.log('暂停后 2 秒游戏时间变化:', (t2-t1).toFixed(2), 's（应为 0）');
  // 恢复
  await p.getByRole('button', { name: '继续', exact: true }).click();
  await p.waitForTimeout(1500);
  const t3 = await p.evaluate(()=>window.__LIFE_GAME.S.t);
  console.log('恢复后 1.5 秒:', (t3-t2).toFixed(2), 's（应 > 0）');
  console.log(errs.length?errs.join('\n'):'无脚本错误');
  await b.close();
})();
