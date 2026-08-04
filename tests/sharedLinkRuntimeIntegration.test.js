const assert = require('assert');

process.env.BOT_TOOL_MODE = 'companion';
process.env.COMPANION_TOOL_MODE_ENABLED = 'true';

const config = require('../config');
config.BOT_TOOL_MODE = 'companion';
config.COMPANION_TOOL_MODE_ENABLED = true;

const { getToolNames } = require('../api/toolRegistry');
const { executeGlobalToolBatch } = require('../api/globalToolRuntime');
const { buildCapabilityRegistry } = require('../api/runtimeV2/capabilities/registry');
const scheduler = require('../api/runtimeV2/capabilities/scheduler');
const routeExecution = require('../core/routeExecution');
const { applyDeterministicToolRouting } = require('../core/router/toolRouting');

function route(text, topRouteType = 'direct_chat', chatType = 'private') {
  return {
    topRouteType,
    question: text,
    cleanText: text,
    intent: { needsMemory: false, needsPlanning: false, toolNeed: [] },
    facets: { sourceScope: 'none', domain: 'general', outputKind: 'answer' },
    meta: {
      chatType,
      chatMode: 'text_chat',
      toolIntent: 'none',
      responseIntent: 'answer',
      allowedTools: []
    }
  };
}

function cardRoute({ text = '', urls = [], cardOnly = false, chatType = 'private', topRouteType = 'direct_chat' } = {}) {
  return {
    ...route(text, topRouteType, chatType),
    meta: {
      ...route(text, topRouteType, chatType).meta,
      cardOnly,
      qqCardUrls: urls,
      cardContexts: urls.map((url, index) => ({
        kind: index % 2 === 0 ? 'news' : 'music',
        title: `卡片 ${index + 1}`,
        primaryUrl: url
      }))
    }
  };
}

