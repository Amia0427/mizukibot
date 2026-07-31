const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createCapabilityDescriptor } = require('../api/runtimeV2/contracts');
const {
  buildDynamicMcpDescriptors,
  buildStaticToolDescriptors
} = require('../api/runtimeV2/capabilities/registry');
const { POLICY_VERSION, getPolicy } = require('../utils/toolPolicy');

const inferredWrite = createCapabilityDescriptor({
  name: 'inferred_write',
  readOnly: false
});
assert.strictEqual(inferredWrite.readOnly, false);
assert.strictEqual(inferredWrite.sideEffect, true);
assert.strictEqual(inferredWrite.parallelSafe, false);

const explicitRead = createCapabilityDescriptor({
  name: 'explicit_read',
  readOnly: true
});
assert.strictEqual(explicitRead.readOnly, true);
assert.strictEqual(explicitRead.sideEffect, false);
assert.strictEqual(explicitRead.parallelSafe, true);

const staticDescriptors = buildStaticToolDescriptors();
const staticByName = new Map(staticDescriptors.map((descriptor) => [descriptor.name, descriptor]));

for (const toolName of ['web_search', 'notebook_add_document', 'skill_stock_watchlist', 'render_qq_visual']) {
  const descriptor = staticByName.get(toolName);
  const policy = getPolicy(toolName);
  assert.ok(descriptor, `missing static descriptor: ${toolName}`);
  assert.strictEqual(descriptor.risk, policy.risk, `${toolName} risk mismatch`);
  assert.deepStrictEqual(descriptor.policy, policy, `${toolName} policy mismatch`);
  assert.strictEqual(descriptor.metadata.policyVersion, POLICY_VERSION);
  assert.strictEqual(descriptor.readOnly, policy.effect === 'none');
  assert.strictEqual(descriptor.sideEffect, policy.effect !== 'none');
  assert.strictEqual(descriptor.parallelSafe, policy.effect === 'none');
}

const dynamicDescriptors = buildDynamicMcpDescriptors([{
  functionName: 'mcp_registered_test',
  serverName: 'test-server',
  toolName: 'write_data',
  schema: {
    type: 'function',
    function: {
      name: 'mcp_registered_test',
      parameters: { type: 'object', properties: {} }
    }
  }
}]);

assert.strictEqual(dynamicDescriptors.length, 1);
assert.strictEqual(dynamicDescriptors[0].name, 'mcp_registered_test');
assert.strictEqual(dynamicDescriptors[0].risk, 'high');
assert.strictEqual(dynamicDescriptors[0].policy.effect, 'unknown');
assert.strictEqual(dynamicDescriptors[0].readOnly, false);
assert.strictEqual(dynamicDescriptors[0].sideEffect, true);
assert.strictEqual(dynamicDescriptors[0].parallelSafe, false);
assert.strictEqual(dynamicDescriptors[0].resumable, false);
assert.strictEqual(dynamicDescriptors[0].metadata.source, 'mcp');
assert.strictEqual(dynamicDescriptors[0].metadata.policyVersion, POLICY_VERSION);

console.log('capabilityPolicyParity.test.js passed');
