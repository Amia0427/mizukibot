const { buildToolCallFingerprint } = require('../runtime/toolExecution');
const {
  filterAllowedToolNames,
  normalizeToolNames
} = require('../../../utils/localToolAccess');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function createLimitEnvelope(item, maxToolCalls) {
  return {
    step_id: `agent_${item.round}_${item.index + 1}`,
    tool_name: item.toolName,
    tool_call_id: item.toolCallId,
    status: 'blocked',
    retryable: false,
    blockedReason: 'tool_call_limit_reached',
    result: `Tool call limit reached: max ${maxToolCalls} calls per turn. Use the evidence already available.`
  };
}

function createBlockedEnvelope(item, allowedTools) {
  return {
    step_id: `agent_${item.round}_${item.index + 1}`,
    tool_name: item.toolName,
    tool_call_id: item.toolCallId,
    status: 'blocked',
    retryable: false,
    blockedReason: 'tool_not_allowed',
    result: `Tool not allowed: ${item.toolName || 'unknown'}. Allowed tools this turn: ${allowedTools.join(', ') || 'none'}.`
  };
}

function createDuplicateEnvelope(item, previous) {
  return {
    ...previous,
    step_id: `agent_${item.round}_${item.index + 1}`,
    tool_call_id: item.toolCallId,
    retryable: false,
    duplicateOfToolCallId: previous.tool_call_id || '',
    blockedReason: 'duplicate_tool_call',
    result: String(previous.result || '')
  };
}

function createArgumentErrorEnvelope(item, message) {
  return {
    step_id: `agent_${item.round}_${item.index + 1}`,
    tool_name: item.toolName,
    tool_call_id: item.toolCallId,
    status: 'failed',
    retryable: false,
    blockedReason: 'invalid_tool_arguments',
    result: String(message || 'Invalid tool arguments')
  };
}

