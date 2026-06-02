const { buildToolCallFingerprint } = require('./toolExecution');

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function createDirectToolLoopHelpers(deps = {}) {
  const {
    createEvent,
    normalizeMessageForToolLoop,
    requestAssistantMessageImpl,
    buildDirectChatToolStep,
    buildDirectChatExecutionBatches,
    parseToolCallArgs,
    isExcludedDirectChatToolName,
    computeEffectiveAllowedTools,
    createMemoryCliTurnState,
    updateMemoryCliTurnStateAfterError,
    runToolStep,
    computeToolEnvelope,
    getPolicy,
    logToolExecution,
    resolveToolLoopReply
  } = deps;
  const { buildMemoryToolTelemetry } = require('./memoryToolTelemetry');

  function cloneDirectToolLoopState(statePatch = {}) {
    return {
      messages: normalizeArray(statePatch.messages).map((item) => ({ ...normalizeObject(item, {}) })),
      events: normalizeArray(statePatch.events).map((item) => ({ ...normalizeObject(item, {}) })),
      memoryCliTurn: createMemoryCliTurnState(statePatch.memoryCliTurn),
      executedToolEnvelopes: normalizeArray(statePatch.executedToolEnvelopes).map((item) => ({ ...normalizeObject(item, {}) })),
      effectiveAllowedTools: normalizeArray(statePatch.effectiveAllowedTools)
    };
  }

  function shouldAllowDirectToolCall(toolCall = {}, allowedTools = []) {
    const toolName = String(toolCall?.function?.name || '').trim();
    if (!toolName) return false;
    if (isExcludedDirectChatToolName(toolName)) return false;
    return normalizeArray(allowedTools).includes(toolName);
  }

  async function runDirectChatToolLoop(messagesToSend, state, directContext, runtimeOptions = {}) {
    const request = normalizeObject(state.request, {});
    const initialAllowedTools = computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn);
    let nextMemoryCliTurn = createMemoryCliTurnState(state.execution?.memoryCliTurn);
    let effectiveAllowedTools = initialAllowedTools;
    let loopMessages = normalizeArray(messagesToSend).map((message) => ({ ...message }));
    const loopEvents = [
      createEvent('effectiveAllowedTools', {
        node: 'direct_reply',
        allowedTools: effectiveAllowedTools
      }),
      createEvent('memoryCliTurn', {
        node: 'direct_reply',
        memoryCliTurn: nextMemoryCliTurn
      })
    ];
    const executedToolEnvelopes = [];
    const duplicateToolResults = new Map();
    let executedToolCallCount = 0;
    const maxToolCallsPerTurn = Math.max(1, Math.floor(Number(runtimeOptions.maxToolCallsPerTurn
      || request.directToolMaxCallsPerTurn
      || deps.config?.DIRECT_TOOL_MAX_CALLS_PER_TURN
      || 4)));
    const duplicateGuardEnabled = runtimeOptions.duplicateToolGuardEnabled !== false
      && deps.config?.DIRECT_TOOL_DUPLICATE_CALL_GUARD_ENABLED !== false;

    function throwWithDirectToolLoopState(error) {
      const nextError = error instanceof Error ? error : new Error(String(error || ''));
      nextError.directToolLoopState = cloneDirectToolLoopState({
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      });
      throw nextError;
    }

    async function requestAssistantMessageForLoop(options = {}) {
      try {
        return normalizeMessageForToolLoop(await requestAssistantMessageImpl(loopMessages, {
          ...directContext,
          dispatchBranch: directContext.dispatchBranch || 'direct_reply',
          triggerBranch: 'direct_reply.tool_loop',
          ...normalizeObject(options, {})
        }));
      } catch (error) {
        throwWithDirectToolLoopState(error);
      }
    }

    const firstAssistantMessage = runtimeOptions.firstAssistantMessage
      ? normalizeMessageForToolLoop(runtimeOptions.firstAssistantMessage)
      : await requestAssistantMessageForLoop({
        disableTools: effectiveAllowedTools.length === 0,
        allowedTools: effectiveAllowedTools
      });
    loopMessages.push(firstAssistantMessage);

    let assistantMessage = firstAssistantMessage;
    let toolCalls = normalizeArray(firstAssistantMessage.tool_calls);

    if (toolCalls.length === 0) {
      const replyResolution = await resolveToolLoopReply(firstAssistantMessage, loopMessages, directContext, 'tool_error', executedToolEnvelopes);
      return {
        reply: replyResolution.text,
        noToolCalls: true,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    for (const toolCall of toolCalls) {
      loopEvents.push(createEvent('tool_call_detected', {
        node: 'direct_reply',
        tool_name: String(toolCall?.function?.name || '').trim(),
        tool_call_id: String(toolCall?.id || '').trim()
      }));
    }

    const toolCallItems = toolCalls.map((toolCall, index) => {
      const built = buildDirectChatToolStep(toolCall, index + 1);
      return {
        index,
        toolCall,
        parsedArgs: built.parsedArgs,
        toolName: built.toolName,
        step: built.step,
        allowed: shouldAllowDirectToolCall(toolCall, effectiveAllowedTools)
      };
    });
    const allowedToolCallItems = toolCallItems.filter((item) => item.allowed);

    const assignBatchMetaToItem = (item, batch = {}) => ({
      ...item,
      step: {
        ...normalizeObject(item?.step, {}),
        ...(String(batch.batchId || '').trim() ? { batchId: String(batch.batchId).trim() } : {}),
        ...(Number.isFinite(Number(batch.batchIndex)) ? { batchIndex: Number(batch.batchIndex) } : {})
      }
    });

    const recordDirectToolEnvelope = (envelope, toolCall) => {
      const toolCallId = String(toolCall?.id || envelope?.tool_call_id || '').trim() || envelope?.tool_call_id;
      const normalizedEnvelope = {
        ...envelope,
        tool_call_id: toolCallId
      };
      logToolExecution(normalizedEnvelope, {}, {
        ...state,
        request: {
          ...request,
          allowedTools: effectiveAllowedTools
        },
        execution: {
          ...state.execution,
          currentNode: 'direct_reply'
        }
      }, {
        node: 'direct_reply',
        allowedTools: effectiveAllowedTools
      });
      executedToolEnvelopes.push(normalizedEnvelope);
      if (normalizedEnvelope.memoryCliTurn) {
        nextMemoryCliTurn = createMemoryCliTurnState(normalizedEnvelope.memoryCliTurn);
      }
      effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
      loopEvents.push(createEvent('tool_result', {
        ...normalizedEnvelope,
        ...buildMemoryToolTelemetry(normalizedEnvelope),
        node: 'direct_reply',
        tool_call_id: toolCallId
      }));
      loopEvents.push(createEvent('memoryCliTurn', {
        node: 'direct_reply',
        memoryCliTurn: nextMemoryCliTurn
      }));
      loopEvents.push(createEvent('effectiveAllowedTools', {
        node: 'direct_reply',
        allowedTools: effectiveAllowedTools
      }));
      loopMessages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: String(normalizedEnvelope.result || '')
      });
      return normalizedEnvelope;
    };

    const createBlockedDirectToolEnvelope = (item, failureType = 'tool_error') => {
      const toolName = String(item?.toolName || '').trim();
      const policy = getPolicy(toolName);
      const allowedList = normalizeArray(effectiveAllowedTools).join(', ') || 'none';
      const blockedResult = `Tool not allowed: ${toolName || 'unknown'}. Allowed tools this turn: ${allowedList}. Do not call blocked tools again; answer directly or retry with an allowed tool only if necessary.`;
      const baseEnvelope = computeToolEnvelope(item?.step || {}, blockedResult, policy);
      if (toolName === 'memory_cli') {
        nextMemoryCliTurn = createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, failureType)
        );
      }
      return {
        ...baseEnvelope,
        status: 'blocked',
        retryable: false,
        result: blockedResult,
        memoryCliTurn: nextMemoryCliTurn,
        invalidateMemoryPrompt: toolName === 'memory_cli',
        blockedReason: 'tool_not_allowed'
      };
    };

    const createToolLimitEnvelope = (item) => ({
      ...computeToolEnvelope(item?.step || {}, `Tool call limit reached: max ${maxToolCallsPerTurn} tool calls per turn. Answer with the evidence already available instead of calling more tools.`, getPolicy(item?.toolName)),
      status: 'blocked',
      retryable: false,
      blockedReason: 'tool_call_limit_reached'
    });

    const createDuplicateToolEnvelope = (item, previousEnvelope = {}) => ({
      ...computeToolEnvelope(item?.step || {}, `Duplicate tool call skipped for ${item?.toolName || 'unknown'}; reused previous result.\n${String(previousEnvelope.result || '')}`, getPolicy(item?.toolName)),
      status: String(previousEnvelope.status || '').trim() || 'completed',
      retryable: false,
      duplicateOfToolCallId: previousEnvelope.tool_call_id || '',
      blockedReason: 'duplicate_tool_call'
    });

    const runOneDirectTool = async (item) => {
      const fingerprint = buildToolCallFingerprint(item.toolName, item.step?.inputs || item.parsedArgs || {});
      if (duplicateGuardEnabled && duplicateToolResults.has(fingerprint)) {
        return recordDirectToolEnvelope(createDuplicateToolEnvelope(item, duplicateToolResults.get(fingerprint)), item.toolCall);
      }
      if (executedToolCallCount >= maxToolCallsPerTurn) {
        return recordDirectToolEnvelope(createToolLimitEnvelope(item), item.toolCall);
      }
      executedToolCallCount += 1;
      const envelope = await runToolStep(item.step, {
        ...state,
        request: {
          ...request,
          allowedTools: effectiveAllowedTools
        },
        execution: {
          ...state.execution,
          memoryCliTurn: nextMemoryCliTurn
        }
      }, runtimeOptions);
      const recorded = recordDirectToolEnvelope(envelope, item.toolCall);
      if (duplicateGuardEnabled && fingerprint) {
        duplicateToolResults.set(fingerprint, recorded);
      }
      return recorded;
    };

    const canRunDirectToolBatchInParallel = (items = [], batch = {}) => {
      const list = normalizeArray(items);
      if (String(batch?.mode || '').trim() !== 'parallel') return false;
      if (list.length < 2) return false;
      if (executedToolCallCount + list.length > maxToolCallsPerTurn) return false;

      const fingerprints = new Set();
      for (const item of list) {
        const toolName = String(item?.toolName || item?.step?.tool || '').trim();
        if (!toolName || toolName === 'memory_cli') return false;
        const fingerprint = buildToolCallFingerprint(toolName, item.step?.inputs || item.parsedArgs || {});
        if (!fingerprint || fingerprints.has(fingerprint)) return false;
        if (duplicateGuardEnabled && duplicateToolResults.has(fingerprint)) return false;
        fingerprints.add(fingerprint);
      }
      return true;
    };

    const runParallelDirectTools = async (items = []) => {
      const allowedToolsSnapshot = normalizeArray(effectiveAllowedTools);
      const memoryCliTurnSnapshot = createMemoryCliTurnState(nextMemoryCliTurn);
      executedToolCallCount += items.length;
      const settled = await Promise.allSettled(items.map((item) => runToolStep(item.step, {
        ...state,
        request: {
          ...request,
          allowedTools: allowedToolsSnapshot
        },
        execution: {
          ...state.execution,
          memoryCliTurn: memoryCliTurnSnapshot
        }
      }, runtimeOptions)));

      return settled.map((settledItem, index) => {
        const sourceItem = items[index];
        if (settledItem.status === 'fulfilled') {
          const recorded = recordDirectToolEnvelope(settledItem.value, sourceItem.toolCall);
          if (duplicateGuardEnabled) {
            const fingerprint = buildToolCallFingerprint(sourceItem.toolName, sourceItem.step?.inputs || sourceItem.parsedArgs || {});
            if (fingerprint) duplicateToolResults.set(fingerprint, recorded);
          }
          return recorded;
        }
        return recordDirectToolEnvelope(
          computeToolEnvelope(sourceItem.step, `Tool error: ${settledItem.reason?.message || 'unknown error'}`, getPolicy(sourceItem.toolName)),
          sourceItem.toolCall
        );
      });
    };

    const executeDirectToolBatch = async (items = [], batch = {}) => {
      const ordered = [];
      for (const item of normalizeArray(items)) {
        if (!item?.allowed) {
          ordered.push(recordDirectToolEnvelope(createBlockedDirectToolEnvelope(item), item.toolCall));
          continue;
        }
        ordered.push(item);
      }
      const allowedItems = ordered.filter((item) => item && !item.tool_call_id);
      if (allowedItems.length === 0) return ordered;
      if (allowedItems.length === 1) {
        const envelope = await runOneDirectTool(allowedItems[0]);
        return ordered.map((item) => (item === allowedItems[0] ? envelope : item));
      }
      if (canRunDirectToolBatchInParallel(allowedItems, batch)) {
        const parallelResults = await runParallelDirectTools(allowedItems);
        let allowedIndex = 0;
        return ordered.map((item) => {
          if (item && item.tool_call_id) return item;
          const result = parallelResults[allowedIndex];
          allowedIndex += 1;
          return result;
        });
      }
      const settled = [];
      for (const item of allowedItems) {
        try {
          settled.push({ status: 'fulfilled', value: await runOneDirectTool(item) });
        } catch (error) {
          settled.push({ status: 'rejected', reason: error });
        }
      }
      let allowedIndex = 0;
      return ordered.map((item) => {
        if (item && item.tool_call_id) return item;
        const settledItem = settled[allowedIndex];
        const sourceItem = allowedItems[allowedIndex];
        allowedIndex += 1;
        return settledItem?.status === 'fulfilled'
          ? settledItem.value
          : recordDirectToolEnvelope(
            computeToolEnvelope(sourceItem.step, `Tool error: ${settledItem?.reason?.message || 'unknown error'}`, getPolicy(sourceItem.toolName)),
            sourceItem.toolCall
          );
      });
    };

    let hadBlockedToolCall = false;
    const directBatches = buildDirectChatExecutionBatches(toolCallItems, (item) => item.step);
    const directBatchResults = [];
    for (const batch of directBatches) {
      const batchItems = normalizeArray(batch.items).map((item) => assignBatchMetaToItem(item, batch));
      const results = await executeDirectToolBatch(batchItems, batch);
      directBatchResults.push(...results);
      if (results.some((item) => String(item?.status || '').trim() === 'blocked')) {
        hadBlockedToolCall = true;
      }
    }

    if (allowedToolCallItems.length === 0) {
      if (!hadBlockedToolCall) {
        nextMemoryCliTurn = createMemoryCliTurnState(
          updateMemoryCliTurnStateAfterError(nextMemoryCliTurn, 'tool_error')
        );
        effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
      }
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'tool_not_allowed',
        allowedTools: effectiveAllowedTools
      }));
      const replyResolution = await resolveToolLoopReply(
        { role: 'assistant', content: '' },
        normalizeArray(messagesToSend),
        {
          ...directContext,
          disableTools: true,
          allowedTools: []
        },
        'tool_error',
        []
      );
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    const firstAllowedToolCall = allowedToolCallItems[0]?.toolCall || null;
    const firstAllowedEnvelope = directBatchResults.find((item) => String(item?.status || '').trim() !== 'blocked') || null;
    const firstToolName = String(firstAllowedToolCall?.function?.name || '').trim();
    if (firstToolName === 'get_context_stats' && allowedToolCallItems.length === 1) {
      assistantMessage = await requestAssistantMessageForLoop({
        disableTools: true,
        allowedTools: []
      });
      loopMessages.push(assistantMessage);
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'single_read_only_tool_complete',
        allowedTools: []
      }));
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }
    const firstCommandWasSearch = String(nextMemoryCliTurn.lastSuccessCommand || '').trim() === 'search';
    const mayOpenOneMoreTime = firstAllowedEnvelope && firstAllowedEnvelope.status === 'completed'
      && firstCommandWasSearch
      && nextMemoryCliTurn.lastResultHadHits
      && !nextMemoryCliTurn.mustAnswer
      && nextMemoryCliTurn.openCount < 1
      && effectiveAllowedTools.includes('memory_cli');

    assistantMessage = await requestAssistantMessageForLoop({
      disableTools: !mayOpenOneMoreTime,
      allowedTools: mayOpenOneMoreTime ? effectiveAllowedTools : []
    });
    loopMessages.push(assistantMessage);

    if (!mayOpenOneMoreTime) {
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'post_tool_empty_reply', executedToolEnvelopes);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: nextMemoryCliTurn.mustAnswer ? 'must_answer' : 'single_tool_complete',
        allowedTools: [],
        failureType: replyResolution.source === 'controlled_failure' ? 'post_tool_empty_reply' : ''
      }));
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    toolCalls = normalizeArray(assistantMessage.tool_calls);
    if (toolCalls.length === 0) {
      const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'no_followup_tool_call',
        allowedTools: effectiveAllowedTools
      }));
      return {
        reply: replyResolution.text,
        noToolCalls: false,
        messages: loopMessages,
        events: loopEvents,
        memoryCliTurn: nextMemoryCliTurn,
        executedToolEnvelopes,
        effectiveAllowedTools
      };
    }

    for (const toolCall of toolCalls) {
      loopEvents.push(createEvent('tool_call_detected', {
        node: 'direct_reply',
        tool_name: String(toolCall?.function?.name || '').trim(),
        tool_call_id: String(toolCall?.id || '').trim()
      }));
    }

    const secondToolCall = toolCalls[0] || null;
    const secondArgs = parseToolCallArgs(secondToolCall);
    const secondCommand = String(secondArgs?.command || '').trim().toLowerCase();
    const secondIsOpen = shouldAllowDirectToolCall(secondToolCall, effectiveAllowedTools)
      && secondCommand.startsWith('mem open');

    if (secondIsOpen) {
      await executeDirectToolBatch([{
        index: 0,
        toolCall: secondToolCall,
        parsedArgs: secondArgs,
        toolName: String(secondToolCall?.function?.name || '').trim(),
        step: buildDirectChatToolStep(secondToolCall, 2).step,
        allowed: true
      }]);
    } else {
      loopEvents.push(createEvent('tool_loop_forced_answer', {
        node: 'direct_reply',
        reason: 'followup_skipped_not_open',
        allowedTools: effectiveAllowedTools
      }));
    }

    assistantMessage = await requestAssistantMessageForLoop({
      disableTools: true,
      allowedTools: []
    });
    loopMessages.push(assistantMessage);
    const replyResolution = await resolveToolLoopReply(assistantMessage, loopMessages.slice(0, -1), directContext, 'tool_error', executedToolEnvelopes);
    loopEvents.push(createEvent('tool_loop_forced_answer', {
      node: 'direct_reply',
      reason: 'final_answer_required',
      allowedTools: []
    }));

    return {
      reply: replyResolution.text,
      noToolCalls: false,
      messages: loopMessages,
      events: loopEvents,
      memoryCliTurn: nextMemoryCliTurn,
      executedToolEnvelopes,
      effectiveAllowedTools
    };
  }

  return {
    cloneDirectToolLoopState,
    runDirectChatToolLoop
  };
}

module.exports = {
  createDirectToolLoopHelpers
};
