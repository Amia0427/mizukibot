const config = require('../../../config');
const { getPolicy } = require('../../../utils/toolPolicy');
const {
  createMemoryCliTurnState,
  decideMemoryCliTurnAction,
  safeParseMemoryCliResult,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
} = require('../../../utils/memoryCliTurnPolicy');
const { buildCapabilityRegistry } = require('./registry');
const { maybeRunGlobalToolRuntime } = require('../globalToolRuntimeFacade');
const {
  normalizeArray,
  normalizeExecutionEnvelope,
  normalizeObject,
  normalizeText
} = require('../contracts');

function resolveCapability(descriptorRegistry, toolName = '') {
  const name = normalizeText(toolName);
  if (!name) return null;
  return descriptorRegistry.byName.get(name) || null;
}

function isWriteLikeCapability(capability = '') {
  return /write/i.test(String(capability || ''));
}

function isSideEffectCapability(descriptor = null) {
  if (!descriptor) return false;
  if (descriptor.sideEffect) return true;
  if (String(descriptor.risk || '').trim().toLowerCase() === 'high') return true;
  const policy = getPolicy(descriptor.name);
  return isWriteLikeCapability(policy.capability) || String(policy.risk || '').trim().toLowerCase() === 'high';
}

function isParallelSafeCapability(descriptor = null) {
  if (!descriptor) return false;
  if (descriptor.parallelSafe === false) return false;
  if (isSideEffectCapability(descriptor)) return false;
  if (descriptor.kind === 'mcp' || descriptor.kind === 'subagent') return false;
  if (descriptor.name === 'web_fetch') return false;
  return true;
}

function filterAllowedCapabilityNames(allowedTools = [], options = {}) {
  const names = normalizeArray(allowedTools)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (options.disableTools) return [];
  return names;
}

function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) return fallback;
  return num;
}

function normalizeNonNegativeInt(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) return fallback;
  return num;
}

function normalizeStepId(step = {}, index = 0) {
  return normalizeText(step?.id || step?.step_id || `step_${index}`);
}

function normalizeDependencyIds(step = {}) {
  return normalizeArray(step.dependsOn || step.depends_on || step.dependencies)
    .map((item) => normalizeText(typeof item === 'string' ? item : item?.id || item?.step_id))
    .filter(Boolean);
}

function resolveCapabilityResource(descriptor = null, step = {}) {
  const explicit = normalizeText(
    step.resourceKey
    || step.resource_key
    || descriptor?.resourceKey
    || descriptor?.resource_key
    || descriptor?.metadata?.resourceKey
    || descriptor?.metadata?.resource_key
  );
  if (explicit) return explicit;
  return normalizeText(step.tool || descriptor?.name || 'unknown');
}

function isCacheableCapability(descriptor = null, step = {}) {
  if (!descriptor) return false;
  if (!isParallelSafeCapability(descriptor)) return false;
  if (step.cacheable === false || step.noCache === true || step.no_cache === true) return false;
  if (descriptor.cacheable === false || descriptor.metadata?.cacheable === false) return false;
  return true;
}

function buildToolCacheKey(step = {}, descriptor = null) {
  return stableHash({
    tool: normalizeText(step.tool || descriptor?.name),
    inputs: normalizeObject(step.inputs, {})
  });
}

function createCacheStore(context = {}) {
  const ttlMs = normalizeNonNegativeInt(
    context.toolResultCacheTtlMs ?? config.AGENT_TOOL_RESULT_CACHE_TTL_MS,
    0
  );
  if (ttlMs <= 0) return null;
  const store = context.toolResultCache instanceof Map ? context.toolResultCache : null;
  return store ? { store, ttlMs } : null;
}

function getCachedEnvelope(cache, key = '') {
  if (!cache || !key) return null;
  const hit = cache.store.get(key);
  if (!hit) return null;
  if (Date.now() - Number(hit.createdAt || 0) > cache.ttlMs) {
    cache.store.delete(key);
    return null;
  }
  return { ...hit.envelope, cached: true };
}

function setCachedEnvelope(cache, key = '', envelope = null) {
  if (!cache || !key || !envelope) return;
  if (String(envelope.status || '').trim() !== 'completed') return;
  cache.store.set(key, {
    createdAt: Date.now(),
    envelope: { ...envelope }
  });
}

