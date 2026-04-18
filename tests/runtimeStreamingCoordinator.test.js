const assert = require('assert');

const { createStreamingCoordinatorHelpers } = require('../api/runtimeV2/runtime/streamingCoordinator');

module.exports = (async () => {
  const deltas = [];
  const helpers = createStreamingCoordinatorHelpers({
    sanitizeUserFacingText: (text) => String(text || ''),
    isChatLikeRoute: () => true,
    buildVisionMessageContent: (text) => text,
    buildV2CanonicalSegments: (_state, input) => ({
      segments: {},
      compactionPlan: {
        compactedSegments: [{ name: 'user', messages: input.userTurnMessages || [] }]
      }
    }),
    buildShortTermContextMessages: () => ({
      sessionSummaryMessages: [],
      summaryMessage: null,
      recentHistory: []
    }),
    resolveShortTermSessionKey: () => 'session',
    resolveMainConversationModelName: () => 'gpt-5.4',
    requestStreamingReplyImpl: async () => 'streamed answer',
    finalizeStreamingReplyWithHumanizerImpl: async (text) => text,
    isHumanizerEnabledImpl: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    requestReplyImpl: async () => 'fallback answer',
    markStreamCompleted: () => ({ completed: true }),
    resolveToolLoopReply: async () => ({ text: 'resolved', source: 'fallback' }),
    config: { AI_MAX_TOKENS: 3500 },
    chatHistory: {},
    shortTermMemory: {}
  });

  const streamed = await helpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: { routePolicyKey: 'direct_chat/default', modelConfig: {}, onDelta(text) { deltas.push(text); } },
    memory: {},
    output: {}
  });
  assert.strictEqual(streamed.finalReply, 'streamed answer');

  const direct = await helpers.maybeStreamFinalReply({
    request: {
      streaming: true,
      onDelta(text) { deltas.push(text); }
    }
  }, 'final text');
  assert.strictEqual(direct, 'final text');
  assert.ok(deltas.includes('final text'));

  const replyMessages = helpers.buildDirectReplyMessages({
    request: { question: 'hello', userId: 'u1', routeMeta: {} },
    thread: {},
    memory: {
      assistantOnlyContextBlocks: [
        { id: 'dynamic_few_shot', content: 'few shot example' }
      ]
    }
  }, 'hello', [{ role: 'system', content: 'sys' }]);
  assert.ok(Array.isArray(replyMessages.messages));
  const assistantOnlyIndex = replyMessages.messages.findIndex((item) => item.role === 'assistant');
  const lastUserIndex = replyMessages.messages.map((item) => item.role).lastIndexOf('user');
  assert.ok(assistantOnlyIndex >= 0);
  assert.ok(assistantOnlyIndex < lastUserIndex);
  assert.ok(String(replyMessages.messages[assistantOnlyIndex].content || '').startsWith('[Context for assistant only]'));

  console.log('runtimeStreamingCoordinator.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
