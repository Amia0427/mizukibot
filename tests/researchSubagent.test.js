const assert = require('assert');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const { clearResearchBriefs, getRecentResearchBriefs } = require('../utils/sessionResearchCache');
const { ALLOWED_RESEARCH_TOOLS, runResearchSubagent } = require('../core/researchSubagent');

module.exports = (async () => {
  clearResearchBriefs();
  const oldSearch = TOOL_EXECUTORS.web_search;
  const oldFetch = TOOL_EXECUTORS.web_fetch;
  const oldSafety = TOOL_EXECUTORS.url_safety_check;
  const calls = [];
  TOOL_EXECUTORS.web_search = async (args) => {
    calls.push(['web_search', args]);
    return 'Result https://example.com/page';
  };
  TOOL_EXECUTORS.web_fetch = async (args) => {
    calls.push(['web_fetch', args]);
    return 'Example Page\nUseful fetched details.';
  };
  TOOL_EXECUTORS.url_safety_check = async (args) => {
    calls.push(['url_safety_check', args]);
    return 'safe';
  };
  try {
    const result = await runResearchSubagent({ sessionKey: 's1', userId: 'u1', query: 'latest example' }, { maxToolRounds: 3, cacheTtlMs: 10000 });
    assert.deepStrictEqual(result.allowedTools, Array.from(ALLOWED_RESEARCH_TOOLS));
    assert.ok(calls.some(([name]) => name === 'web_search'));
    assert.ok(calls.some(([name]) => name === 'web_fetch'));
    assert.ok(result.summary.includes('latest example'));
    assert.strictEqual(getRecentResearchBriefs('s1', { query: 'example' }).length, 1);
  } finally {
    TOOL_EXECUTORS.web_search = oldSearch;
    TOOL_EXECUTORS.web_fetch = oldFetch;
    TOOL_EXECUTORS.url_safety_check = oldSafety;
    clearResearchBriefs();
  }
  console.log('researchSubagent.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
