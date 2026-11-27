const assert = require('node:assert/strict');
const { enterWard, gameUrl, launchBrowser } = require('./browser');

async function withWard(browser, scenario, { caseId = 'review-test', glucose = 5.3 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const nativeFrame = window.requestAnimationFrame.bind(window);
      let simulationFrame, timestamp = 1000;
      // Keep the game's clock deterministic while leaving browser animation frames available.
      window.requestAnimationFrame = callback => {
        if (callback.name !== 'loop') return nativeFrame(callback);
        simulationFrame = callback;
        return 0;
      };
      window.advanceSimulation = (milliseconds = 250) => simulationFrame(timestamp += milliseconds);
    });
    await page.goto(gameUrl);
    await page.evaluate(({ caseId, glucose }) => {
      const game = window.__LIFE_GAME;
      const patient = (name, glu, id = 'review-test') => game.E.create({
        id, name: '病情复评测试病例', tags: [], goals: [],
        patient: { name, sex: '女', age: 40, height: 165, weight: 60 },
        init: { ...window.CASEGEN.BASE, glu },
      });
      Object.assign(game.S, patient('测试甲', glucose, caseId));
      game.beds.push({ S: patient('测试乙', 5.3) });
      window.advanceSimulation(0);
    }, { caseId, glucose });
    await enterWard(page);
    await scenario(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function state(page) {
  return page.evaluate(() => {
    const game = window.__LIFE_GAME;
    return {
      speedLabel: document.querySelector('#ff').textContent,
      pauseLabel: document.querySelector('#pause').textContent,
      selectedSpeed: document.querySelector('#speed [data-s][aria-pressed="true"]')?.dataset.s,
      toast: document.querySelector('#toast').textContent,
      result: document.querySelector('#conditionReviewResult')?.textContent,
      clocks: game.beds.map(bed => bed.S.t),
      reports: game.beds.map(bed => bed.S.tests.cbc?.done),
      reviewLogs: game.beds.map(bed => bed.S.log.map(row => row[1]).filter(message => /病情复评|血糖复评/.test(message))),
    };
  });
}

async function startWaiting(page, selector = '#conditionWait') {
  await page.locator('#speed [data-s="4"]').click();
  await page.locator(selector).click();
  assert.equal((await state(page)).speedLabel, '结束等待');
  assert.equal(await page.locator(selector).innerText(), '结束等待');
}

async function assertReviewFinished(page, reason, { bed = 0, glucoseOnly = false } = {}) {
  const stopped = await state(page);
  assert.equal(stopped.speedLabel, '快进 20×');
  assert.equal(stopped.pauseLabel, '暂停');
  assert.equal(stopped.selectedSpeed, '1');
  assert.match(glucoseOnly ? stopped.toast : stopped.result, reason);
  assert.equal(stopped.reviewLogs.flat().length, 1);
  assert.match(stopped.reviewLogs[bed][0], glucoseOnly ? /血糖复评/ : /病情复评/);
  assert.match(stopped.reviewLogs[bed][0], reason);
  if (!glucoseOnly) assert.ok(await page.locator('#conditionReviewResult').isVisible());
  const later = await assertClockAdvance(page, stopped, 0.4);
  assert.deepEqual(later.reviewLogs, stopped.reviewLogs);
  assert.equal(later.result, stopped.result);
  return stopped;
}

async function withGlucoseReview(browser, scenario, options = {}) {
  await withWard(browser, async page => {
    await page.locator('#opTitle').selectOption('pancreas');
    assert.match(await page.locator('#glucoseWait').innerText(), /等待血糖变化.*30 分钟/);
    await scenario(page);
  }, { glucose: 16, ...options });
}

async function assertClockAdvance(page, before, expectedSeconds) {
  await page.evaluate(() => window.advanceSimulation(420));
  const after = await state(page);
  for (const [index, seconds] of after.clocks.entries()) {
    const elapsed = seconds - before.clocks[index];
    assert.ok(Math.abs(elapsed - expectedSeconds) < 0.00001,
      `Bed ${index + 1} advanced ${elapsed} seconds, expected ${expectedSeconds}`);
  }
  return after;
}

async function testPause(browser) {
  await withWard(browser, async page => {
    const pause = page.locator('.top #pause');
    const normalSpeed = page.locator('.top #speed [data-s="1"]');
    assert.equal(await pause.innerText(), '暂停');
    const pauseBounds = await pause.boundingBox();
    const normalSpeedBounds = await normalSpeed.boundingBox();
    assert.ok(pauseBounds.x + pauseBounds.width <= normalSpeedBounds.x);

    await page.locator('#speed [data-s="4"]').click();
    await pause.click();
    const stopped = await state(page);
    assert.equal(stopped.pauseLabel, '继续');
    assert.equal(stopped.speedLabel, '快进 20×');
    await assertClockAdvance(page, stopped, 0);

    await page.locator('#btnMenu').click();
    const menu = page.locator('#sheet');
    await menu.waitFor({ state: 'visible' });
    assert.equal(await menu.getByText(/^(?:暂停|继续（已暂停）)$/).count(), 0);
    await page.locator('#sheetClose').click();

    await pause.click();
    const resumed = await state(page);
    assert.equal(resumed.pauseLabel, '暂停');
    assert.equal(resumed.selectedSpeed, '4');
    await assertClockAdvance(page, resumed, 1.6);
  });

  for (const [run, selector] of [[withWard, '#conditionWait'], [withGlucoseReview, '#glucoseWait']]) {
    await run(browser, async page => {
      await startWaiting(page, selector);
      await page.evaluate(() => window.advanceSimulation());
      const waiting = await state(page);
      await page.locator('#pause').click();
      const stopped = await state(page);
      assert.equal(stopped.pauseLabel, '继续');
      assert.equal(stopped.speedLabel, '快进 20×');
      assert.deepEqual(stopped.clocks, waiting.clocks);
      await assertClockAdvance(page, stopped, 0);

      await page.locator('#pause').click();
      const resumed = await state(page);
      assert.equal(resumed.pauseLabel, '暂停');
      assert.equal(resumed.selectedSpeed, '1');
      await assertClockAdvance(page, resumed, 0.4);
    });
  }
}

async function testGlucoseReview(browser) {
  await withGlucoseReview(browser, async page => {
    await startWaiting(page, '#glucoseWait');
    await page.evaluate(() => window.advanceSimulation());
    const waiting = await state(page);
    assert.equal(waiting.speedLabel, '结束等待');
    assert.ok(waiting.clocks.every(seconds => seconds > 1));
    await page.evaluate(() => {
      window.__LIFE_GAME.S.glu = 10.9;
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /血糖已进入本病例目标范围/, { glucoseOnly: true });
    assert.match(stopped.toast, /16\.0 → 10\.9 mmol\/L/);
    assert.deepEqual(stopped.clocks, waiting.clocks);
  }, { caseId: 'dka' });

  await withGlucoseReview(browser, async page => {
    await startWaiting(page, '#glucoseWait');
    await page.evaluate(() => {
      window.__LIFE_GAME.S.glu = 17.9;
      window.advanceSimulation(0);
    });
    assert.equal((await state(page)).speedLabel, '结束等待');
    await page.evaluate(() => {
      window.__LIFE_GAME.S.glu = 18;
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /血糖进一步偏离本病例目标/, { glucoseOnly: true });
    assert.match(stopped.toast, /16\.0 → 18\.0 mmol\/L/);
  });

  await withGlucoseReview(browser, async page => {
    await startWaiting(page, '#glucoseWait');
    await page.evaluate(() => {
      const { beds } = window.__LIFE_GAME;
      for (const { S } of beds) S.t += 30 * 60 - 0.2;
    });
    assert.equal((await state(page)).speedLabel, '结束等待');
    await page.evaluate(() => window.advanceSimulation());
    const stopped = await assertReviewFinished(page, /已到复评时间，血糖仍未达标/, { glucoseOnly: true });
    assert.match(stopped.toast, /已过 30 分钟/);
    assert.ok(stopped.clocks.every(seconds => Math.abs(seconds - 1800) < 0.00001));
  });

  await withGlucoseReview(browser, async page => {
    await startWaiting(page, '#glucoseWait');
    await page.evaluate(() => {
      const game = window.__LIFE_GAME;
      game.S.glu = 11.9;
      game.beds[1].S.rhythm = 'vf';
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /床位 2：室颤/, { glucoseOnly: true });
    assert.deepEqual(stopped.clocks, [0, 0]);
    assert.doesNotMatch(stopped.toast, /已进入本病例目标/);
  });

  await withGlucoseReview(browser, async page => {
    await page.evaluate(() => { window.__LIFE_GAME.beds[1].S.rhythm = 'vf'; });
    await page.locator('#glucoseWait').click();
    const refused = await state(page);
    assert.equal(refused.speedLabel, '快进 20×');
    assert.match(refused.toast, /床位 2：室颤.*请先处理/);
    assert.deepEqual(refused.reviewLogs, [[], []]);
  });

  await withGlucoseReview(browser, async page => {
    await page.evaluate(() => {
      const { beds, E } = window.__LIFE_GAME;
      E.orderTest(beds[1].S, 'cbc');
      beds[1].S.tests.cbc.readyAt = 0.2;
    });
    await startWaiting(page, '#glucoseWait');
    await page.evaluate(() => window.advanceSimulation());
    const stopped = await assertReviewFinished(page, /床位 2 的血常规已回报/, { glucoseOnly: true });
    assert.deepEqual(stopped.reports, [undefined, true]);
    assert.deepEqual(stopped.clocks, [0.2, 0.2]);
  });

  for (const selector of ['#glucoseWait', '#ff']) {
    await withGlucoseReview(browser, async page => {
      await startWaiting(page, '#glucoseWait');
      await page.locator(selector).click();
      await assertReviewFinished(page, /已手动结束等待/, { glucoseOnly: true });
    });
  }
}

async function testConditionReview(browser) {
  await withWard(browser, async page => {
    assert.equal(await page.locator('#opTitle').inputValue(), 'heart');
    assert.equal(await page.locator('.top #conditionWait').innerText(), '等病情变化');
    assert.equal(await page.evaluate(() => {
      const { E, S } = window.__LIFE_GAME;
      return E.glucoseReviewStatus(S).inTarget;
    }), true);
    await startWaiting(page);
    await page.evaluate(() => {
      window.advanceSimulation();
      window.advanceSimulation();
    });
    const waiting = await state(page);
    assert.equal(waiting.speedLabel, '结束等待');
    assert.ok(waiting.clocks.every(seconds => seconds > 20));
    assert.deepEqual(waiting.reviewLogs, [[], []]);

    await page.evaluate(() => {
      window.__LIFE_GAME.S.gcs = 14;
      window.advanceSimulation(0);
    });
    assert.equal((await state(page)).speedLabel, '结束等待');
    await page.evaluate(() => {
      window.__LIFE_GAME.S.gcs = 13;
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /GCS|意识/);
    assert.deepEqual(stopped.clocks, waiting.clocks);
    await page.locator('#toast.on').waitFor({ state: 'detached' });
    assert.ok(await page.locator('#conditionReviewResult').isVisible());
    assert.equal((await state(page)).result, stopped.result);
  });

  await withWard(browser, async page => {
    await startWaiting(page);
    await page.evaluate(() => {
      window.__LIFE_GAME.beds[1].S.hr += 25;
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /心率/, { bed: 1 });
    assert.match(stopped.result, /床位\s*2/);
    assert.deepEqual(stopped.clocks, [0, 0]);

    await page.locator('#btnLobby').click();
    await page.locator('#lobby [data-bed="1"]').click();
    assert.equal(await page.evaluate(() => window.__LIFE_GAME.activeIdx), 1);
    assert.ok(await page.locator('#conditionReviewResult').isVisible());
    assert.equal((await state(page)).result, stopped.result);
  });

  await withWard(browser, async page => {
    await startWaiting(page);
    await page.evaluate(() => {
      window.__LIFE_GAME.S.glu = 10.9;
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /血糖/);
    assert.match(stopped.result, /10\.9/);
  }, { caseId: 'dka', glucose: 16 });

  await withWard(browser, async page => {
    await startWaiting(page);
    await page.evaluate(() => {
      const { S, beds } = window.__LIFE_GAME;
      S.gcs = 13;
      beds[1].S.rhythm = 'vf';
      window.advanceSimulation();
    });
    const stopped = await assertReviewFinished(page, /床位\s*2.*室颤/, { bed: 1 });
    assert.deepEqual(stopped.clocks, [0, 0]);
  });

  await withWard(browser, async page => {
    await page.evaluate(() => { window.__LIFE_GAME.beds[1].S.rhythm = 'vf'; });
    await page.locator('#conditionWait').click();
    const refused = await state(page);
    assert.equal(refused.speedLabel, '快进 20×');
    assert.match(refused.toast, /床位\s*2.*室颤.*请先处理/);
    assert.deepEqual(refused.reviewLogs, [[], []]);
  });

  await withWard(browser, async page => {
    await page.evaluate(() => {
      const { beds, E } = window.__LIFE_GAME;
      E.orderTest(beds[1].S, 'cbc');
      beds[1].S.tests.cbc.readyAt = 0.2;
    });
    await startWaiting(page);
    await page.evaluate(() => window.advanceSimulation());
    const stopped = await assertReviewFinished(page, /床位\s*2.*血常规.*回报/, { bed: 1 });
    assert.deepEqual(stopped.reports, [undefined, true]);
    assert.deepEqual(stopped.clocks, [0.2, 0.2]);
  });

  for (const selector of ['#conditionWait', '#ff']) {
    await withWard(browser, async page => {
      await startWaiting(page);
      await page.locator(selector).click();
      await assertReviewFinished(page, /手动.*结束/);
    });
  }

  await withWard(browser, async page => {
    await startWaiting(page);
    const limit = 6 * 60 * 60;
    // Set both clocks without changing patient physiology to isolate the time limit.
    await page.evaluate(() => {
      for (const { S } of window.__LIFE_GAME.beds) S.t = 30 * 60;
      window.advanceSimulation(0);
    });
    assert.equal((await state(page)).speedLabel, '结束等待');
    await page.evaluate(seconds => {
      for (const { S } of window.__LIFE_GAME.beds) S.t = seconds - 0.2;
      window.advanceSimulation(0);
    }, limit);
    assert.equal((await state(page)).speedLabel, '结束等待');
    await page.evaluate(() => window.advanceSimulation());
    const stopped = await assertReviewFinished(page, /6\s*(?:个模拟)?小时.*未见明显病情变化/);
    assert.ok(stopped.clocks.every(seconds => Math.abs(seconds - limit) < 0.00001));
  });
}

async function main() {
  const browser = await launchBrowser();
  try {
    await testPause(browser);
    await testGlucoseReview(browser);
    await testConditionReview(browser);
    console.log('pause, glucose and condition review UI passed');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
