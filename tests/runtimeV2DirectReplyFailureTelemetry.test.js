const assert = require('assert');

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');

module.exports = (async () => {
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
