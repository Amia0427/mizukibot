const assert = require('assert');

const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');
const {
  buildAdminPrivateMainReplyStreamTimeoutReply,
  createAdminPrivateMainReplyStreamFirstTokenTimeoutError
} = require('../utils/adminPrivateMainReplyStreamTimeout');

module.exports = (async () => {
  let nonStreamFallbackCalls = 0;
  const events = [];
  const timeoutReply = buildAdminPrivateMainReplyStreamTimeoutReply(45000);

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
    mirrorStreamingFlags(_output, text) {
      return { hadOutput: Boolean(String(text || '').trim()) };
    },
    isPureToolCallMarkup() {
      return false;
    },
    async streamDirectReply() {
      throw createAdminPrivateMainReplyStreamFirstTokenTimeoutError(45000);
    },
    async requestReplyImpl() {
      nonStreamFallbackCalls += 1;
      return 'non-stream fallback';
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

  const result = await directReplyNode({
    request: {
      question: 'hello',
      userId: 'admin_1',
      routePolicyKey: 'direct_chat/default',
      routeMeta: { chatType: 'private', userId: 'admin_1' },
      topRouteType: 'direct_chat',
      customPrompt: '',
      allowTools: true,
      allowedTools: [],
      modelConfig: {},
      imageUrl: '',
      streaming: true,
      reviewMode: ''
    },
    execution: { mode: 'chat', memoryCliTurn: null },
    memory: { dynamicPrompt: '', affinity: null },
    output: { stream: {} },
    plan: {},
    events
  });

  assert.strictEqual(nonStreamFallbackCalls, 0, 'admin private first-token timeout must not start non-stream fallback');
  assert.strictEqual(result.output.finalReply, timeoutReply);
  assert.strictEqual(result.output.displayReply, timeoutReply);
  assert.strictEqual(result.output.stream.fallbackToNonStream, false);
  assert.strictEqual(result.output.stream.adminPrivateStreamFirstTokenTimedOut, true);
  assert.ok(result.events.some((event) => event.type === 'admin_private_stream_first_token_timeout'));

  console.log('directReplyAdminPrivateStreamTimeout.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
