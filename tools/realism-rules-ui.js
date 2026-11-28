const assert = require('node:assert/strict');
const { enterWard, gameUrl, launchBrowser } = require('./browser');

const conditions = /出院评估|可出院|未达标|稳定期留观|血钾|测试治疗目标/;

async function withPage(browser, scenario, legacyInsurance = false) {
  const page = await browser.newPage({ offline: true, viewport: { width: 1400, height: 950 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(legacy => {
      if (legacy && !sessionStorage.getItem('seededLegacy')) {
        localStorage.setItem('life.realism', '1');
        sessionStorage.setItem('seededLegacy', '1');
      }
      // Keep animation frames available for the UI while controlling the simulation clock.
      const nativeFrame = window.requestAnimationFrame.bind(window);
      let simulationFrame, timestamp = 1000;
      window.requestAnimationFrame = callback => {
        if (callback.name !== 'loop') return nativeFrame(callback);
        simulationFrame = callback;
        return 0;
      };
      window.advanceSimulation = (milliseconds = 0) => simulationFrame(timestamp += milliseconds);
    }, legacyInsurance);
    await page.goto(gameUrl);
    await scenario(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function openRules(page) {
  await page.locator('#lobby [data-mode="realism"]').click();
  await page.locator('#sheet.on').getByText('医保与自付', { exact: true }).waitFor();
}

function rule(page, name) {
  return page.locator(`[data-rule="${name}"]`);
}

async function assertRules(page, insurance, signedDischarge, noPause = false) {
  assert.equal(await rule(page, 'insurance').getAttribute('aria-pressed'), String(insurance));
  assert.equal(await rule(page, 'signedDischarge').getAttribute('aria-pressed'), String(signedDischarge));
  assert.equal(await rule(page, 'noPause').getAttribute('aria-pressed'), String(noPause));
}

async function startPatient(page, replace = true) {
  await enterWard(page);
  await page.evaluate(replace => {
    const game = window.__LIFE_GAME;
    game.startCase({
      id: 'realism-rules-test', name: '出院规则测试病例', tags: [], goals: ['测试治疗目标'],
      patient: { name: '测试患者', sex: '女', age: 40, height: 165, weight: 60 },
      init: { ...window.CASEGEN.BASE },
    }, replace);
    window.dischargeTestPatient = game.S;
  }, replace);
  const intro = page.locator('#admissionIntro');
  await intro.getByText(/查体与化验请自行评估/).click();
  await intro.waitFor({ state: 'detached' });
}

async function advanceBedCost(page) {
  return page.evaluate(() => {
    const { S } = window.__LIFE_GAME;
    const before = S.bedCost || 0;
    window.advanceSimulation();
    window.advanceSimulation(420);
    return (S.bedCost || 0) - before;
  });
}

async function openSigning(page, checkSheet = true) {
  if (checkSheet) await page.locator('#btnMenu').click();
  const checks = page.locator('#sheet.on #sheetList');
  const discharge = checks.getByRole('button').first();
  assert.doesNotMatch(await discharge.innerText(), conditions);
  assert.equal(await checks.getByText('出院评估', { exact: true }).count(), 0);
  await discharge.getByText('办理出院', { exact: true }).click();
  const prompt = page.locator('#sheet.on').filter({ hasText: /是否签字出院/ });
  await prompt.waitFor();
  assert.doesNotMatch(await prompt.innerText(), conditions);
  return prompt;
}

async function recordCount(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('life.records') || '[]').length);
}

async function assertSignedOutcome(page, prompt, status) {
  await prompt.getByRole('button', { name: /确认签字出院/ }).click();
  await page.locator('#detail.on .case-review-summary').waitFor();
  const result = await page.evaluate(() => {
    const patient = window.dischargeTestPatient;
    return [patient.dischargeOutcome?.status, patient.running, patient.discharged, patient.death];
  });
  assert.deepEqual(result, [status, false, status !== 'failed', null]);
  assert.equal(await recordCount(page), 1);
}

async function testMigration(page) {
  await openRules(page);
  await assertRules(page, true, false);
  await rule(page, 'insurance').click();
  await rule(page, 'signedDischarge').click();
  await assertRules(page, false, true);
  await page.reload();
  await openRules(page);
  await assertRules(page, false, true);
}

async function testFailedDischarge(page) {
  await startPatient(page);
  await page.locator('#btnLobby').click();
  await openRules(page);
  await assertRules(page, false, false);
  await rule(page, 'insurance').click();
  await assertRules(page, true, false);
  await page.locator('#sheetClose').click();
  await enterWard(page);
  assert.ok(await advanceBedCost(page) > 0);
  await page.evaluate(() => { window.__LIFE_GAME.S.k = 7.2; });
  await page.locator('#btnMenu').click();
  await page.locator('#sheet.on').getByText('出院评估', { exact: true }).click();
  assert.match(await page.locator('#detail.on #dWarn').innerText(), /血钾/);
  await page.locator('#detailX').click();
  await page.locator('#sheetClose').click();

  await page.locator('#btnLobby').click();
  await openRules(page);
  await rule(page, 'signedDischarge').click();
  await assertRules(page, true, true);
  await rule(page, 'insurance').click();
  await assertRules(page, false, true);
  await page.locator('#sheetClose').click();
  await enterWard(page);
  assert.equal(await advanceBedCost(page), 0);
  const severeWarning = page.locator('#sevOk');
  if (await severeWarning.isVisible()) await severeWarning.click();
  let prompt = await openSigning(page);
  await prompt.getByText('取消', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.dischargeTestPatient.running), true);
  assert.equal(await recordCount(page), 0);
  prompt = await openSigning(page, false);
  await assertSignedOutcome(page, prompt, 'failed');
  assert.equal(await page.locator('#dName').innerText(), '出院判定失败');
  assert.match(await page.locator('#detail.on').innerText(), /血钾/);

  await page.reload();
  await page.locator('#lobby [data-act="records"]').click();
  await page.locator('#sheet.on').getByText('出院规则测试病例', { exact: true }).click();
  assert.equal(await page.locator('#detail.on #dName').innerText(), '出院判定失败');
  const summary = page.locator('.case-review-summary');
  assert.equal(await summary.locator('dt:has-text("结算时启用") + dd').innerText(), '真实出院');
  assert.equal(await summary.locator('dt:has-text("本例曾启用") + dd').innerText(), '医保与自付、真实出院');
}

async function testSuccessfulDischarges(page, status) {
  await openRules(page);
  await rule(page, 'signedDischarge').click();
  await assertRules(page, false, true);
  await page.locator('#sheetClose').click();
  await startPatient(page);
  if (status === 'penalized') await page.evaluate(() => { window.__LIFE_GAME.S.temp = 38.1; });
  await assertSignedOutcome(page, await openSigning(page), status);
  const deduction = page.locator('.case-review-score').getByRole('row', { name: /出院条件未达标/ });
  if (status === 'penalized') assert.match(await deduction.innerText(), /−30/);
  else assert.equal(await deduction.count(), 0);
}

async function assertWardElapsed(page, expectedSeconds) {
  const elapsed = await page.evaluate(() => {
    const { beds } = window.__LIFE_GAME;
    const before = beds.map(({ S }) => S.t);
    window.advanceSimulation();
    window.advanceSimulation(420);
    return beds.map(({ S }, index) => S.t - before[index]);
  });
  assert.equal(elapsed.length, 2);
  for (const seconds of elapsed) assert.ok(Math.abs(seconds - expectedSeconds) < 1e-6, `${seconds} ≠ ${expectedSeconds}`);
}

async function testNoPause(page) {
  await startPatient(page);
  await startPatient(page, false);
  const pause = page.locator('#pause');
  const fastForward = page.locator('#ff');
  const normalSpeed = page.locator('#speed [data-s="1"]');
  const wait = page.locator('#conditionWait');

  await fastForward.click();
  await pause.click();
  assert.equal(await pause.innerText(), '继续');
  await assertWardElapsed(page, 0);

  await page.locator('#btnMenu').click();
  await page.locator('#sheet.on').getByText('现实模式', { exact: true }).click();
  await rule(page, 'noPause').click();
  await assertRules(page, false, false, true);
  await assertWardElapsed(page, 0.4);
  await page.locator('#sheetClose').click();
  assert.equal(await pause.isVisible(), false);
  assert.equal(await pause.isDisabled(), true);
  await pause.dispatchEvent('click');
  assert.equal(await normalSpeed.getAttribute('aria-pressed'), 'true');
  await assertWardElapsed(page, 0.4);

  await page.locator('#speed [data-s="4"]').click();
  await assertWardElapsed(page, 1.6);
  await fastForward.click();
  await assertWardElapsed(page, 8.4);
  await fastForward.click();
  await page.evaluate(() => {
    const { E, S } = window.__LIFE_GAME;
    E.orderTest(S, 'cbc');
    S.tests.cbc.readyAt = S.t + 0.3;
  });
  await wait.click();
  assert.equal(await wait.innerText(), '结束等待');
  await assertWardElapsed(page, 0.4);
  assert.equal(await page.evaluate(() => window.__LIFE_GAME.S.tests.cbc.done), true);
  assert.equal(await wait.innerText(), '等病情变化');
  assert.equal(await normalSpeed.getAttribute('aria-pressed'), 'true');

  await page.reload();
  assert.deepEqual(await page.evaluate(() => window.__LIFE_GAME.beds.map(({ S }) => S.usedRealismRules)),
    [['noPause'], ['noPause']]);
  await openRules(page);
  await assertRules(page, false, false, true);
  await page.locator('#sheetClose').click();
  await enterWard(page);
  assert.equal(await pause.isVisible(), false);
  await assertWardElapsed(page, 0.4);

  await page.locator('#btnLobby').click();
  await openRules(page);
  await rule(page, 'noPause').click();
  await assertRules(page, false, false);
  await rule(page, 'signedDischarge').click();
  await page.locator('#sheetClose').click();
  await enterWard(page);
  assert.equal(await pause.isVisible(), true);
  assert.equal(await pause.isEnabled(), true);
  await pause.click();
  await assertWardElapsed(page, 0);
  await pause.click();
  await assertWardElapsed(page, 0.4);

  const signing = await openSigning(page);
  await signing.getByRole('button', { name: /确认签字出院/ }).click();
  const summary = page.locator('#detail.on .case-review-summary');
  assert.equal(await summary.locator('dt:has-text("结算时启用") + dd').innerText(), '真实出院');
  assert.equal(await summary.locator('dt:has-text("本例曾启用") + dd').innerText(), '禁用暂停、真实出院');
}

async function main() {
  const browser = await launchBrowser();
  try {
    await withPage(browser, testMigration, true);
    await withPage(browser, testFailedDischarge);
    await withPage(browser, page => testSuccessfulDischarges(page, 'penalized'));
    await withPage(browser, page => testSuccessfulDischarges(page, 'normal'));
    await withPage(browser, testNoPause);
    console.log('Realism rule migration, billing, signed discharge, continuous ward clocks, and persistent case records passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
