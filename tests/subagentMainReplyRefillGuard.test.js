const assert = require('assert');

const { createMessageReplyRuntime } = require('../core/messageReplyRuntime');
const { buildBridgeGuidancePrompt } = require('../core/messagePromptComposer');

(() => {
  const noisySubagentReply = [
    '当然可以，以下是完整教程。',
    '首先，你需要先确认目标。你是不是还想继续？你是不是还想我补充？',
    '其次，这里继续写很多教程腔内容。'.repeat(120)
  ].join('\n');

  const runtime = createMessageReplyRuntime({
    sendWithRetry: async () => true,
    runtimeConfig: {}
  });
  const normalized = runtime.normalizeUserFacingReply(noisySubagentReply, {
    policyKey: 'admin/full',
    routeDebugKey: 'admin/full',
    topRouteType: 'admin',
    allowTools: true,
    subagentRefill: true,
    requestText: '查一下然后回复'
  });

  assert.ok(normalized.length <= 1400, 'main reply refill from subagent should stay in fallback budget');
  assert.ok(!/当然可以|以下是|首先|其次|你需要先/.test(normalized), 'main reply refill should not revive AI/tutorial scaffolding');
  assert.ok((normalized.match(/[？?]/g) || []).length <= 1, 'main reply refill should not stack questions');

  const bridgePrompt = buildBridgeGuidancePrompt(
    { topRouteType: 'admin', meta: { command: { cmd: 'full' }, admin: true } },
    'command',
    { policyKey: 'admin/full', routeDebugKey: 'admin/full' }
  );
  assert.ok(bridgePrompt.includes('Subagent style budget'), 'planner/dispatch bridge prompt should include style budget');

  console.log('subagentMainReplyRefillGuard.test.js passed');
})();
