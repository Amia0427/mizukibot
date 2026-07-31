const assert = require('assert');
const path = require('path');

const { createToolAuthorizationStore } = require('../utils/toolAuthorizationStore');

function actor(userId = 'user-1', chatType = 'group', groupId = 'group-1') {
  return { userId, chatType, groupId };
}

function pendingInput(requestKey, overrides = {}) {
  return {
    requestKey,
    toolName: 'schedule_group_message',
    rawArgs: { group_id: 'group-1', message: 'hello' },
    toolContext: { routePolicyKey: 'test/tool-authorization' },
    actor: actor(),
    policy: {
      version: 'tool_policy_v1',
      risk: 'medium',
      effect: 'external_send',
      confirmation: 'explicit',
      idempotency: 'required',
      replay: 'block_uncertain'
    },
    ...overrides
  };
}

module.exports = (() => {
  let now = 1000;
  let sequence = 0;
  const store = createToolAuthorizationStore({
    file: ':memory:',
    ttlMs: 500,
    now: () => now,
    generateTicketId: () => `TA-TEST-${++sequence}`
  });

  const first = store.createPending(pendingInput('request-1'));
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.ticket.status, 'pending');
  assert.strictEqual(first.ticket.id, 'TA-TEST-1');
  assert.deepStrictEqual(first.ticket.rawArgs, { group_id: 'group-1', message: 'hello' });

  const duplicateRequest = store.createPending(pendingInput('request-1'));
  assert.strictEqual(duplicateRequest.created, false);
  assert.strictEqual(duplicateRequest.ticket.id, first.ticket.id);

  const wrongUser = store.claim(first.ticket.id, actor('user-2'));
  assert.deepStrictEqual(wrongUser, { ok: false, reason: 'identity_mismatch' });
  assert.strictEqual(store.getTicket(first.ticket.id).status, 'pending');

  const wrongGroup = store.claim(first.ticket.id, actor('user-1', 'group', 'group-2'));
  assert.deepStrictEqual(wrongGroup, { ok: false, reason: 'context_mismatch' });
  assert.strictEqual(store.getTicket(first.ticket.id).status, 'pending');

  const claimed = store.claim(first.ticket.id, actor());
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(claimed.ticket.status, 'executing');
  assert.deepStrictEqual(claimed.ticket.rawArgs, { group_id: 'group-1', message: 'hello' });

  const duplicateClaim = store.claim(first.ticket.id, actor());
  assert.deepStrictEqual(duplicateClaim, { ok: false, reason: 'already_consumed', status: 'executing' });

  const completed = store.complete(first.ticket.id, { resultHash: 'result-hash' });
  assert.strictEqual(completed.ok, true);
  assert.strictEqual(completed.ticket.status, 'completed');
  assert.strictEqual(completed.ticket.rawArgs, null);
  assert.strictEqual(completed.ticket.toolContext, null);
  assert.strictEqual(completed.ticket.resultHash, 'result-hash');

  const completedAgain = store.claim(first.ticket.id, actor());
  assert.deepStrictEqual(completedAgain, { ok: false, reason: 'already_consumed', status: 'completed' });

  const cancellable = store.createPending(pendingInput('request-2')).ticket;
  const cancelled = store.cancel(cancellable.id, actor(), 'user_cancelled');
  assert.strictEqual(cancelled.ok, true);
  assert.strictEqual(cancelled.ticket.status, 'cancelled');
  assert.strictEqual(cancelled.ticket.rawArgs, null);
  assert.strictEqual(cancelled.ticket.toolContext, null);
  assert.deepStrictEqual(
    store.cancel(cancellable.id, actor()),
    { ok: false, reason: 'already_consumed', status: 'cancelled' }
  );

  const expiring = store.createPending(pendingInput('request-3')).ticket;
  now = expiring.expiresAt + 1;
  const expired = store.claim(expiring.id, actor());
  assert.deepStrictEqual(expired, { ok: false, reason: 'expired', status: 'expired' });
  const expiredTicket = store.getTicket(expiring.id);
  assert.strictEqual(expiredTicket.status, 'expired');
  assert.strictEqual(expiredTicket.rawArgs, null);
  assert.strictEqual(expiredTicket.toolContext, null);

  now += 10;
  const rejectable = store.createPending(pendingInput('request-4')).ticket;
  const rejected = store.reject(rejectable.id, 'policy_changed');
  assert.strictEqual(rejected.ok, true);
  assert.strictEqual(rejected.ticket.status, 'cancelled');
  assert.strictEqual(rejected.ticket.terminalReason, 'policy_changed');

  const uncertainInput = store.createPending(pendingInput('request-5')).ticket;
  assert.strictEqual(store.claim(uncertainInput.id, actor()).ok, true);
  const uncertain = store.markUncertain(uncertainInput.id, { errorCode: 'executor_interrupted' });
  assert.strictEqual(uncertain.ok, true);
  assert.strictEqual(uncertain.ticket.status, 'uncertain');
  assert.strictEqual(uncertain.ticket.rawArgs, null);
  assert.strictEqual(uncertain.ticket.toolContext, null);

  const auditEvents = store.listAuditEvents(first.ticket.id);
  assert.ok(auditEvents.length >= 4);
  assert.ok(auditEvents.every((event) => event.type === 'tool_authorization_decision'));
  assert.ok(auditEvents.some((event) => event.decision === 'identity_mismatch'));
  assert.ok(auditEvents.some((event) => event.decision === 'completed'));
  store.close();

  const crashFile = path.join(
    __dirname,
    '..',
    'tmp',
    `tool-authorization-crash-${process.pid}-${Date.now()}.sqlite`
  );
  const firstProcess = createToolAuthorizationStore({
    file: crashFile,
    ttlMs: 1000,
    now: () => now,
    generateTicketId: () => 'TA-CRASH'
  });
  const interrupted = firstProcess.createPending(pendingInput('request-crash')).ticket;
  assert.strictEqual(firstProcess.claim(interrupted.id, actor()).ok, true);
  firstProcess.close();

  const restarted = createToolAuthorizationStore({ file: crashFile, ttlMs: 1000, now: () => now });
  const recovered = restarted.getTicket(interrupted.id);
  assert.strictEqual(recovered.status, 'uncertain');
  assert.strictEqual(recovered.terminalReason, 'process_interrupted');
  assert.strictEqual(recovered.rawArgs, null);
  assert.strictEqual(recovered.toolContext, null);
  assert.deepStrictEqual(
    restarted.claim(interrupted.id, actor()),
    { ok: false, reason: 'already_consumed', status: 'uncertain' }
  );
  restarted.close();

  console.log('toolAuthorizationStore.test.js passed');
})();
