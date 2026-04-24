const assert = require('assert');
const {
  clearResearchBriefs,
  getRecentResearchBriefs,
  saveResearchBrief
} = require('../utils/sessionResearchCache');

module.exports = (() => {
  clearResearchBriefs();
  saveResearchBrief({ sessionKey: 's1', userId: 'u1', query: 'OpenAI docs', status: 'completed', summary: 'OpenAI documentation summary', sources: [{ url: 'https://example.com' }] }, { now: 1000, ttlMs: 10000 });
  assert.strictEqual(getRecentResearchBriefs('s1', { query: 'docs', now: 2000 }).length, 1);
  assert.strictEqual(getRecentResearchBriefs('s1', { query: 'unrelated', now: 2000 }).length, 0);
  assert.strictEqual(getRecentResearchBriefs('s1', { query: 'docs', now: 20000 }).length, 0);
  clearResearchBriefs();
  console.log('sessionResearchCache.test.js passed');
})();
