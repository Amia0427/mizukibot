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

  let unsafeFallbackCalls = 0;
  const unsafeDirectReplyNode = createDirectReplyNode({
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
      return {
        role: 'assistant',
        content: 'I\'ll search for "[Context for assistant only] [ContinuityState] [ActiveTopic] 喂猪50一天去不去"',
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
      throw new Error('unsafe assistant text should retry non-stream instead of streaming');
    },
    async requestReplyImpl(_messages, context = {}) {
      unsafeFallbackCalls += 1;
      assert.strictEqual(context.triggerBranch, 'direct_reply.unsafe_tool_probe_retry');
      return '你这话听着就不像正经打工，50一天还没监控，多少有点可疑。';
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

  const unsafeResult = await unsafeDirectReplyNode({
    request: {
      question: '喂猪50一天去不去',
      routePolicyKey: 'chat/default',
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
  assert.strictEqual(unsafeFallbackCalls, 1);
  assert.strictEqual(unsafeResult.execution.firstAssistantReused, false);
  assert.strictEqual(unsafeResult.output.finalReply, '你这话听着就不像正经打工，50一天还没监控，多少有点可疑。');
  assert.ok((unsafeResult.events || []).some((item) => item.type === 'unsafe_reply_blocked'));

  const directReplyObjectContentNode = createDirectReplyNode({
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
      return {
        role: 'assistant',
        content: [{ type: 'text', text: '对象内容也应该被正确复用。' }],
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
      throw new Error('stream path should not be used for reusable assistant object content');
    },
    async requestReplyImpl() {
      throw new Error('fallback should not run for reusable assistant object content');
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

  const objectContentResult = await directReplyObjectContentNode({
    request: {
      question: '对象内容测试',
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
  assert.strictEqual(objectContentResult.output.finalReply, '对象内容也应该被正确复用。');

  const safetyRestrictionNode = createDirectReplyNode({
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
      return value || {};
    },
    cloneDirectToolLoopState(value) {
      return { ...(value || {}) };
    },
    normalizeMessageForToolLoop(message) {
      return message;
    },
    async requestAssistantMessageImpl() {
      throw new Error('tool probe should not run without allowed tools');
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
      throw new Error('non-stream safety marker test should not stream');
    },
    async requestReplyImpl() {
      return {
        persistedText: '这个话题我们先换一个吧',
        visibleText: '这个话题我们先换一个吧',
        hasSafetyRestriction: true
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

  const safetyRestrictionResult = await safetyRestrictionNode({
    request: {
      question: '隐私问题',
      routePolicyKey: 'chat/default',
      routeMeta: {},
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: false,
      allowedTools: [],
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
  assert.strictEqual(safetyRestrictionResult.output.finalReply, '这个话题我们先换一个吧');
  assert.strictEqual(safetyRestrictionResult.output.hasSafetyRestriction, true);

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
      return '刚刚那句没组织稳。你再发一次，我继续接。';
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
    '刚刚那句没组织稳。你再发一次，我继续接。'
  );

  console.log('runtimeV2DirectReplyFailureTelemetry.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
