const assert = require('node:assert/strict');
require('../prototype/substances.js');
const E = require('../prototype/engine.js');
const G = require('../prototype/generator.js');
const I = require('../prototype/intake.js');

function discover(S, chart) {
  for (const source of chart.sources.filter(source => source.available)) {
    for (const topic of chart.topics) I.ask(S, source.id, topic.id);
  }
  return I.view(S).known;
}

for (const module of G.MODULES) {
  for (const seed of [1, 42, 170, 457]) {
    let previousCount = Infinity;
    for (let difficulty = 1; difficulty <= 6; difficulty++) {
      const S = E.create(G.generate(difficulty, seed, [module.id]));
      const chart = I.view(S);
      assert.equal(chart.difficulty, difficulty);
      assert.equal(chart.chief.section, 'chief');
      assert.ok(chart.chief.text && !chart.chief.text.includes('；'), module.id);
      assert.ok(chart.chief.source !== 'patient' || S.gcs >= 13, module.id);
      assert.ok(chart.known.length <= previousCount, `${module.id}, level ${difficulty}`);
      previousCount = chart.known.length;
      if (difficulty === 6) {
        assert.equal(chart.known.length, 0);
        const known = discover(S, chart);
        assert.ok(known.length > 0, `${module.id} must have a source for more information`);
        assert.equal(known.length, new Set(known.map(fact => fact.id)).size);
      }
    }
  }
}

for (const seed of [...Array.from({ length: 64 }, (_, index) => index + 1), 915]) {
  const fifth = G.generate(5, seed);
  const sixth = G.generate(6, seed);
  assert.equal(sixth.init.diff, 6);
  assert.equal(sixth.diff, 6);
  assert.deepEqual(sixth.init, { ...fifth.init, diff: 6 });
  assert.deepEqual(sixth.cases, fifth.cases);
  assert.deepEqual(sixth.patient, fifth.patient);
  assert.deepEqual(sixth.traits, fifth.traits);
  assert.equal(sixth.bloodType, fifth.bloodType);
  const s5 = E.create(fifth);
  const s6 = E.create(sixth);
  assert.deepEqual(I.view(s5).sources, I.view(s6).sources);
  assert.deepEqual(I.view(s5).chief, I.view(s6).chief);
  assert.ok(!I.view(s6).known.length);
  assert.ok(discover(s6, I.view(s6)).length);
}

for (const id of ['hyperkalemia', 'dka', 'bleed', 'sepsis', 'opioid']) {
  const S = E.create(id);
  I.init(S, 6);
  const chart = I.view(S);
  assert.ok(chart.chief.text);
  assert.equal(chart.known.length, 0);
  assert.ok(discover(S, chart).length, id);
}

const hypoglycemia = E.create(G.generate(6, 42, ['hypogly']));
assert.match(I.ask(hypoglycemia, 'family', 'present').evidence[0].text, /大汗.*反应变差/);
assert.match(I.ask(hypoglycemia, 'family', 'medications').evidence[0].text, /注射胰岛素后未进食/);

const pesticide = E.create(G.generate(6, 42, ['organophosphate']));
assert.match(I.ask(pesticide, 'witness', 'medications').evidence[0].text, /喷洒农药/);
assert.match(I.ask(pesticide, 'witness', 'present').evidence[0].text, /两小时后.*流涎/);
assert.match(I.ask(pesticide, 'ems', 'prehospital').evidence[0].text, /瞳孔/);

const fire = E.create(G.generate(6, 42, ['burn', 'co', 'heatstroke']));
const fireExposure = I.ask(fire, 'witness', 'medications').evidence.map(item => item.text).join('');
assert.match(fireExposure, /火场.*烟气/);
assert.match(fireExposure, /火场.*高温/);
assert.doesNotMatch(fireExposure, /燃气热水器|四小时/);

const ingestion = E.create(G.generate(6, 42, ['tca', 'apap']));
assert.equal(I.view(ingestion).chief.source, 'ems');
ingestion.gcs = 15;
const ingested = I.ask(ingestion, 'patient', 'medications').evidence;
assert.equal(ingested.length, 1);
assert.match(ingested[0].text, /对乙酰氨基酚和阿米替林/);
assert.equal(ingested[0].minutesBefore, 240);
const afterIngestion = I.ask(ingestion, 'patient', 'present').evidence;
assert.ok(afterIngestion.some(item => item.text.includes('口干')));
assert.ok(afterIngestion.every(item => item.minutesBefore === null));

const mixed = E.create(G.generate(6, 42, ['asthma', 'opioid', 'aki']));
assert.match(I.view(mixed).chief.text, /呼之不应/);
const mixedHandoff = I.ask(mixed, 'ems', 'prehospital').evidence.map(item => item.text).join('');
assert.match(mixedHandoff, /喘鸣/);
assert.match(mixedHandoff, /水肿/);
assert.doesNotMatch(mixedHandoff, /患者说话断续/);

const trauma = E.create(G.generate(6, 42, ['tamponade', 'tbi']));
const traumaScene = I.ask(trauma, 'witness', 'present').evidence;
assert.equal(traumaScene.find(item => item.text.includes('交通事故')).minutesBefore, null);
assert.ok(traumaScene.some(item => item.text.includes('一小时后')));