function hasCompletedDependency(stepId = '', completedIds = new Set()) {
  return stepId && completedIds.has(stepId);
}

function buildExecutionBatches(steps = [], descriptorRegistry = null) {
  const registry = descriptorRegistry || buildCapabilityRegistry();
  if (config.AGENT_DEPENDENCY_AWARE_BATCHING === false) {
    const batches = [];
    let currentParallelBatch = [];

    for (const step of normalizeArray(steps)) {
      const descriptor = resolveCapability(registry, step?.tool);
      if (!descriptor || !isParallelSafeCapability(descriptor)) {
        if (currentParallelBatch.length > 0) {
          batches.push({
            mode: currentParallelBatch.length > 1 ? 'parallel' : 'serial',
            items: currentParallelBatch
          });
          currentParallelBatch = [];
        }
        batches.push({
          mode: 'serial',
          items: [step]
        });
        continue;
      }
      currentParallelBatch.push(step);
    }

    if (currentParallelBatch.length > 0) {
      batches.push({
        mode: currentParallelBatch.length > 1 ? 'parallel' : 'serial',
        items: currentParallelBatch
      });
    }

    return batches;
  }

  const normalizedSteps = normalizeArray(steps).map((step, index) => ({
    ...step,
    __batchIndex: index,
    __stepId: normalizeStepId(step, index)
  }));
  const batches = [];
  const completedIds = new Set();
  const pending = normalizedSteps.slice();

  while (pending.length > 0) {
    const ready = [];
    for (const step of pending) {
      const deps = normalizeDependencyIds(step);
      if (deps.every((dep) => hasCompletedDependency(dep, completedIds))) {
        ready.push(step);
      }
    }

    const candidates = ready.length > 0 ? ready : [pending[0]];
    const firstSerialIndex = candidates.findIndex((step) => {
      const descriptor = resolveCapability(registry, step?.tool);
      return !descriptor || !isParallelSafeCapability(descriptor);
    });

    if (firstSerialIndex === 0) {
      const serialStep = candidates[0];
      batches.push({ mode: 'serial', items: [serialStep] });
      pending.splice(pending.indexOf(serialStep), 1);
      completedIds.add(serialStep.__stepId);
      continue;
    }

    const resources = new Set();
    const parallelItems = [];
    const parallelCandidates = firstSerialIndex > 0 ? candidates.slice(0, firstSerialIndex) : candidates;
    for (const step of parallelCandidates) {
      const descriptor = resolveCapability(registry, step?.tool);
      const resource = resolveCapabilityResource(descriptor, step);
      if (resources.has(resource)) continue;
      resources.add(resource);
      parallelItems.push(step);
    }

    const items = parallelItems.length > 0 ? parallelItems : [candidates[0]];
    batches.push({
      mode: items.length > 1 ? 'parallel' : 'serial',
      items
    });
    for (const item of items) {
      pending.splice(pending.indexOf(item), 1);
      completedIds.add(item.__stepId);
    }
  }

  return batches.map((batch) => ({
    ...batch,
    items: normalizeArray(batch.items).map(({ __batchIndex, __stepId, ...step }) => step)
  }));
}

async function runCapabilityPreflight(question = '', context = {}) {
  const policy = normalizeObject(context.policy, {});
  if (!policy.allowGlobalTools) {
    return {
      skipped: true,
      reason: 'policy-disabled',
      results: [],
      evidenceMessage: '',
      memoryCliTurn: createMemoryCliTurnState(context.memoryCliTurn)
    };
  }

  return maybeRunGlobalToolRuntime(question, context);
}

function getCapabilityExecutors(runtimeOptions = {}) {
  const registry = runtimeOptions.capabilityRegistry || buildCapabilityRegistry();
  const runtimeExecutors = normalizeObject(runtimeOptions.toolExecutors, {});
  const executors = {};
  for (const descriptor of registry.descriptors) {
    if (!descriptor.name) continue;
    executors[descriptor.name] = runtimeExecutors[descriptor.name] || descriptor.executor || null;
  }
  return {
    registry,
    executors
  };
}

function stableHash(value) {
  return JSON.stringify(value || {});
}

