const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { parseDecision } = require('../core/passiveGroupAwareness');
const { buildBridgeGuidancePrompt } = require('../core/messageHandler');

const exitDecision = parseDecision('{"should_reply":false,"confidence":0.9,"reason":"先这样，晚安"}');
assert.strictEqual(exitDecision.shouldReply, false);

const prompt = buildBridgeGuidancePrompt({
  meta: {
    reason: '需要工具'
  }
}, 'command', {
  routeDebugKey: 'direct_chat/text_chat/action',
  topRouteType: 'direct_chat'
});

assert.ok(prompt.includes('路由原因'));
assert.ok(prompt.includes('执行步骤') || !prompt.includes('鎵ц'));
assert.ok(!prompt.includes('璺敱'));

console.log('messageCopyMojibake.test.js passed');
