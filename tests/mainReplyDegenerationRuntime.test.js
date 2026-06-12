const assert = require('assert');

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');
const { createStreamingCoordinatorHelpers } = require('../api/runtimeV2/runtime/streamingCoordinator');
const { createFinalValidateNode } = require('../api/runtimeV2/nodes/finalValidate');

const DEGENERATED_REPLY = [
  '我懂你的意思，就是这件事其实有点复杂。',
  '我懂你的意思，就是这件事其实有点复杂。',
  '我懂你的意思，就是这件事其实有点复杂。',
  '我懂你的意思，就是这件事其实有点复杂。'
].join('');
const STREAM_DEGENERATED_REPLY = '喜欢你不是因为某一个标签，而是因为你说话时会认真接住我'.repeat(6);
const REPAIRED_REPLY = '我最喜欢你的地方，是你会把小事认真放在心上，聊天时让人觉得稳定又被接住。';

function baseDirectDeps(extra = {}) {
  return {
    normalizeObject: (value, fallback = {}) => (value && typeof value === 'object' ? value : fallback),
    normalizeArray: (value) => (Array.isArray(value) ? value : []),
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReviewMode: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    computeEffectiveAllowedTools: () => [],
    getToolPlannerExecutionPlan: () => null,
    isPlannerSingleAuthorityEnabled: () => false,
    getRouteToolPlanner: () => null,
    buildVisionMessageContent: (text) => text,
    stripMemoryCliInstruction: (text) => String(text || ''),
    getMainConversationSystemMessages: () => [],
    buildDirectReplyMessages: () => ({ messages: [{ role: 'user', content: '你最喜欢我哪一点？' }] }),
    buildLiveMainConversationSnapshot: () => null,
    ensureOutputStream: (_output, mode = 'direct') => ({ mode, hadOutput: false, completed: false, fallbackToNonStream: false }),
    createMemoryCliTurnState: (value) => value || null,
    cloneDirectToolLoopState: (value) => ({ ...(value || {}) }),
    normalizeMessageForToolLoop: (value) => value,
    requestAssistantMessageImpl: async () => ({ role: 'assistant', content: '' }),
    compileDirectChatToolCallsToPlan: (toolCalls, plan) => ({ ...(plan || {}), steps: toolCalls }),
    saveAndEmit: (state) => state,
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    isPureToolCallMarkup: () => false,
    streamDirectReply: async () => {
      throw new Error('stream path should not run');
    },
    classifyDirectReplyError: () => 'generic_model_failure',
    summarizeDirectReplyError: (error) => String(error?.message || error || ''),
    attemptDirectMemoryRecovery: async () => null,
    getControlledFailureReply: () => 'controlled failure',
    updateMemoryCliTurnStateAfterError: (state) => state,
    classifyReplyFailure: () => ({ type: 'none' }),
    ...extra
  };
}

function baseState() {
  return {
    request: {
      question: '你最喜欢我哪一点？',
      userId: 'u_degeneration',
      routePolicyKey: 'chat/default',
      routeMeta: { chatType: 'private' },
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: false,
      allowedTools: [],
      modelConfig: { model: 'same-model', temperature: 1.05 },
      imageUrl: '',
      streaming: false,
      reviewMode: ''
    },
    execution: { mode: 'chat', memoryCliTurn: null, latencyBreakdown: {} },
    memory: { dynamicPrompt: '', affinity: null },
    output: { stream: {} },
    plan: {}
  };
}

