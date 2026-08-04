const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { buildExecutionBatches, executeBatch } = require('../api/runtimeV2/capabilities/scheduler');
const { buildStaticToolDescriptors } = require('../api/runtimeV2/capabilities/registry');
const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');
const { getPolicy, hasPublicToolPolicy, resolveToolPolicy } = require('../utils/toolPolicy');

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
    toolExecutors: {
      skill_stock_watchlist: executor,
      skill_ontology_graph: executor,
      web_search: executor
    }
  });
}

function createState(toolName) {
  return {
    request: {
      userId: 'u1',
      routeMeta: { allowedTools: [toolName] },
      allowedTools: [toolName]
    },
    execution: {},
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

  let stockCalls = 0;
  const stockDescriptor = {
    ...staticRegistry.byName.get('skill_stock_watchlist'),
    executor: async () => {
      stockCalls += 1;
      return 'ok';
    }
  };
  const stockContext = {
    registry: buildRegistry([stockDescriptor]),
    executeAuthorizedToolCall: executeWithoutConfirmation,
    toolResultCache: new Map(),
    toolResultCacheTtlMs: 1000,
    helpers: { enforceToolPolicy: (_toolName, args) => args }
  };
  const [firstRead] = await executeBatch([
    createStep('scheduler_read_1', 'skill_stock_watchlist', { action: 'list' })
  ], createState('skill_stock_watchlist'), stockContext);
  const [cachedRead] = await executeBatch([
    createStep('scheduler_read_2', 'skill_stock_watchlist', { action: 'list' })
  ], createState('skill_stock_watchlist'), stockContext);
  const [firstWrite] = await executeBatch([
    createStep('scheduler_write_1', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
  ], createState('skill_stock_watchlist'), stockContext);
  await executeBatch([
    createStep('scheduler_write_2', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' })
  ], createState('skill_stock_watchlist'), stockContext);
  assert.strictEqual(firstRead.side_effect, false);
  assert.strictEqual(cachedRead.cached, true);
  assert.strictEqual(firstWrite.side_effect, true);
  assert.strictEqual(stockCalls, 3);

  let ontologyCalls = 0;
  const ontologyDescriptor = {
    ...staticRegistry.byName.get('skill_ontology_graph'),
    executor: async () => {
      ontologyCalls += 1;
      return 'ok';
    }
  };
  const ontologyContext = {
    registry: buildRegistry([ontologyDescriptor]),
    executeAuthorizedToolCall: executeWithoutConfirmation,
    toolResultCache: new Map(),
    toolResultCacheTtlMs: 1000,
    helpers: { enforceToolPolicy: (_toolName, args) => args }
  };
  await executeBatch([
    createStep('ontology_read_1', 'skill_ontology_graph', { action: 'query', type: 'Task' })
  ], createState('skill_ontology_graph'), ontologyContext);
  const [cachedOntologyRead] = await executeBatch([
    createStep('ontology_read_2', 'skill_ontology_graph', { action: 'query', type: 'Task' })
  ], createState('skill_ontology_graph'), ontologyContext);
  const [ontologyValidate] = await executeBatch([
    createStep('ontology_validate_1', 'skill_ontology_graph', { action: 'validate' })
  ], createState('skill_ontology_graph'), ontologyContext);
  await executeBatch([
    createStep('ontology_validate_2', 'skill_ontology_graph', { action: 'validate' })
  ], createState('skill_ontology_graph'), ontologyContext);
  assert.strictEqual(cachedOntologyRead.cached, true);
  assert.strictEqual(ontologyValidate.side_effect, true);
  assert.strictEqual(ontologyCalls, 3);

  let directCalls = 0;
  const directHelpers = createExecutionHelpers(async () => {
    directCalls += 1;
    return 'ok';
  });
  const directRead = await directHelpers.runToolStep(
    createStep('direct_read', 'skill_stock_watchlist', { action: 'list' }),
    createState('skill_stock_watchlist')
  );
  const directWrite = await directHelpers.runToolStep(
    createStep('direct_write', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
    createState('skill_stock_watchlist')
  );
  assert.strictEqual(directRead.side_effect, false);
  assert.strictEqual(directWrite.side_effect, true);
  assert.strictEqual(directCalls, 2);

  let concurrentWrites = 0;
  const writeHelpers = createExecutionHelpers(async () => {
    concurrentWrites += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return 'ok';
  }, { inflightDedup: true });
  await Promise.all([
    writeHelpers.runToolStep(
      createStep('write_stock_1', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
      createState('skill_stock_watchlist')
    ),
    writeHelpers.runToolStep(
      createStep('write_stock_2', 'skill_stock_watchlist', { action: 'add', ticker: 'AAA' }),
      createState('skill_stock_watchlist')
    )
  ]);
  assert.strictEqual(concurrentWrites, 2);

  console.log('toolPolicyRuntimeEffects.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
