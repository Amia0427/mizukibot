const assert = require('assert');

const nativeArxiv = require('../api/skills_native/arxiv');
const nativeWeather = require('../api/skills_native/weather');
const nativeSkillValidation = require('../api/skills_native/skillValidation');
const nativeClawddocs = require('../api/skills_native/clawddocs');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');

module.exports = (async () => {
  const skillValidation = nativeSkillValidation.validateSkillByName('D:\\waifu\\skills', 'web-search');
  assert.ok(String(skillValidation).includes('Skill: web-search'));

  const clawddocsSearch = nativeClawddocs.searchDocs('D:\\waifu\\skills\\clawddocs', 'gateway');
  assert.ok(Array.isArray(clawddocsSearch));

  const clawddocsFetch = nativeClawddocs.fetchDoc('D:\\waifu\\skills\\clawddocs', clawddocsSearch[0] || 'SKILL.md');
  assert.ok(typeof clawddocsFetch === 'string');

  const depCheck = await TOOL_EXECUTORS.skill_qqbot_dep_check({});
  assert.ok(String(depCheck).includes('axios:'));

  const weather = await nativeWeather.getWeatherSummary({ location: 'Shanghai' });
  assert.ok(typeof weather === 'string');

  const arxivGetMissing = await nativeArxiv.getArxiv({ arxiv_id: '' });
  assert.strictEqual(arxivGetMissing, 'Missing arxiv_id.');

  console.log('nativeSkills.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