const legacyExposureCase = G.generate(6, 42, ['organophosphate']);
const exposureText = '到院前喷洒农药，约两小时后出现大汗、流涎和呕吐。';
legacyExposureCase.admission.history = [{ moduleId: 'organophosphate', minutesBefore: null, source: '现场人员转述', text: exposureText }];
const legacyExposure = E.create(legacyExposureCase);
assert.match(I.ask(legacyExposure, 'witness', 'medications').evidence[0].text, /喷洒农药/);

const persisted = E.create(G.generate(6, 42, ['organophosphate']));
const { chief, contacts } = I.init(persisted);
persisted.intake = JSON.parse(JSON.stringify({ version: 1, difficulty: 6, chief, contacts,
  known: [{ id: 'intake-1p67tvx', section: 'present', text: exposureText, source: 'witness',
    sourceLabel: '现场目击者', minutesBefore: null, obtainedAt: 127 }],
}));
for (const topic of ['present', 'medications']) {
  const result = I.ask(persisted, 'witness', topic);
  assert.equal(result.status, 'known');
  assert.equal(result.evidence[0].source, 'witness');
  assert.equal(result.evidence[0].obtainedAt, 127);
}
assert.equal(I.view(persisted).known.length, 2);
assert.equal(I.ask(persisted, 'witness', 'typo').status, 'unavailable');
assert.equal(I.view(persisted).inquiries.length, 0);

const savedSeizure = E.create(G.generate(6, 42, ['seizure']));
const seizureIntake = I.init(savedSeizure);
savedSeizure.intake = { ...seizureIntake, version: 1, contacts: { ...seizureIntake.contacts, witness: false },
  chief: { ...seizureIntake.chief, source: 'ems', sourceLabel: '急救交接' },
  known: [{ id: 'intake-1', section: 'prehospital', text: '开始持续抽搐，伴牙关紧闭和发绀。',
    source: 'ems', sourceLabel: '急救交接', minutesBefore: 20, obtainedAt: 11 }],
};
assert.equal(I.view(savedSeizure).sources.find(item => item.id === 'witness').available, false);
assert.equal(I.ask(savedSeizure, 'ems', 'prehospital').status, 'known');
assert.ok(I.view(savedSeizure).known.every(item => item.source === 'ems' && item.obtainedAt === 11));

// An unresponsive patient without family cannot supply subjective symptoms.
const noFamily = Array.from({ length: 64 }, (_, i) => E.create(G.generate(6, i + 1, ['pancreatitis'])))
  .find(S => !I.view(S).sources.find(source => source.id === 'family').available);
assert.equal(I.view(noFamily).chief.source, 'ems');
assert.equal(I.view(noFamily).chief.minutesBefore, null);
assert.match(I.view(noFamily).chief.text, /无法自述/);
assert.doesNotMatch(I.view(noFamily).chief.text, /疼痛|剧痛|8 小时/);
assert.equal(I.ask(noFamily, 'patient', 'present').status, 'unavailable');
assert.equal(I.ask(noFamily, 'ems', 'present').status, 'unknown');
assert.equal(I.ask(noFamily, 'ems', 'prehospital').status, 'learned');

// Initial and current speaking ability are independent.
const intubated = E.create(G.generate(6, 42, ['highK']));
intubated.admissionVitals = { gcs: 15, vent: 1, rhythm: 'sinus' };
intubated.vent = 1;
assert.notEqual(I.view(intubated).chief.source, 'patient');
assert.equal(I.ask(intubated, 'patient', 'present').status, 'unavailable');
intubated.vent = 0;
assert.equal(I.ask(intubated, 'patient', 'present').status, 'learned');
const arrested = E.create(G.generate(6, 42, ['highK']));
arrested.rhythm = 'vf';
assert.notEqual(I.view(arrested).chief.source, 'patient');
assert.equal(I.ask(arrested, 'patient', 'present').status, 'unavailable');

// Inquiry evidence keeps its original source and timestamp after reloading.
const unconscious = E.create('opioid');
I.init(unconscious, 6);
assert.equal(I.view(unconscious).chief.source, 'ems');
assert.equal(I.ask(unconscious, 'patient', 'medications').status, 'unavailable');
const handoff = I.ask(unconscious, 'ems', 'medications').evidence[0];
assert.equal(handoff.source, 'ems');
unconscious.gcs = 15;
unconscious.t = 123;
const recollection = I.ask(unconscious, 'patient', 'medications').evidence[0];
assert.equal(recollection.source, 'patient');
assert.equal(recollection.obtainedAt, 123);
const reloaded = Object.assign(E.create('opioid'), { intake: JSON.parse(JSON.stringify(unconscious.intake)), t: 200, gcs: 15 });
assert.deepEqual(I.view(reloaded).known, [handoff, recollection]);
assert.equal(I.view(reloaded).difficulty, 6);
assert.deepEqual(I.ask(reloaded, 'patient', 'medications').evidence, [recollection]);

const legacy = E.create('hyperkalemia');
legacy.t = 600;
legacy.gcs = 7;
assert.equal(I.view(legacy).difficulty, 1);
assert.equal(I.ask(legacy, 'patient', 'present').status, 'unavailable');
assert.ok(I.view(legacy).known.some(fact => fact.section === 'history' && fact.text === '慢性肾病 3 期'));
assert.equal(I.ask(legacy, 'ems', 'allergies').evidence.length, 0);

console.log('入院问诊回归通过');
