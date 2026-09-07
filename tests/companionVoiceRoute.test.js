'use strict';

const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { detectIntent } = require('../core/router');
const { resolveRouteExecution } = require('../core/routeExecution');

function getVoicePlan(rawText, chatType) {
  const route = detectIntent({
    rawText,
    botQQ: '3326471600',
    userId: 'voice-route-user',
    chatType,
    effectiveIntentText: rawText
  });
  const plan = resolveRouteExecution(route, {
    BOT_TOOL_MODE: 'companion',
    COMPANION_TOOL_MODE_ENABLED: true,
    COMPANION_ALLOWED_TOOLS: ''
  });
  return { route, plan };
}

for (const chatType of ['private', 'group']) {
  const { route, plan } = getVoicePlan('请用语音说：おはよう、今日も頑張ろう。', chatType);
  assert.deepStrictEqual(route.meta.allowedTools, ['companion_voice_reply']);
  assert.strictEqual(route.meta.toolIntent, 'force_tools');
  assert.strictEqual(plan.allowTools, true);
  assert.deepStrictEqual(plan.allowedTools, ['companion_voice_reply']);
}

const ordinary = getVoicePlan('你好，今天过得怎么样？', 'private');
assert.deepStrictEqual(ordinary.route.meta.allowedTools, []);
assert.strictEqual(ordinary.plan.allowTools, false);

console.log('companionVoiceRoute.test.js passed');
