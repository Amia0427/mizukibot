const assert = require('assert');

const { createMessageRouteFlow, buildUnavailableRouteReply } = require('../core/messageRouteFlow');

module.exports = (async () => {
  const sent = [];

  const routeFlow = createMessageRouteFlow({
    config: {},
    handleAdminCommand: async () => ({ handled: true, replyText: 'meme ok' }),
    handleQqScheduleAdminCommand: async () => ({ text: 'schedule ok' }),
    publishQzoneForContext: async () => ({ text: 'qzone ok' }),
    isAdminUser: (userId) => userId === 'admin_1',
    listScheduledTasks: () => ({ text: 'list ok' }),
    cancelScheduledTask: () => ({ text: 'cancel ok' }),
    deleteScheduledTask: () => ({ text: 'delete ok' }),
    formatEventsAsText: () => 'events ok',
    searchEvents: () => [],
    listRecentEvents: () => [],
    formatPatternsAsText: () => 'patterns ok',
    listPatterns: () => [],
    formatRulesAsText: () => 'rules ok',
    listRules: () => [],
    formatGuidesAsText: () => 'guides ok',
    listGuides: () => [],
    formatStyleProfileAsText: () => 'style ok',
    formatSocialContextAsText: () => 'social ok',
    formatRelationshipGraphAsText: () => 'graph ok',
    sendGroupReply: async (payload) => {
      sent.push(payload);
      return true;
    }
  });

  const result = await routeFlow.dispatchAdminRoute({
    route: {
      topRouteType: 'admin',
      meta: {
        admin: true,
        command: { cmd: 'help', args: [], raw: '/help' }
      }
    },
    groupId: '',
    senderId: 'admin_1',
    rawText: '/help',
    userInfo: null,
    chatType: 'private'
  });

  assert.strictEqual(result.handled, true);
  assert.ok(sent.length >= 1);
  assert.strictEqual(sent[0].chatType, 'private');
  assert.strictEqual(sent[0].userId, 'admin_1');
  assert.strictEqual(sent[0].atSender, false);
  assert.ok(String(sent[0].replyText || '').includes('/create <prompt>'));

  const unknownPrivateReply = buildUnavailableRouteReply(
    {
      meta: {
        command: { cmd: 'unknown' },
        chatType: 'private'
      }
    },
    {
      unavailableReason: 'private-group-only'
    },
    {
      isAdminUser: (userId) => userId === 'admin_1'
    }
  );

  assert.strictEqual(unknownPrivateReply, '这个得在目标群里喊我才行哦。');

  const groupSummaryPrivateReply = buildUnavailableRouteReply(
    {
      meta: {
        command: { cmd: 'group_summary' },
        chatType: 'private'
      }
    },
    {
      unavailableReason: 'private-group-only'
    },
    {
      isAdminUser: (userId) => userId === 'admin_1'
    }
  );

  assert.strictEqual(groupSummaryPrivateReply, '这个要在群里才接得住啦。');

  const privateWriteDisabledReply = buildUnavailableRouteReply(
    {
      meta: {
        chatType: 'private'
      }
    },
    {
      unavailableReason: 'private-write-disabled'
    }
  );

  assert.strictEqual(privateWriteDisabledReply, '私聊现在先收起来了，只对白名单和管理员开放哦。');
  assert.ok(!privateWriteDisabledReply.includes('只读能力'));

  console.log('privateChatAdminRouting.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
