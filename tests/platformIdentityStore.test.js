const assert = require('assert');

const { createPlatformIdentityStore } = require('../src/platforms/identityStore');
const { createIdentityCommandHandler } = require('../src/platforms/identityCommands');

(() => {
  let timestamp = 1_000;
  const store = createPlatformIdentityStore({
    databaseFile: ':memory:',
    now: () => timestamp,
    randomBytes: () => Buffer.alloc(8, 7),
    linkCodeTtlMs: 60_000,
    adminUserIds: ['12345']
  });

  try {
    assert.strictEqual(store.resolveBoundQqPrincipal('weixin', 'wx-unknown'), null);
    assert.deepStrictEqual(store.listBindings('weixin:wx-unknown'), []);

    const weixinBinding = store.bindExternalIdentityToQq({
      platform: 'weixin',
      externalUserId: 'wx-user-1',
      qqUserId: '12345'
    });
    assert.strictEqual(weixinBinding.principalId, '12345');
    assert.strictEqual(weixinBinding.qqUserId, '12345');
    assert.strictEqual(store.resolveBoundQqPrincipal('weixin', 'wx-user-1').principalId, '12345');

    const telegram = store.resolveIdentity('telegram', 'tg-1');
    assert.strictEqual(telegram.principalId, 'telegram:tg-1');
    const link = store.beginLink({ platform: 'telegram', externalUserId: 'tg-1' });
    timestamp += 1_000;
    const linked = store.consumeLink({ platform: 'qq', externalUserId: '12345', code: link.code });
    assert.strictEqual(linked.ok, true);
    assert.strictEqual(linked.principalId, '12345', 'QQ identity must remain the storage primary');
    assert.deepStrictEqual(
      store.getAliases('12345').sort(),
      ['12345', 'telegram:tg-1', 'weixin:wx-user-1'].sort()
    );
    assert.strictEqual(store.isAdminPrincipal('12345'), true);
    assert.strictEqual(store.resolveIdentity('telegram', 'tg-1').principalId, '12345');

    assert.throws(() => store.bindExternalIdentityToQq({
      platform: 'weixin',
      externalUserId: 'wx-user-1',
      qqUserId: '54321'
    }), (error) => error?.code === 'PLATFORM_IDENTITY_ALREADY_BOUND');

    const replacedWeixinBinding = store.replaceExternalIdentityForQq({
      platform: 'weixin',
      externalUserId: 'wx-user-2',
      previousExternalUserId: 'wx-user-1',
      qqUserId: '12345'
    });
    assert.strictEqual(replacedWeixinBinding.principalId, '12345');
    assert.strictEqual(store.resolveBoundQqPrincipal('weixin', 'wx-user-1'), null);
    assert.strictEqual(store.resolveBoundQqPrincipal('weixin', 'wx-user-2').principalId, '12345');
    assert.strictEqual(store.getAliases('12345').includes('weixin:wx-user-1'), false);
    assert.strictEqual(store.bindExternalIdentityToQq({
      platform: 'weixin',
      externalUserId: 'wx-user-1',
      qqUserId: '54321'
    }).principalId, '54321');

    const replay = store.consumeLink({ platform: 'discord', externalUserId: 'dc-1', code: link.code });
    assert.deepStrictEqual(replay, { ok: false, reason: 'code_used' });

    const expiring = store.beginLink({ platform: 'discord', externalUserId: 'dc-2' });
    timestamp += 61_000;
    const expired = store.consumeLink({ platform: 'telegram', externalUserId: 'tg-2', code: expiring.code });
    assert.deepStrictEqual(expired, { ok: false, reason: 'code_expired' });

    store.recordPrivateActivity('12345', {
      platform: 'telegram',
      chatType: 'private',
      conversationId: 'chat-1'
    });
    assert.strictEqual(store.getLastPrivateTarget('telegram:tg-1').conversationId, 'chat-1');

    const commandHandler = createIdentityCommandHandler({ store });
    const list = commandHandler.handle({
      text: '/bindings',
      chatType: 'private',
      platform: 'telegram',
      externalUserId: 'tg-1'
    });
    assert.strictEqual(list.handled, true);
    assert.match(list.replyText, /qq: 12345/);
    assert.match(list.replyText, /telegram: tg-1/);

    const unlink = store.unlink({ platform: 'telegram', externalUserId: 'tg-1', confirm: true });
    assert.strictEqual(unlink.ok, true);
    assert.strictEqual(store.resolveIdentity('telegram', 'tg-1').principalId, 'telegram:tg-1');
  } finally {
    store.close();
  }

  console.log('platformIdentityStore.test.js passed');
})();
