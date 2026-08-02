const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const projectRoot = path.resolve(__dirname, '..');
  const skillsDir = path.join(projectRoot, 'skills');

  const childProcess = require('child_process');
  const processMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const originalProcessMethods = Object.fromEntries(processMethods.map((name) => [name, childProcess[name]]));
  for (const name of processMethods) {
    childProcess[name] = () => {
      throw new Error(`guarded native skill attempted child_process.${name}`);
    };
  }

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = path.join(projectRoot, 'tmp', 'tests', 'in-process-skills');
    process.env.MIZUKI_SKILLS_DIR = skillsDir;
    clearProjectCache();

    const calls = [];
    const patchMethod = (modulePath, method, result) => {
      const target = require(modulePath);
      target[method] = (...args) => {
        calls.push({ modulePath, method, args });
        return result;
      };
    };

    const sentinel = 'native-sentinel';
    const nativeCases = [
      ['skill_arxiv_search', '../api/skills_native/arxiv', 'searchArxiv', { query: 'q' }, [sentinel]],
      ['skill_arxiv_get', '../api/skills_native/arxiv', 'getArxiv', { id: '1' }, [sentinel]],
      ['skill_arxiv_latest', '../api/skills_native/arxiv', 'latestArxiv', { category: 'cs.AI' }, [sentinel]],
      ['skill_earthquake_latest', '../api/skills_native/earthquake', 'queryLatestEarthquakes', { scope: 'global' }, [sentinel]],
      ['skill_weather', '../api/skills_native/weather', 'getWeatherSummary', { city: '上海' }, [sentinel]],
      ['skill_weather_cloud', '../api/skills_native/weatherCloud', 'sendLatestWeatherCloud', { channel: 'infrared' }, [sentinel]],
      ['skill_youtube_transcript', '../api/skills_native/youtube', 'getYoutubeTranscript', { url: 'https://example.com' }, [sentinel]],
      ['skill_summarize', '../api/skills_native/summarize', 'summarizeInput', { text: 'hello' }, [sentinel]],
      ['skill_stock_analyze', '../api/skills_native/stocks/analyze', 'analyzeStocks', { symbols: ['A'] }, [sentinel]],
      ['skill_stock_dividend', '../api/skills_native/stocks/dividend', 'queryDividends', { symbol: 'A' }, [sentinel]],
      ['skill_stock_price_query', '../api/skills_native/stocks/quote', 'queryQuotes', { symbol: 'A' }, [sentinel]],
      ['skill_ontology_graph', '../api/skills_native/ontology', 'mutateOntology', { action: 'list' }, [sentinel]],
      ['skill_stock_watchlist', '../api/skills_native/stocks/watchlist', 'mutateWatchlist', { action: 'list' }, [sentinel]],
      ['skill_skill_validate', '../api/skills_native/skillValidation', 'validateSkillByName', { skill_name: 'demo' }, [sentinel]],
      ['skill_stock_hot', '../api/skills_native/stocks/hot', 'scanHot', { market: 'cn' }, [sentinel]],
      ['skill_stock_portfolio', '../api/skills_native/stocks/portfolio', 'mutatePortfolio', { action: 'list' }, [sentinel]],
      ['skill_stock_rumor', '../api/skills_native/stocks/rumor', 'scanRumors', {}, [sentinel]],
      ['skill_ppt_generate', '../api/skills_native/ppt', 'generatePpt', { title: 'demo' }, [sentinel]],
      ['skill_ppt_theme_list', '../api/skills_native/ppt', 'listThemes', {}, [sentinel]],
      ['skill_clawddocs_search', '../api/skills_native/clawddocs', 'searchDocs', { query: 'routing' }, [`1. ${sentinel}`]],
      ['skill_clawddocs_fetch', '../api/skills_native/clawddocs', 'fetchDoc', { doc_path: 'guide.md' }, [sentinel]],
      ['skill_image_generate_pro', '../api/skills_native/imageGenerate', 'generateImage', { prompt: 'moon' }, [sentinel]]
    ];

    for (const [, modulePath, method] of nativeCases) {
      patchMethod(modulePath, method, method === 'searchDocs' ? [sentinel] : sentinel);
    }

    const { TOOL_EXECUTORS } = require('../api/toolExecutors');
    for (const [name, modulePath, method, args, expectedResults] of nativeCases) {
      const before = calls.length;
      const result = await TOOL_EXECUTORS[name](args);
      assert.ok(expectedResults.includes(result), `${name} should return its native module result`);
      assert.strictEqual(calls.length, before + 1, `${name} should call one native module method`);
      assert.strictEqual(calls[before].modulePath, modulePath);
      assert.strictEqual(calls[before].method, method);
      const callArgs = calls[before].args;
      if (['skill_ontology_graph', 'skill_stock_watchlist', 'skill_stock_portfolio'].includes(name)) {
        assert.deepStrictEqual(callArgs, [process.env.DATA_DIR, args]);
      } else if (['skill_summarize', 'skill_image_generate_pro'].includes(name)) {
        assert.deepStrictEqual(callArgs, [args, process.env.DATA_DIR]);
      } else if (name === 'skill_skill_validate') {
        assert.deepStrictEqual(callArgs, [skillsDir, 'demo']);
      } else if (name === 'skill_clawddocs_search') {
        assert.deepStrictEqual(callArgs, [path.join(skillsDir, 'clawddocs'), 'routing']);
      } else if (name === 'skill_clawddocs_fetch') {
        assert.deepStrictEqual(callArgs, [path.join(skillsDir, 'clawddocs'), 'guide.md']);
      } else if (['skill_stock_rumor', 'skill_ppt_theme_list'].includes(name)) {
        assert.deepStrictEqual(callArgs, []);
      } else {
        assert.deepStrictEqual(callArgs, [args]);
      }
    }

    const dependencyReport = await TOOL_EXECUTORS.skill_qqbot_dep_check();
    assert.match(dependencyReport, /axios:ok/);
    assert.match(dependencyReport, /cheerio:ok/);
    assert.match(dependencyReport, /@langchain\/core:ok/);

    console.log('noExternalProcessSkillsSource.test.js passed');
  } finally {
    for (const [name, implementation] of Object.entries(originalProcessMethods)) {
      childProcess[name] = implementation;
    }
    restoreEnv(envSnapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
