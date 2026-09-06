const assert = require('assert');

const { parseAdminCommand } = require('../core/router/adminCommands');
const { createMessageAdminCoordinator } = require('../core/messageAdminCommands');

const calls = [];
const userBlockStore = {
  blockUser(input) {
    calls.push({ type: 'block', input });
    return { userId: input.userId, expiresAt: input.now + input.durationMs };
  },
  unblockUser(input) {
    calls.push({ type: 'unblock', input });
    return { removed: input.userId === '10001', userId: input.userId };
  }
};

const coordinator = createMessageAdminCoordinator({
  config: {},
  isAdminUser: (userId) => userId === 'admin',
  userBlockStore,
  chatHistory: {},
  shortTermMemory: {},
  resolveShortTermSessionKey: () => 'session',
  getSessionSummaryCooldownStatus: () => ({ limited: false, remainingMs: 0 }),
  saveSessionContextSummary: () => ({ saved: true }),
  generateSessionContextSummary: async () => ({ summary: 'ok' }),
  getGroupInitiativeState: () => ({}),
  clearGroupMute: () => {},
  setGroupMute: () => {},
  scheduleGroupMessage: async () => ({}),
  createScheduledCommand: async () => ({})
});

const blockCommand = parseAdminCommand('/block 10001 30');
assert.deepStrictEqual(blockCommand, {
  cmd: 'block',
  args: ['10001', '30'],
  raw: '/block 10001 30',
  payload: '10001 30'
});
assert.deepStrictEqual(parseAdminCommand('/unblock 10001').args, ['10001']);

module.exports = (async () => {
  const timed = await coordinator.handleUserBlockAdminCommand({
    command: blockCommand,
    userId: 'admin'
  });
  assert.strictEqual(timed.handled, true);
  assert.ok(timed.replyText.includes('30 分钟'));
  assert.strictEqual(calls[0].input.durationMs, 30 * 60 * 1000);

  await coordinator.handleUserBlockAdminCommand({
    command: parseAdminCommand('/block 10001 2h'),
    userId: 'admin'
  });
  assert.strictEqual(calls[1].input.durationMs, 2 * 60 * 60 * 1000);

  const permanent = await coordinator.handleUserBlockAdminCommand({
    command: parseAdminCommand('/block 10001 永久'),
    userId: 'admin'
  });
  assert.ok(permanent.replyText.includes('永久'));
  assert.strictEqual(calls[2].input.durationMs, 0);

  const denied = await coordinator.handleUserBlockAdminCommand({
    command: parseAdminCommand('/block 10001 30'),
    userId: 'user'
  });
  assert.strictEqual(denied.replyText, '这个按钮现在只给管理员按哦。');
  assert.strictEqual(calls.length, 3);

  const invalid = await coordinator.handleUserBlockAdminCommand({
    command: parseAdminCommand('/block 10001 nonsense'),
    userId: 'admin'
  });
  assert.ok(invalid.replyText.includes('/block <QQ号> <时长>'));

  const unblocked = await coordinator.handleUserBlockAdminCommand({
    command: parseAdminCommand('/unblock 10001'),
    userId: 'admin'
  });
  assert.ok(unblocked.replyText.includes('已解封'));
  assert.strictEqual(calls[3].type, 'unblock');

  console.log('userBlockCommands.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
