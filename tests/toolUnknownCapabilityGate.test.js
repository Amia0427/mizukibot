const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { executeStep } = require('../api/runtimeV2/capabilities/scheduler');
const { buildStaticToolDescriptors } = require('../api/runtimeV2/capabilities/registry');
const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');
const {
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
} = require('../utils/toolPolicy');

function createHelpers(executors, isDynamicToolRegistered = () => false) {
  return createToolExecutionHelpers({
    config: {
      TOOL_ARG_VALIDATION_ENABLED: false,
      READONLY_TOOL_CACHE_TTL_MS: 0,
      READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: false
    },
    stableHash: (value) => JSON.stringify(value || {}),
    summarizeToolLogValue: (value) => String(value),
    getPolicy,
    resolveToolPolicy,
    hasPublicToolPolicy,
    isDynamicToolRegistered,
    enforceToolPolicy: (_toolName, args) => args,
    shouldRunParallel: () => false,
    capabilityRegistry: { byName: new Map() },
    buildLiveMainConversationSnapshot: () => null,
    computeEffectiveAllowedTools: (request = {}) => request.allowedTools || [],
    createMemoryCliTurnState: (value = {}) => value,
    updateMemoryCliTurnStateAfterError: (state = {}) => state,
    updateMemoryCliTurnStateAfterResult: (state = {}) => state,
    decideMemoryCliTurnAction: () => ({ ok: true }),
    safeParseMemoryCliResult: () => null,
    captureToolFailure: () => {},
    isPlannerSingleAuthorityEnabled: () => false,
    toolExecutors: executors
  });
}

function createState(toolName) {
  return {
    request: {
      userId: 'u1',
      routeMeta: {},
      allowedTools: [toolName]
    },
    execution: {},
    plan: { steps: [] },
    memory: {}
  };
}

function createStep(toolName, inputs = {}) {
  return {
    id: `${toolName}_step`,
    kind: 'tool',
    tool: toolName,
    inputs,
    status: 'pending',
    evidence: []
  };
}

module.exports = (async () => {
  let directCalls = 0;
  const unknownName = '__injected_unknown_tool__';
  const internalName = 'local_howtocook_recipe_search';
  const fakeMcpName = 'mcp_forged_metadata';
  const directHelpers = createHelpers({
    [unknownName]: async () => {
      directCalls += 1;
      return 'unknown executed';
    },
    [internalName]: async () => {
      directCalls += 1;
      return 'internal executed';
    },
    skill_stock_watchlist: async () => {
      directCalls += 1;
      return 'stock executed';
    },
    [fakeMcpName]: async () => {
      directCalls += 1;
      return 'mcp executed';
    }
  });

  const unknownDirect = await directHelpers.runToolStep(
    createStep(unknownName),
    createState(unknownName)
  );
  assert.strictEqual(unknownDirect.status, 'blocked');
  assert.strictEqual(unknownDirect.blockedReason, 'unknown_capability');

  const internalDirect = await directHelpers.runToolStep(
    createStep(internalName),
    createState(internalName)
  );
  assert.strictEqual(internalDirect.status, 'blocked');
  assert.strictEqual(internalDirect.blockedReason, 'internal_capability');

  const unknownActionDirect = await directHelpers.runToolStep(
    createStep('skill_stock_watchlist', { action: 'replace' }),
    createState('skill_stock_watchlist')
  );
  assert.strictEqual(unknownActionDirect.status, 'blocked');
  assert.strictEqual(unknownActionDirect.blockedReason, 'unknown_action');

  const fakeMcpDirect = await directHelpers.runToolStep(
    createStep(fakeMcpName),
    createState(fakeMcpName)
  );
  assert.strictEqual(fakeMcpDirect.status, 'blocked');
  assert.strictEqual(fakeMcpDirect.blockedReason, 'unknown_capability');
  assert.strictEqual(directCalls, 0);

  let registeredMcpCalls = 0;
  const registeredMcpHelpers = createHelpers({
    [fakeMcpName]: async () => {
      registeredMcpCalls += 1;
      return 'registered mcp ok';
    }
  }, (toolName) => toolName === fakeMcpName);
  const registeredMcpDirect = await registeredMcpHelpers.runToolStep(
    createStep(fakeMcpName),
    createState(fakeMcpName)
  );
  assert.strictEqual(registeredMcpDirect.status, 'completed');
  assert.strictEqual(registeredMcpDirect.side_effect, true);
  assert.strictEqual(registeredMcpCalls, 1);

  let schedulerCalls = 0;
  const createSchedulerContext = (toolName, options = {}) => {
    const descriptor = options.descriptor || {
      name: toolName,
      executor: async () => {
        schedulerCalls += 1;
        return 'scheduler ok';
      },
      policy: getPolicy(toolName),
      metadata: options.metadata || {}
    };
    return {
      registry: {
        descriptors: [descriptor],
        byName: new Map([[toolName, descriptor]])
      },
      isDynamicToolRegistered: options.isDynamicToolRegistered || (() => false),
      helpers: {
        enforceToolPolicy: (_toolName, args) => args
      }
    };
  };

  const unknownScheduler = await executeStep(
    createStep(unknownName),
    createState(unknownName),
    createSchedulerContext(unknownName)
  );
  assert.strictEqual(unknownScheduler.status, 'blocked');
  assert.strictEqual(unknownScheduler.blockedReason, 'unknown_capability');

  const internalScheduler = await executeStep(
    createStep(internalName),
    createState(internalName),
    createSchedulerContext(internalName)
  );
  assert.strictEqual(internalScheduler.status, 'blocked');
  assert.strictEqual(internalScheduler.blockedReason, 'internal_capability');

  const stockDescriptor = buildStaticToolDescriptors()
    .find((descriptor) => descriptor.name === 'skill_stock_watchlist');
  const unknownActionScheduler = await executeStep(
    createStep('skill_stock_watchlist', { action: 'replace' }),
    createState('skill_stock_watchlist'),
    createSchedulerContext('skill_stock_watchlist', {
      descriptor: {
        ...stockDescriptor,
        executor: async () => {
          schedulerCalls += 1;
          return 'stock scheduler ok';
        }
      }
    })
  );
  assert.strictEqual(unknownActionScheduler.status, 'blocked');
  assert.strictEqual(unknownActionScheduler.blockedReason, 'unknown_action');

  const forgedMcpScheduler = await executeStep(
    createStep(fakeMcpName),
    createState(fakeMcpName),
    createSchedulerContext(fakeMcpName, { metadata: { source: 'mcp' } })
  );
  assert.strictEqual(forgedMcpScheduler.status, 'blocked');
  assert.strictEqual(forgedMcpScheduler.blockedReason, 'unknown_capability');

  const registeredMcpScheduler = await executeStep(
    createStep(fakeMcpName),
    createState(fakeMcpName),
    createSchedulerContext(fakeMcpName, {
      metadata: { source: 'mcp' },
      isDynamicToolRegistered: (toolName) => toolName === fakeMcpName
    })
  );
  assert.strictEqual(registeredMcpScheduler.status, 'completed');
  assert.strictEqual(registeredMcpScheduler.side_effect, true);
  assert.strictEqual(schedulerCalls, 1);

  console.log('toolUnknownCapabilityGate.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
