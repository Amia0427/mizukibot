const assert = require('assert');

const { executeStep } = require('../api/runtimeV2/capabilities/scheduler');
const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');

function createToolHelpers(executor) {
  return createToolExecutionHelpers({
    config: {
      TOOL_ARG_VALIDATION_ENABLED: true,
      READONLY_TOOL_CACHE_TTL_MS: 0,
      READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: false
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
    capabilityRegistry: { byName: new Map() },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    computeEffectiveAllowedTools(request = {}) {
      return request.allowedTools || [];
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
    decideMemoryCliTurnAction() {
      return { ok: true };
    },
    safeParseMemoryCliResult() {
      return null;
    },
    captureToolFailure() {},
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    toolExecutors: {
      local_lookup: executor
    }
  });
}

module.exports = (async () => {
  let helperCalls = 0;
  const helpers = createToolHelpers(async () => {
    helperCalls += 1;
    return 'lookup ok';
  });

  const blockedByToolStep = await helpers.runToolStep({
    id: 'local_step_blocked',
    tool: 'local_lookup',
    inputs: { query: 'secret' }
  }, {
    request: {
      userId: 'u1',
      routeMeta: {},
      allowedTools: []
    },
    execution: {},
    plan: { steps: [] }
  }, { node: 'dispatch' });

  assert.strictEqual(helperCalls, 0, 'unallowed tool must not reach executor');
  assert.strictEqual(blockedByToolStep.status, 'blocked');
  assert.strictEqual(blockedByToolStep.blockedReason, 'tool_not_allowed');
  assert.match(blockedByToolStep.result, /Tool not allowed: local_lookup/);

  const allowedByToolStep = await helpers.runToolStep({
    id: 'local_step_allowed',
    tool: 'local_lookup',
    inputs: { query: 'public' }
  }, {
    request: {
      userId: 'u1',
      routeMeta: {},
      allowedTools: ['local_lookup']
    },
    execution: {},
    plan: { steps: [] }
  }, { node: 'dispatch' });

  assert.strictEqual(helperCalls, 1, 'allowed tool should reach executor');
  assert.strictEqual(allowedByToolStep.status, 'completed');
  assert.strictEqual(allowedByToolStep.result, 'lookup ok');

  let schedulerCalls = 0;
  const registry = {
    byName: new Map([[
      'local_lookup',
      {
        name: 'local_lookup',
        executor: async () => {
          schedulerCalls += 1;
          return 'scheduler ok';
        },
        parallelSafe: true
      }
    ]]),
    descriptors: []
  };
  const schedulerContext = {
    node: 'dispatch',
    registry,
    executors: {
      local_lookup: async () => {
        schedulerCalls += 1;
        return 'scheduler ok';
      }
    },
    helpers: {
      enforceToolPolicy(_toolName, args) {
        return args;
      }
    }
  };

  const blockedByScheduler = await executeStep({
    id: 'scheduler_blocked',
    tool: 'local_lookup',
    inputs: { query: 'secret' }
  }, {
    request: {
      userId: 'u1',
      routeMeta: {},
      allowedTools: []
    },
    execution: {},
    plan: { steps: [] }
  }, schedulerContext);

  assert.strictEqual(schedulerCalls, 0, 'scheduler must not execute unallowed tool');
  assert.strictEqual(blockedByScheduler.status, 'blocked');
  assert.strictEqual(blockedByScheduler.blockedReason, 'tool_not_allowed');

  const allowedByScheduler = await executeStep({
    id: 'scheduler_allowed',
    tool: 'local_lookup',
    inputs: { query: 'public' }
  }, {
    request: {
      userId: 'u1',
      routeMeta: {},
      allowedTools: ['local_lookup']
    },
    execution: {},
    plan: { steps: [] }
  }, schedulerContext);

  assert.strictEqual(schedulerCalls, 1, 'scheduler should execute allowed tool');
  assert.strictEqual(allowedByScheduler.status, 'completed');
  assert.strictEqual(allowedByScheduler.result, 'scheduler ok');

  console.log('localToolRuntimeAllowlist.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
