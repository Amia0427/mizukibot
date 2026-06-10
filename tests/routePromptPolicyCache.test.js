const assert = require('assert');
const fs = require('fs');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (() => {
  clearProjectCache();

  const {
    ROUTE_PROMPT_POLICY_PATH,
    clearRoutePromptPolicyCache,
    resolveRoutePromptPolicy
  } = require('../utils/routePromptPolicy');

  clearRoutePromptPolicyCache();
  const originalReadFileSync = fs.readFileSync;
  let policyReads = 0;

  try {
    fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
      if (path.resolve(String(filePath || '')) === path.resolve(ROUTE_PROMPT_POLICY_PATH)) {
        policyReads += 1;
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };

    const first = resolveRoutePromptPolicy('chat/default', { topRouteType: 'direct_chat' });
    const second = resolveRoutePromptPolicy('chat/default', { topRouteType: 'direct_chat' });

    assert.deepStrictEqual(second, first);
    assert.strictEqual(policyReads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
    clearProjectCache();
  }

  console.log('routePromptPolicyCache.test.js passed');
})();
