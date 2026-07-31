const assert = require('assert');

process.env.AGENT_DEPENDENCY_AWARE_BATCHING = 'true';
process.env.AGENT_PARALLEL_SAFE_TOOLS = 'true';
process.env.AGENT_BATCH_MAX_CONCURRENCY = '2';
process.env.AGENT_BATCH_TOOL_TIMEOUT_MS = '40';
process.env.AGENT_TOOL_RESULT_CACHE_TTL_MS = '1000';
process.env.AGENT_RUNTIME_METRICS_ENABLED = 'false';

const scheduler = require('../api/runtimeV2/capabilities/scheduler');

module.exports = (async () => {
  const registry = {
    byName: new Map([
      ['web_search', { name: 'web_search', kind: 'tool', policy: { effect: 'none' }, parallelSafe: true }],
      ['get_current_time', { name: 'get_current_time', kind: 'tool', policy: { effect: 'none' }, parallelSafe: true }],
      ['skill_stock_watchlist', { name: 'skill_stock_watchlist', kind: 'tool', policy: { effect: 'local_write' }, parallelSafe: false, sideEffect: true }]
    ])
  };

  const batches = scheduler.buildExecutionBatches([
    { id: 'a', kind: 'tool', tool: 'web_search', inputs: { q: 1 } },
    { id: 'b', kind: 'tool', tool: 'get_current_time', inputs: { q: 2 } },
    { id: 'c', kind: 'tool', tool: 'skill_stock_watchlist', inputs: { q: 3 } },
    { id: 'd', kind: 'tool', tool: 'web_search', dependsOn: ['c'], inputs: { q: 4 } }
  ], registry);

  assert.deepStrictEqual(batches.map((batch) => batch.mode), ['parallel', 'serial', 'serial']);
  assert.deepStrictEqual(batches[0].items.map((step) => step.id).sort(), ['a', 'b']);
  assert.strictEqual(batches[1].items[0].id, 'c');
  assert.strictEqual(batches[2].items[0].id, 'd');

  let active = 0;
  let maxActive = 0;
  let callCount = 0;
  const cache = new Map();
  const executeBatchRegistry = {
    byName: new Map([
      ['web_search', {
        name: 'web_search',
        kind: 'tool',
        policy: { effect: 'none' },
        parallelSafe: true,
        executor: async () => {
          callCount += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          return 'ok';
        }
      }],
      ['get_current_time', {
        name: 'get_current_time',
        kind: 'tool',
        policy: { effect: 'none' },
        parallelSafe: true,
        executor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return 'late';
        }
      }]
    ])
  };

  const results = await scheduler.executeBatch([
    { id: 'x1', kind: 'tool', tool: 'web_search', inputs: { same: true } },
    { id: 'x2', kind: 'tool', tool: 'web_search', inputs: { same: false } },
    { id: 'x3', kind: 'tool', tool: 'web_search', inputs: { same: 'third' } }
  ], { request: { allowedTools: ['web_search'] } }, {
    registry: executeBatchRegistry,
    toolResultCache: cache,
    batches: [{ mode: 'parallel', items: [
      { id: 'x1', kind: 'tool', tool: 'web_search', inputs: { same: true } },
      { id: 'x2', kind: 'tool', tool: 'web_search', inputs: { same: false } },
      { id: 'x3', kind: 'tool', tool: 'web_search', inputs: { same: 'third' } }
    ] }]
  });

  assert.strictEqual(results.length, 3);
  assert.ok(maxActive <= 2, 'batch executor should respect max concurrency');

  await scheduler.executeBatch([
    { id: 'x4', kind: 'tool', tool: 'web_search', inputs: { same: true } }
  ], { request: { allowedTools: ['web_search'] } }, {
    registry: executeBatchRegistry,
    toolResultCache: cache
  });
  assert.strictEqual(callCount, 3, 'cache should skip duplicate read-only tool execution');

  const [timeoutResult] = await scheduler.executeBatch([
    { id: 'slow_1', kind: 'tool', tool: 'get_current_time', inputs: {} }
  ], { request: { allowedTools: ['get_current_time'] } }, {
    registry: executeBatchRegistry
  });
  assert.strictEqual(timeoutResult.status, 'failed');
  assert.match(timeoutResult.result, /timeout/i);

  console.log('agentSchedulerOptimization.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
