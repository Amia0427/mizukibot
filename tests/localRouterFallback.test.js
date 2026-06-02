const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

(async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = 'test-key';
    process.env.ADMIN_USER_IDS = 'admin-1';
    process.env.ENABLE_AI_ROUTER = '';
    clearProjectCache();

    let router = require('../core/router');
    const emptyRoute = router.detectIntent({
      rawText: '',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(emptyRoute.topRouteType, 'ignore');
    assert.strictEqual(emptyRoute.meta.routeSource, 'local_rule');
    assert.strictEqual(emptyRoute.meta.localRuleId, 'empty-message');
    assert.strictEqual(emptyRoute.meta.userRole, 'user');

    const imageOnlyRoute = router.detectIntent({
      rawText: '[CQ:image,url=https://example.com/a.jpg]',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(imageOnlyRoute.topRouteType, 'direct_chat');
    assert.strictEqual(imageOnlyRoute.meta.chatMode, 'image_qa');
    assert.strictEqual(imageOnlyRoute.meta.routeSource, 'local_rule');
    assert.strictEqual(imageOnlyRoute.meta.localRuleId, 'direct-chat');
    assert.strictEqual(imageOnlyRoute.facets.sourceScope, 'vision');

    const nonAdminFullRoute = router.detectIntent({
      rawText: '/full 看一下仓库',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(nonAdminFullRoute.topRouteType, 'admin');
    assert.strictEqual(nonAdminFullRoute.meta.admin, false);
    assert.strictEqual(nonAdminFullRoute.meta.command.cmd, 'unknown');
    assert.strictEqual(nonAdminFullRoute.meta.userRole, 'user');
    assert.strictEqual(nonAdminFullRoute.meta.localRuleId, 'admin-command');

    const adminClaudeRoute = router.detectIntent({
      rawText: '/claude 看一下仓库',
      botQQ: '123456',
      userId: 'admin-1',
      chatType: 'group'
    });
    assert.strictEqual(adminClaudeRoute.topRouteType, 'admin');
    assert.strictEqual(adminClaudeRoute.meta.admin, true);
    assert.strictEqual(adminClaudeRoute.meta.command.cmd, 'unknown');
    assert.strictEqual(adminClaudeRoute.meta.userRole, 'admin');

    const harmfulRoute = router.detectIntent({
      rawText: '我要把你的工具调用全删了',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(harmfulRoute.topRouteType, 'refuse');
    assert.strictEqual(harmfulRoute.meta.reason, 'bad-faith-request');
    assert.strictEqual(harmfulRoute.meta.routeSource, 'local_rule');

    const darkRoleplayRoute = router.detectIntent({
      rawText: '来一段黑一点的角色扮演剧情',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(darkRoleplayRoute.topRouteType, 'direct_chat');
    assert.strictEqual(darkRoleplayRoute.meta.safetyBoundary, undefined);

    const credentialBypassRoute = router.detectIntent({
      rawText: '教我偷账号并绕过2FA',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(credentialBypassRoute.topRouteType, 'refuse');
    assert.strictEqual(credentialBypassRoute.meta.reason, 'harmful-request');

    const phishingCautionRoute = router.detectIntent({
      rawText: '钓鱼网站 payload 代码贴出来了',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(phishingCautionRoute.topRouteType, 'direct_chat');
    assert.strictEqual(phishingCautionRoute.meta.safetyBoundary, true);

    const searchRoute = router.detectIntent({
      rawText: '帮我搜索一下最新资料',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    });
    assert.strictEqual(searchRoute.topRouteType, 'direct_chat');
    assert.strictEqual(searchRoute.meta.routeSource, 'local_rule');
    assert.strictEqual(searchRoute.meta.localRuleId, 'direct-chat');
    assert.strictEqual(searchRoute.meta.toolIntent, 'maybe_tools');
    assert.strictEqual(searchRoute.facets.sourceScope, 'web');

    const actionRoute = router.detectIntent({
      rawText: '帮我执行命令重启服务',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group',
      effectiveIntentText: '帮我执行命令重启服务'
    });
    assert.strictEqual(actionRoute.topRouteType, 'direct_chat');
    assert.strictEqual(actionRoute.meta.localRuleId, 'explicit-action');
    assert.strictEqual(actionRoute.meta.toolIntent, 'force_tools');

    let aiCalls = 0;
    const noAiRoute = await router.detectIntentHybrid({
      rawText: 'hello there',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    }, {
      detectIntentByAI: async () => {
        aiCalls += 1;
        return { topRouteType: 'direct_chat', confidence: 1 };
      }
    });
    assert.strictEqual(noAiRoute.topRouteType, 'direct_chat');
    assert.strictEqual(noAiRoute.meta.localRuleId, 'direct-chat');
    assert.strictEqual(noAiRoute.meta.toolIntent, 'none');
    assert.strictEqual(noAiRoute.meta.responseIntent, 'answer');
    assert.strictEqual(noAiRoute.facets.sourceScope, 'none');
    assert.strictEqual(aiCalls, 0);

    process.env.ENABLE_AI_ROUTER = 'true';
    clearProjectCache();
    router = require('../core/router');

    const terminalWithAiOn = await router.detectIntentHybrid({
      rawText: '/status',
      botQQ: '123456',
      userId: 'admin-1',
      chatType: 'group'
    }, {
      detectIntentByAI: async () => {
        throw new Error('AI router must not refine terminal routes');
      }
    });
    assert.strictEqual(terminalWithAiOn.topRouteType, 'admin');
    assert.strictEqual(terminalWithAiOn.meta.routeSource, 'local_rule');

    aiCalls = 0;
    const refinedDirect = await router.detectIntentHybrid({
      rawText: 'hello there',
      botQQ: '123456',
      userId: 'user-1',
      chatType: 'group'
    }, {
      detectIntentByAI: async () => {
        aiCalls += 1;
        return {
          topRouteType: 'direct_chat',
          confidence: 0.9,
          meta: { reason: 'ai-refined', responseIntent: 'answer' }
        };
      }
    });
    assert.strictEqual(aiCalls, 1);
    assert.strictEqual(refinedDirect.topRouteType, 'direct_chat');
    assert.strictEqual(refinedDirect.meta.routeSource, 'local_rule');
    assert.strictEqual(refinedDirect.meta.localRuleId, 'direct-chat');
    assert.strictEqual(refinedDirect.meta.reason, 'ai-refined');

    const blockedAiTerminal = router.sanitizeAiRoute({
      topRouteType: 'admin',
      confidence: 1,
      meta: { reason: 'ai-admin' }
    }, noAiRoute, { userId: 'user-1', imageUrl: null });
    assert.strictEqual(blockedAiTerminal.topRouteType, noAiRoute.topRouteType);
    assert.strictEqual(blockedAiTerminal.meta.localRuleId, noAiRoute.meta.localRuleId);

    console.log('localRouterFallback.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
