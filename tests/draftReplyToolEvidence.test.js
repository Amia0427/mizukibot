const assert = require('assert');

const { createDraftReplyNode } = require('../api/runtimeV2/nodes/draftReply');

function createBaseState() {
  return {
    request: {
      question: '总结搜索结果',
      userInfo: {},
      userId: 'u1',
      routeMeta: {},
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      allowTools: true,
      allowedTools: ['web_search'],
      modelConfig: {}
    },
    memory: {
      dynamicPrompt: 'role prompt',
      dirty: false
    },
    plan: {
      finalPlan: {
        goal: 'answer with evidence',
        need_tools: true,
        steps: [{
          id: 'planner_step_1',
          action: 'web_search',
          args: { query: 'OpenAI docs' }
        }]
      },
      finalExecLogs: [{
        id: 'planner_step_1',
        action: 'web_search',
        ok: true,
        result: 'OpenAI Docs: https://platform.openai.com/docs',
        args: { query: 'OpenAI docs' }
      }],
      steps: [{
        id: 'planner_step_1',
        kind: 'tool',
        tool: 'web_search',
        inputs: { query: 'OpenAI docs' },
        status: 'completed',
        evidence: [{
          tool_call_id: 'call_search_1',
          step_id: 'planner_step_1',
          tool_name: 'web_search',
          args_hash: 'hash',
          args: { query: 'OpenAI docs' },
          status: 'completed',
          result: 'OpenAI Docs: https://platform.openai.com/docs',
          retryable: false,
          duration_ms: 12,
          source: 'dispatch'
        }]
      }]
    },
    execution: {
      mode: 'tool_plan',
      toolResults: [{
        tool_call_id: 'call_search_1',
        step_id: 'planner_step_1',
        tool_name: 'web_search',
        args_hash: 'hash',
        args: { query: 'OpenAI docs' },
        status: 'completed',
        result: 'OpenAI Docs: https://platform.openai.com/docs',
        retryable: false,
        duration_ms: 12,
        source: 'dispatch'
      }],
      latencyBreakdown: {}
    },
    output: {}
  };
}

function createNode(overrides = {}) {
  return createDraftReplyNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    buildDynamicPromptImpl: async () => ({ dynamicPrompt: '' }),
    rebuildFinalPlanFromSteps(state) {
      return state.plan.finalPlan;
    },
    buildContinuitySystemMessage() {
      return null;
    },
    isReviewMode() {
      return false;
    },
    getMainConversationSystemMessages() {
      return [{ role: 'system', content: 'system prompt' }];
    },
    buildDirectReplyMessages(_state, messageContent) {
      return {
        messages: [{ role: 'user', content: String(messageContent || '') }]
      };
    },
    buildVisionMessageContent(text) {
      return text;
    },
    normalizeMessageForToolLoop(message) {
      return message;
    },
    compileDirectChatToolCallsToPlan(toolCalls, plan) {
      return { ...plan, steps: toolCalls };
    },
    computeEffectiveAllowedTools() {
      return ['web_search'];
    },
    resolveToolLoopReply: async (message) => ({ text: String(message.content || '') }),
    synthesizeImpl: async () => 'fallback synthesis reply',
    saveAndEmit(state) {
      return state;
    },
    ...overrides
  });
}

module.exports = (async () => {
  let followupMessages = null;
  let followupOptions = null;
  let synthesizeCalls = 0;
  const successNode = createNode({
    async requestAssistantMessageImpl(messages, options) {
      followupMessages = messages;
      followupOptions = options;
      return {
        role: 'assistant',
        content: '这是基于工具结果的最终答复。',
        tool_calls: []
      };
    },
    synthesizeImpl: async () => {
      synthesizeCalls += 1;
      return 'should not synthesize';
    }
  });

  const success = await successNode(createBaseState());

  assert.strictEqual(success.output.draftReply, '这是基于工具结果的最终答复。');
  assert.strictEqual(synthesizeCalls, 0);
  assert.strictEqual(followupOptions.disableTools, true);
  assert.deepStrictEqual(followupOptions.allowedTools, []);
  assert.ok(followupMessages.some((item) => item.role === 'assistant' && Array.isArray(item.tool_calls)));
  assert.ok(followupMessages.some((item) => item.role === 'tool' && item.tool_call_id === 'call_search_1'));
  assert.ok(success.events.some((item) => item.type === 'tool_result_injected'));
  assert.strictEqual(success.execution.latencyBreakdown.model.draft_reply_followup_calls, 1);
  assert.strictEqual(success.execution.latencyBreakdown.model.draft_reply_synthesis_calls, 0);
  assert.strictEqual(success.execution.latencyBreakdown.model.total_model_calls, 1);

  let fallbackSynthesizeArgs = null;
  const fallbackNode = createNode({
    async requestAssistantMessageImpl() {
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'unexpected',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{}'
          }
        }]
      };
    },
    async synthesizeImpl(...args) {
      fallbackSynthesizeArgs = args;
      return 'fallback synthesis reply';
    }
  });

  const fallback = await fallbackNode(createBaseState());

  assert.strictEqual(fallback.output.draftReply, 'fallback synthesis reply');
  assert.ok(fallback.events.some((item) => item.type === 'tool_result_injection_fallback'));
  assert.ok(fallbackSynthesizeArgs);
  assert.match(JSON.stringify(fallbackSynthesizeArgs[3]), /OpenAI Docs/);
  assert.strictEqual(fallback.execution.latencyBreakdown.model.draft_reply_followup_calls, 1);
  assert.strictEqual(fallback.execution.latencyBreakdown.model.draft_reply_synthesis_calls, 1);
  assert.strictEqual(fallback.execution.latencyBreakdown.model.total_model_calls, 2);

  console.log('draftReplyToolEvidence.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