module.exports = (async () => {
  const directCalls = [];
  const directReplyNode = createDirectReplyNode(baseDirectDeps({
    requestReplyImpl: async (messages, context) => {
      directCalls.push({ messages, context });
      return directCalls.length === 1 ? DEGENERATED_REPLY : REPAIRED_REPLY;
    }
  }));
  const directResult = await directReplyNode(baseState());

  assert.strictEqual(directCalls.length, 2);
  assert.strictEqual(directCalls[1].context.triggerBranch, 'direct_reply.degeneration_final_retry');
  assert.ok(directCalls[1].messages.some((message) => String(message.content || '').includes('sampling degeneration')));
  assert.strictEqual(directResult.output.finalReply, REPAIRED_REPLY);
  assert.ok(directResult.events.some((event) => event.type === 'main_reply_degeneration_detected' && event.repairAttempted === true));
  assert.ok(directResult.events.some((event) => event.type === 'main_reply_degeneration_repair' && event.ok === true));

  const streamEvents = [];
  const streamDeltas = [];
  const streamCalls = [];
  const streamingHelpers = createStreamingCoordinatorHelpers({
    sanitizeUserFacingText: (text) => String(text || ''),
    isChatLikeRoute: () => true,
    buildVisionMessageContent: (text) => text,
    buildV2CanonicalSegments: (_state, input) => ({
      segments: {},
      compactionPlan: { compactedSegments: [{ name: 'user', messages: input.userTurnMessages || [] }] }
    }),
    buildShortTermContextMessages: () => ({ sessionSummaryMessages: [], summaryMessage: null, recentHistory: [] }),
    resolveShortTermSessionKey: () => 'session',
    resolveMainConversationModelName: () => 'same-model',
    requestStreamingReplyImpl: async () => STREAM_DEGENERATED_REPLY,
    finalizeStreamingReplyWithHumanizerImpl: async (text) => text,
    isHumanizerEnabledImpl: () => false,
    shouldBypassHumanizerForPolicy: () => false,
    ensureOutputStream: () => ({ hadOutput: false, completed: false, fallbackToNonStream: false, mode: 'none' }),
    mirrorStreamingFlags: (_output, text) => ({ hadOutput: Boolean(text) }),
    requestReplyImpl: async (messages, context) => {
      streamCalls.push({ messages, context });
      return REPAIRED_REPLY;
    },
    markStreamCompleted: () => ({ completed: true }),
    resolveToolLoopReply: async () => ({ text: 'resolved', source: 'fallback' }),
    config: { AI_MAX_TOKENS: 3500 },
    chatHistory: {},
    shortTermMemory: {},
    createEvent: (type, payload = {}) => ({ type, ...payload })
  });
  const streamed = await streamingHelpers.streamDirectReply([{ role: 'user', content: '你最喜欢我哪一点？' }], {
    request: {
      streaming: true,
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private' },
      modelConfig: { model: 'same-model', temperature: 1.05 },
      onDelta(text) {
        streamDeltas.push(text);
      },
      onEvent(event) {
        streamEvents.push(event);
      }
    },
    memory: {},
    output: {}
  });
  assert.strictEqual(streamCalls.length, 1);
  assert.strictEqual(streamCalls[0].context.triggerBranch, 'direct_reply.streaming_final_degeneration_retry');
  assert.strictEqual(streamed.finalReply, REPAIRED_REPLY);
  assert.strictEqual(streamDeltas[0], REPAIRED_REPLY);
  assert.ok(streamed.stream.degenerationRepaired);
  assert.ok(streamEvents.some((event) => event.type === 'main_reply_degeneration_detected'));
  assert.ok(streamEvents.some((event) => event.type === 'main_reply_degeneration_repair' && event.ok === true));

  const finalValidateNode = createFinalValidateNode({
    createEvent: (type, payload = {}) => ({ type, ...payload }),
    isReplyFailure: () => false,
    classifyReplyFailure: () => ({ type: 'none' }),
    protectFinalOutput: (text) => ({ text, blocked: false, reason: '', matches: [] }),
    saveAndEmit: (state) => state
  });
  const finalValidated = await finalValidateNode({
    request: {
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private' }
    },
    output: {
      finalReply: '先说结论。你适合先从立直和振听开始。你适合先从立直和振听开始。你适合先从立直和振听开始。',
      displayReply: '先说结论。你适合先从立直和振听开始。你适合先从立直和振听开始。你适合先从立直和振听开始。'
    },
    memory: {},
    execution: {}
  });
  assert.strictEqual(finalValidated.output.finalReply, '先说结论。你适合先从立直和振听开始。');
  assert.ok(finalValidated.events.some((event) => (
    event.type === 'main_reply_degeneration_detected'
      && event.node === 'final_validate'
      && event.tailTrimmed === true
  )));

  console.log('mainReplyDegenerationRuntime.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
