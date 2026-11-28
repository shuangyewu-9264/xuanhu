const assert = require('node:assert/strict');
const { launchBrowser, gameUrl, enterWard } = require('./browser');

async function main() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ offline: true, viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      let frameTime = 0;
      window.requestAnimationFrame = callback => {
        if (callback.name !== 'loop') return raf(callback);
        window.advanceWardFrame = () => callback(frameTime += 500);
        return 0;
      };
    });

    const rows = page.locator('#sheetList');
    const detail = page.locator('#detail');
    const contents = detail.locator('#dKv');
    const choose = name => rows.getByText(name, { exact: true }).click();
    const closeSheet = () => page.locator('#sheetClose').click();
    const closeDetail = async () => {
      await detail.locator('#detailX').click();
      if (await page.locator('#sheet.on').isVisible()) await closeSheet();
    };
    const menu = async name => { await page.locator('#btnMenu').click(); await choose(name); };
    const openLog = async () => {
      await menu('查看操作日志');
      await page.locator('#detail.on[data-view="operation-log"]').waitFor();
    };
    const openInfusions = async () => {
      await menu('当前输液与泵药');
      await page.locator('#detail.on[data-view="infusions"]').waitFor();
    };
    const selectDrug = async (name, id) => {
      await page.locator('#btnDrug').click();
      await page.getByRole('searchbox', { name: '搜索全库' }).fill(name);
      await page.locator(`#drugList [data-id="${id}"]`).click();
    };
    const give = async (name, id) => {
      await selectDrug(name, id);
      await page.locator('#dGo').click();
    };

    await page.goto(gameUrl);
    await enterWard(page);
    // This seed has a hidden QT trait and no acute coronary occlusion.
    const [source, topic, lung, testGroup, glucose, procedure] = await page.evaluate(() => {
      const game = window.__LIFE_GAME;
      game.startCase(window.CASEGEN.generate(6, 11), true);
      const { S, E } = game;
      const chart = window.INTAKE.view(S);
      for (const source of chart.sources.filter(item => item.available)) {
        for (const topic of chart.topics) {
          const probe = { ...S, intake: structuredClone(S.intake) };
          if (window.INTAKE.ask(probe, source.id, topic.id).status !== 'learned') continue;
          const glucose = E.TESTS.glucose;
          return [source.label, topic.label, E.EXAMS.lungs.name,
            E.TEST_GROUPS.find(group => group.id === glucose.group).name, glucose.name, E.ACTIONS.pci.name];
        }
      }
      throw new Error('测试病例缺少可询问的新病史');
    });
    await page.locator('#admissionIntro').click();
    await page.locator('#btnAdmission').click();
    await page.locator('#historySources').click();
    await choose(source);
    await choose(topic);
    await closeDetail();

    await give('胺碘酮', 'amiodarone');
    await page.locator('#btnOps').click();
    await choose(procedure);
    await page.locator('#btnBody').click();
    await choose('床旁查体');
    await choose(lung);
    await closeDetail();
    await page.locator('#btnBody').click();
    await choose(testGroup);
    await choose(glucose);

    await openLog();
    assert.ok((await contents.innerText()).includes(`开出 ${glucose}`));
    await page.evaluate(() => {
      const { S } = window.__LIFE_GAME;
      S.t = S.tests.glucose.readyAt;
      window.advanceWardFrame();
      window.advanceWardFrame();
    });
    const log = await contents.innerText();
    const expected = [`${glucose} 结果已出`, `开出 ${glucose}`, lung, procedure, '给予 胺碘酮', `${source} · 补录${topic}`];
    const positions = expected.map(message => log.indexOf(message));
    assert.ok(positions.every((index, i) => index >= 0 && (i === 0 || index > positions[i - 1])), log);
    assert.deepEqual(await page.evaluate(() => {
      const { S } = window.__LIFE_GAME;
      return ['长 QT 体质', '无急性缺血证据'].map(text => S.log.some(entry => entry[1].includes(text)));
    }), [true, true]);
    assert.doesNotMatch(log, /血钾|\bpH\b|长 QT|无急性缺血证据|带教点评/);
    await closeDetail();

    await give('左乙拉西坦', 'levetiracetam');
    await give('去甲肾上腺素', 'norepi');
    await page.evaluate(() => { window.__LIFE_GAME.S.t += 120; });
    await give('左乙拉西坦', 'levetiracetam');
    await page.evaluate(() => { window.__LIFE_GAME.S.t += 60; });
    const time = () => page.evaluate(() => window.__LIFE_GAME.S.t);
    const pauseStarted = await time();
    await page.locator('#pause').click();
    await openInfusions();
    const active = contents.locator('.infusion-section').first();
    const pump = detail.getByRole('button', { name: '调速或停用', exact: true });
    assert.match(await active.innerText(), /去甲肾上腺素.*8 μg\/min/s);
    assert.doesNotMatch(await active.innerText(), /胺碘酮/);
    const progress = () => detail.locator('progress').evaluateAll(bars => bars.map(bar => bar.position));
    const initialProgress = await progress();
    const elapsedFractions = [1 / 15, 3 / 15];
    assert.deepEqual([...initialProgress].sort((a, b) => a - b), elapsedFractions);
    await page.evaluate(() => {
      window.advanceWardFrame();
      window.advanceWardFrame();
    });
    assert.equal(await time(), pauseStarted);
    assert.deepEqual(await progress(), initialProgress);
    await page.reload();
    await enterWard(page);
    assert.equal(await time(), pauseStarted);
    await openInfusions();
    assert.deepEqual(await progress(), initialProgress);

    const timed = detail.locator('button[data-infusion-id="levetiracetam"]');
    await timed.nth(initialProgress.indexOf(elapsedFractions[1])).click();
    assert.deepEqual(await progress(), [elapsedFractions[1]]);
    await detail.getByRole('button', { name: '停止输注', exact: true }).click();
    await page.locator('#detail.on[data-view="infusions"]').waitFor();
    assert.equal(await timed.count(), 1);
    assert.deepEqual(await progress(), [elapsedFractions[0]]);
    await pump.click();
    await page.getByRole('button', { name: '停止泵入', exact: true }).click();
    await page.locator('#detail.on[data-view="infusions"]').waitFor();
    assert.equal(await pump.count(), 0);
    assert.match(await contents.innerText(), /去甲肾上腺素.*已停泵/s);
    assert.equal(await timed.count(), 1);
    await page.evaluate(() => {
      const { S } = window.__LIFE_GAME;
      const active = S.given.filter(order => order.id === 'levetiracetam').at(-1);
      S.t = active.t + active.infusionMinutes * 60 - 0.1;
      window.advanceWardFrame();
      window.advanceWardFrame();
    });
    assert.equal(await timed.count(), 0);
    assert.match(await contents.innerText(), /左乙拉西坦.*已完成/s);
    await closeDetail();
    await openLog();
    const stops = await contents.innerText();
    assert.match(stops, /左乙拉西坦.*静滴完成/);
    assert.match(stops, /停止泵入 去甲肾上腺素/);
    assert.match(stops, /停止.*左乙拉西坦|左乙拉西坦.*停止/);
    await closeDetail();

    await give('去甲肾上腺素', 'norepi');
    await menu('病房床位');
    await choose('开一个新病例（占用空床）');
    await page.locator('#admissionIntro').click();
    await openLog();
    assert.doesNotMatch(await contents.innerText(), /左乙拉西坦|去甲肾上腺素|胺碘酮/);
    await closeDetail();
    await openInfusions();
    assert.doesNotMatch(await contents.innerText(), /去甲肾上腺素/);
    await closeDetail();
    await menu('病房床位');
    await choose('床位 1');
    await openInfusions();
    assert.match(await contents.innerText(), /去甲肾上腺素/);
    assert.deepEqual(errors, []);
    console.log('床旁操作日志、定时输注进度、停用、刷新及床位隔离均通过。');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
