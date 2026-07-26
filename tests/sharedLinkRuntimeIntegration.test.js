const assert = require('assert');

process.env.BOT_TOOL_MODE = 'companion';
process.env.COMPANION_TOOL_MODE_ENABLED = 'true';
process.env.PLAN_API_BASE_URL = '';
process.env.PLAN_API_KEY = '';
process.env.PLANNER_SUBAGENT_ENABLED = 'false';

const config = require('../config');
config.BOT_TOOL_MODE = 'companion';
config.COMPANION_TOOL_MODE_ENABLED = true;
config.PLAN_API_BASE_URL = '';
config.PLAN_API_KEY = '';
config.PLANNER_SUBAGENT_ENABLED = false;

const { getToolNames } = require('../api/toolRegistry');
const { executeGlobalToolBatch } = require('../api/globalToolRuntime');
const { buildCapabilityRegistry } = require('../api/runtimeV2/capabilities/registry');
const scheduler = require('../api/runtimeV2/capabilities/scheduler');
const { planDirectChat } = require('../core/directChatPlanner');

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
      allowedTools: ['read_shared_link']
    }
  };
}

module.exports = (async () => {
  assert.ok(getToolNames().includes('read_shared_link'));

  const privateDecision = await planDirectChat(route('看看这个 https://b23.tv/abc123'));
  assert.strictEqual(privateDecision.executionPlan.mode, 'tool_plan');
  assert.deepStrictEqual(privateDecision.allowedToolNames, ['read_shared_link']);
  assert.strictEqual(privateDecision.executionPlan.steps.length, 1);
  assert.strictEqual(privateDecision.executionPlan.steps[0].action, 'read_shared_link');
  assert.deepStrictEqual(privateDecision.executionPlan.steps[0].args, { url: 'https://b23.tv/abc123' });
  assert.strictEqual(privateDecision.decisionSource, 'rule_preflight_shared_link');

  const groupDecision = await planDirectChat(route('这个怎么样 https://music.163.com/#/song?id=186016', 'direct_chat', 'group'));
  assert.strictEqual(groupDecision.executionPlan.mode, 'tool_plan');

  const ignored = await planDirectChat(route('https://b23.tv/abc123', 'ignore', 'group'));
  assert.strictEqual(ignored.executionPlan.mode, 'chat_only');
  assert.ok(!ignored.allowedToolNames.includes('read_shared_link'));

  const duplicate = await planDirectChat(route('https://b23.tv/abc123 再看 https://music.163.com/#/song?id=186016'));
  assert.strictEqual(duplicate.executionPlan.steps.length, 1);
  assert.strictEqual(duplicate.executionPlan.steps[0].args.url, 'https://b23.tv/abc123');

  const registry = buildCapabilityRegistry();
  assert.strictEqual(registry.byName.get('read_shared_link').timeoutMs, 30000);

  const timeoutRegistry = {
    byName: new Map([
      ['default_timeout', {
        name: 'default_timeout',
        kind: 'tool',
        parallelSafe: true,
        executor: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 35))
      }],
      ['custom_timeout', {
        name: 'custom_timeout',
        kind: 'tool',
        parallelSafe: true,
        timeoutMs: 60,
        executor: async () => new Promise((resolve) => setTimeout(() => resolve('ok'), 35))
      }]
    ])
  };
  const results = await scheduler.executeBatch([
    { id: 'default', kind: 'tool', tool: 'default_timeout', inputs: {} },
    { id: 'custom', kind: 'tool', tool: 'custom_timeout', inputs: {} }
  ], { request: { allowedTools: ['default_timeout', 'custom_timeout'] } }, {
    registry: timeoutRegistry,
    timeoutMs: 20,
    batches: [{ mode: 'parallel', items: [
      { id: 'default', kind: 'tool', tool: 'default_timeout', inputs: {} },
      { id: 'custom', kind: 'tool', tool: 'custom_timeout', inputs: {} }
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
    toolExecutors: {
      read_shared_link: async () => '公开内容已读取'
    }
  });
  assert.strictEqual(globalBatch.results[0].status, 'completed');
  assert.ok(!JSON.stringify(globalBatch.results[0]).includes('must-not-log'));

  console.log('sharedLinkRuntimeIntegration.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
