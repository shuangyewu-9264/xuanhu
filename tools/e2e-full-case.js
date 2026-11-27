/* Exercise the fixed teaching case through discharge and persistent records. */
const assert = require('node:assert/strict');
const { launchBrowser, gameUrl, enterWard } = require('./browser');

async function main() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(gameUrl);
    await enterWard(page);
    await page.locator('#btnMenu').click();
    const rows = page.locator('#sheetList .drow');
    await rows.filter({ hasText: '切换病例' }).click();
    /* 病名已匿名化：教学病例按序号列出，第 1 个是高钾血症 */
    await rows.filter({ hasText: '教学病例 1' }).click();
    const assessment = await page.evaluate(() => {
      const { S, E } = window.__LIFE_GAME;
      if (S.caseId !== 'hyperkalemia') throw Error('未能切换至固定病例');
      E.give(S, 'calcium', 10);
      E.give(S, 'insulin', 10);
      E.give(S, 'dextrose50', 25);
      for (let i = 0; i < 480 && S.running && !E.dischargeCheck(S).ok; i++) {
        if (S.k > 5.5 && S.t > 300) E.ACTIONS.dialysis.apply(S);
        E.tick(S, 30);
      }
      return E.dischargeCheck(S);
    });
    assert.equal(assessment.ok, true, assessment.reasons.join('、'));
    const warning = page.locator('#sevOk');
    if (await warning.isVisible()) await warning.click();
    await page.locator('#btnBody').click();
    await rows.filter({ hasText: '办理出院' }).click();
    await page.waitForFunction(() => window.__LIFE_GAME.beds.length === 0);
    await page.reload();
    const { records, entries } = await page.evaluate(() => ({
      records: JSON.parse(localStorage.getItem('life.records') || '[]'),
      entries: JSON.parse(localStorage.getItem('life.handbook') || '{}').entries || [],
    }));
    assert.equal(records.length, 1, '一次出院应写入一份病历');
    assert.equal(records[0].结局, '出院');
    assert.ok(entries.some(e => e.cured > 0), '手册应保存治愈记录');
    assert.deepEqual(errors, []);
    console.log('高钾教学病例通过：办理出院，刷新后保留一份病历和手册记录。');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
