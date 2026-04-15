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

function buildExecutionBatches(steps = [], descriptorRegistry = buildCapabilityRegistry()) {
  const batches = [];
  let currentParallelBatch = [];

  for (const step of normalizeArray(steps)) {
    const descriptor = resolveCapability(descriptorRegistry, step?.tool);
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
  const registry = buildCapabilityRegistry();
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

function computeToolEnvelope(step = {}, rawResult = '', descriptor = null, helpers = {}) {
  const resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult ?? '');
  const args = normalizeObject(step.inputs, {});
  const argsHash = typeof helpers.stableHash === 'function'
    ? String(helpers.stableHash(args) || '').trim()
    : stableHash(args);
  const status = !resultText
    ? 'failed'
    : /^Tool error:/i.test(resultText) || /^Unknown tool:/i.test(resultText) || /^Tool not allowed:/i.test(resultText)
      ? 'failed'
      : 'completed';
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
  const fallbackMainConversationSnapshot = toolName === 'get_context_stats'
    && typeof helpers.buildLiveMainConversationSnapshot === 'function'
    && typeof helpers.computeEffectiveAllowedTools === 'function'
    ? helpers.buildLiveMainConversationSnapshot(state, {
        affinity: state.memory?.affinity,
        allowedTools: helpers.computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn),
        source: normalizeText(overrides.snapshotSource || 'tool_context') || 'tool_context'
      })
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

async function executeStep(step = {}, state = {}, context = {}) {
  const descriptorRegistry = context.registry || buildCapabilityRegistry();
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
  const descriptorRegistry = context.registry || buildCapabilityRegistry();
  const batches = context.batches || buildExecutionBatches(steps, descriptorRegistry);
  const results = [];

  for (const batch of normalizeArray(batches)) {
    const items = normalizeArray(batch.items).map((step) => ({ ...step }));
    if (items.length === 0) continue;

    if (batch.mode !== 'parallel' || items.length < 2) {
      for (const item of items) {
        results.push(await executeStep(item, state, {
          ...context,
          registry: descriptorRegistry
        }));
      }
      continue;
    }

    const settled = await Promise.allSettled(items.map((item) => executeStep(item, state, {
      ...context,
      registry: descriptorRegistry
    })));
    for (let index = 0; index < items.length; index += 1) {
      const settledResult = settled[index];
      if (settledResult?.status === 'fulfilled') {
        results.push(settledResult.value);
        continue;
      }
      const item = items[index];
      const descriptor = resolveCapability(descriptorRegistry, item.tool);
      results.push(computeToolEnvelope(
        item,
        `Tool error: ${settledResult?.reason?.message || 'unknown error'}`,
        descriptor,
        normalizeObject(context.helpers, {})
      ));
    }
  }

  return results.map((item, index) => normalizeExecutionEnvelope(item, steps[index] || {}));
}

function shouldRunParallel(steps = [], descriptorRegistry = buildCapabilityRegistry()) {
  if (!config.AGENT_PARALLEL_SAFE_TOOLS) return false;
  const normalized = normalizeArray(steps);
  if (normalized.length < 2) return false;
  return normalized.every((step) => {
    const descriptor = resolveCapability(descriptorRegistry, step?.tool);
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
