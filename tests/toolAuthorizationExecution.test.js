const assert = require('assert');

const { createToolAuthorizationService } = require('../api/toolAuthorization');
const { createToolAuthorizationStore } = require('../utils/toolAuthorizationStore');
const { validateToolCallArgs } = require('../api/runtimeV2/runtime/toolExecutionPrimitives');

function schema(name, required = []) {
  return {
    type: 'function',
    function: {
      name,
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required
      }
    }
  };
}

function policy(confirmation, overrides = {}) {
  return {
    version: 'tool_policy_v1',
    risk: confirmation === 'none' ? 'low' : 'medium',
    capability: confirmation === 'none' ? 'local_read' : 'local_write',
    effect: confirmation === 'none' ? 'none' : 'local_write',
    confirmation,
    scope: confirmation === 'admin_explicit' ? 'admin' : 'user',
    idempotency: confirmation === 'none' ? 'none' : 'required',
    replay: confirmation === 'none' ? 'reuse_result' : 'block_uncertain',
    exposure: 'public',
    ...overrides
  };
}

function actor(userId = 'user-1', chatType = 'group', groupId = 'group-1') {
  return { userId, chatType, groupId };
}

function createFixture() {
  let now = 1000;
  let sequence = 0;
  const adminIds = new Set(['admin-1']);
  const dynamicNames = new Set(['mcp_dynamic_write']);
  const policies = new Map([
    ['read_tool', policy('none')],
    ['write_tool', policy('explicit')],
    ['admin_tool', policy('admin_explicit')],
    ['mcp_dynamic_write', policy('explicit', { effect: 'unknown', capability: 'unknown', risk: 'high' })]
  ]);
  const schemas = new Map([
    ['read_tool', schema('read_tool')],
    ['write_tool', schema('write_tool', ['value'])],
    ['admin_tool', schema('admin_tool')],
    ['mcp_dynamic_write', schema('mcp_dynamic_write')]
  ]);
  const calls = new Map();
  const executors = new Map();
  for (const name of policies.keys()) {
    executors.set(name, async (args) => {
      calls.set(name, Number(calls.get(name) || 0) + 1);
      return `${name}:${args.value || 'ok'}`;
    });
  }
  const store = createToolAuthorizationStore({
    file: ':memory:',
    ttlMs: 500,
    now: () => now,
    generateTicketId: () => `TA-SERVICE-${++sequence}`
  });
  const service = createToolAuthorizationService({
    store,
    ttlMs: 500,
    now: () => now,
    isAdminUser: (userId) => adminIds.has(userId),
    hasPublicToolPolicy: (name) => policies.has(name) && !name.startsWith('mcp_'),
    isDynamicToolRegistered: (name) => dynamicNames.has(name),
    getToolSchemaByName: (name) => schemas.get(name) || null,
    getToolExecutor: (name) => executors.get(name) || null,
    resolveToolPolicy: (name) => ({ policy: { ...(policies.get(name) || policy('explicit', { effect: 'unknown' })) }, reason: '' }),
    enforceToolPolicy: (_name, args) => ({ ...args }),
    validateToolCallArgs
  });
  return {
    adminIds,
    calls,
    dynamicNames,
    executors,
    policies,
    schemas,
    service,
    store,
    advance(ms) { now += ms; }
  };
}

