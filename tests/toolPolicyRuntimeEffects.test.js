const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createDispatchNode } = require('../api/runtimeV2/nodes/dispatch');
const {
  buildExecutionBatches,
  executeBatch
} = require('../api/runtimeV2/capabilities/scheduler');
const { buildStaticToolDescriptors } = require('../api/runtimeV2/capabilities/registry');
const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');
const {
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
} = require('../utils/toolPolicy');

async function executeWithoutConfirmation(input) {
  return {
    status: 'completed',
    executed: true,
    result: await input.executor({ ...input.normalizedArgs, __context: input.toolContext })
  };
}

function buildRegistry(descriptors) {
  return {
    descriptors,
    byName: new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]))
  };
}

function createExecutionHelpers(executor, options = {}) {
  return createToolExecutionHelpers({
    config: {
      TOOL_ARG_VALIDATION_ENABLED: false,
      READONLY_TOOL_CACHE_TTL_MS: 0,
      READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: options.inflightDedup === true
    },
    stableHash: (value) => JSON.stringify(value || {}),
    summarizeToolLogValue: (value) => String(value),
    getPolicy: options.getPolicy || getPolicy,
    resolveToolPolicy,
    hasPublicToolPolicy,
    isDynamicToolRegistered: () => false,
    executeAuthorizedToolCall: executeWithoutConfirmation,
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
    toolExecutors: {
      skill_stock_watchlist: executor,
      skill_ontology_graph: executor,
      web_search: executor
    }
  });
}

