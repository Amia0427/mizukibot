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

  const unavailableReply = buildUnavailableRouteReply(
    {
      meta: {
        command: { cmd: 'full' },
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

  assert.strictEqual(unavailableReply, '私聊不支持 /full，请在目标群内 @我后使用。');

  console.log('privateChatAdminRouting.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