function isToolFailureText(resultText = '') {
  const text = String(resultText || '').trim();
  if (!text) return true;
  return /^Tool error:/i.test(text)
    || /^Unknown tool:/i.test(text)
    || /^Tool not allowed:/i.test(text)
    || /^页面提取失败[:：]/i.test(text)
    || /^MCP tool failed:/i.test(text)
    || /^request was blocked/i.test(text)
    || /^invalid api key$/i.test(text);
}

function isMemorySearchCommand(commandText = '') {
  return /^mem search\b/i.test(normalizeText(commandText));
}

function isUnresolvedMemoryOpenCommand(commandText = '') {
  const text = normalizeText(commandText);
  if (!/^mem open --ref\s+/i.test(text)) return false;
  return /^mem open --ref\s+\"mc_ref:planner_pending:/i.test(text)
    || /^mem open --ref\s+\"<[^"]+>\"/i.test(text);
}

function computeToolEnvelope(step = {}, rawResult = '', descriptor = null, helpers = {}) {
  const resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
  const args = normalizeObject(step.inputs, {});
  const argsHash = typeof helpers.stableHash === 'function'
    ? String(helpers.stableHash(args) || '').trim()
    : stableHash(args);
  const status = isToolFailureText(resultText) ? 'failed' : 'completed';
  return normalizeExecutionEnvelope({
    tool_call_id: `${normalizeText(step.id)}_${argsHash}_${Date.now()}`,
    step_id: normalizeText(step.id),
    tool_name: normalizeText(step.tool),
    args_hash: argsHash,
    args,
    status,
    result: resultText,
    side_effect: isSideEffectCapability(descriptor),
    retryable: status !== 'completed',
    attempt: Number(step.attempts || 0) + 1,
    batch_id: step.batchId || step.batch_id || '',
    batch_index: step.batchIndex ?? step.batch_index
  }, step);
}

function parseSearchResultRows(resultText = '') {
  const rows = [];
  const text = String(resultText || '').trim();
  if (!text) return rows;
  const blocks = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map((item) => item.trim()).filter(Boolean);
    const urlLine = lines.find((line) => /^https?:\/\//i.test(line));
    if (!urlLine) continue;
    const titleLine = lines.find((line) => /^\d+\.\s+/.test(line)) || '';
    const title = titleLine.replace(/^\d+\.\s+/, '').trim();
    const desc = lines.find((line) => line !== titleLine && line !== urlLine) || '';
    rows.push({ title, url: urlLine, desc });
  }
  return rows;
}

function extractPreferredDomains(question = '') {
  const text = String(question || '').trim();
  const domains = new Set();
  const matches = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/ig) || [];
  for (const item of matches) {
    const domain = String(item || '').trim().toLowerCase();
    if (domain) domains.add(domain);
  }
  return [...domains];
}

