const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const warnings = [];
  const originalWarn = console.warn;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.LANGGRAPH_RUNTIME_VERSION = '1';
    clearProjectCache();

    const agentGraphV2Path = require.resolve('../api/agentGraphV2');
    const calls = [];
    require.cache[agentGraphV2Path] = {
      id: agentGraphV2Path,
      filename: agentGraphV2Path,
      loaded: true,
      exports: {
        askAIByGraphV2: async (...args) => {
          calls.push(args);
          return `v2:${args[0]}`;
        }
      }
    };

    console.warn = (...args) => warnings.push(args);
    const facade = require('../api/agentGraphFacade');

    assert.strictEqual(
      await facade.askAIByGraph('first', { level: 'stranger' }, 'u1'),
      'v2:first'
    );
    assert.strictEqual(
      await facade.askAIByGraphV1('second', { level: 'stranger' }, 'u1'),
      'v2:second'
    );
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(warnings.length, 1, 'compat warning should be emitted once');
    assert.match(String(warnings[0][0] || ''), /V2 runtime is always used/);
    assert.deepStrictEqual(warnings[0][1], { configured: '1' });

    console.log('langgraphRuntimeVersion.test.js passed');
  } finally {
    console.warn = originalWarn;
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})();