module.exports = (async () => {
  assert.ok(getToolNames().includes('read_shared_link'));

  const privateLink = applyDeterministicToolRouting(route('看看这个 https://b23.tv/abc123'));
  assert.deepStrictEqual(privateLink.meta.allowedTools, ['read_shared_link']);
  assert.strictEqual(privateLink.meta.sharedLinkUrl, 'https://b23.tv/abc123');

  const groupLink = applyDeterministicToolRouting(route(
    '这个怎么样 https://music.163.com/#/song?id=186016',
    'direct_chat',
    'group'
  ));
  assert.deepStrictEqual(groupLink.meta.allowedTools, ['read_shared_link']);

  const ignored = applyDeterministicToolRouting(route('https://b23.tv/abc123', 'ignore', 'group'));
  assert.deepStrictEqual(ignored.meta.allowedTools, []);

  const duplicate = applyDeterministicToolRouting(route(
    'https://b23.tv/abc123 再看 https://music.163.com/#/song?id=186016'
  ));
  assert.strictEqual(duplicate.meta.sharedLinkUrl, 'https://b23.tv/abc123');
  assert.deepStrictEqual(duplicate.meta.allowedTools, ['read_shared_link']);

  const purePrivateCard = applyDeterministicToolRouting(cardRoute({
    text: '[分享链接] https://music.163.com/#/song?id=186016',
    urls: ['https://music.163.com/#/song?id=186016'],
    cardOnly: true
  }));
  assert.deepStrictEqual(purePrivateCard.meta.allowedTools, ['read_shared_link', 'web_fetch']);
  const purePrivateExecution = routeExecution.resolveRouteExecution(purePrivateCard, config);
  assert.strictEqual(purePrivateExecution.allowTools, true);
  assert.ok(purePrivateExecution.allowedTools.includes('web_fetch'));

  const ordinaryShare = applyDeterministicToolRouting(cardRoute({
    text: '分享给你 https://example.com/ordinary',
    urls: ['https://example.com/ordinary']
  }));
  assert.strictEqual(ordinaryShare.meta.cardReadPolicy, 'metadata_only');
  assert.deepStrictEqual(ordinaryShare.meta.allowedTools, []);

  const requestedSummary = applyDeterministicToolRouting(cardRoute({
    text: '帮我总结一下 https://example.com/summary',
    urls: ['https://example.com/summary']
  }));
  assert.strictEqual(requestedSummary.meta.cardReadPolicy, 'read');
  assert.deepStrictEqual(requestedSummary.meta.allowedTools, ['web_fetch']);

  const groupPureCard = applyDeterministicToolRouting(cardRoute({
    text: '[分享链接] https://example.com/group',
    urls: ['https://example.com/group'],
    cardOnly: true,
    chatType: 'group'
  }));
  assert.strictEqual(groupPureCard.meta.cardReadPolicy, 'metadata_only');
  assert.deepStrictEqual(groupPureCard.meta.allowedTools, []);

  const comparedUrls = [
    'https://example.com/first',
    'https://example.com/second',
    'https://example.com/third'
  ];
  const comparedCards = applyDeterministicToolRouting(cardRoute({
    text: '比较这三张卡片',
    urls: comparedUrls
  }));
  assert.deepStrictEqual(comparedCards.meta.allowedTools, ['web_fetch']);
  assert.deepStrictEqual(comparedCards.meta.qqCardUrls, comparedUrls);

  const tooManyCards = applyDeterministicToolRouting(cardRoute({
    text: '看看这些卡片',
    urls: Array.from({ length: 4 }, (_, index) => `https://example.com/${index + 1}`)
  }));
  assert.strictEqual(tooManyCards.meta.cardReadPolicy, 'limit_exceeded');
  assert.deepStrictEqual(tooManyCards.meta.allowedTools, []);

  const registry = buildCapabilityRegistry();
  assert.strictEqual(registry.byName.get('read_shared_link').timeoutMs, 30000);

  const timeoutRegistry = {
    byName: new Map([
      ['web_search', {
        name: 'web_search',
        kind: 'tool',
        parallelSafe: true,
        executor: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 35))
      }],
      ['get_current_time', {
        name: 'get_current_time',
        kind: 'tool',
        parallelSafe: true,
        timeoutMs: 60,
        executor: async () => new Promise((resolve) => setTimeout(() => resolve('ok'), 35))
      }]
    ])
  };
  const results = await scheduler.executeBatch([
    { id: 'default', kind: 'tool', tool: 'web_search', inputs: {} },
    { id: 'custom', kind: 'tool', tool: 'get_current_time', inputs: {} }
  ], { request: { allowedTools: ['web_search', 'get_current_time'] } }, {
    registry: timeoutRegistry,
    timeoutMs: 20,
    batches: [{ mode: 'parallel', items: [
      { id: 'default', kind: 'tool', tool: 'web_search', inputs: {} },
      { id: 'custom', kind: 'tool', tool: 'get_current_time', inputs: {} }
    ] }]
  });
  assert.strictEqual(results.find((item) => item.step_id === 'default').status, 'failed');
  assert.strictEqual(results.find((item) => item.step_id === 'custom').status, 'completed');

  const secretUrl = 'https://www.xiaohongshu.com/explore/note123?xsec_token=must-not-log';
  const [sanitizedEnvelope] = await scheduler.executeBatch([
    { id: 'secret', kind: 'tool', tool: 'read_shared_link', inputs: { url: secretUrl } }
  ], { request: { allowedTools: ['read_shared_link'] } }, {
    registry: {
      byName: new Map([['read_shared_link', {
        name: 'read_shared_link',
        kind: 'tool',
        parallelSafe: true,
        executor: async () => '公开内容已读取'
      }]])
    },
    timeoutMs: 100
  });
  assert.strictEqual(sanitizedEnvelope.args.platform, 'xiaohongshu');
  assert.ok(sanitizedEnvelope.args.contentId);
  assert.ok(!JSON.stringify(sanitizedEnvelope).includes('must-not-log'));

  const globalBatch = await executeGlobalToolBatch([{
    toolName: 'read_shared_link',
    args: { url: secretUrl }
  }], {
    allowedGlobalTools: ['read_shared_link'],
    toolExecutors: { read_shared_link: async () => '公开内容已读取' }
  });
  assert.strictEqual(globalBatch.results[0].status, 'completed');
  assert.ok(!JSON.stringify(globalBatch.results[0]).includes('must-not-log'));

  console.log('sharedLinkRuntimeIntegration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