function createExecuteToolsNode(deps = {}) {
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function executeToolsNode(state) {
    const request = normalizeObject(state.request);
    const agent = normalizeObject(state.execution?.agent);
    const pending = normalizeArray(agent.pendingToolCalls);
    const allowedTools = filterAllowedToolNames(
      normalizeToolNames(request.allowedTools),
      normalizeToolNames(request.routeMeta?.allowedTools)
    );
    const maxToolCalls = Math.max(1, Number(agent.maxToolCalls || 4));
    const history = normalizeArray(agent.toolHistory).map((item) => ({ ...item }));
    const historyByFingerprint = new Map(history.map((item) => [item.fingerprint, item.envelope]));
    let memoryCliTurn = state.execution?.memoryCliTurn;
    const envelopes = [];
    const toolMessages = [];
    const events = [createEvent('node_start', { node: 'execute_tools', count: pending.length })];

    const record = (item, fingerprint, envelope) => {
      const normalizedEnvelope = {
        ...envelope,
        tool_call_id: item.toolCallId,
        tool_name: String(envelope?.tool_name || item.toolName || '').trim(),
        step_id: String(envelope?.step_id || `agent_${item.round}_${item.index + 1}`).trim()
      };
      envelopes.push(normalizedEnvelope);
      toolMessages.push({
        role: 'tool',
        tool_call_id: item.toolCallId,
        content: String(normalizedEnvelope.result || '')
      });
      if (normalizedEnvelope.memoryCliTurn) memoryCliTurn = normalizedEnvelope.memoryCliTurn;
      if (fingerprint && normalizedEnvelope.blockedReason !== 'duplicate_tool_call') {
        historyByFingerprint.set(fingerprint, normalizedEnvelope);
        history.push({ fingerprint, envelope: normalizedEnvelope });
      }
      events.push(createEvent('agent_tool_result', {
        node: 'execute_tools',
        toolName: normalizedEnvelope.tool_name,
        toolCallId: normalizedEnvelope.tool_call_id,
        status: normalizedEnvelope.status,
        blockedReason: normalizedEnvelope.blockedReason || ''
      }));
      return normalizedEnvelope;
    };

    const executeOne = async (item) => {
      const built = deps.buildDirectChatToolStep(item.toolCall, item.index + 1);
      const step = {
        ...built.step,
        id: `agent_${item.round}_${item.index + 1}`,
        source: 'agent',
        directToolCallId: item.toolCallId
      };
      const fingerprint = buildToolCallFingerprint(built.toolName, built.parsedArgs);
      if (!item.withinBudget) return { item, fingerprint, envelope: createLimitEnvelope(item, maxToolCalls) };
      if (built.parseError) return { item, fingerprint, envelope: createArgumentErrorEnvelope(item, built.parseError) };
      if (!built.toolName || deps.isExcludedDirectChatToolName(built.toolName) || !allowedTools.includes(built.toolName)) {
        return { item, fingerprint, envelope: createBlockedEnvelope(item, allowedTools) };
      }
      if (fingerprint && historyByFingerprint.has(fingerprint)) {
        return { item, fingerprint, envelope: createDuplicateEnvelope(item, historyByFingerprint.get(fingerprint)) };
      }
      const policy = deps.getPolicy(built.toolName, built.parsedArgs);
      const sideEffect = deps.isSideEffectPolicy(policy);
      if (sideEffect) {
        deps.saveTransition({
          ...state,
          execution: {
            ...state.execution,
            currentNode: 'execute_tools',
            agent: { ...agent, pendingToolCalls: pending.slice(item.index) }
          }
        }, 'execute_tools', 'running', [createEvent('checkpoint', {
          node: 'execute_tools',
          stage: 'before_side_effect',
          toolName: built.toolName,
          toolCallId: item.toolCallId
        })]);
      }
      const envelope = await deps.runToolStep(step, {
        ...state,
        request: { ...request, allowedTools },
        execution: { ...state.execution, memoryCliTurn, currentNode: 'execute_tools' }
      }, {
        node: 'execute_tools',
        allowedTools
      });
      return { item, fingerprint, envelope, sideEffect };
    };

    const recordResult = async (result) => {
      const envelope = record(result.item, result.fingerprint, result.envelope);
      if (result.sideEffect) {
        deps.saveTransition({
          ...state,
          messages: normalizeArray(state.messages).concat(toolMessages),
          execution: {
            ...state.execution,
            currentNode: 'execute_tools',
            memoryCliTurn,
            toolResults: normalizeArray(state.execution?.toolResults).concat(envelopes),
            agent: {
              ...agent,
              pendingToolCalls: pending.slice(result.item.index + 1),
              toolHistory: history,
              completedToolCallIds: normalizeArray(agent.completedToolCallIds).concat([result.item.toolCallId])
            }
          }
        }, 'execute_tools', 'running', [createEvent('checkpoint', {
          node: 'execute_tools',
          stage: 'after_side_effect',
          toolName: result.item.toolName,
          toolCallId: result.item.toolCallId,
          status: envelope.status
        })]);
      }
      return envelope;
    };

    const runSafely = async (item) => {
      try {
        return await executeOne(item);
      } catch (error) {
        return {
          item,
          fingerprint: '',
          envelope: {
            step_id: `agent_${item.round}_${item.index + 1}`,
            tool_name: item.toolName,
            tool_call_id: item.toolCallId,
            status: 'failed',
            retryable: true,
            result: `Tool error: ${String(error?.message || error || 'unknown error')}`
          }
        };
      }
    };

    const flushReadonly = async (items) => {
      if (items.length === 0) return;
      const results = [];
      if (items.length > 1 && deps.canRunStepsInParallel?.(items.map((item) => item.step))) {
        results.push(...await Promise.all(items.map(runSafely)));
      } else {
        for (const item of items) results.push(await runSafely(item));
      }
      for (const result of results) await recordResult(result);
    };

    let readonlyBatch = [];
    const queuedFingerprints = new Set();
    for (const item of pending) {
      const built = deps.buildDirectChatToolStep(item.toolCall, item.index + 1);
      const step = { ...built.step, id: `agent_${item.round}_${item.index + 1}`, source: 'agent', directToolCallId: item.toolCallId };
      const policy = deps.getPolicy(built.toolName, built.parsedArgs);
      const fingerprint = buildToolCallFingerprint(built.toolName, built.parsedArgs);
      const duplicate = fingerprint && (historyByFingerprint.has(fingerprint) || queuedFingerprints.has(fingerprint));
      const canParallel = !built.parseError
        && item.withinBudget
        && !deps.isExcludedDirectChatToolName(built.toolName)
        && allowedTools.includes(built.toolName)
        && !deps.isSideEffectPolicy(policy)
        && !deps.isDirectChatRuntimeDependentStep?.(step)
        && !duplicate
        && deps.canRunStepsInParallel?.([step]);
      if (canParallel) {
        readonlyBatch.push({ ...item, step, fingerprint });
        if (fingerprint) queuedFingerprints.add(fingerprint);
        continue;
      }
      await flushReadonly(readonlyBatch);
      readonlyBatch = [];
      await recordResult(await runSafely(item));
    }
    await flushReadonly(readonlyBatch);

    const forceFinal = agent.forceFinalAfterTools === true;
    const nextEvents = events.concat([
      ...(forceFinal ? [createEvent('agent_limit_reached', {
        node: 'execute_tools',
        reason: agent.stopReason || 'agent_limit_reached'
      })] : []),
      createEvent('node_complete', { node: 'execute_tools' })
    ]);
    return saveAndEmit({
      ...state,
      memory: {
        ...state.memory,
        dirty: Boolean(state.memory?.dirty || envelopes.some((envelope) => envelope.invalidateMemoryPrompt))
      },
      execution: {
        ...state.execution,
        status: 'tools_completed',
        currentNode: 'execute_tools',
        memoryCliTurn,
        toolResults: normalizeArray(state.execution?.toolResults).concat(envelopes),
        agent: {
          ...agent,
          pendingToolCalls: [],
          toolHistory: history,
          completedToolCallIds: normalizeArray(agent.completedToolCallIds).concat(
            envelopes.map((envelope) => String(envelope.tool_call_id || '').trim()).filter(Boolean)
          ),
          forceFinal,
          forceFinalAfterTools: false
        }
      },
      messages: normalizeArray(state.messages).concat(toolMessages),
      events: nextEvents
    }, 'execute_tools', 'running', nextEvents);
  };
}

module.exports = {
  createBlockedEnvelope,
  createDuplicateEnvelope,
  createExecuteToolsNode,
  createLimitEnvelope
};
