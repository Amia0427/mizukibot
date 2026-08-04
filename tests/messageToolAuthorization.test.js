const assert = require('assert');

const {
  handleToolAuthorizationCommand,
  parseToolAuthorizationCommand
} = require('../core/messageToolAuthorization');

assert.deepStrictEqual(parseToolAuthorizationCommand('/tool-confirm TA-ABC-123'), {
  action: 'confirm',
  ticketId: 'TA-ABC-123'
});
assert.deepStrictEqual(parseToolAuthorizationCommand('/tool-cancel TA-ABC-123'), {
  action: 'cancel',
  ticketId: 'TA-ABC-123'
});
assert.deepStrictEqual(parseToolAuthorizationCommand('/工具确认 TA-ABC-123'), {
  action: 'confirm',
  ticketId: 'TA-ABC-123'
});
assert.deepStrictEqual(parseToolAuthorizationCommand('/工具取消 TA-ABC-123'), {
  action: 'cancel',
  ticketId: 'TA-ABC-123'
});
assert.strictEqual(parseToolAuthorizationCommand('请 /tool-confirm TA-ABC-123'), null);
assert.strictEqual(parseToolAuthorizationCommand('/tool-confirm TA-ABC-123 extra'), null);
assert.strictEqual(parseToolAuthorizationCommand('/tool-confirm'), null);

module.exports = (async () => {
  const calls = [];
  const deps = {
    async confirm(ticketId, actor) {
      calls.push({ action: 'confirm', ticketId, actor });
      return { status: 'completed', result: '发送成功' };
    },
    async cancel(ticketId, actor) {
      calls.push({ action: 'cancel', ticketId, actor });
      return { status: 'cancelled' };
    }
  };
  const context = { userId: 'user-1', chatType: 'group', groupId: 'group-1' };

  const confirmed = await handleToolAuthorizationCommand('/tool-confirm TA-ABC-123', context, deps);
  assert.deepStrictEqual(confirmed, {
    handled: true,
    action: 'confirm',
    ticketId: 'TA-ABC-123',
    replyText: '工具已执行：发送成功',
    result: { status: 'completed', result: '发送成功' }
  });
  assert.deepStrictEqual(calls[0], {
    action: 'confirm',
    ticketId: 'TA-ABC-123',
    actor: context
  });

  const objectResult = await handleToolAuthorizationCommand('/tool-confirm TA-OBJECT', context, {
    ...deps,
    confirm: async () => ({ status: 'completed', result: { ok: true, id: 'job-1' } })
  });
  assert.strictEqual(objectResult.replyText, '工具已执行：{"ok":true,"id":"job-1"}');

  const cancelled = await handleToolAuthorizationCommand('/tool-cancel TA-ABC-123', context, deps);
  assert.strictEqual(cancelled.handled, true);
  assert.strictEqual(cancelled.replyText, '已取消这次工具执行。');

  const uncertain = await handleToolAuthorizationCommand('/tool-confirm TA-UNCERTAIN', context, {
    ...deps,
    confirm: async () => ({ status: 'uncertain', reason: 'executor_failed' })
  });
  assert.strictEqual(uncertain.replyText, '工具可能已经执行，但结果无法确认；为避免重复操作，系统已禁止重试。');

  const expired = await handleToolAuthorizationCommand('/tool-confirm TA-EXPIRED', context, {
    ...deps,
    confirm: async () => ({ status: 'denied', reason: 'expired', ticketStatus: 'expired' })
  });
  assert.strictEqual(expired.replyText, '确认票据已过期，工具未执行。');

  const mismatch = await handleToolAuthorizationCommand('/tool-confirm TA-MISMATCH', context, {
    ...deps,
    confirm: async () => ({ status: 'denied', reason: 'identity_mismatch' })
  });
  assert.strictEqual(mismatch.replyText, '这张确认票据不属于当前用户或聊天，工具未执行。');

  const duplicate = await handleToolAuthorizationCommand('/tool-confirm TA-DUPLICATE', context, {
    ...deps,
    confirm: async () => ({ status: 'denied', reason: 'already_consumed', ticketStatus: 'completed' })
  });
  assert.strictEqual(duplicate.replyText, '这张确认票据已处理，系统不会重复执行。');

  const ignored = await handleToolAuthorizationCommand('普通消息', context, deps);
  assert.deepStrictEqual(ignored, { handled: false });

  console.log('messageToolAuthorization.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
