const assert = require('assert');

const {
  buildNormalFastReplyDecision,
  isNormalFastReplyEligible
} = require('../utils/normalFastReplyGate');

function baseInput(overrides = {}) {
  return {
    userId: 'normal_1',
    cleanText: '今晚吃什么好',
    route: {
      topRouteType: 'direct_chat',
      cleanText: '今晚吃什么好',
      meta: {
        chatType: 'private'
      }
    },
    routeExecutionPlan: {
      executor: 'direct',
      topRouteType: 'direct_chat',
      allowTools: false,
      allowedTools: []
    },
    ...overrides
  };
}

const config = {
  NORMAL_FAST_REPLY_ENABLED: true,
  ADMIN_USER_IDS: ['admin_1'],
  PRIVATE_CHAT_TEST_USER_IDS: ['private_tester']
};

assert.strictEqual(isNormalFastReplyEligible(baseInput(), config), true, '普通纯文本应命中 fast path');
assert.strictEqual(isNormalFastReplyEligible(baseInput(), { ADMIN_USER_IDS: [] }), false, '未显式开启时应禁用 fast path');
assert.strictEqual(
  isNormalFastReplyEligible(baseInput(), { NORMAL_FAST_REPLY_ENABLED: false, ADMIN_USER_IDS: [] }),
  false,
  '显式关闭时应禁用 fast path'
);

assert.strictEqual(isNormalFastReplyEligible(baseInput({ userId: 'admin_1' }), config), false, '管理员不应命中');

assert.strictEqual(
  isNormalFastReplyEligible(baseInput({ userId: 'private_tester' }), config),
  true,
  'PRIVATE_CHAT_TEST_USER_IDS 不赋予管理员权限'
);

assert.strictEqual(isNormalFastReplyEligible(baseInput({ imageUrl: 'https://example.com/a.png' }), config), false, '图片不应命中');

assert.strictEqual(
  isNormalFastReplyEligible(baseInput({ routeExecutionPlan: { executor: 'direct', topRouteType: 'direct_chat', allowTools: true, allowedTools: ['memory_cli'] } }), config),
  false,
  '允许工具不应命中'
);

const blockedCases = [
  ['搜索一下今天新闻', '搜索不应命中'],
  ['给我做一个计划', '计划不应命中'],
  ['总结一下刚才内容', '总结不应命中'],
  ['你还记得上次说什么吗', '记忆召回不应命中'],
  ['/full 帮我查', 'admin/slash 命令不应命中']
];

for (const [text, message] of blockedCases) {
  const decision = buildNormalFastReplyDecision(baseInput({
    cleanText: text,
    route: {
      ...baseInput().route,
      cleanText: text
    }
  }), config);
  assert.strictEqual(decision.eligible, false, message);
}

console.log('normalFastReplyGate.test.js passed');
