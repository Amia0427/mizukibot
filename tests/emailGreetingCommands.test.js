const assert = require('assert');
const {
  createEmailGreetingCommandHandler,
  formatStatus,
  parseEmailGreetingCommand
} = require('../src/features/email-greetings/commands');

assert.deepStrictEqual(parseEmailGreetingCommand('/邮件问候 订阅 user@example.com'), {
  action: 'subscribe',
  email: 'user@example.com'
});
assert.deepStrictEqual(parseEmailGreetingCommand('/邮件问候 验证 123456'), {
  action: 'verify',
  code: '123456'
});
assert.deepStrictEqual(parseEmailGreetingCommand('/邮件问候 节日 关闭 七夕'), {
  action: 'holiday',
  enabled: false,
  holiday: '七夕'
});
assert.deepStrictEqual(parseEmailGreetingCommand('/邮件问候 纪念日 添加 相识纪念日 08-19'), {
  action: 'anniversary_add',
  name: '相识纪念日',
  date: '08-19'
});
assert.deepStrictEqual(parseEmailGreetingCommand('/邮件问候 纪念日 删除 相识纪念日'), {
  action: 'anniversary_remove',
  name: '相识纪念日'
});
assert.strictEqual(parseEmailGreetingCommand('帮我订阅邮件问候'), null);

(async () => {
  const replies = [];
  const calls = [];
  const handler = createEmailGreetingCommandHandler({
    getRuntime: () => ({
      enabled: true,
      service: {
        requestSubscription: async (...args) => { calls.push(['subscribe', ...args]); return { status: 'verification_sent', email: args[1] }; },
        verify: (...args) => { calls.push(['verify', ...args]); return { status: 'verified' }; },
        getStatus: () => ({ status: 'active', email: 'u***@example.com', disabledHolidayIds: [], anniversaries: [] }),
        unsubscribe: () => ({ status: 'unsubscribed' })
      }
    }),
    sendReply: async (_msg, text) => replies.push(text)
  });
  await handler.handle({ message_type: 'group', raw_message: '/邮件问候 状态', user_id: '1' });
  assert.strictEqual(replies[0], '邮件问候订阅仅支持 QQ 私聊管理。');
  await handler.handle({ message_type: 'private', raw_message: '/邮件问候 订阅 u@example.com', user_id: '1', sender: { nickname: '小明' } });
  assert.strictEqual(calls[0][0], 'subscribe');
  assert.strictEqual(replies[1], '验证码已发送至 u@example.com，请在 15 分钟内完成验证。');
  await handler.handle({ message_type: 'private', raw_message: '/邮件问候 状态', user_id: '1' });
  assert.ok(replies[2].includes('邮件问候：接收中'));
  assert.ok(formatStatus({ status: 'not_subscribed', disabledHolidayIds: [], anniversaries: [] }).includes('尚未订阅'));
  console.log('emailGreetingCommands.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