function scoreSearchCandidate(row = {}, question = '', preferredDomains = []) {
  const url = String(row?.url || '').trim().toLowerCase();
  const title = String(row?.title || '').trim().toLowerCase();
  const desc = String(row?.desc || '').trim().toLowerCase();
  const text = String(question || '').trim().toLowerCase();
  let score = 0;
  if (preferredDomains.some((domain) => url.includes(domain))) score += 100;
  if (/(官网|官方|official)/i.test(text) && /(official|docs|developer|help|support|api)/i.test(`${url} ${title}`)) score += 30;
  if (/(文档|docs?|documentation|api)/i.test(text) && /(docs|doc|developer|api)/i.test(`${url} ${title}`)) score += 25;
  if (/(latest|最新|news|新闻)/i.test(text) && /(news|blog|release|changelog|announc)/i.test(`${url} ${title} ${desc}`)) score += 10;
  if (/^https?:\/\//i.test(url)) score += 5;
  return score;
}

function resolveWebFetchArgs(step = {}, state = {}) {
  const stepInputs = normalizeObject(step?.inputs, {});
  const existingUrl = String(stepInputs.url || '').trim();
  if (existingUrl) return stepInputs;

  const previousEnvelopes = normalizeArray(state.execution?.toolResults);
  const previousSteps = normalizeArray(state.plan?.steps);
  const webSearchResult = [...previousEnvelopes].reverse().find((item) => normalizeText(item?.tool_name) === 'web_search' && normalizeText(item?.status) === 'completed')
    || previousSteps
      .filter((candidate) => normalizeText(candidate?.tool) === 'web_search')
      .flatMap((candidate) => normalizeArray(candidate?.evidence))
      .reverse()
      .find((item) => normalizeText(item?.status) === 'completed');
  const rows = parseSearchResultRows(webSearchResult?.result || '');
  if (rows.length === 0) {
    throw new Error('web_fetch could not resolve url from previous web_search result');
  }

  const question = String(state.request?.question || '').trim();
  const preferredDomains = extractPreferredDomains(question);
  const ranked = rows
    .map((row, index) => ({ ...row, score: scoreSearchCandidate(row, question, preferredDomains), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0] || null;
  if (!selected?.url) {
    throw new Error('web_fetch could not find a usable url from search results');
  }
  return {
    ...stepInputs,
    url: selected.url
  };
}

function buildToolContext(state, overrides = {}, helpers = {}) {
  const request = normalizeObject(state.request, {});
  const routeMeta = normalizeObject(request.routeMeta, {});
  const toolName = normalizeText(overrides.toolName);
  const preparedSnapshot = state.memory?.mainConversationSnapshot
    && typeof state.memory.mainConversationSnapshot === 'object'
    && Array.isArray(state.memory.mainConversationSnapshot.segments)
    ? state.memory.mainConversationSnapshot
    : null;
  const fallbackMainConversationSnapshot = toolName === 'get_context_stats'
    && typeof helpers.buildLiveMainConversationSnapshot === 'function'
    && typeof helpers.computeEffectiveAllowedTools === 'function'
    ? (preparedSnapshot || helpers.buildLiveMainConversationSnapshot(state, {
        affinity: state.memory?.affinity,
        allowedTools: helpers.computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn),
        source: normalizeText(overrides.snapshotSource || 'tool_context') || 'tool_context'
      }))
    : null;
  return {
    userId: normalizeText(request.userId),
    routePolicyKey: normalizeText(request.routePolicyKey),
    topRouteType: normalizeText(request.topRouteType),
    routeMeta,
    reviewMode: normalizeText(request.reviewMode),
    taskType: normalizeText(routeMeta.taskType || routeMeta.task_type),
    sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id),
    channelId: normalizeText(routeMeta.channelId || routeMeta.channel_id),
    groupId: normalizeText(routeMeta.groupId || routeMeta.group_id),
    mainConversationSnapshot: overrides.mainConversationSnapshot
      && typeof overrides.mainConversationSnapshot === 'object'
      && Array.isArray(overrides.mainConversationSnapshot.segments)
      ? { ...overrides.mainConversationSnapshot }
      : fallbackMainConversationSnapshot
  };
}

function summarizeToolLogValue(value, maxLen = 160) {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function logToolExecution(envelope = {}, step = {}, state = {}, extra = {}) {
  const status = normalizeText(envelope.status).toLowerCase();
  if (status === 'completed' && config.GRAPH_TOOL_SUCCESS_LOG_ENABLED === false) {
    return;
  }
  const request = normalizeObject(state.request, {});
  const routeMeta = normalizeObject(request.routeMeta, {});
  const args = normalizeObject(envelope.args, normalizeObject(step.inputs, {}));
  const sanitizedArgs = { ...args };
  delete sanitizedArgs.__context;
  console.log('[graph-tool]', {
    node: normalizeText(extra.node || state.execution?.currentNode) || 'unknown',
    topRouteType: normalizeText(request.topRouteType || routeMeta.topRouteType),
    routePolicyKey: normalizeText(request.routePolicyKey),
    toolName: normalizeText(envelope.tool_name || step.tool),
    stepId: normalizeText(envelope.step_id || step.id),
    status: normalizeText(envelope.status),
    batchId: normalizeText(envelope.batch_id || step.batchId),
    batchIndex: Number.isFinite(Number(envelope.batch_index))
      ? Number(envelope.batch_index)
      : (Number.isFinite(Number(step.batchIndex)) ? Number(step.batchIndex) : null),
    userId: normalizeText(request.userId),
    groupId: normalizeText(routeMeta.groupId || routeMeta.group_id),
    allowedTools: normalizeArray(extra.allowedTools || request.allowedTools),
    argsPreview: summarizeToolLogValue(sanitizedArgs),
    resultPreview: summarizeToolLogValue(envelope.result),
    blockedReason: normalizeText(envelope.blockedReason),
    retryable: Boolean(envelope.retryable)
  });
}

function maybeCaptureToolFailure(envelope = {}, step = {}, state = {}, helpers = {}) {
  if (!config.SELF_IMPROVEMENT_ENABLED) return;
  const status = normalizeText(envelope?.status).toLowerCase();
  if (status === 'completed') return;
  const blockedReason = normalizeText(envelope?.blockedReason).toLowerCase();
  if (blockedReason.startsWith('runtime_binding_unresolved:')) return;
  if (typeof helpers.captureToolFailure !== 'function') return;
  const request = normalizeObject(state.request, {});
  const routeMeta = normalizeObject(request.routeMeta, {});
  try {
    helpers.captureToolFailure({
      envelope,
      purpose: normalizeText(step?.instruction || step?.successCriteria),
      details: normalizeText(step?.successCriteria),
      routePolicyKey: normalizeText(request.routePolicyKey),
      topRouteType: normalizeText(request.topRouteType || routeMeta.topRouteType),
      toolName: normalizeText(envelope.tool_name || step?.tool || routeMeta.toolName || routeMeta.tool_name),
      taskType: normalizeText(routeMeta.taskType || routeMeta.task_type),
      sessionId: normalizeText(routeMeta.sessionId || routeMeta.session_id),
      channelId: normalizeText(routeMeta.channelId || routeMeta.channel_id),
      groupId: normalizeText(routeMeta.groupId || routeMeta.group_id),
      userId: normalizeText(request.userId),
      evidence: [
        { label: 'tool_result', excerpt: normalizeText(envelope?.result) }
      ]
    });
  } catch (error) {
    console.error('[self-improvement] tool failure capture failed:', error?.message || error);
  }
}

function buildBlockedToolEnvelope(step = {}, executionState = {}, descriptor = null, helpers = {}, reason = 'tool_not_allowed') {
  const toolName = normalizeText(step?.tool);
  const blockedResult = `Tool not allowed: ${toolName || 'unknown'}`;
  let nextMemoryCliTurn = createMemoryCliTurnState(executionState.memoryCliTurn);
  let invalidateMemoryPrompt = false;
  if (toolName === 'memory_cli') {
    nextMemoryCliTurn = createMemoryCliTurnState(
      updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_error')
    );
    invalidateMemoryPrompt = true;
  }
  const baseEnvelope = computeToolEnvelope(step, blockedResult, descriptor, helpers);
  return normalizeExecutionEnvelope({
    ...baseEnvelope,
    ...(normalizeText(step?.directToolCallId || step?.toolCallId)
      ? { tool_call_id: normalizeText(step?.directToolCallId || step?.toolCallId) }
      : {}),
    status: 'blocked',
    retryable: false,
    result: blockedResult,
    ...(toolName === 'memory_cli' ? { memoryCliTurn: nextMemoryCliTurn, invalidateMemoryPrompt } : {}),
    blockedReason: normalizeText(reason) || 'tool_not_allowed'
  }, step);
}

function getPreviousMemorySearchResult(state = {}, currentStepId = '') {
  const currentId = normalizeText(currentStepId);
  const planEvidence = normalizeArray(state.plan?.steps)
    .filter((candidate) => normalizeText(candidate?.id) !== currentId)
    .flatMap((candidate) => normalizeArray(candidate?.evidence));
  const executionEvidence = normalizeArray(state.execution?.toolResults);
  const candidates = [...executionEvidence, ...planEvidence].reverse();
  for (const envelope of candidates) {
    const resultText = normalizeText(envelope?.result);
    if (!resultText) continue;
    const parsed = safeParseMemoryCliResult(resultText);
    if (normalizeText(parsed?.command) !== 'search') continue;
    return resultText;
  }
  return '';
}

function buildUnresolvedMemoryRefEnvelope(step = {}, normalizedArgs = {}, descriptor = null, helpers = {}, executionState = {}) {
  const blockedReason = 'runtime_binding_unresolved:memory_ref';
  const result = `Tool error: ${blockedReason}`;
  return normalizeExecutionEnvelope({
    ...computeToolEnvelope({ ...step, inputs: normalizedArgs }, result, descriptor, helpers),
    status: 'blocked',
    retryable: false,
    result,
    memoryCliTurn: createMemoryCliTurnState(executionState.memoryCliTurn),
    invalidateMemoryPrompt: true,
    blockedReason,
    unsatisfiedRequirement: blockedReason
  }, step);
}

function buildReusedMemorySearchEnvelope(step = {}, normalizedArgs = {}, descriptor = null, helpers = {}, executionState = {}, previousResult = '') {
  return normalizeExecutionEnvelope({
    ...computeToolEnvelope({ ...step, inputs: normalizedArgs }, previousResult, descriptor, helpers),
    memoryCliTurn: createMemoryCliTurnState(executionState.memoryCliTurn),
    invalidateMemoryPrompt: true,
    reusedPreviousResult: true
  }, step);
}

async function executeStep(step = {}, state = {}, context = {}) {
  const descriptorRegistry = context.registry || context.capabilityRegistry || buildCapabilityRegistry();
  const descriptor = resolveCapability(descriptorRegistry, step.tool);
  const helpers = normalizeObject(context.helpers, {});
  const executionState = normalizeObject(state.execution, {});
  const toolName = normalizeText(step.tool);
  const runtimeNode = normalizeText(context.node || state.execution?.currentNode) || 'unknown';
  const allowedTools = normalizeArray(context.allowedTools ?? state.request?.allowedTools)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const executor = normalizeObject(context.executors, {})[toolName] || descriptor?.executor || null;

  if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
    const blockedEnvelope = buildBlockedToolEnvelope(step, executionState, descriptor, helpers, 'tool_not_allowed');
    maybeCaptureToolFailure(blockedEnvelope, step, state, helpers);
    logToolExecution(blockedEnvelope, step, state, {
      node: runtimeNode,
      allowedTools
    });
    return blockedEnvelope;
  }

  if (
    normalizeText(step?.source) === 'direct_chat'
    && normalizeText(step?.blockingReason) === 'tool_not_allowed'
  ) {
    const blockedEnvelope = buildBlockedToolEnvelope(step, executionState, descriptor, helpers, 'tool_not_allowed');
    maybeCaptureToolFailure(blockedEnvelope, step, state, helpers);
    logToolExecution(blockedEnvelope, step, state, {
      node: runtimeNode,
      allowedTools: state.request?.allowedTools
    });
    return blockedEnvelope;
  }

  try {
    let preparedArgs = normalizeObject(step.inputs, {});
    if (toolName === 'web_fetch') {
      preparedArgs = resolveWebFetchArgs({
        ...step,
        inputs: preparedArgs
      }, state);
    }
    const enforceToolPolicy = typeof helpers.enforceToolPolicy === 'function'
      ? helpers.enforceToolPolicy
      : ((_toolName, args) => args);
    let normalizedArgs = enforceToolPolicy(toolName, preparedArgs, {
      userId: state.request?.userId
    });

    if (toolName === 'memory_cli') {
      if (isUnresolvedMemoryOpenCommand(normalizedArgs.command)) {
        const unresolvedEnvelope = buildUnresolvedMemoryRefEnvelope(step, normalizedArgs, descriptor, helpers, executionState);
        logToolExecution(unresolvedEnvelope, { ...step, inputs: normalizedArgs }, state, {
          node: runtimeNode,
          allowedTools: state.request?.allowedTools
        });
        return unresolvedEnvelope;
      }
      if (
        isMemorySearchCommand(normalizedArgs.command)
        && Number(executionState.memoryCliTurn?.searchCount || 0) >= 1
        && normalizeText(executionState.memoryCliTurn?.lastSuccessCommand) === 'search'
        && Boolean(executionState.memoryCliTurn?.lastResultHadHits)
        && !Boolean(executionState.memoryCliTurn?.mustAnswer)
      ) {
        const previousResult = getPreviousMemorySearchResult(state, step.id);
        if (previousResult) {
          const reusedEnvelope = buildReusedMemorySearchEnvelope(step, normalizedArgs, descriptor, helpers, executionState, previousResult);
          logToolExecution(reusedEnvelope, { ...step, inputs: normalizedArgs }, state, {
            node: runtimeNode,
            allowedTools: state.request?.allowedTools
          });
          return reusedEnvelope;
        }
      }
      const decision = decideMemoryCliTurnAction(normalizedArgs.command, executionState.memoryCliTurn);
      if (!decision.ok) {
        const result = typeof decision.result === 'string' ? decision.result : JSON.stringify(decision.result);
        const blockedEnvelope = normalizeExecutionEnvelope({
          ...computeToolEnvelope({
            ...step,
            inputs: { ...normalizedArgs, command: decision.preparedCommand || normalizedArgs.command }
          }, result, descriptor, helpers),
          status: 'blocked',
          retryable: decision.errorType !== 'tool_error',
          result,
          memoryCliTurn: decision.nextState,
          invalidateMemoryPrompt: true,
          repairApplied: Boolean(decision.repairApplied),
          repairStrategy: normalizeArray(decision.repairStrategy),
          blockedReason: normalizeText(decision.reason)
        }, step);
        maybeCaptureToolFailure(blockedEnvelope, { ...step, inputs: normalizedArgs }, state, helpers);
        return blockedEnvelope;
      }

      if (typeof executor !== 'function') {
        const unknownEnvelope = normalizeExecutionEnvelope({
          ...computeToolEnvelope(step, `Unknown tool: ${toolName}`, descriptor, helpers),
          memoryCliTurn: executionState.memoryCliTurn
        }, step);
        maybeCaptureToolFailure(unknownEnvelope, step, state, helpers);
        return unknownEnvelope;
      }

      let out = await executor({
        ...normalizedArgs,
        command: decision.preparedCommand || normalizedArgs.command,
        __context: buildToolContext(state, {
          ...context,
          toolName
        }, helpers)
      });
      if (context.applyResultFormatter === true && typeof descriptor?.resultFormatter === 'function') {
        out = await descriptor.resultFormatter(out, {
          step,
          state,
          args: normalizedArgs
        });
      }
      const resultEnvelope = normalizeExecutionEnvelope({
        ...computeToolEnvelope({
          ...step,
          inputs: {
            ...normalizedArgs,
            command: decision.preparedCommand || normalizedArgs.command
          }
        }, out, descriptor, helpers),
        memoryCliTurn: createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterResult(executionState.memoryCliTurn, decision.parsed, out)
        ),
        invalidateMemoryPrompt: true,
        repairApplied: Boolean(decision.repairApplied),
        repairStrategy: normalizeArray(decision.repairStrategy)
      }, step);
      maybeCaptureToolFailure(resultEnvelope, { ...step, inputs: normalizedArgs }, state, helpers);
      logToolExecution(resultEnvelope, { ...step, inputs: normalizedArgs }, state, {
        node: runtimeNode,
        allowedTools: state.request?.allowedTools
      });
      return resultEnvelope;
    }

    if (typeof executor !== 'function') {
      const unknownEnvelope = computeToolEnvelope(step, `Unknown tool: ${toolName}`, descriptor, helpers);
      maybeCaptureToolFailure(unknownEnvelope, step, state, helpers);
      return unknownEnvelope;
    }

    let out = await executor({
      ...normalizedArgs,
      __context: buildToolContext(state, {
        ...context,
        toolName
      }, helpers)
    });
    if (context.applyResultFormatter === true && typeof descriptor?.resultFormatter === 'function') {
      out = await descriptor.resultFormatter(out, {
        step,
        state,
        args: normalizedArgs
      });
    }
    const envelope = computeToolEnvelope({ ...step, inputs: normalizedArgs }, out, descriptor, helpers);
    maybeCaptureToolFailure(envelope, { ...step, inputs: normalizedArgs }, state, helpers);
    logToolExecution(envelope, { ...step, inputs: normalizedArgs }, state, {
      node: runtimeNode,
      allowedTools: state.request?.allowedTools
    });
    return envelope;
  } catch (error) {
    const errorEnvelope = computeToolEnvelope(step, `Tool error: ${error.message}`, descriptor, helpers);
    maybeCaptureToolFailure(errorEnvelope, step, state, helpers);
    logToolExecution(errorEnvelope, step, state, {
      node: runtimeNode,
      allowedTools: state.request?.allowedTools
    });
    if (toolName === 'memory_cli') {
      return normalizeExecutionEnvelope({
        ...errorEnvelope,
        memoryCliTurn: createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterError(executionState.memoryCliTurn, 'tool_error')
        ),
        invalidateMemoryPrompt: true
      }, step);
    }
    return errorEnvelope;
  }
}

