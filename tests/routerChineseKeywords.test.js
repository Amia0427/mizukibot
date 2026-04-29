const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { detectIntent, sanitizeAiRoute } = require('../core/router');
const { parseAdminCommand } = require('../core/router');

const imageSummaryRoute = detectIntent({
  rawText: '请总结这张图片 [CQ:image,url=https://example.com/a.jpg]',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(imageSummaryRoute.topRouteType, 'direct_chat');
assert.strictEqual(imageSummaryRoute.meta.chatMode, 'image_summary');
assert.strictEqual(imageSummaryRoute.meta.localRuleId, 'direct-chat');
assert.strictEqual(imageSummaryRoute.meta.responseIntent, 'summary');
assert.strictEqual(imageSummaryRoute.facets.sourceScope, 'vision');

const summaryRoute = detectIntent({
  rawText: '帮我总结这段文字：项目完成路由压平，后续补回归测试。',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(summaryRoute.topRouteType, 'direct_chat');
assert.strictEqual(summaryRoute.meta.localRuleId, 'direct-chat');
assert.strictEqual(summaryRoute.meta.responseIntent, 'summary');
assert.strictEqual(summaryRoute.meta.toolIntent, 'none');

const actionRoute = detectIntent({
  rawText: '帮我执行命令重启服务',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group',
  effectiveIntentText: '帮我执行命令重启服务'
});

assert.strictEqual(actionRoute.topRouteType, 'direct_chat');
assert.strictEqual(actionRoute.meta.localRuleId, 'explicit-action');
assert.strictEqual(actionRoute.meta.responseIntent, 'action_guidance');

const hapiCommand = parseAdminCommand('/hapi status');
assert.strictEqual(hapiCommand.cmd, 'hapi');
assert.strictEqual(hapiCommand.payload, 'status');

const claudeCommand = parseAdminCommand('/claude 帮我看下这个仓库');
assert.strictEqual(claudeCommand.cmd, 'claude');
assert.strictEqual(claudeCommand.payload, '帮我看下这个仓库');

const claudeOpenCommand = parseAdminCommand('/claude-open');
assert.strictEqual(claudeOpenCommand.cmd, 'claude-open');

const claudeSendCommand = parseAdminCommand('/claude-send 继续');
assert.strictEqual(claudeSendCommand.cmd, 'claude-send');
assert.strictEqual(claudeSendCommand.payload, '继续');

const notebookLookupRoute = detectIntent({
  rawText: '宝我昨天给你发了什么图',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(notebookLookupRoute.topRouteType, 'direct_chat');
assert.strictEqual(notebookLookupRoute.meta.responseIntent, 'answer');
assert.strictEqual(notebookLookupRoute.facets.sourceScope, 'notebook');
assert.strictEqual(notebookLookupRoute.meta.localRuleId, 'direct-chat');
assert.strictEqual(notebookLookupRoute.meta.toolIntent, 'maybe_tools');
assert.deepStrictEqual(notebookLookupRoute.meta.allowedTools, ['notebook_search', 'notebook_list_docs']);

const recapRoute = detectIntent({
  rawText: '宝说一下我今天和你说的',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(recapRoute.topRouteType, 'direct_chat');
assert.strictEqual(recapRoute.facets.sourceScope, 'notebook');
assert.strictEqual(recapRoute.facets.freshness, 'unknown');
assert.strictEqual(recapRoute.intent.needsMemory, true);
assert.deepStrictEqual(recapRoute.meta.allowedTools, ['notebook_search', 'notebook_list_docs']);
assert.strictEqual(recapRoute.meta.toolIntent, 'maybe_tools');

const todaySongRoute = detectIntent({
  rawText: '宝我今天打了哪些歌',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(todaySongRoute.topRouteType, 'direct_chat');
assert.strictEqual(todaySongRoute.facets.sourceScope, 'notebook');
assert.strictEqual(todaySongRoute.facets.freshness, 'unknown');
assert.strictEqual(todaySongRoute.intent.needsMemory, true);
assert.deepStrictEqual(todaySongRoute.meta.allowedTools, ['notebook_search', 'notebook_list_docs']);
assert.strictEqual(todaySongRoute.meta.toolIntent, 'maybe_tools');

const textOnlyPlanRoute = detectIntent({
  rawText: 'plan a study roadmap',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});

assert.strictEqual(textOnlyPlanRoute.topRouteType, 'direct_chat');
assert.strictEqual(textOnlyPlanRoute.meta.responseIntent, 'plan');
assert.strictEqual(textOnlyPlanRoute.meta.toolIntent, 'none');
assert.strictEqual(textOnlyPlanRoute.facets.outputKind, 'plan');
assert.strictEqual(textOnlyPlanRoute.facets.sourceScope, 'none');

const fallbackChatRoute = detectIntent({
  rawText: 'hello there',
  botQQ: '123456',
  userId: 'u1',
  chatType: 'group'
});
const downgradedHighRiskRoute = sanitizeAiRoute({
  confidence: 0.6,
  topRouteType: 'direct_chat',
  intent: { risk: 'medium', toolNeed: ['local-write'], executionMode: 'delegated', needsPlanning: true, needsMemory: false },
  facets: { modality: 'text', sourceScope: 'mixed', domain: 'general', outputKind: 'action', freshness: 'unknown' },
  meta: { toolIntent: 'force_tools', responseIntent: 'action_guidance' }
}, fallbackChatRoute, { userId: 'u1', imageUrl: null });

assert.strictEqual(downgradedHighRiskRoute.meta.fallbackReason, 'ai-router-low-confidence-high-risk');
assert.notStrictEqual(downgradedHighRiskRoute.meta.toolIntent, 'force_tools');

console.log('routerChineseKeywords.test.js passed');
