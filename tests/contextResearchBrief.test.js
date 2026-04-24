const assert = require('assert');
const { formatResearchBriefsForPrompt } = require('../api/runtimeV2/context/service');

module.exports = (() => {
  const text = formatResearchBriefsForPrompt([
    { query: 'AI news', summary: 'Research summary', sources: [{ url: 'https://example.com' }] }
  ]);
  assert.ok(text.includes('[BackgroundResearch]'));
  assert.ok(text.includes('Research summary'));
  assert.ok(text.includes('https://example.com'));
  assert.strictEqual(formatResearchBriefsForPrompt([]), '');
  console.log('contextResearchBrief.test.js passed');
})();