async function executeBatch(steps = [], state = {}, context = {}) {
  const descriptorRegistry = context.registry || context.capabilityRegistry || buildCapabilityRegistry();
  const batches = context.batches || buildExecutionBatches(steps, descriptorRegistry);
  const results = [];
  const cache = createCacheStore(context);
  const maxConcurrency = normalizePositiveInt(
    context.maxConcurrency ?? config.AGENT_BATCH_MAX_CONCURRENCY,
    4
  );
  const timeoutMs = normalizeNonNegativeInt(
    context.timeoutMs ?? config.AGENT_BATCH_TOOL_TIMEOUT_MS ?? config.TOOL_TIMEOUT_MS,
    0
  );

  const executeItem = async (item) => {
    const descriptor = resolveCapability(descriptorRegistry, item.tool);
    const cacheKey = isCacheableCapability(descriptor, item) ? buildToolCacheKey(item, descriptor) : '';
    const cached = getCachedEnvelope(cache, cacheKey);
    if (cached) return cached;
    const startedAt = Date.now();
    const run = executeStep(item, state, {
      ...context,
      registry: descriptorRegistry
    });
    const envelope = timeoutMs > 0
      ? await Promise.race([
        run,
        new Promise((resolve) => setTimeout(() => resolve(computeToolEnvelope(
          item,
          `Tool error: timeout after ${timeoutMs}ms`,
          descriptor,
          normalizeObject(context.helpers, {})
        )), timeoutMs))
      ])
      : await run;
    const finalEnvelope = {
      ...envelope,
      duration_ms: Number.isFinite(Number(envelope?.duration_ms))
        ? Number(envelope.duration_ms)
        : Math.max(0, Date.now() - startedAt)
    };
    setCachedEnvelope(cache, cacheKey, finalEnvelope);
    return finalEnvelope;
  };

  const executeLimited = async (items) => {
    const output = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(maxConcurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        try {
          output[currentIndex] = await executeItem(items[currentIndex]);
        } catch (error) {
          const item = items[currentIndex];
          const descriptor = resolveCapability(descriptorRegistry, item.tool);
          output[currentIndex] = computeToolEnvelope(
            item,
            `Tool error: ${error?.message || 'unknown error'}`,
            descriptor,
            normalizeObject(context.helpers, {})
          );
        }
      }
    }));
    return output;
  };

  for (const batch of normalizeArray(batches)) {
    const items = normalizeArray(batch.items).map((step) => ({ ...step }));
    if (items.length === 0) continue;
    const batchStartedAt = Date.now();

    if (batch.mode !== 'parallel' || items.length < 2) {
      for (const item of items) {
        results.push(await executeItem(item));
      }
      continue;
    }

    const parallelResults = await executeLimited(items);
    results.push(...parallelResults);
    if (config.AGENT_RUNTIME_METRICS_ENABLED) {
      console.log('[agent-runtime] capability_batch', {
        mode: batch.mode,
        itemCount: items.length,
        maxConcurrency,
        durationMs: Math.max(0, Date.now() - batchStartedAt),
        completed: parallelResults.filter((item) => String(item?.status || '') === 'completed').length,
        failed: parallelResults.filter((item) => String(item?.status || '') !== 'completed').length
      });
    }
  }

  return results.map((item, index) => normalizeExecutionEnvelope(item, steps[index] || {}));
}

function shouldRunParallel(steps = [], descriptorRegistry = null) {
  if (!config.AGENT_PARALLEL_SAFE_TOOLS) return false;
  const normalized = normalizeArray(steps);
  if (normalized.length < 2) return false;
  const registry = descriptorRegistry || buildCapabilityRegistry();
  return normalized.every((step) => {
    const descriptor = resolveCapability(registry, step?.tool);
    return isParallelSafeCapability(descriptor);
  });
}

module.exports = {
  buildExecutionBatches,
  computeToolEnvelope,
  executeBatch,
  executeStep,
  filterAllowedCapabilityNames,
  getCapabilityExecutors,
  isParallelSafeCapability,
  isSideEffectCapability,
  resolveCapability,
  runCapabilityPreflight,
  shouldRunParallel
};
