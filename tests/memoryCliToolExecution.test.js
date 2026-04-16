const assert = require('assert');

const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');

module.exports = (async () => {
  const helpers = createToolExecutionHelpers({
    config: {
      SELF_IMPROVEMENT_ENABLED: true
    },
    stableHash(value) {
      return JSON.stringify(value || {});
    },
    summarizeToolLogValue(value) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    getPolicy() {
      return {};
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
      return ['memory_cli'];
    },
    createMemoryCliTurnState(value = {}) {
      return {
        searchCount: 0,
        openCount: 0,
        successfulCount: 0,
        mustAnswer: false,
        lastSuccessCommand: '',
        lastResultHadHits: false,
        lastErrorType: 'none',
        ...value
      };
    },
    updateMemoryCliTurnStateAfterError(state, errorType) {
      return {
        ...state,
        mustAnswer: true,
        lastErrorType: errorType
      };
    },
    updateMemoryCliTurnStateAfterResult(state, _parsed, toolResult) {
      const parsed = JSON.parse(toolResult);
      return {
        ...state,
        lastSuccessCommand: parsed.command,
        lastResultHadHits: Boolean(parsed.count),
        searchCount: parsed.command === 'search' ? Number(state.searchCount || 0) + 1 : Number(state.searchCount || 0),
        openCount: parsed.command === 'open' ? Number(state.openCount || 0) + 1 : Number(state.openCount || 0),
        mustAnswer: parsed.command === 'open'
      };
    },
    decideMemoryCliTurnAction(command) {
      return {
        ok: true,
        parsed: { commandName: /^mem open\b/i.test(command) ? 'open' : 'search' },
        preparedCommand: command,
        repairApplied: false,
        repairStrategy: []
      };
    },
    safeParseMemoryCliResult(text) {
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    },
    captureToolFailure() {
      throw new Error('captureToolFailure should not run for runtime_binding_unresolved');
    },
    isPlannerSingleAuthorityEnabled() {
      return true;
    },
    toolExecutors: {
      memory_cli: async () => '{"ok":true,"command":"open","data":{"id":"x"}}'
    }
  });

  const unresolvedOpen = await helpers.runToolStep({
    id: 'planner_step_2',
    tool: 'memory_cli',
    inputs: { command: 'mem open --ref "<to_be_populated_from_search>"' }
  }, {
    request: {
      userId: 'u1',
      allowedTools: ['memory_cli'],
      routeMeta: {}
    },
    execution: {
      memoryCliTurn: {}
    },
    plan: {
      steps: []
    }
  }, {
    node: 'dispatch'
  });

  assert.strictEqual(unresolvedOpen.status, 'blocked');
  assert.strictEqual(unresolvedOpen.retryable, false);
  assert.strictEqual(unresolvedOpen.blockedReason, 'runtime_binding_unresolved:memory_ref');

  const previousSearchResult = '{"ok":true,"command":"search","count":1,"results":[{"ref":"mc_ref:personal:abc","preview":"喜欢猫"}]}';
  const reusedSearch = await helpers.runToolStep({
    id: 'planner_step_3',
    tool: 'memory_cli',
    inputs: { command: 'mem search --query "喜欢什么"' }
  }, {
    request: {
      userId: 'u1',
      allowedTools: ['memory_cli'],
      routeMeta: {}
    },
    execution: {
      memoryCliTurn: {
        searchCount: 1,
        openCount: 0,
        successfulCount: 1,
        mustAnswer: false,
        lastSuccessCommand: 'search',
        lastResultHadHits: true,
        lastErrorType: 'none'
      },
      toolResults: [{
        tool_name: 'memory_cli',
        result: previousSearchResult
      }]
    },
    plan: {
      steps: []
    }
  }, {
    node: 'dispatch'
  });

  assert.strictEqual(reusedSearch.status, 'completed');
  assert.strictEqual(reusedSearch.retryable, false);
  assert.strictEqual(reusedSearch.result, previousSearchResult);

  console.log('memoryCliToolExecution.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
