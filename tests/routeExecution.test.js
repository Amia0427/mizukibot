const assert = require('assert');

const { buildCapabilityRegistry } = require('../api/runtimeV2/capabilities/registry');
const {
  EXECUTORS,
  resolveRouteExecution,
  shouldUseSubagentToolRoute
} = require('../core/routeExecution');

const adminPlan = resolveRouteExecution({
  topRouteType: 'admin',
  meta: {
    command: {
      cmd: 'unknown',
      raw: '/full task'
    }
  }
});

assert.strictEqual(adminPlan.executor, 'admin');
assert.notStrictEqual(adminPlan.executor, 'full_subagent');
assert.ok(!EXECUTORS.includes('full_subagent'));
assert.strictEqual(shouldUseSubagentToolRoute({ topRouteType: 'admin' }), false);

const directPlan = resolveRouteExecution({
  topRouteType: 'direct_chat',
  meta: {
    chatMode: 'text_chat',
    responseIntent: 'answer',
    toolIntent: 'none'
  },
  facets: {
    sourceScope: 'none',
    outputKind: 'answer'
  }
});

assert.notStrictEqual(directPlan.executor, 'full_subagent');

const registry = buildCapabilityRegistry();
assert.strictEqual(registry.byName.has('subagent_bridge'), false);
assert.ok(!registry.descriptors.some((descriptor) => descriptor.name === 'subagent_bridge'));

console.log('routeExecution.test.js passed');
