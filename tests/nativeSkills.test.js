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

  const weather = await nativeWeather.getWeatherSummary({ location: '上海今天天气' }, {
    apiHost: 'https://weather.example.qweatherapi.com',
    apiSecret: 'test-secret',
    httpClient: {
      async get(url) {
        if (url.endsWith('/geo/v2/city/lookup')) {
          return { data: { code: '200', location: [{ name: '上海', country: '中国', lat: '31.23', lon: '121.47', tz: 'Asia/Shanghai' }] } };
        }
        if (url.includes('/weather/v1/current/')) {
          return { data: { condition: { text: '晴' }, temperature: { value: 30 }, feelsLike: { value: 31 }, humidity: 0.5 } };
        }
        return { data: { days: [] } };
      }
    }
  });
  assert.match(weather, /和风天气/);

  const arxivGetMissing = await nativeArxiv.getArxiv({ arxiv_id: '' });
  assert.strictEqual(arxivGetMissing, 'Missing arxiv_id.');

  console.log('nativeSkills.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
