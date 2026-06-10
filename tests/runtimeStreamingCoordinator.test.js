const assert = require('assert');

const { createStreamingCoordinatorHelpers } = require('../api/runtimeV2/runtime/streamingCoordinator');
const {
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY,
  createNormalUserMainReplyStreamFirstTokenTimeoutError
} = require('../utils/normalUserMainReplyStreamTimeout');

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

  const objectReplyHelpers = createStreamingCoordinatorHelpers({
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
    requestStreamingReplyImpl: async () => ({
      visibleText: 'visible object reply',
      persistedText: 'persisted object reply'
    }),
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
  const objectStreamed = await objectReplyHelpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: { routePolicyKey: 'direct_chat/default', modelConfig: {}, onDelta(text) { deltas.push(text); } },
    memory: {},
    output: {}
  });
  assert.strictEqual(objectStreamed.finalReply, 'persisted object reply');

  const normalUserTimeoutDeltas = [];
  const normalUserTimeoutEvents = [];
  let normalUserTimeoutFallbackCalls = 0;
  const normalUserTimeoutHelpers = createStreamingCoordinatorHelpers({
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
    requestStreamingReplyImpl: async () => {
      throw createNormalUserMainReplyStreamFirstTokenTimeoutError(35);
    },
    finalizeStreamingReplyWithHumanizerImpl: async (text) => text,
    isHumanizerEnabledImpl: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    requestReplyImpl: async () => {
      normalUserTimeoutFallbackCalls += 1;
      return 'non-stream fallback';
    },
    markStreamCompleted: () => ({ completed: true }),
    resolveToolLoopReply: async () => ({ text: 'resolved', source: 'fallback' }),
    createEvent: (type, payload) => ({ type, ...payload }),
    config: { AI_MAX_TOKENS: 3500 },
    chatHistory: {},
    shortTermMemory: {}
  });
  const normalUserTimeoutStreamed = await normalUserTimeoutHelpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: {
      routePolicyKey: 'direct_chat/default',
      modelConfig: {},
      onDelta(text, fullText) {
        normalUserTimeoutDeltas.push({ text, fullText });
      },
      onEvent(event) {
        normalUserTimeoutEvents.push(event);
      }
    },
    memory: {},
    output: {}
  });
  assert.strictEqual(normalUserTimeoutStreamed.finalReply, NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY);
  assert.strictEqual(normalUserTimeoutStreamed.visibleText, NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY);
  assert.strictEqual(normalUserTimeoutStreamed.persistedText, NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY);
  assert.strictEqual(normalUserTimeoutStreamed.normalUserStreamFirstTokenTimedOut, true);
  assert.strictEqual(normalUserTimeoutStreamed.stream.normalUserStreamFirstTokenTimedOut, true);
  assert.strictEqual(normalUserTimeoutStreamed.stream.fallbackToNonStream, false);
  assert.strictEqual(normalUserTimeoutFallbackCalls, 0);
  assert.deepStrictEqual(normalUserTimeoutDeltas, [{
    text: NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY,
    fullText: NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY
  }]);
  assert.ok(normalUserTimeoutEvents.some((event) => event.type === 'normal_user_stream_first_token_timeout'));

  const privateDeltas = [];
  const privateGuardHelpers = createStreamingCoordinatorHelpers({
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
    requestStreamingReplyImpl: async (_messages, options) => {
      if (typeof options.onDelta === 'function') {
        options.onDelta('buffered private reply', 'buffered private reply');
      }
      return 'buffered private reply';
    },
    finalizeStreamingReplyWithHumanizerImpl: async (text) => text,
    isHumanizerEnabledImpl: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    requestReplyImpl: async () => 'fallback answer',
    markStreamCompleted: () => ({ completed: true }),
    resolveToolLoopReply: async () => ({ text: 'resolved', source: 'fallback' }),
    createEvent: (type, payload) => ({ type, ...payload }),
    config: { AI_MAX_TOKENS: 3500 },
    chatHistory: {},
    shortTermMemory: {}
  });
  const privateGuarded = await privateGuardHelpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: {
      routePolicyKey: 'direct_chat/default',
      routeMeta: { chatType: 'private' },
      modelConfig: {},
      onDelta(text) { privateDeltas.push(text); }
    },
    memory: {},
    output: {}
  });
  assert.strictEqual(privateGuarded.finalReply, 'buffered private reply');
  assert.deepStrictEqual(privateDeltas, ['buffered private reply']);

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

  let visionCanonicalInput = null;
  const visionLiteHelpers = createStreamingCoordinatorHelpers({
    sanitizeUserFacingText: (text) => String(text || ''),
    isChatLikeRoute: () => true,
    buildVisionMessageContent: (text) => text,
    buildV2CanonicalSegments: (_state, input) => {
      visionCanonicalInput = input;
      return {
        segments: {
          system_prompt: input.systemPromptMessages || [],
          short_term_summary: input.shortTermSummaryMessages || [],
          recent_history: input.recentHistoryMessages || [],
          retrieved_memory: input.disableMemoryContextSegments ? [] : [{ role: 'system', content: '[RetrievedMemory] should not appear' }],
          current_user_turn: input.userTurnMessages || []
        },
        compactionPlan: {
          compactedSegments: [
            { name: 'system_prompt', messages: input.systemPromptMessages || [] },
            { name: 'current_user_turn', messages: input.userTurnMessages || [] }
          ]
        }
      };
    },
    buildShortTermContextMessages: () => ({
      sessionSummaryMessages: [{ role: 'system', content: '[Summary] should drop' }],
      summaryMessage: { role: 'system', content: '[Summary] should also drop' },
      recentHistory: [{ role: 'user', content: 'recent raw should drop' }]
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
    config: {
      AI_MAX_TOKENS: 3500,
      IMAGE_MODEL_INPUT_TOKEN_HARD_LIMIT: 20000,
      VISION_ROUTE_SYSTEM_CONTEXT_MAX_TOKENS: 10000
    },
    chatHistory: {},
    shortTermMemory: {}
  });
  const visionReplyMessages = visionLiteHelpers.buildDirectReplyMessages({
    request: {
      routePolicyKey: 'transform/vision-summary',
      routeMeta: { chatMode: 'image_summary' },
      userId: 'u1',
      imageUrl: 'https://example.com/a.png',
      modelConfig: { maxTokens: 512 }
    },
    thread: {},
    memory: {
      assistantOnlyContextBlocks: [{ id: 'dynamic_few_shot', content: 'assistant-only should drop' }],
      context: {
        segments: {
          retrievedMemory: [{ role: 'system', content: '[RetrievedMemory] should drop' }]
        }
      }
    }
  }, [{ type: 'text', text: '用户原文：总结图片' }], [
    { role: 'system', content: 'stable system prompt' },
    { role: 'system', content: '[Summary]\nraw quote should drop' },
    { role: 'system', content: '[GlobalToolEvidence]\nshould drop' }
  ]);
  const visionText = JSON.stringify(visionReplyMessages.messages);
  assert.strictEqual(visionReplyMessages.contextBudgetMode, 'vision_lite');
  assert.strictEqual(visionReplyMessages.disableMemoryContextSegments, true);
  assert.strictEqual(visionCanonicalInput.disableMemoryContextSegments, true);
  assert.deepStrictEqual(visionCanonicalInput.shortTermSummaryMessages, []);
  assert.deepStrictEqual(visionCanonicalInput.recentHistoryMessages, []);
  assert.deepStrictEqual(visionCanonicalInput.assistantOnlyContextMessages, []);
  assert.ok(visionText.includes('stable system prompt'));
  assert.ok(visionText.includes('总结图片'));
  assert.ok(!visionText.includes('raw quote should drop'));
  assert.ok(!visionText.includes('RetrievedMemory'));
  assert.ok(!visionText.includes('assistant-only should drop'));

  const humanizerDeltas = [];
  const humanizerHelpers = createStreamingCoordinatorHelpers({
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
    requestStreamingReplyImpl: async (_messages, options) => {
      if (typeof options.onDelta === 'function') {
        options.onDelta('raw leaked', 'raw leaked');
      }
      return {
        visibleText: 'raw visible reply',
        persistedText: 'raw persisted reply'
      };
    },
    finalizeStreamingReplyWithHumanizerImpl: async () => {
      const error = new Error('humanizer stalled');
      error.code = 'HUMANIZER_FIRST_TOKEN_TIMEOUT';
      error.reason = 'humanizer_first_token_timeout';
      error.humanizerFirstTokenTimeout = true;
      throw error;
    },
    isHumanizerEnabledImpl: () => true,
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
  const humanizerStreamed = await humanizerHelpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: {
      routePolicyKey: 'direct_chat/default',
      modelConfig: {},
      onDelta(text, fullText) {
        humanizerDeltas.push({ text, fullText });
      }
    },
    memory: {},
    output: { stream: { hadOutput: false } }
  });
  assert.strictEqual(humanizerStreamed.finalReply, 'raw persisted reply');
  assert.strictEqual(humanizerStreamed.humanizerTimedOut, true);
  assert.strictEqual(humanizerStreamed.stream.humanizerTimedOut, true);
  assert.strictEqual(humanizerStreamed.stream.fallbackToNonStream, false);
  assert.deepStrictEqual(humanizerDeltas, [{ text: 'raw persisted reply', fullText: 'raw persisted reply' }]);

  const humanizerErrorDeltas = [];
  const humanizerErrorEvents = [];
  let humanizerErrorInput = '';
  const humanizerErrorHelpers = createStreamingCoordinatorHelpers({
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
    requestStreamingReplyImpl: async () => ({
      visibleText: 'raw visible error reply',
      persistedText: 'raw persisted error reply'
    }),
    finalizeStreamingReplyWithHumanizerImpl: async (text) => {
      humanizerErrorInput = text;
      const error = new Error('Request failed with status code 400');
      error.code = 'ERR_BAD_REQUEST';
      throw error;
    },
    isHumanizerEnabledImpl: () => true,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    requestReplyImpl: async () => 'fallback answer',
    markStreamCompleted: () => ({ completed: true }),
    resolveToolLoopReply: async () => ({ text: 'resolved', source: 'fallback' }),
    createEvent: (type, payload) => ({ type, ...payload }),
    config: { AI_MAX_TOKENS: 3500 },
    chatHistory: {},
    shortTermMemory: {}
  });
  const humanizerErrorStreamed = await humanizerErrorHelpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: {
      routePolicyKey: 'direct_chat/default',
      modelConfig: {},
      onDelta(text, fullText) {
        humanizerErrorDeltas.push({ text, fullText });
      },
      onEvent(event) {
        humanizerErrorEvents.push(event);
      }
    },
    memory: {},
    output: { stream: { hadOutput: false } }
  });
  assert.strictEqual(humanizerErrorInput, 'raw persisted error reply');
  assert.strictEqual(humanizerErrorStreamed.finalReply, 'raw persisted error reply');
  assert.strictEqual(humanizerErrorStreamed.humanizerTimedOut, false);
  assert.strictEqual(humanizerErrorStreamed.humanizerFailed, true);
  assert.strictEqual(humanizerErrorStreamed.stream.humanizerFailed, true);
  assert.strictEqual(humanizerErrorStreamed.stream.fallbackToNonStream, false);
  assert.deepStrictEqual(humanizerErrorDeltas, [{ text: 'raw persisted error reply', fullText: 'raw persisted error reply' }]);
  assert.ok(humanizerErrorEvents.some((event) => event.type === 'humanizer_failed_fallback'));

  const longGroupReply = '最先要记的是役和振听。然后你要理解立直的条件。还有一个坑是副露之后很多门清役会消失。推荐路线是先打雀魂低段，再复盘系统提示，最后再补番种表。';
  const groupTimeoutDeltas = [];
  const groupTimeoutHelpers = createStreamingCoordinatorHelpers({
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
    requestStreamingReplyImpl: async () => ({ persistedText: longGroupReply }),
    finalizeStreamingReplyWithHumanizerImpl: async () => {
      const error = new Error('humanizer stalled');
      error.code = 'HUMANIZER_FIRST_TOKEN_TIMEOUT';
      throw error;
    },
    isHumanizerEnabledImpl: () => true,
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
  const groupTimeoutStreamed = await groupTimeoutHelpers.streamDirectReply([{ role: 'user', content: 'hi' }], {
    request: {
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      routeMeta: { groupId: '1092700300' },
      modelConfig: {},
      onDelta(text, fullText) {
        groupTimeoutDeltas.push({ text, fullText });
      }
    },
    memory: {},
    output: { stream: { hadOutput: false } }
  });
  assert.strictEqual(groupTimeoutStreamed.humanizerTimedOut, true);
  assert.ok(groupTimeoutStreamed.finalReply.length < longGroupReply.length);
  assert.strictEqual(groupTimeoutDeltas.length, 1);
  assert.strictEqual(groupTimeoutDeltas[0].text, groupTimeoutStreamed.finalReply);

  console.log('runtimeStreamingCoordinator.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
