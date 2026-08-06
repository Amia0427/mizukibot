const assert = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  decodeMasterKey,
  decryptSecret,
  encryptSecret
} = require('../src/platforms/weixin/crypto');
const { createWeixinStore } = require('../src/platforms/weixin/store');

function expectCode(action, code) {
  assert.throws(action, (error) => error && error.code === code);
}

(() => {
  const encodedKey = Buffer.alloc(32, 9).toString('base64');
  const key = decodeMasterKey(encodedKey);
  assert.strictEqual(key.length, 32);
  assert.throws(() => decodeMasterKey(''), /exactly 32 bytes/);
  assert.throws(() => decodeMasterKey(Buffer.alloc(31).toString('base64')), /exactly 32 bytes/);
  const base64UrlKey = Buffer.alloc(32, 255).toString('base64').replace(/\//g, '_');
  assert.throws(() => decodeMasterKey(base64UrlKey), /exactly 32 bytes/);

  const encrypted = encryptSecret('bot-secret', key, 'binding:qq-1');
  assert.notStrictEqual(encrypted.ciphertext.toString('utf8'), 'bot-secret');
  assert.strictEqual(decryptSecret(encrypted, key, 'binding:qq-1'), 'bot-secret');
  assert.throws(() => decryptSecret(encrypted, key, 'binding:qq-2'));

  let timestamp = 1_000;
  let rawDatabase;
  function CapturingDatabase(file, options) {
    rawDatabase = new Database(file, options);
    return rawDatabase;
  }
  const store = createWeixinStore({
    databaseFile: ':memory:',
    masterKey: encodedKey,
    now: () => timestamp,
    Database: CapturingDatabase
  });

  try {
    const binding = store.saveBinding({
      qqUserId: '10001',
      ilinkUserId: 'wx-user-1',
      ilinkBotId: 'wx-bot-1',
      accountId: 'wx-bot-1',
      botToken: 'token-1',
      baseUrl: 'https://ilink.example.test'
    });
    assert.deepStrictEqual(binding, {
      qqUserId: '10001',
      ilinkUserId: 'wx-user-1',
      ilinkBotId: 'wx-bot-1',
      accountId: 'wx-bot-1',
      notificationPlatform: 'qq',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000
    });
    assert.deepStrictEqual(store.getBindingByQqUserId('10001'), binding);
    assert.deepStrictEqual(store.getBindingByIlinkUserId('wx-user-1'), binding);
    assert.deepStrictEqual(store.listActiveBindings(), [binding]);
    assert.deepStrictEqual(store.getWorkerBindingByQqUserId('10001'), {
      ...binding,
      botToken: 'token-1',
      baseUrl: 'https://ilink.example.test'
    });
    const rawBinding = rawDatabase.prepare(`
      SELECT bot_token_ciphertext, base_url_ciphertext FROM weixin_bindings
      WHERE qq_user_id = ?
    `).get('10001');
    assert.doesNotMatch(rawBinding.bot_token_ciphertext.toString('utf8'), /token-1/);
    assert.doesNotMatch(rawBinding.base_url_ciphertext.toString('utf8'), /ilink\.example/);

    expectCode(() => store.saveBinding({
      qqUserId: '10002',
      ilinkUserId: 'wx-user-1',
      ilinkBotId: 'wx-bot-2',
      botToken: 'token-2',
      baseUrl: 'https://ilink.example.test'
    }), 'WEIXIN_ILINK_USER_ALREADY_BOUND');
    expectCode(() => store.saveBinding({
      qqUserId: '10002',
      ilinkUserId: 'wx-user-2',
      ilinkBotId: 'wx-bot-1',
      botToken: 'token-2',
      baseUrl: 'https://ilink.example.test'
    }), 'WEIXIN_ILINK_BOT_ALREADY_BOUND');

    timestamp = 2_000;
    assert.strictEqual(store.setNotificationPlatform('10001', 'weixin').notificationPlatform, 'weixin');
    assert.throws(() => store.setNotificationPlatform('10001', 'both'), /notification platform/);

    const attempt = store.beginLoginAttempt({
      attemptId: 'attempt-1',
      qqUserId: '10001',
      mode: 'rebind',
      qrCode: 'https://qr.example.test/one',
      loginCredential: 'login-secret',
      expiresAt: 7_000
    });
    assert.strictEqual(attempt.status, 'pending');
    assert.strictEqual(Object.hasOwn(attempt, 'qrCode'), false);
    assert.strictEqual(Object.hasOwn(attempt, 'loginCredential'), false);
    assert.deepStrictEqual(store.getLoginAttemptForWorker('attempt-1'), {
      ...attempt,
      qrCode: 'https://qr.example.test/one',
      loginCredential: 'login-secret'
    });
    const rawAttempt = rawDatabase.prepare(`
      SELECT qr_code, credential_ciphertext FROM weixin_login_attempts WHERE attempt_id = ?
    `).get('attempt-1');
    assert.strictEqual(rawAttempt.qr_code, '[encrypted]');
    assert.doesNotMatch(rawAttempt.credential_ciphertext.toString('utf8'), /login-secret|qr\.example/);
    assert.strictEqual(store.updateLoginAttempt('attempt-1', { status: 'scanned' }).status, 'scanned');
    assert.strictEqual(store.expireLoginAttempt('attempt-1').status, 'expired');
    expectCode(() => store.beginLoginAttempt({
      attemptId: 'attempt-expired',
      qqUserId: '10001',
      qrCode: 'https://qr.example.test/expired',
      loginCredential: 'temporary',
      expiresAt: 1_999
    }), 'WEIXIN_LOGIN_ATTEMPT_EXPIRED');

    store.setSyncCursor('wx-bot-1', 'cursor-secret');
    store.setContextToken('wx-bot-1', 'wx-user-1', 'context-secret');
    assert.strictEqual(store.getSyncCursor('wx-bot-1'), 'cursor-secret');
    assert.strictEqual(store.getContextToken('wx-bot-1', 'wx-user-1'), 'context-secret');
    const rawSecrets = rawDatabase.prepare(`
      SELECT
        (SELECT cursor_ciphertext FROM weixin_sync_state WHERE account_id = 'wx-bot-1') AS cursor,
        (SELECT token_ciphertext FROM weixin_context_tokens
          WHERE account_id = 'wx-bot-1' AND peer_id = 'wx-user-1') AS context
    `).get();
    assert.doesNotMatch(rawSecrets.cursor.toString('utf8'), /cursor-secret/);
    assert.doesNotMatch(rawSecrets.context.toString('utf8'), /context-secret/);

    const inbox = store.enqueueInbox({
      accountId: 'wx-bot-1',
      messageId: 'message-1',
      qqUserId: '10001',
      peerId: 'wx-user-1',
      contextToken: 'latest-context-secret',
      payload: { text: 'hello', contextToken: 'must-not-enter-inbox' }
    });
    assert.strictEqual(inbox.inserted, true);
    const duplicateInbox = store.enqueueInbox({
      accountId: 'wx-bot-1',
      messageId: 'message-1',
      qqUserId: '10001',
      payload: { text: 'different' }
    });
    assert.strictEqual(duplicateInbox.inserted, false);
    assert.strictEqual(duplicateInbox.item.id, inbox.item.id);
    const [claimedInbox] = store.claimInbox({ limit: 1 });
    assert.deepStrictEqual(claimedInbox.payload, { text: 'hello' });
    assert.strictEqual(store.getContextToken('wx-bot-1', 'wx-user-1'), 'latest-context-secret');
    assert.strictEqual(claimedInbox.status, 'processing');
    assert.strictEqual(store.completeInbox(claimedInbox.id), true);

    timestamp = 3_000;
    const retryInbox = store.enqueueInbox({
      accountId: 'wx-bot-1',
      messageId: 'message-2',
      qqUserId: '10001',
      payload: { text: 'retry' }
    }).item;
    store.claimInbox();
    assert.strictEqual(store.failInbox(retryInbox.id, { errorCode: 'temporary', retryAt: 4_000 }).status, 'pending');
    assert.deepStrictEqual(store.claimInbox(), []);
    timestamp = 4_000;
    assert.strictEqual(store.claimInbox()[0].id, retryInbox.id);
    assert.strictEqual(store.failInbox(retryInbox.id, { errorCode: 'permanent' }).status, 'failed');

    const outbox = store.enqueueOutbox({
      clientId: 'client-1',
      accountId: 'wx-bot-1',
      peerId: 'wx-user-1',
      payload: { text: 'reply' }
    });
    assert.strictEqual(outbox.inserted, true);
    assert.strictEqual(store.enqueueOutbox({
      clientId: 'client-1',
      accountId: 'wx-bot-1',
      peerId: 'wx-user-1',
      payload: { text: 'duplicate' }
    }).inserted, false);
    const [claimedOutbox] = store.claimOutbox();
    assert.strictEqual(claimedOutbox.clientId, 'client-1');
    assert.strictEqual(store.completeOutbox(claimedOutbox.id), true);

    const failedOutbox = store.enqueueOutbox({
      clientId: 'client-2',
      accountId: 'wx-bot-1',
      peerId: 'wx-user-1',
      payload: { text: 'fail' }
    }).item;
    store.claimOutbox();
    assert.strictEqual(store.failOutbox(failedOutbox.id, { errorCode: 'rejected' }).status, 'failed');

    const audit = store.appendAudit({
      accountId: 'wx-bot-1',
      eventType: 'message_rejected',
      reason: 'group_message',
      senderId: 'raw-weixin-user',
      body: 'must never be stored',
      text: 'must never be stored either'
    });
    assert.match(audit.senderHash, /^[a-f0-9]{64}$/);
    assert.strictEqual(store.audit({
      accountId: 'wx-bot-1',
      event: 'sender_rejected',
      reason: 'not_bound',
      senderHash: audit.senderHash
    }).senderHash, audit.senderHash);
    assert.doesNotMatch(JSON.stringify(store.listAuditEvents()), /must never|raw-weixin-user/);
    store.commitInboundBatch({
      accountId: 'wx-bot-1',
      cursor: 'atomic-cursor',
      expectedBinding: {
        qqUserId: '10001',
        ilinkUserId: 'wx-user-1',
        botToken: 'token-1',
        baseUrl: 'https://ilink.example.test'
      },
      operations: [{
        type: 'audit',
        input: {
          accountId: 'wx-bot-1',
          eventType: 'inbound_rejected',
          reason: 'group_message',
          senderId: 'group-sender'
        }
      }]
    });
    assert.strictEqual(store.getSyncCursor('wx-bot-1'), 'atomic-cursor');
    assert.strictEqual(store.listAuditEvents('wx-bot-1').at(-1).reason, 'group_message');

    const approval = store.createApproval({
      ticketId: 'WX-APPROVAL-1',
      qqUserId: '10001',
      action: 'weixin_unbind',
      expiresAt: 9_000
    });
    assert.strictEqual(approval.status, 'pending');
    assert.deepStrictEqual(store.claimApproval('WX-APPROVAL-1', {
      platform: 'weixin',
      userId: '10001',
      chatType: 'private'
    }), { ok: false, reason: 'platform_mismatch' });
    assert.deepStrictEqual(store.claimApproval('WX-APPROVAL-1', {
      platform: 'qq',
      userId: '10002',
      chatType: 'private'
    }), { ok: false, reason: 'identity_mismatch' });
    assert.strictEqual(store.claimApproval('WX-APPROVAL-1', {
      platform: 'qq',
      userId: '10001',
      chatType: 'private'
    }).ok, true);
    assert.strictEqual(store.completeApproval('WX-APPROVAL-1').status, 'completed');
    assert.deepStrictEqual(store.claimApproval('WX-APPROVAL-1', {
      platform: 'qq',
      userId: '10001',
      chatType: 'private'
    }), { ok: false, reason: 'already_consumed', status: 'completed' });
    assert.deepStrictEqual(store.quickCheck(), { ok: true, messages: ['ok'] });

    assert.strictEqual(store.markBindingRevoking('10001').status, 'revoking');
    assert.deepStrictEqual(store.listActiveBindings(), []);
    assert.strictEqual(store.deleteBinding('10001'), true);
    assert.strictEqual(store.getBindingByQqUserId('10001'), null);
    assert.strictEqual(store.getSyncCursor('wx-bot-1'), null);
    assert.strictEqual(store.getContextToken('wx-bot-1', 'wx-user-1'), null);
    assert.throws(() => store.commitInboundBatch({
      accountId: 'wx-bot-1',
      cursor: 'stale-cursor',
      expectedBinding: {
        qqUserId: '10001',
        ilinkUserId: 'wx-user-1',
        botToken: 'token-1',
        baseUrl: 'https://ilink.example.test'
      },
      operations: [{
        type: 'context_token',
        input: {
          accountId: 'wx-bot-1',
          peerId: 'wx-user-1',
          token: 'stale-token'
        }
      }]
    }), (error) => error.code === 'WEIXIN_BINDING_INACTIVE');
    assert.strictEqual(store.getSyncCursor('wx-bot-1'), null);
    assert.strictEqual(store.getContextToken('wx-bot-1', 'wx-user-1'), null);
  } finally {
    store.close();
    store.close();
  }

  const restartRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-restart-'));
  const restartDatabaseFile = path.join(restartRoot, 'weixin.sqlite');
  try {
    const interruptedStore = createWeixinStore({
      databaseFile: restartDatabaseFile,
      masterKey: encodedKey,
      now: () => 10_000
    });
    interruptedStore.createApproval({
      ticketId: 'WX-INTERRUPTED-1',
      qqUserId: '10001',
      action: 'weixin_unbind',
      createdAt: 10_000,
      expiresAt: 20_000
    });
    assert.strictEqual(interruptedStore.claimApproval('WX-INTERRUPTED-1', {
      platform: 'qq',
      userId: '10001',
      chatType: 'private'
    }).ok, true);
    interruptedStore.close();

    const resumedStore = createWeixinStore({
      databaseFile: restartDatabaseFile,
      masterKey: encodedKey,
      now: () => 11_000
    });
    assert.deepStrictEqual(resumedStore.getApproval('WX-INTERRUPTED-1'), {
      ticketId: 'WX-INTERRUPTED-1',
      qqUserId: '10001',
      action: 'weixin_unbind',
      status: 'failed',
      expiresAt: 20_000,
      createdAt: 10_000,
      updatedAt: 11_000,
      completedAt: 11_000,
      errorCode: 'process_interrupted'
    });
    assert.deepStrictEqual(resumedStore.claimApproval('WX-INTERRUPTED-1', {
      platform: 'qq',
      userId: '10001',
      chatType: 'private'
    }), { ok: false, reason: 'already_consumed', status: 'failed' });
    resumedStore.close();
  } finally {
    fs.rmSync(restartRoot, { recursive: true, force: true });
  }

  assert.throws(() => createWeixinStore({ databaseFile: ':memory:', masterKey: '' }), /WEIXIN_CREDENTIAL_MASTER_KEY/);
  console.log('weixinStore.test.js passed');
})();
