function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    caseName: 'all',
    timeoutMs: 30000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] || '').trim();
    if (item === '--case' && argv[i + 1]) {
      out.caseName = String(argv[i + 1] || '').trim() || 'all';
      i += 1;
      continue;
    }
    if (item.startsWith('--case=')) {
      out.caseName = item.slice('--case='.length).trim() || 'all';
      continue;
    }
    if (item === '--timeout-ms' && argv[i + 1]) {
      out.timeoutMs = Math.max(1000, Number(argv[i + 1]) || out.timeoutMs);
      i += 1;
      continue;
    }
    if (item.startsWith('--timeout-ms=')) {
      out.timeoutMs = Math.max(1000, Number(item.slice('--timeout-ms='.length)) || out.timeoutMs);
    }
  }
  return out;
}

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

function clearRequireCache(relativeIds = []) {
  for (const relativeId of relativeIds) {
    try {
      delete require.cache[require.resolve(relativeId)];
    } catch (_) {}
  }
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

async function withTimeout(label = '', timeoutMs = 30000, fn) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label || 'benchmark'} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function benchDirectReplyNoTool() {
  const { createDirectReplyNode } = require('../api/runtimeV2/nodes/directReply');
  let modelCalls = 0;
  let lastRunModelCalls = 0;
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
      throw new Error('no-tool benchmark should not use assistant probe path');
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
      modelCalls += 1;
      return {
        persistedText: 'bench direct reply',
        visibleText: 'bench direct reply'
      };
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
    const beforeCalls = modelCalls;
    const result = await node({
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
    lastRunModelCalls = modelCalls - beforeCalls;
    return result;
  };

  let coldResult = null;
  const coldStartedAt = Date.now();
  coldResult = await run();
  const cold = Date.now() - coldStartedAt;
  const warm = [];
  let lastWarmResult = coldResult;
  for (let i = 0; i < 12; i += 1) {
    const startedAt = Date.now();
    lastWarmResult = await run();
    warm.push(Date.now() - startedAt);
  }
  return {
    coldMs: cold,
    warm: summarize(warm),
    modelCallsPerRun: lastRunModelCalls,
    totalModelCalls: modelCalls,
    promptCollectMs: Number(lastWarmResult?.execution?.latencyBreakdown?.prepare?.prompt_collect_ms || 0) || 0,
    promptRenderMs: Number(lastWarmResult?.execution?.latencyBreakdown?.prepare?.prompt_render_ms || 0) || 0
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
    return helpers.runToolStep({
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

const BENCH_CASES = {
  direct_chat_no_tool: benchDirectReplyNoTool,
  direct_chat_one_readonly_tool: benchReadonlyTool
};

async function runBenchCase(name, fn, timeoutMs) {
  const startedAt = Date.now();
  try {
    const result = await withTimeout(name, timeoutMs, fn);
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      result
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error || 'benchmark failed')
    };
  }
}

async function main() {
  const args = parseArgs();
  const selectedNames = args.caseName === 'all'
    ? Object.keys(BENCH_CASES)
    : [args.caseName];
  const unknown = selectedNames.filter((name) => !BENCH_CASES[name]);
  if (unknown.length > 0) {
    throw new Error(`Unknown benchmark case: ${unknown.join(', ')}. Available: ${Object.keys(BENCH_CASES).join(', ')}`);
  }

  const results = {
    generatedAt: new Date().toISOString(),
    selectedCase: args.caseName,
    timeoutMs: args.timeoutMs
  };
  for (const name of selectedNames) {
    results[name] = await runBenchCase(name, BENCH_CASES[name], args.timeoutMs);
  }
  const direct = results.direct_chat_no_tool?.result;
  if (direct && direct.modelCallsPerRun !== 1) {
    throw new Error('direct_chat_no_tool benchmark is invalid: expected at least 1 model call');
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
