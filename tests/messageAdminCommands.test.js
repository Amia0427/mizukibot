const assert = require('assert');

const { createMessageAdminCoordinator } = require('../core/messageAdminCommands');

let muted = null;
let cleared = false;

const coordinator = createMessageAdminCoordinator({
  config: {
    INITIATIVE_POLICY_ENABLED: true,
    INITIATIVE_GROUP_MAX_PER_DAY: 8
  },
  chatHistory: {},
  shortTermMemory: {},
  resolveShortTermSessionKey: () => 'session_1',
  getSessionSummaryCooldownStatus: () => ({ limited: false, remainingMs: 0 }),
  saveSessionContextSummary: () => ({ saved: true, duplicate: false, cooldownLimited: false }),
  generateSessionContextSummary: async () => ({ summary: 'summary ok' }),
  isAdminUser: (userId) => userId === 'admin_1',
  getGroupInitiativeState: () => ({
    mute: { until: 0 },
    daily: { count: 2, lastSource: 'timer' },
    lastSkipReason: 'none'
  }),
  clearGroupMute: () => { cleared = true; },
  setGroupMute: (_groupId, payload) => { muted = payload; },
  scheduleGroupMessage: async (message, when) => ({ ok: true, kind: 'message', message, when }),
  createScheduledCommand: async (action, when, payload) => ({ ok: true, kind: 'command', action, when, payload })
});

module.exports = (async () => {
  const summary = await coordinator.handleSessionSummaryCommand({
    rawText: '/sr',
    senderId: 'u1',
    groupId: 'g1'
  });
  assert.strictEqual(summary.handled, true);
  assert.strictEqual(summary.replyText, '当前会话总结已保存。');

  const mute = await coordinator.handleInitiativeAdminCommand({
    rawText: '/initiative mute 15',
    groupId: 'g1',
    userId: 'admin_1'
  });
  assert.strictEqual(mute.handled, true);
  assert.ok(String(mute.replyText).includes('15'));
  assert.ok(muted && muted.until > Date.now());

  const resume = await coordinator.handleInitiativeAdminCommand({
    rawText: '/initiative resume',
    groupId: 'g1',
    userId: 'admin_1'
  });
  assert.strictEqual(resume.handled, true);
  assert.strictEqual(cleared, true);

  const schedule = await coordinator.handleQqScheduleAdminCommand({
    payload: '{"kind":"message","message":"hello","when":"tomorrow"}'
  }, { groupId: 'g1' });
  assert.strictEqual(schedule.ok, true);
  assert.strictEqual(schedule.kind, 'message');

  assert.strictEqual(coordinator.handleHapiAdminCommand, undefined);

  const restart = await coordinator.handleRestartAdminCommand({
    rawText: '/restart',
    userId: 'admin_1'
  });
  assert.strictEqual(restart.handled, true);
  assert.strictEqual(restart.restartRequested, true);
  assert.ok(String(restart.replyText).includes('重启'));

  const restartDenied = await coordinator.handleRestartAdminCommand({
    rawText: '/restart',
    userId: 'u1'
  });
  assert.strictEqual(restartDenied.handled, true);
  assert.strictEqual(restartDenied.restartRequested, undefined);
  assert.strictEqual(restartDenied.replyText, '仅管理员可用。');

  const restartWithTail = await coordinator.handleRestartAdminCommand({
    rawText: '/restart now',
    userId: 'admin_1'
  });
  assert.strictEqual(restartWithTail, null);

  console.log('messageAdminCommands.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