function createState(toolName, inputs) {
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

function createStep(id, tool, inputs) {
  return { id, kind: 'tool', tool, inputs, status: 'pending', evidence: [] };
}

module.exports = (async () => {
  const staticDescriptors = buildStaticToolDescriptors();
  const staticRegistry = buildRegistry(staticDescriptors);

  const readBatches = buildExecutionBatches([
    createStep('stock_list', 'skill_stock_watchlist', { action: 'list' }),
    createStep('web_read', 'web_search', { query: 'market' })
  ], staticRegistry);
  assert.deepStrictEqual(readBatches.map((batch) => batch.mode), ['parallel']);

  const writeBatches = buildExecutionBatches([
    createStep('stock_add', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
    createStep('web_after_write', 'web_search', { query: 'market' })
  ], staticRegistry);
  assert.deepStrictEqual(writeBatches.map((batch) => batch.mode), ['serial', 'serial']);

  let schedulerCalls = 0;
  const stockDescriptor = {
    ...staticRegistry.byName.get('skill_stock_watchlist'),
    executor: async () => {
      schedulerCalls += 1;
      return 'ok';
    }
  };
  const stockRegistry = buildRegistry([stockDescriptor]);
  const toolResultCache = new Map();
  const schedulerState = createState('skill_stock_watchlist', {});
  const schedulerContext = {
    registry: stockRegistry,
    executeAuthorizedToolCall: executeWithoutConfirmation,
    toolResultCache,
    toolResultCacheTtlMs: 1000,
    helpers: {
      enforceToolPolicy: (_toolName, args) => args
    }
  };

  const [firstRead] = await executeBatch([
    createStep('scheduler_read_1', 'skill_stock_watchlist', { action: 'list' })
  ], schedulerState, schedulerContext);
  const [cachedRead] = await executeBatch([
    createStep('scheduler_read_2', 'skill_stock_watchlist', { action: 'list' })
  ], schedulerState, schedulerContext);
  assert.strictEqual(firstRead.side_effect, false);
  assert.strictEqual(cachedRead.cached, true);
  assert.strictEqual(schedulerCalls, 1, 'read action should reuse scheduler cache');

  const [firstWrite] = await executeBatch([
    createStep('scheduler_write_1', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
  ], schedulerState, schedulerContext);
  await executeBatch([
    createStep('scheduler_write_2', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
  ], schedulerState, schedulerContext);
  assert.strictEqual(firstWrite.side_effect, true);
  assert.strictEqual(schedulerCalls, 3, 'write action must never reuse scheduler cache');

  let ontologyCalls = 0;
  const ontologyDescriptor = {
    ...staticRegistry.byName.get('skill_ontology_graph'),
    executor: async () => {
      ontologyCalls += 1;
      return 'ok';
    }
  };
  const ontologyRegistry = buildRegistry([ontologyDescriptor]);
  const ontologyCache = new Map();
  const ontologyContext = {
    registry: ontologyRegistry,
    executeAuthorizedToolCall: executeWithoutConfirmation,
    toolResultCache: ontologyCache,
    toolResultCacheTtlMs: 1000,
    helpers: {
      enforceToolPolicy: (_toolName, args) => args
    }
  };
  await executeBatch([
    createStep('ontology_read_1', 'skill_ontology_graph', { action: 'query', type: 'Task' })
  ], createState('skill_ontology_graph', {}), ontologyContext);
  const [cachedOntologyRead] = await executeBatch([
    createStep('ontology_read_2', 'skill_ontology_graph', { action: 'query', type: 'Task' })
  ], createState('skill_ontology_graph', {}), ontologyContext);
  const [ontologyValidate] = await executeBatch([
    createStep('ontology_validate_1', 'skill_ontology_graph', { action: 'validate' })
  ], createState('skill_ontology_graph', {}), ontologyContext);
  await executeBatch([
    createStep('ontology_validate_2', 'skill_ontology_graph', { action: 'validate' })
  ], createState('skill_ontology_graph', {}), ontologyContext);
  assert.strictEqual(cachedOntologyRead.cached, true);
  assert.strictEqual(ontologyValidate.side_effect, true);
  assert.strictEqual(ontologyCalls, 3, 'ontology writes must not reuse the read-only cache');

  let directCalls = 0;
  const directHelpers = createExecutionHelpers(async () => {
    directCalls += 1;
    return 'ok';
  });
  const directRead = await directHelpers.runToolStep(
    createStep('direct_read', 'skill_stock_watchlist', { action: 'list' }),
    createState('skill_stock_watchlist', { action: 'list' })
  );
  const directWrite = await directHelpers.runToolStep(
    createStep('direct_write', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
    createState('skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
  );
  assert.strictEqual(directRead.side_effect, false);
  assert.strictEqual(directWrite.side_effect, true);
  assert.strictEqual(directCalls, 2);

  const directOntologyRead = await directHelpers.runToolStep(
    createStep('direct_ontology_read', 'skill_ontology_graph', { action: 'query', type: 'Task' }),
    createState('skill_ontology_graph', { action: 'query', type: 'Task' })
  );
  const directOntologyValidate = await directHelpers.runToolStep(
    createStep('direct_ontology_validate', 'skill_ontology_graph', { action: 'validate' }),
    createState('skill_ontology_graph', { action: 'validate' })
  );
  assert.strictEqual(directOntologyRead.side_effect, false);
  assert.strictEqual(directOntologyValidate.side_effect, true);
  assert.strictEqual(directCalls, 4);

  let concurrentWriteCalls = 0;
  const writeHelpers = createExecutionHelpers(async () => {
    concurrentWriteCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return 'ok';
  }, {
    inflightDedup: true
  });
  await Promise.all([
    writeHelpers.runToolStep(
      createStep('write_stock_1', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
      createState('skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
    ),
    writeHelpers.runToolStep(
      createStep('write_stock_2', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
      createState('skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
    )
  ]);
  assert.strictEqual(concurrentWriteCalls, 2, 'write actions must not share inflight work');

  async function runDispatch(inputs) {
    const checkpointEvents = [];
    const persisted = [];
    const step = createStep('dispatch_step', 'skill_stock_watchlist', inputs);
    const dispatchNode = createDispatchNode({
      createEvent: (type, payload = {}) => ({ type, ...payload }),
      stableHash: (value) => JSON.stringify(value || {}),
      isCompletedSideEffectStep: () => false,
      findEvidenceEnvelope: () => null,
      isDirectChatRequest: () => false,
      buildExecutionBatches: (steps) => [{ mode: 'serial', items: steps }],
      buildLiveMainConversationSnapshot: () => null,
      computeEffectiveAllowedTools: () => ['skill_stock_watchlist'],
      createMemoryCliTurnState: (value = {}) => value,
      persistCheckpoint(state) {
        persisted.push(Boolean(state.execution?.pendingInterrupt));
      },
      appendRuntimeEvents(_state, events) {
        checkpointEvents.push(...events.filter((event) => event.type === 'checkpoint'));
      },
      updatePlanStepsWithEnvelope(steps, envelope) {
        return steps.map((item) => item.id === envelope.step_id
          ? { ...item, status: envelope.status, evidence: [envelope] }
          : item);
      },
      getPolicy,
      isSideEffectPolicy: (policy) => policy.effect !== 'none',
      async executeBatch(steps) {
        return steps.map((item) => ({
          tool_call_id: `${item.id}_call`,
          step_id: item.id,
          tool_name: item.tool,
          args_hash: JSON.stringify(item.inputs || {}),
          args: item.inputs || {},
          status: 'completed',
          result: 'ok',
          side_effect: getPolicy(item.tool, item.inputs).effect !== 'none',
          retryable: false,
          attempt: 1
        }));
      },
      rebuildFinalPlanFromSteps: (state) => ({ steps: state.plan.steps }),
      buildExecLogsFromSteps: () => [],
      mergeAllowedToolsWithMemoryCli: (allowed) => allowed || [],
      saveAndEmit: (state) => state,
      config: { PLAN_MAX_STEPS: 5 }
    });
    await dispatchNode({
      request: {
        question: 'stock action',
        allowedTools: ['skill_stock_watchlist'],
        allowTools: true
      },
      plan: { steps: [step] },
      execution: { retryQueue: [], memoryCliTurn: {}, toolResults: [] },
      memory: { dirty: false },
      output: {}
    });
    return { checkpointEvents, persisted };
  }

  const readDispatch = await runDispatch({ action: 'list' });
  assert.deepStrictEqual(readDispatch.checkpointEvents, []);
  assert.deepStrictEqual(readDispatch.persisted, []);

  const writeDispatch = await runDispatch({ action: 'add', ticker: 'AAA' });
  assert.deepStrictEqual(
    writeDispatch.checkpointEvents.map((event) => event.stage),
    ['before_side_effect', 'after_side_effect']
  );
  assert.deepStrictEqual(writeDispatch.persisted, [true, false]);

  console.log('toolPolicyRuntimeEffects.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
