const assert = require('assert');

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');

module.exports = (async () => {
  let capturedContext = null;

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
      return { messages: [{ role: 'user', content: String(messageContent || '') }] };
    },
    buildLiveMainConversationSnapshot() {
      return null;
    },
    ensureOutputStream(output = {}, mode = 'direct') {
      return { ...(output.stream || {}), mode, hadOutput: false, completed: false };
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
      throw new Error('tool loop should not run');
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
      throw new Error('stream path should not run');
    },
    async requestReplyImpl(_messages, context) {
      capturedContext = context;
      return 'ok';
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

  await directReplyNode({
    request: {
      question: 'hello',
      userId: '1960901788',
      routePolicyKey: 'direct_chat/default',
      routeMeta: { chatType: 'group', groupId: '1083095371' },
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: true,
      allowedTools: [],
      modelConfig: {},
      imageUrl: '',
      streaming: false,
      reviewMode: ''
    },
    execution: { mode: 'chat', memoryCliTurn: null },
    memory: { dynamicPrompt: '', affinity: null },
    output: { stream: {} },
    plan: {}
  });

  assert.ok(capturedContext, 'expected requestReplyImpl context to be captured');
  assert.strictEqual(capturedContext.userId, '1960901788');
  assert.strictEqual(capturedContext.routeMeta.groupId, '1083095371');

  console.log('directReplyUserIdPropagation.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
