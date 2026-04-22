const path = require('path');

function percentile(values = [], ratio = 0.5) {
  const list = Array.isArray(values) ? values.slice().sort((a, b) => a - b) : [];
  if (!list.length) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil(list.length * ratio) - 1));
  return list[index];
}

function summarize(values = []) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    samples: values
  };
}

async function timeRun(fn) {
  const startedAt = Date.now();
  await fn();
  return Date.now() - startedAt;
}

async function sample(fn, count = 8) {
  const values = [];
  for (let i = 0; i < count; i += 1) {
    values.push(await timeRun(fn));
  }
  return values;
}

async function benchDirectReplyNoTool() {
  const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');
  let assistantCalls = 0;
  const node = createDirectReplyNode({
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
      assistantCalls += 1;
      return {
        role: 'assistant',
        content: 'bench direct reply',
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
      throw new Error('should not stream in benchmark');
    },
    async requestReplyImpl() {
      throw new Error('should not issue second request in benchmark');
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

  const run = async () => {
    await node({
      request: {
        question: 'bench',
        routePolicyKey: 'direct_chat/default',
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
  };

  const cold = await timeRun(run);
  const warm = await sample(run, 12);
  return {
    coldMs: cold,
    warm: summarize(warm),
    assistantCalls
  };
}

async function benchReadonlyTool() {
  const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');
  let searchCalls = 0;
  const helpers = createToolExecutionHelpers({
    config: {
      READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: true,
      READONLY_TOOL_CACHE_TTL_MS: 1000,
      CONTEXT_STATS_CACHE_TTL_MS: 1000
    },
    stableHash(value) {
      return JSON.stringify(value || {});
    },
    summarizeToolLogValue(value) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    getPolicy() {
      return {};
    },
    enforceToolPolicy(_toolName, args) {
      return args;
    },
    shouldRunParallel() {
      return false;
    },
    capabilityRegistry: {},
    buildLiveMainConversationSnapshot() {
      return null;
    },
    computeEffectiveAllowedTools() {
      return ['web_search'];
    },
    createMemoryCliTurnState(value = {}) {
      return value;
    },
    updateMemoryCliTurnStateAfterError(state = {}) {
      return state;
    },
    updateMemoryCliTurnStateAfterResult(state = {}) {
      return state;
    },
    decideMemoryCliTurnAction(command = '') {
      return {
        ok: true,
        parsed: { commandName: command },
        preparedCommand: command,
        repairApplied: false,
        repairStrategy: []
      };
    },
    safeParseMemoryCliResult() {
      return null;
    },
    captureToolFailure() {},
    isPlannerSingleAuthorityEnabled() {
      return false;
    },
    toolExecutors: {
      web_search: async () => {
        searchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return '1. Example\nhttps://example.com';
      }
    }
  });

  const state = {
    request: {
      question: 'bench readonly tool',
      userId: 'u1',
      sessionKey: 'session-bench',
      routeMeta: {},
      allowedTools: ['web_search']
    },
    execution: {
      memoryCliTurn: {}
    },
    plan: {
      steps: []
    }
  };

  const run = async () => {
    await helpers.runToolStep({
      id: `step_${Date.now()}`,
      tool: 'web_search',
      inputs: { query: 'same' }
    }, state, { node: 'bench' });
  };

  const cold = await timeRun(run);
  const warm = await sample(run, 12);
  return {
    coldMs: cold,
    warm: summarize(warm),
    searchCalls
  };
}

async function benchSubagentSequentialCalls() {
  process.env.API_KEY = process.env.API_KEY || 'bench-key';
  process.env.SUBAGENT_COMMAND = process.execPath;
  process.env.SUBAGENT_WORKDIR = path.join(__dirname, '..');
  process.env.SUBAGENT_ARGS = JSON.stringify([
    path.join(__dirname, '..', 'tests', 'fixtures', 'subagent-cli-stub.js'),
    '--session',
    '{sessionId}',
    '--message',
    '{message}'
  ]);
  process.env.SUBAGENT_COMMAND_MODE = 'persistent';
  process.env.SUBAGENT_WORKER_IDLE_TTL_MS = '1000';
  process.env.SUBAGENT_WORKER_MAX_REUSE = '100';
  process.env.SUBAGENT_TIMEOUT_MS = '2000';

  const backend = require('../api/subagentBackends/commandBackend');
  backend.resetPersistentWorkerState();

  const run = async (text) => {
    const call = backend.createCommandBridgeCall({
      question: text,
      sessionId: 'bench-session',
      options: {}
    });
    await call.promise;
  };

  try {
    const cold = await timeRun(() => run('subagent first'));
    const warm = [];
    for (let i = 0; i < 12; i += 1) {
      warm.push(await timeRun(() => run(`subagent warm ${i}`)));
    }
    const snapshot = backend.getPersistentWorkerSnapshot();
    return {
      coldMs: cold,
      warm: summarize(warm),
      activeWorkers: snapshot.length,
      reuseCount: snapshot[0]?.reuseCount || 0
    };
  } catch (error) {
    return {
      skipped: true,
      reason: String(error?.message || error || 'subagent benchmark failed')
    };
  }
}

async function main() {
  const results = {
    generatedAt: new Date().toISOString(),
    direct_chat_no_tool: await benchDirectReplyNoTool(),
    direct_chat_one_readonly_tool: await benchReadonlyTool(),
    subagent_sequential_calls: await benchSubagentSequentialCalls()
  };
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
