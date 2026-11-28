const assert = require('node:assert/strict');
const { launchBrowser, gameUrl, enterWard } = require('./browser');

async function main() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, offline: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('life.realismRules', JSON.stringify({ insurance: true }));
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => callback.name === 'loop' ? 0 : raf(callback);
    });
    await page.goto(gameUrl);
    await enterWard(page);
    await page.evaluate(() => {
      const { S } = window.__LIFE_GAME;
      // Start one yuan below the deductible to exercise a partially reimbursed order.
      S.cost = 799;
      S.bedCost = 0;
      S.ins = { t: '职工医保', rate: 0.78, ded: 800, cap: 30000, income: 5000, oopCap: 15000 };
    });
    await page.locator('#btnDrug').click();
    const catalog = page.locator('#drugList');
    const search = page.getByRole('searchbox', { name: '搜索全库' });
    const quick = catalog.locator('details[data-section="急救"]');
    assert.equal(await catalog.locator('details[open]').count(), 0);
    await quick.locator('summary').press('Enter');
    const atropine = quick.locator('[data-id="atropine"]');
    await atropine.waitFor({ state: 'visible', timeout: 4000 });
    await atropine.click();
    await page.getByRole('button', { name: '返回药物列表' }).click();
    assert.ok(await atropine.isVisible());

    await search.fill('罗氏芬');
    assert.equal(await catalog.locator('button.drow').count(), 1);
    assert.ok(await catalog.locator('[data-id="ceftriaxone"]').isVisible());
    await search.fill('先锋必');
    assert.match(await catalog.innerText(), /头孢哌酮.*暂未收录/s);
    await search.fill('');
    assert.ok(await atropine.isVisible());
    await page.getByRole('button', { name: '食物', exact: true }).click();
    assert.equal(await catalog.locator('details').count(), 1);
    await search.fill('抗感染');
    assert.ok(await catalog.locator('[data-id="ceftriaxone"]').isVisible());
    await page.getByRole('button', { name: '药品', exact: true }).click();
    assert.equal(await search.inputValue(), '');
    await catalog.locator('details[data-section="循环与心律"] summary').click();
    await catalog.locator('details[data-section="循环与心律"] [data-id="nicardipine"]').click();
    const give = page.locator('#dGo');
    assert.match(await give.innerText(), /尼卡地平.*5 mg\/h/);
    await page.locator('#dPlus').click();
    assert.match(await give.innerText(), /7\.5 mg\/h/);
    await give.click();
    assert.equal(await page.evaluate(() => window.LIFE.pumpRate(window.__LIFE_GAME.S, 'nicardipine')), 7.5);

    await page.locator('#btnDrug').click();
    await search.fill('左乙拉西坦');
    await catalog.locator('[data-id="levetiracetam"]').click();
    assert.match(await give.innerText(), /静滴.*2000\s*mg.*15\s*分钟/);
    const price = await page.evaluate(() => window.SUBSTANCES.byId('levetiracetam').cost);
    const covered = Math.round(Math.max(0, price - 1) * 0.78 * 100) / 100;
    const expected = '预计新增自付 ¥' + (price - covered).toFixed(2);
    assert.ok((await page.locator('#sheetList').innerText()).includes(expected));
    await give.click();
    assert.ok(await page.evaluate(() => window.__LIFE_GAME.S.given.some(g => g.id === 'levetiracetam' && g.infusionMinutes === 15)));
    await page.locator('#btnMenu').click();
    await page.getByText('费用与医保', { exact: true }).click();
    const bill = page.locator('#dKv');
    assert.equal(await bill.locator('dt:has-text("医保支付") + dd').innerText(), '¥' + covered.toFixed(2));
    assert.equal(await bill.locator('dt:has-text("家庭自付") + dd').innerText(), '¥' + (799 + price - covered).toFixed(2));
    assert.deepEqual(errors, []);
    console.log('药库分类、跨类搜索、返回列表，以及新药的泵入与静滴医嘱均通过。');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
