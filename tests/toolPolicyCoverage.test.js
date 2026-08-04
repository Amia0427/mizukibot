const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { TOOL_SCHEMAS } = require('../api/toolSchemas');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');
const {
  POLICY_VERSION,
  TOOL_POLICIES,
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
} = require('../utils/toolPolicy');

const schemaNames = TOOL_SCHEMAS
  .map((schema) => String(schema?.function?.name || '').trim())
  .filter(Boolean);
const executorNames = Object.keys(TOOL_EXECUTORS);
const registeredNames = Array.from(new Set([...schemaNames, ...executorNames])).sort();
const policyNames = Object.keys(TOOL_POLICIES).sort();

assert.deepStrictEqual(
  registeredNames.filter((name) => !TOOL_POLICIES[name]),
  [],
  'every static schema and executor must have a policy'
);
assert.deepStrictEqual(
  policyNames.filter((name) => !registeredNames.includes(name)),
  [],
  'manifest must not contain stale static tool names'
);

const allowedValues = {
  risk: new Set(['low', 'medium', 'high']),
  effect: new Set(['none', 'local_write', 'external_send', 'destructive', 'unknown']),
  confirmation: new Set(['none', 'explicit', 'admin_explicit']),
  scope: new Set(['user', 'group', 'admin']),
  idempotency: new Set(['none', 'required']),
  replay: new Set(['reuse_result', 'block_uncertain']),
  exposure: new Set(['public', 'internal'])
};

for (const name of registeredNames) {
  const policy = TOOL_POLICIES[name];
  assert.strictEqual(policy.version, POLICY_VERSION, `${name} must use the current policy version`);
  assert.ok(String(policy.capability || '').trim(), `${name} must declare capability`);
  for (const [field, values] of Object.entries(allowedValues)) {
    assert.ok(values.has(policy[field]), `${name} has invalid ${field}: ${policy[field]}`);
  }
}

for (const name of schemaNames) {
  assert.strictEqual(TOOL_POLICIES[name].exposure, 'public', `${name} schema must be public`);
  assert.strictEqual(hasPublicToolPolicy(name), true, `${name} must pass the public policy gate`);
}

const executorOnlyNames = executorNames.filter((name) => !schemaNames.includes(name));
assert.deepStrictEqual(executorOnlyNames, ['local_howtocook_recipe_search']);
assert.strictEqual(TOOL_POLICIES.local_howtocook_recipe_search.exposure, 'internal');
assert.strictEqual(hasPublicToolPolicy('local_howtocook_recipe_search'), false);

function assertResolution(toolName, args, expectedEffect, expectedReason = '') {
  const resolution = resolveToolPolicy(toolName, args);
  assert.strictEqual(resolution.policy.effect, expectedEffect, `${toolName} effect mismatch`);
  assert.strictEqual(resolution.reason, expectedReason, `${toolName} resolution reason mismatch`);
  return resolution.policy;
}

assertResolution('skill_stock_watchlist', { action: 'list' }, 'none');
assertResolution('skill_stock_watchlist', { action: 'check' }, 'none');
assertResolution('skill_stock_watchlist', { action: 'add' }, 'local_write');
assertResolution('skill_stock_watchlist', { action: 'remove' }, 'destructive');
assertResolution('skill_stock_watchlist', { action: 'replace' }, 'unknown', 'unknown_action');

assertResolution('skill_stock_portfolio', { action: 'list' }, 'none');
assertResolution('skill_stock_portfolio', { action: 'show' }, 'none');
assertResolution('skill_stock_portfolio', { action: 'create' }, 'local_write');
assertResolution('skill_stock_portfolio', { action: 'add' }, 'local_write');
assertResolution('skill_stock_portfolio', { action: 'update' }, 'local_write');
assertResolution('skill_stock_portfolio', { action: 'rename' }, 'local_write');
assertResolution('skill_stock_portfolio', { action: 'delete' }, 'destructive');
assertResolution('skill_stock_portfolio', { action: 'remove' }, 'destructive');
assertResolution('skill_stock_portfolio', { action: 'export' }, 'unknown', 'unknown_action');

assertResolution('skill_ontology_graph', { action: 'get' }, 'none');
assertResolution('skill_ontology_graph', { action: 'query' }, 'none');
assertResolution('skill_ontology_graph', { action: 'list' }, 'none');
assertResolution('skill_ontology_graph', { action: 'related' }, 'none');
assertResolution('skill_ontology_graph', { action: 'create' }, 'local_write');
assertResolution('skill_ontology_graph', { action: 'update' }, 'local_write');
assertResolution('skill_ontology_graph', { action: 'relate' }, 'local_write');
assertResolution('skill_ontology_graph', { action: 'validate' }, 'local_write');
assertResolution('skill_ontology_graph', { action: 'schema-append' }, 'local_write');
assertResolution('skill_ontology_graph', { action: 'delete' }, 'destructive');
assertResolution('skill_ontology_graph', { action: 'import' }, 'unknown', 'unknown_action');

const groupSchedulePolicy = assertResolution(
  'create_scheduled_command',
  { action: 'group_message' },
  'external_send'
);
assert.strictEqual(groupSchedulePolicy.scope, 'group');
assert.strictEqual(groupSchedulePolicy.confirmation, 'explicit');

const qzoneSchedulePolicy = assertResolution(
  'create_scheduled_command',
  { action: 'qzone_post' },
  'external_send'
);
assert.strictEqual(qzoneSchedulePolicy.scope, 'admin');
assert.strictEqual(qzoneSchedulePolicy.confirmation, 'admin_explicit');
assertResolution('create_scheduled_command', { action: 'shell' }, 'unknown', 'unknown_action');
assertResolution('delete_scheduled_task', { job_id: 'job-1' }, 'destructive');

const unknownResolution = resolveToolPolicy('__unknown_tool__', {});
assert.strictEqual(unknownResolution.reason, 'unknown_capability');
assert.strictEqual(unknownResolution.policy.risk, 'high');
assert.strictEqual(unknownResolution.policy.effect, 'unknown');
assert.strictEqual(unknownResolution.policy.confirmation, 'explicit');
assert.strictEqual(hasPublicToolPolicy('__unknown_tool__'), false);

const fakeMcpPolicy = getPolicy('mcp_not_registered', {});
assert.strictEqual(fakeMcpPolicy.effect, 'unknown');
assert.strictEqual(fakeMcpPolicy.confirmation, 'explicit');

assert.notStrictEqual(
  getPolicy('web_search'),
  getPolicy('web_search'),
  'callers must not receive a mutable manifest object'
);

console.log('toolPolicyCoverage.test.js passed');
