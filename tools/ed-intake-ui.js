const assert = require('node:assert/strict');
const { launchBrowser, gameUrl, enterWard } = require('./browser');

async function main() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ offline: true, viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    // Advance the patient's clock explicitly to isolate sampling time from result time.
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = fn => {
        if (fn.name !== 'loop') return raf(fn);
        window.tickWard = () => fn(performance.now());
        return 0;
      };
    });
    await page.goto(gameUrl);
    const rows = page.locator('#sheetList');
    const choose = async name => rows.getByText(name, { exact: true }).click();
    const close = async () => page.locator('#sheetClose').click();
    await page.locator('#lobby [data-act="diff"]').click();
    await choose('病例难度');
    await rows.getByRole('button', { name: /6 急诊首诊/ }).click();
    await enterWard(page);
    await page.evaluate(() => window.__LIFE_GAME.startCase(window.CASEGEN.generate(6, 123), true));
    await page.locator('#admissionIntro').click();
    await page.locator('#btnAdmission').click();
    const initial = await page.locator('#dKv').innerText();
    assert.match(initial, /陈述来源/);
    assert.match(initial, /尚未取得资料/);
    assert.deepEqual(await page.evaluate(() => {
      const chart = window.INTAKE.view(window.__LIFE_GAME.S);
      return [chart.difficulty, chart.known.length];
    }), [6, 0]);

    await page.locator('#historySources').click();
    const interview = await page.evaluate(() => {
      const { S } = window.__LIFE_GAME;
      const chart = window.INTAKE.view(S);
      for (const source of chart.sources.filter(s => s.available)) {
        for (const topic of chart.topics) {
          const probe = { ...S, intake: structuredClone(S.intake) };
          if (window.INTAKE.ask(probe, source.id, topic.id).status === 'learned') return [source.label, topic.label];
        }
      }
    });
    assert.ok(interview, '测试病例应能从至少一个来源取得新病史');
    await choose(interview[0]);
    await choose(interview[1]);
    await page.locator('#detail.on').waitFor();
    assert.ok(await page.evaluate(() => window.INTAKE.view(window.__LIFE_GAME.S).known.length > 0));
    await page.locator('#detailX').click();
    await close();

    await page.locator('#btnBody').click();
    assert.doesNotMatch(await rows.innerText(), /出院|结局/);
    await choose('床旁查体');
    const lung = await page.evaluate(() => window.LIFE.EXAMS.lungs.name);
    await choose(lung);
    assert.match(await page.locator('#dKv').innerText(), /查体时间/);
    await page.locator('#detailX').click();
    const lungActions = rows.locator('.paired-actions').filter({ hasText: lung });
    assert.equal(await lungActions.getByRole('button', { name: '上次记录' }).isVisible(), true);
    await choose(lung);
    await page.locator('#detailX').click();
    await close();

    const [group, glucose] = await page.evaluate(() => {
      const e = window.LIFE;
      return [e.TEST_GROUPS.find(g => g.id === e.TESTS.glucose.group).name, e.TESTS.glucose.name];
    });
    await page.locator('#btnBody').click();
    await choose(group);
    await choose(glucose);
    await page.locator('#btnBlood').click();
    assert.match(await page.locator('#dKv').innerText(), /待回报/);
    const lungSummary = page.locator('#dKv > dt').filter({ hasText: lung }).locator('xpath=following-sibling::dd[1]//summary').first();
    await lungSummary.click();
    assert.match(await page.locator('#dKv').innerText(), /上次对照/);
    await page.evaluate(() => {
      const { S } = window.__LIFE_GAME;
      S.t = S.tests.glucose.readyAt;
      window.tickWard();
    });
    assert.doesNotMatch(await page.locator('#dKv').innerText(), /待回报/);
    assert.equal(await lungSummary.evaluate(summary => summary.parentElement.open), true);
    await page.reload();
    await enterWard(page);
    assert.ok(await page.evaluate(() => window.INTAKE.view(window.__LIFE_GAME.S).known.length > 0));
    await page.locator('#btnBlood').click();
    await page.locator('#dKv details').filter({ hasText: /血糖/ }).first().locator('summary').click();
    assert.match(await page.locator('#dKv').innerText(), /采集时间/);
    assert.doesNotMatch(await page.locator('#dKv').innerText(), /重症监护快照/);
    await page.locator('#detailX').click();
    await page.locator('#btnMenu').click();
    assert.match(await rows.getByRole('button').first().innerText(), /出院/);
    assert.deepEqual(errors, []);
    console.log('Emergency intake, interview, examination, test ordering, report reload and discharge menu passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
