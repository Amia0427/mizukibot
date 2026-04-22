const assert = require('assert');

const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');

module.exports = (async () => {
  let searchCalls = 0;
  let writeCalls = 0;
  const helpers = createToolExecutionHelpers({
    config: {
      READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: true,
      READONLY_TOOL_CACHE_TTL_MS: 0,
      CONTEXT_STATS_CACHE_TTL_MS: 0
    },
    stableHash(value) {
      return JSON.stringify(value || {});
    },
    summarizeToolLogValue(value) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    getPolicy(toolName) {
      return toolName === 'write_tool'
        ? { capability: 'write', risk: 'high' }
        : {};
    },
    enforceToolPolicy(_toolName, args) {
      return args;
    },
    shouldRunParallel() {
      return false;
    },
    capabilityRegistry: {},
    buildLiveMainConversationSnapshot() {
      return null;
    },
    computeEffectiveAllowedTools() {
      return ['web_search', 'write_tool'];
    },
    createMemoryCliTurnState(value = {}) {
      return value;
    },
    updateMemoryCliTurnStateAfterError(state = {}) {
      return state;
    },
    updateMemoryCliTurnStateAfterResult(state = {}) {
      return state;
    },
    decideMemoryCliTurnAction(command = '') {
      return {
        ok: true,
        parsed: { commandName: command },
        preparedCommand: command,
        repairApplied: false,
        repairStrategy: []
      };
    },
    safeParseMemoryCliResult() {
      return null;
    },
    captureToolFailure() {},
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    toolExecutors: {
      web_search: async () => {
        searchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'search ok';
      },
      write_tool: async () => {
        writeCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'write ok';
      }
    }
  });

  const state = {
    request: {
      userId: 'u1',
      sessionKey: 's1',
      routeMeta: {},
      allowedTools: ['web_search', 'write_tool']
    },
    execution: {
      memoryCliTurn: {}
    },
    plan: {
      steps: []
    }
  };

  const [a, b] = await Promise.all([
    helpers.runToolStep({
      id: 'step_1',
      tool: 'web_search',
      inputs: { query: 'same' }
    }, state, { node: 'dispatch' }),
    helpers.runToolStep({
      id: 'step_2',
      tool: 'web_search',
      inputs: { query: 'same' }
    }, state, { node: 'dispatch' })
  ]);

  assert.strictEqual(searchCalls, 1, 'same readonly tool call should dedupe in flight');
  assert.strictEqual(a.status, 'completed');
  assert.strictEqual(b.status, 'completed');

  await Promise.all([
    helpers.runToolStep({
      id: 'step_3',
      tool: 'write_tool',
      inputs: { id: 1 }
    }, state, { node: 'dispatch' }),
    helpers.runToolStep({
      id: 'step_4',
      tool: 'write_tool',
      inputs: { id: 1 }
    }, state, { node: 'dispatch' })
  ]);

  assert.strictEqual(writeCalls, 2, 'write-like tools must not be deduped');

  console.log('readonlyToolInflightDedup.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
