function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
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

function createToolExecutionHelpers(deps = {}) {
  const {
    config,
    stableHash,
    summarizeToolLogValue,
    getPolicy,
    enforceToolPolicy,
    shouldRunParallel,
    capabilityRegistry,
    buildLiveMainConversationSnapshot,
    computeEffectiveAllowedTools,
    createMemoryCliTurnState,
    updateMemoryCliTurnStateAfterError,
    updateMemoryCliTurnStateAfterResult,
    decideMemoryCliTurnAction,
    safeParseMemoryCliResult,
    captureToolFailure,
    isPlannerSingleAuthorityEnabled,
    toolExecutors
  } = deps;

  function isWriteLikeCapability(capability = '') {
    return /write/i.test(String(capability || ''));
  }

  function isSideEffectPolicy(policy = {}) {
    return isWriteLikeCapability(policy.capability) || String(policy.risk || '').trim().toLowerCase() === 'high';
  }

  function computeToolEnvelope(step = {}, rawResult = '', policy = {}) {
    const normalizedInputs = normalizeObject(step.inputs, {});
    const argsHash = stableHash(normalizedInputs);
    const resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    const batchId = String(step.batchId || step.batch_id || '').trim();
    const batchIndex = Number.isFinite(Number(step.batchIndex ?? step.batch_index))
      ? Number(step.batchIndex ?? step.batch_index)
      : null;
    const status = isToolFailureText(resultText) ? 'failed' : 'completed';
    return {
      tool_call_id: `${step.id}_${argsHash}_${Date.now()}`,
      step_id: String(step.id || '').trim(),
      tool_name: String(step.tool || '').trim(),
      args_hash: argsHash,
      args: normalizedInputs,
      status,
      result: resultText,
      side_effect: isSideEffectPolicy(policy),
      retryable: status !== 'completed',
      attempt: Number(step.attempts || 0) + 1,
      ...(batchId ? { batch_id: batchId } : {}),
      ...(batchIndex !== null ? { batch_index: batchIndex } : {})
    };
  }

  function canRunStepsInParallel(steps = []) {
    return shouldRunParallel(steps, capabilityRegistry);
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
    const webSearchResult = [...previousEnvelopes].reverse().find((item) => String(item?.tool_name || '').trim() === 'web_search' && String(item?.status || '').trim() === 'completed')
      || previousSteps
        .filter((candidate) => String(candidate?.tool || '').trim() === 'web_search')
        .flatMap((candidate) => normalizeArray(candidate?.evidence))
        .reverse()
        .find((item) => String(item?.status || '').trim() === 'completed');
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

  function buildToolContext(state, overrides = {}) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const toolName = String(overrides.toolName || '').trim();
    const fallbackMainConversationSnapshot = toolName === 'get_context_stats'
      ? buildLiveMainConversationSnapshot(state, {
        affinity: state.memory?.affinity,
        allowedTools: computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn),
        source: String(overrides.snapshotSource || 'tool_context').trim() || 'tool_context'
      })
      : null;
    return {
      userId: String(request.userId || '').trim(),
      routePolicyKey: String(request.routePolicyKey || '').trim(),
      topRouteType: String(request.topRouteType || '').trim(),
      routeMeta,
      reviewMode: String(request.reviewMode || '').trim(),
      taskType: String(routeMeta.taskType || routeMeta.task_type || '').trim(),
      sessionId: String(routeMeta.sessionId || routeMeta.session_id || '').trim(),
      channelId: String(routeMeta.channelId || routeMeta.channel_id || '').trim(),
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      mainConversationSnapshot: overrides.mainConversationSnapshot
        && typeof overrides.mainConversationSnapshot === 'object'
        && Array.isArray(overrides.mainConversationSnapshot.segments)
        ? { ...overrides.mainConversationSnapshot }
        : fallbackMainConversationSnapshot
    };
  }

  function logToolExecution(envelope = {}, step = {}, state = {}, extra = {}) {
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const args = normalizeObject(envelope.args, normalizeObject(step.inputs, {}));
    const sanitizedArgs = { ...args };
    delete sanitizedArgs.__context;
    console.log('[graph-tool]', {
      node: String(extra.node || state.execution?.currentNode || '').trim() || 'unknown',
      topRouteType: String(request.topRouteType || routeMeta.topRouteType || '').trim(),
      routePolicyKey: String(request.routePolicyKey || '').trim(),
      toolName: String(envelope.tool_name || step.tool || '').trim(),
      stepId: String(envelope.step_id || step.id || '').trim(),
      status: String(envelope.status || '').trim(),
      batchId: String(envelope.batch_id || step.batchId || '').trim(),
      batchIndex: Number.isFinite(Number(envelope.batch_index))
        ? Number(envelope.batch_index)
        : (Number.isFinite(Number(step.batchIndex)) ? Number(step.batchIndex) : null),
      userId: String(request.userId || '').trim(),
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      allowedTools: normalizeArray(extra.allowedTools || request.allowedTools),
      argsPreview: summarizeToolLogValue(sanitizedArgs),
      resultPreview: summarizeToolLogValue(envelope.result),
      blockedReason: String(envelope.blockedReason || '').trim(),
      retryable: Boolean(envelope.retryable)
    });
  }

  function maybeCaptureToolFailure(envelope = {}, step = {}, state = {}) {
    if (!config.SELF_IMPROVEMENT_ENABLED) return;
    const status = String(envelope?.status || '').trim().toLowerCase();
    if (status === 'completed') return;
    const blockedReason = normalizeText(envelope?.blockedReason).toLowerCase();
    if (blockedReason.startsWith('runtime_binding_unresolved:')) return;
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    try {
      captureToolFailure({
        envelope,
        purpose: String(step?.instruction || step?.successCriteria || '').trim(),
        details: String(step?.successCriteria || '').trim(),
        routePolicyKey: String(request.routePolicyKey || '').trim(),
        topRouteType: String(request.topRouteType || routeMeta.topRouteType || '').trim(),
        toolName: String(envelope.tool_name || step?.tool || routeMeta.toolName || routeMeta.tool_name || '').trim(),
        taskType: String(routeMeta.taskType || routeMeta.task_type || '').trim(),
        sessionId: String(routeMeta.sessionId || routeMeta.session_id || '').trim(),
        channelId: String(routeMeta.channelId || routeMeta.channel_id || '').trim(),
        groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
        userId: String(request.userId || '').trim(),
        evidence: [
          { label: 'tool_result', excerpt: String(envelope?.result || '').trim() }
        ]
      });
    } catch (error) {
      console.error('[self-improvement] tool failure capture failed:', error?.message || error);
    }
  }

  function buildBlockedToolEnvelope(step = {}, memoryCliTurn = null, reason = 'tool_not_allowed') {
    const toolName = String(step?.tool || '').trim();
    const policy = getPolicy(toolName);
    const blockedResult = `Tool not allowed: ${toolName || 'unknown'}`;
    let nextMemoryCliTurn = createMemoryCliTurnState(memoryCliTurn);
    let invalidateMemoryPrompt = false;
    if (toolName === 'memory_cli') {
      nextMemoryCliTurn = createMemoryCliTurnState(
        updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_error')
      );
      invalidateMemoryPrompt = true;
    }
    const baseEnvelope = computeToolEnvelope(step, blockedResult, policy);
    const directToolCallId = String(step?.directToolCallId || step?.toolCallId || '').trim();
    return {
      ...baseEnvelope,
      ...(directToolCallId ? { tool_call_id: directToolCallId } : {}),
      status: 'blocked',
      retryable: false,
      result: blockedResult,
      ...(toolName === 'memory_cli' ? { memoryCliTurn: nextMemoryCliTurn, invalidateMemoryPrompt } : {}),
      blockedReason: String(reason || 'tool_not_allowed').trim() || 'tool_not_allowed'
    };
  }

  function getPreviousMemorySearchResult(state = {}, currentStepId = '') {
    const currentId = normalizeText(currentStepId);
    const planEvidence = normalizeArray(state.plan?.steps)
      .filter((candidate) => normalizeText(candidate?.id) !== currentId)
      .flatMap((candidate) => normalizeArray(candidate?.evidence));
    const executionEvidence = normalizeArray(state.execution?.toolResults);
    const candidates = [...executionEvidence, ...planEvidence].reverse();
    for (const envelope of candidates) {
      const resultText = String(envelope?.result || '').trim();
      if (!resultText) continue;
      const parsed = safeParseMemoryCliResult(resultText);
      if (normalizeText(parsed?.command) !== 'search') continue;
      return resultText;
    }
    return '';
  }

  function buildUnresolvedMemoryRefEnvelope(step = {}, normalizedArgs = {}, policy = {}, executionState = {}) {
    const blockedReason = 'runtime_binding_unresolved:memory_ref';
    const result = `Tool error: ${blockedReason}`;
    return {
      ...computeToolEnvelope({ ...step, inputs: normalizedArgs }, result, policy),
      status: 'blocked',
      retryable: false,
      result,
      memoryCliTurn: createMemoryCliTurnState(executionState.memoryCliTurn),
      invalidateMemoryPrompt: true,
      blockedReason,
      unsatisfiedRequirement: blockedReason
    };
  }

  function buildReusedMemorySearchEnvelope(step = {}, normalizedArgs = {}, policy = {}, executionState = {}, previousResult = '') {
    return {
      ...computeToolEnvelope({ ...step, inputs: normalizedArgs }, previousResult, policy),
      memoryCliTurn: createMemoryCliTurnState(executionState.memoryCliTurn),
      invalidateMemoryPrompt: true,
      reusedPreviousResult: true
    };
  }

  async function runToolStep(step, state, runtimeOptions = {}) {
    const toolName = String(step.tool || '').trim();
    const policy = getPolicy(toolName);
    const executionState = normalizeObject(state.execution, {});
    const toolContextOverrides = {
      ...runtimeOptions,
      toolName
    };

    if (
      String(step?.source || '').trim() === 'direct_chat'
      && String(step?.blockingReason || '').trim() === 'tool_not_allowed'
    ) {
      const envelope = buildBlockedToolEnvelope(step, executionState.memoryCliTurn, 'tool_not_allowed');
      maybeCaptureToolFailure(envelope, step, state);
      logToolExecution(envelope, step, state, {
        node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
        allowedTools: state.request?.allowedTools
      });
      return envelope;
    }

    try {
      let preparedArgs = step.inputs || {};
      if (toolName === 'web_fetch') {
        preparedArgs = resolveWebFetchArgs({
          ...step,
          inputs: preparedArgs
        }, state);
      }
      let normalizedArgs = enforceToolPolicy(toolName, preparedArgs, {
        userId: state.request.userId
      });
      if (toolName === 'memory_cli') {
        if (isPlannerSingleAuthorityEnabled()) {
          const commandText = normalizeText(normalizedArgs.command);
          if (/^mem open --ref\s+\"mc_ref:planner_pending:/i.test(commandText)) {
            const previousResult = safeParseMemoryCliResult(getPreviousMemorySearchResult(state, step.id));
            const previousRef = normalizeText(previousResult?.results?.[0]?.ref);
            if (previousRef) {
              normalizedArgs = {
                ...normalizedArgs,
                command: `mem open --ref ${JSON.stringify(previousRef)}`
              };
            }
          }
        }
        if (isUnresolvedMemoryOpenCommand(normalizedArgs.command)) {
          const envelope = buildUnresolvedMemoryRefEnvelope(step, normalizedArgs, policy, executionState);
          logToolExecution(envelope, { ...step, inputs: normalizedArgs }, state, {
            node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
            allowedTools: state.request?.allowedTools
          });
          return envelope;
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
            const envelope = buildReusedMemorySearchEnvelope(step, normalizedArgs, policy, executionState, previousResult);
            logToolExecution(envelope, { ...step, inputs: normalizedArgs }, state, {
              node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
              allowedTools: state.request?.allowedTools
            });
            return envelope;
          }
        }
        const decision = decideMemoryCliTurnAction(normalizedArgs.command, executionState.memoryCliTurn);
        if (!decision.ok) {
          const result = typeof decision.result === 'string' ? decision.result : JSON.stringify(decision.result);
          const envelope = {
            ...computeToolEnvelope({ ...step, inputs: { ...normalizedArgs, command: decision.preparedCommand || normalizedArgs.command } }, result, policy),
            status: 'blocked',
            retryable: decision.errorType !== 'tool_error',
            result,
            memoryCliTurn: decision.nextState,
            invalidateMemoryPrompt: true,
            repairApplied: Boolean(decision.repairApplied),
            repairStrategy: normalizeArray(decision.repairStrategy),
            blockedReason: String(decision.reason || '').trim()
          };
          maybeCaptureToolFailure(envelope, { ...step, inputs: normalizedArgs }, state);
          return envelope;
        }

        const executor = toolExecutors[toolName];
        if (!executor) {
          const envelope = {
            ...computeToolEnvelope(step, `Unknown tool: ${toolName}`, policy),
            memoryCliTurn: executionState.memoryCliTurn
          };
          maybeCaptureToolFailure(envelope, step, state);
          return envelope;
        }

        const out = await executor({
          ...normalizedArgs,
          command: decision.preparedCommand || normalizedArgs.command,
          __context: buildToolContext(state, toolContextOverrides)
        });
        const envelope = computeToolEnvelope({
          ...step,
          inputs: {
            ...normalizedArgs,
            command: decision.preparedCommand || normalizedArgs.command
          }
        }, out, policy);
        const resultEnvelope = {
          ...envelope,
          memoryCliTurn: createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterResult(executionState.memoryCliTurn, decision.parsed, out)
          ),
          invalidateMemoryPrompt: true,
          repairApplied: Boolean(decision.repairApplied),
          repairStrategy: normalizeArray(decision.repairStrategy)
        };
        maybeCaptureToolFailure(resultEnvelope, { ...step, inputs: normalizedArgs }, state);
        logToolExecution(resultEnvelope, { ...step, inputs: normalizedArgs }, state, {
          node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
          allowedTools: state.request?.allowedTools
        });
        return resultEnvelope;
      }

      const executor = toolExecutors[toolName];
      if (!executor) {
        const envelope = computeToolEnvelope(step, `Unknown tool: ${toolName}`, policy);
        maybeCaptureToolFailure(envelope, step, state);
        return envelope;
      }

      const out = await executor({
        ...normalizedArgs,
        __context: buildToolContext(state, toolContextOverrides)
      });
      const envelope = computeToolEnvelope({ ...step, inputs: normalizedArgs }, out, policy);
      maybeCaptureToolFailure(envelope, { ...step, inputs: normalizedArgs }, state);
      logToolExecution(envelope, { ...step, inputs: normalizedArgs }, state, {
        node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
        allowedTools: state.request?.allowedTools
      });
      return envelope;
    } catch (error) {
      const base = computeToolEnvelope(step, `Tool error: ${error.message}`, policy);
      maybeCaptureToolFailure(base, step, state);
      logToolExecution(base, step, state, {
        node: runtimeOptions.node || state.execution?.currentNode || 'unknown',
        allowedTools: state.request?.allowedTools
      });
      if (toolName === 'memory_cli') {
        return {
          ...base,
          memoryCliTurn: createMemoryCliTurnState(
            updateMemoryCliTurnStateAfterError(executionState.memoryCliTurn, 'tool_error')
          ),
          invalidateMemoryPrompt: true
        };
      }
      return base;
    }
  }

  return {
    buildBlockedToolEnvelope,
    buildToolContext,
    canRunStepsInParallel,
    computeToolEnvelope,
    isSideEffectPolicy,
    logToolExecution,
    maybeCaptureToolFailure,
    runToolStep
  };
}

module.exports = {
  createToolExecutionHelpers
};
