const assert = require('assert');

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');

module.exports = (async () => {
  let requestAssistantCalls = 0;
  let requestReplyCalls = 0;
  const directReplyReuseNode = createDirectReplyNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    isReviewMode() {
      return false;
    },
    shouldBypassHumanizerForPolicy() {
      return false;
    },
    computeEffectiveAllowedTools() {
      return ['memory_cli'];
    },
    getToolPlannerExecutionPlan() {
      return null;
    },
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    getRouteToolPlanner() {
      return null;
    },
    buildVisionMessageContent(text) {
      return text;
    },
    stripMemoryCliInstruction(text) {
      return String(text || '');
    },
    getMainConversationSystemMessages() {
      return [];
    },
    buildDirectReplyMessages(_state, messageContent) {
      return {
        messages: [{ role: 'user', content: String(messageContent || '') }]
      };
    },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    ensureOutputStream(output = {}, mode = 'direct') {
      return {
        ...(output.stream || {}),
        mode,
        hadOutput: false,
        completed: false,
        fallbackToNonStream: false
      };
    },
    createMemoryCliTurnState(value) {
      return value || {};
    },
    cloneDirectToolLoopState(value) {
      return { ...(value || {}) };
    },
    normalizeMessageForToolLoop(message) {
      return message;
    },
    async requestAssistantMessageImpl() {
      requestAssistantCalls += 1;
      return {
        role: 'assistant',
        content: '这是直接复用的首条回复。',
        tool_calls: []
      };
    },
    compileDirectChatToolCallsToPlan(toolCalls, plan) {
      return { ...(plan || {}), steps: toolCalls };
    },
    saveAndEmit(state) {
      return state;
    },
    mirrorStreamingFlags() {
      return {};
    },
    isPureToolCallMarkup() {
      return false;
    },
    async streamDirectReply() {
      throw new Error('stream path should not be used when first assistant is reusable');
    },
    async requestReplyImpl() {
      requestReplyCalls += 1;
      return 'fallback should not run';
    },
    buildReplyTextVariants(text = '') {
      return {
        visibleText: String(text || '').trim(),
        persistedText: String(text || '').trim()
      };
    },
    classifyDirectReplyError() {
      return 'generic_model_failure';
    },
    summarizeDirectReplyError(error) {
      return String(error?.message || error || '');
    },
    async attemptDirectMemoryRecovery() {
      return null;
    },
    getControlledFailureReply() {
      return 'controlled failure';
    },
    updateMemoryCliTurnStateAfterError(state = {}) {
      return state;
    },
    classifyReplyFailure() {
      return { type: 'none' };
    }
  });

  const reuseResult = await directReplyReuseNode({
    request: {
      question: '你好吗',
      routePolicyKey: 'direct_chat/default',
      routeMeta: {},
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: true,
      allowedTools: ['memory_cli'],
      modelConfig: {},
      imageUrl: '',
      streaming: false,
      reviewMode: ''
    },
    execution: {
      mode: 'chat',
      memoryCliTurn: null,
      latencyBreakdown: {}
    },
    memory: {
      dynamicPrompt: '',
      affinity: null
    },
    output: {
      stream: {}
    },
    plan: {}
  });

  assert.strictEqual(requestAssistantCalls, 1);
  assert.strictEqual(requestReplyCalls, 0, 'stable first assistant should be reused without a second model request');
  assert.strictEqual(reuseResult.output.finalReply, '这是直接复用的首条回复。');
  assert.strictEqual(reuseResult.execution.firstAssistantReused, true);
  assert.ok((reuseResult.events || []).some((item) => item.type === 'first_assistant_reused'));

  const directReplyNode = createDirectReplyNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    isReviewMode() {
      return false;
    },
    shouldBypassHumanizerForPolicy() {
      return false;
    },
    computeEffectiveAllowedTools() {
      return [];
    },
    getToolPlannerExecutionPlan() {
      return null;
    },
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    getRouteToolPlanner() {
      return null;
    },
    buildVisionMessageContent(text) {
      return text;
    },
    stripMemoryCliInstruction(text) {
      return String(text || '');
    },
    getMainConversationSystemMessages() {
      return [];
    },
    buildDirectReplyMessages(_state, messageContent) {
      return {
        messages: [{ role: 'user', content: String(messageContent || '') }]
      };
    },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    ensureOutputStream(output = {}, mode = 'direct') {
      return {
        ...(output.stream || {}),
        mode,
        hadOutput: false,
        completed: false,
        fallbackToNonStream: false
      };
    },
    createMemoryCliTurnState(value) {
      return value || {
        searchCount: 0,
        openCount: 0,
        successfulCount: 0,
        mustAnswer: false,
        lastSuccessCommand: '',
        lastResultHadHits: false,
        lastErrorType: 'none'
      };
    },
    cloneDirectToolLoopState(value) {
      return { ...(value || {}) };
    },
    normalizeMessageForToolLoop(message) {
      return message;
    },
    async requestAssistantMessageImpl() {
      throw new Error('upstream timeout while requesting direct reply');
    },
    compileDirectChatToolCallsToPlan(toolCalls, plan) {
      return { ...(plan || {}), steps: toolCalls };
    },
    saveAndEmit(state) {
      return state;
    },
    mirrorStreamingFlags() {
      return {};
    },
    isPureToolCallMarkup() {
      return false;
    },
    async streamDirectReply() {
      return {
        finalReply: '',
        stream: {
          hadOutput: false,
          completed: false,
          fallbackToNonStream: true,
          mode: 'direct'
        }
      };
    },
    async requestReplyImpl() {
      throw new Error('upstream timeout while requesting direct reply');
    },
    classifyDirectReplyError(error) {
      const text = String(error?.message || error || '').toLowerCase();
      return text.includes('timeout') ? 'generic_model_failure' : 'tool_error';
    },
    summarizeDirectReplyError(error) {
      return String(error?.message || error || '');
    },
    async attemptDirectMemoryRecovery() {
      return null;
    },
    getControlledFailureReply() {
      return '我刚才没有稳定组织出回复。你可以直接再说一次，或者把需求说得更具体一点。';
    },
    updateMemoryCliTurnStateAfterError(state = {}, failureType = 'tool_error') {
      return {
        ...state,
        lastErrorType: failureType
      };
    },
    classifyReplyFailure() {
      return { type: 'none' };
    }
  });

  const result = await directReplyNode({
    request: {
      question: '你怎么啦',
      routePolicyKey: 'chat/default',
      routeMeta: {},
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: true,
      allowedTools: [],
      modelConfig: {},
      imageUrl: '',
      streaming: false,
      reviewMode: ''
    },
    execution: {
      mode: 'chat',
      memoryCliTurn: null
    },
    memory: {
      dynamicPrompt: '',
      affinity: null
    },
    output: {
      stream: {}
    },
    plan: {}
  });

  const failureEvent = (result.events || []).find((item) => item.type === 'direct_reply_failure');
  assert.ok(failureEvent, 'expected direct_reply_failure telemetry event');
  assert.strictEqual(failureEvent.failureType, 'generic_model_failure');
  assert.strictEqual(failureEvent.fallbackSource, 'controlled_failure');
  assert.ok(String(failureEvent.rawErrorMessage || '').includes('upstream timeout'));

  const finalOutput = (result.events || []).find((item) => item.type === 'final_output');
  assert.ok(finalOutput, 'expected final_output event');
  assert.strictEqual(
    finalOutput.text,
    '我刚才没有稳定组织出回复。你可以直接再说一次，或者把需求说得更具体一点。'
  );

  console.log('runtimeV2DirectReplyFailureTelemetry.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
