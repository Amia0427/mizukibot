const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');

const { createToolAuthorizationStore } = require('../utils/toolAuthorizationStore');
const { createDeliveryTarget } = require('../src/platforms/contracts');

function actor(userId = 'user-1', chatType = 'group', groupId = 'group-1', platform = 'qq') {
  return { userId, chatType, groupId, platform };
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

  const crossPlatform = store.createPending(pendingInput('request-weixin', {
    actor: actor('user-1', 'private', '', 'weixin'),
    approvalActor: actor('user-1', 'private', '', 'qq'),
    originRoute: {
      platform: 'weixin',
      chatType: 'private',
      accountId: 'bot-1',
      peerId: 'wx-user-1'
    }
  })).ticket;
  assert.strictEqual(crossPlatform.actor.platform, 'weixin');
  assert.strictEqual(crossPlatform.approvalActor.platform, 'qq');
  assert.deepStrictEqual(crossPlatform.originRoute, createDeliveryTarget({
    platform: 'weixin',
    chatType: 'private',
    accountId: 'bot-1',
    peerId: 'wx-user-1'
  }));
  assert.deepStrictEqual(
    store.claim(crossPlatform.id, actor('user-1', 'private', '', 'weixin')),
    { ok: false, reason: 'platform_mismatch' }
  );
  assert.strictEqual(store.claim(crossPlatform.id, actor('user-1', 'private', '', 'qq')).ok, true);

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

  const legacyFile = path.join(
    __dirname,
    '..',
    'tmp',
    `tool-authorization-legacy-${process.pid}-${Date.now()}.sqlite`
  );
  const legacyDb = new Database(legacyFile);
  legacyDb.exec(`
    CREATE TABLE tool_authorizations (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      args_json TEXT,
      context_json TEXT,
      args_hash TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      confirmation TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      group_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      result_hash TEXT,
      terminal_reason TEXT,
      error_code TEXT
    );
    CREATE TABLE tool_authorization_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      authorization_id TEXT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      status TEXT,
      tool_name TEXT,
      actor_user_id TEXT,
      actor_chat_type TEXT,
      actor_group_id TEXT,
      metadata_json TEXT
    );
  `);
  const legacyPolicy = pendingInput('legacy').policy;
  legacyDb.prepare(`
    INSERT INTO tool_authorizations (
      id, request_key, tool_name, status, args_json, context_json, args_hash,
      context_hash, policy_json, policy_version, confirmation, user_id,
      chat_type, group_id, created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, 'pending', '{}', '{}', ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(
    'TA-LEGACY',
    'legacy-request',
    'schedule_group_message',
    require('../utils/toolAuthorizationStore').hashValue({}),
    require('../utils/toolAuthorizationStore').hashValue({}),
    JSON.stringify(legacyPolicy),
    legacyPolicy.version,
    legacyPolicy.confirmation,
    'legacy-user',
    'private',
    now,
    now + 1000,
    now
  );
  legacyDb.close();

  const migrated = createToolAuthorizationStore({ file: legacyFile, now: () => now });
  const legacyTicket = migrated.getTicket('TA-LEGACY');
  assert.strictEqual(legacyTicket.actor.platform, 'qq');
  assert.deepStrictEqual(legacyTicket.approvalActor, actor('legacy-user', 'private', '', 'qq'));
  migrated.close();

  console.log('toolAuthorizationStore.test.js passed');
})();