module.exports = (async () => {
  const fixture = createFixture();

  const readResult = await fixture.service.executeAuthorizedToolCall({
    toolName: 'read_tool',
    rawArgs: { value: 'a' },
    normalizedArgs: { value: 'a' },
    policy: fixture.policies.get('read_tool'),
    actor: actor(),
    invocationKey: 'read-1',
    toolContext: { routePolicyKey: 'test/read' },
    executor: fixture.executors.get('read_tool')
  });
  assert.strictEqual(readResult.status, 'completed');
  assert.strictEqual(readResult.executed, true);
  assert.strictEqual(readResult.result, 'read_tool:a');
  assert.strictEqual(fixture.calls.get('read_tool'), 1);

  const pending = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'b' },
    normalizedArgs: { value: 'b' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-1',
    toolContext: { routePolicyKey: 'test/write' },
    executor: fixture.executors.get('write_tool')
  });
  assert.strictEqual(pending.status, 'confirmation_required');
  assert.strictEqual(pending.executed, false);
  assert.strictEqual(fixture.calls.get('write_tool') || 0, 0);
  assert.strictEqual(pending.authorization.ticketId, 'TA-SERVICE-1');
  assert.strictEqual(pending.authorization.confirmation, 'explicit');
  assert.strictEqual(pending.auditEvent.type, 'tool_authorization_decision');

  const sameInvocation = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'b' },
    normalizedArgs: { value: 'b' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-1',
    toolContext: { routePolicyKey: 'test/write' },
    executor: fixture.executors.get('write_tool')
  });
  assert.strictEqual(sameInvocation.authorization.ticketId, pending.authorization.ticketId);

  const wrongIdentity = await fixture.service.confirm(pending.authorization.ticketId, actor('user-2'));
  assert.strictEqual(wrongIdentity.status, 'denied');
  assert.strictEqual(wrongIdentity.reason, 'identity_mismatch');
  assert.strictEqual(fixture.calls.get('write_tool') || 0, 0);

  const confirmed = await fixture.service.confirm(pending.authorization.ticketId, actor());
  assert.strictEqual(confirmed.status, 'completed');
  assert.strictEqual(confirmed.executed, true);
  assert.strictEqual(confirmed.result, 'write_tool:b');
  assert.strictEqual(fixture.calls.get('write_tool'), 1);

  const confirmedAgain = await fixture.service.confirm(pending.authorization.ticketId, actor());
  assert.strictEqual(confirmedAgain.status, 'denied');
  assert.strictEqual(confirmedAgain.reason, 'already_consumed');
  assert.strictEqual(confirmedAgain.ticketStatus, 'completed');
  assert.strictEqual(fixture.calls.get('write_tool'), 1);

  const nonAdmin = await fixture.service.executeAuthorizedToolCall({
    toolName: 'admin_tool',
    rawArgs: {},
    normalizedArgs: {},
    policy: fixture.policies.get('admin_tool'),
    actor: actor(),
    invocationKey: 'admin-denied',
    toolContext: {},
    executor: fixture.executors.get('admin_tool')
  });
  assert.strictEqual(nonAdmin.status, 'denied');
  assert.strictEqual(nonAdmin.reason, 'admin_required');

  const adminPending = await fixture.service.executeAuthorizedToolCall({
    toolName: 'admin_tool',
    rawArgs: {},
    normalizedArgs: {},
    policy: fixture.policies.get('admin_tool'),
    actor: actor('admin-1'),
    invocationKey: 'admin-1',
    toolContext: {},
    executor: fixture.executors.get('admin_tool')
  });
  fixture.adminIds.delete('admin-1');
  const revokedAdmin = await fixture.service.confirm(adminPending.authorization.ticketId, actor('admin-1'));
  assert.strictEqual(revokedAdmin.status, 'denied');
  assert.strictEqual(revokedAdmin.reason, 'admin_required');
  assert.strictEqual(fixture.calls.get('admin_tool') || 0, 0);

  const expiring = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'late' },
    normalizedArgs: { value: 'late' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-expired',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  fixture.advance(501);
  const expired = await fixture.service.confirm(expiring.authorization.ticketId, actor());
  assert.strictEqual(expired.status, 'denied');
  assert.strictEqual(expired.reason, 'expired');

  const invalidArgs = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'valid-now' },
    normalizedArgs: { value: 'valid-now' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-schema-change',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  fixture.schemas.set('write_tool', schema('write_tool', ['missing_after_change']));
  const invalidated = await fixture.service.confirm(invalidArgs.authorization.ticketId, actor());
  assert.strictEqual(invalidated.status, 'denied');
  assert.strictEqual(invalidated.reason, 'invalid_args');
  assert.strictEqual(fixture.store.getTicket(invalidArgs.authorization.ticketId).status, 'cancelled');
  fixture.schemas.set('write_tool', schema('write_tool', ['value']));

  const changedPolicy = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'policy' },
    normalizedArgs: { value: 'policy' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-policy-change',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  fixture.policies.set('write_tool', policy('admin_explicit'));
  const policyDenied = await fixture.service.confirm(changedPolicy.authorization.ticketId, actor());
  assert.strictEqual(policyDenied.status, 'denied');
  assert.strictEqual(policyDenied.reason, 'policy_changed');
  fixture.policies.set('write_tool', policy('explicit'));

  const changedScope = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'scope' },
    normalizedArgs: { value: 'scope' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-scope-change',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  fixture.policies.set('write_tool', policy('explicit', { scope: 'admin' }));
  const scopeDenied = await fixture.service.confirm(changedScope.authorization.ticketId, actor());
  assert.strictEqual(scopeDenied.status, 'denied');
  assert.strictEqual(scopeDenied.reason, 'policy_changed');
  fixture.policies.set('write_tool', policy('explicit'));

  const tampered = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'original' },
    normalizedArgs: { value: 'original' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-tampered',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  const getPendingForActor = fixture.store.getPendingForActor;
  fixture.store.getPendingForActor = (...args) => {
    const inspected = getPendingForActor(...args);
    return inspected.ok
      ? { ...inspected, ticket: { ...inspected.ticket, rawArgs: { value: 'tampered' } } }
      : inspected;
  };
  const integrityDenied = await fixture.service.confirm(tampered.authorization.ticketId, actor());
  fixture.store.getPendingForActor = getPendingForActor;
  assert.strictEqual(integrityDenied.status, 'denied');
  assert.strictEqual(integrityDenied.reason, 'ticket_integrity_failed');
  assert.strictEqual(fixture.calls.get('write_tool'), 1);

  const dynamicPending = await fixture.service.executeAuthorizedToolCall({
    toolName: 'mcp_dynamic_write',
    rawArgs: {},
    normalizedArgs: {},
    policy: fixture.policies.get('mcp_dynamic_write'),
    actor: actor(),
    invocationKey: 'dynamic-1',
    toolContext: {},
    executor: fixture.executors.get('mcp_dynamic_write')
  });
  fixture.dynamicNames.delete('mcp_dynamic_write');
  const missingDynamic = await fixture.service.confirm(dynamicPending.authorization.ticketId, actor());
  assert.strictEqual(missingDynamic.status, 'denied');
  assert.strictEqual(missingDynamic.reason, 'unknown_capability');
  assert.strictEqual(fixture.calls.get('mcp_dynamic_write') || 0, 0);

  fixture.executors.set('write_tool', async () => {
    fixture.calls.set('write_tool', Number(fixture.calls.get('write_tool') || 0) + 1);
    throw new Error('side effect result unknown');
  });
  const throwingPending = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'throw' },
    normalizedArgs: { value: 'throw' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-throw',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  const uncertain = await fixture.service.confirm(throwingPending.authorization.ticketId, actor());
  assert.strictEqual(uncertain.status, 'uncertain');
  assert.strictEqual(uncertain.reason, 'executor_failed');
  assert.strictEqual(fixture.store.getTicket(throwingPending.authorization.ticketId).status, 'uncertain');
  const uncertainAgain = await fixture.service.confirm(throwingPending.authorization.ticketId, actor());
  assert.strictEqual(uncertainAgain.reason, 'already_consumed');
  assert.strictEqual(uncertainAgain.ticketStatus, 'uncertain');

  const cancelPending = await fixture.service.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'cancel' },
    normalizedArgs: { value: 'cancel' },
    policy: fixture.policies.get('write_tool'),
    actor: actor(),
    invocationKey: 'write-cancel',
    toolContext: {},
    executor: fixture.executors.get('write_tool')
  });
  const cancelled = await fixture.service.cancel(cancelPending.authorization.ticketId, actor());
  assert.strictEqual(cancelled.status, 'cancelled');
  const cancelledConfirm = await fixture.service.confirm(cancelPending.authorization.ticketId, actor());
  assert.strictEqual(cancelledConfirm.reason, 'already_consumed');
  assert.strictEqual(cancelledConfirm.ticketStatus, 'cancelled');

  const persistenceStore = createToolAuthorizationStore({
    file: ':memory:',
    ttlMs: 500,
    now: () => 5000,
    generateTicketId: () => 'TA-PERSISTENCE-FAILURE'
  });
  let persistenceExecutorCalls = 0;
  const persistenceService = createToolAuthorizationService({
    store: {
      ...persistenceStore,
      complete() {
        throw new Error('simulated completion persistence failure');
      }
    },
    isAdminUser: () => false,
    hasPublicToolPolicy: (name) => name === 'write_tool',
    isDynamicToolRegistered: () => false,
    getToolSchemaByName: () => schema('write_tool', ['value']),
    getToolExecutor: () => async () => {
      persistenceExecutorCalls += 1;
      return 'side effect completed';
    },
    resolveToolPolicy: () => ({ policy: policy('explicit'), reason: '' }),
    enforceToolPolicy: (_name, args) => ({ ...args }),
    validateToolCallArgs
  });
  const persistencePending = await persistenceService.executeAuthorizedToolCall({
    toolName: 'write_tool',
    rawArgs: { value: 'persist' },
    normalizedArgs: { value: 'persist' },
    policy: policy('explicit'),
    actor: actor(),
    invocationKey: 'write-persistence-failure',
    toolContext: {},
    executor: async () => 'not executed before confirmation'
  });
  const persistenceFailure = await persistenceService.confirm(
    persistencePending.authorization.ticketId,
    actor()
  );
  assert.strictEqual(persistenceFailure.status, 'uncertain');
  assert.strictEqual(persistenceFailure.reason, 'completion_persistence_failed');
  assert.strictEqual(persistenceExecutorCalls, 1);
  assert.strictEqual(
    persistenceStore.getTicket(persistencePending.authorization.ticketId).status,
    'uncertain'
  );
  persistenceStore.close();

  fixture.store.close();
  console.log('toolAuthorizationExecution.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
