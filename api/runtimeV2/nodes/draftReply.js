const { buildToolEvidenceBundle } = require('../contracts');

function createDraftReplyNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const buildDynamicPromptImpl = typeof deps.buildDynamicPromptImpl === 'function'
    ? deps.buildDynamicPromptImpl
    : (async () => ({ dynamicPrompt: '', affinity: null, memoryContext: null }));
  const rebuildFinalPlanFromSteps = typeof deps.rebuildFinalPlanFromSteps === 'function'
    ? deps.rebuildFinalPlanFromSteps
    : (() => ({ goal: '', need_tools: false, steps: [] }));
  const buildContinuitySystemMessage = typeof deps.buildContinuitySystemMessage === 'function'
    ? deps.buildContinuitySystemMessage
    : (() => null);
  const isReviewMode = typeof deps.isReviewMode === 'function'
    ? deps.isReviewMode
    : (() => false);
  const getMainConversationSystemMessages = typeof deps.getMainConversationSystemMessages === 'function'
    ? deps.getMainConversationSystemMessages
    : (() => []);
  const buildDirectReplyMessages = typeof deps.buildDirectReplyMessages === 'function'
    ? deps.buildDirectReplyMessages
    : (() => ({ messages: [] }));
  const buildVisionMessageContent = typeof deps.buildVisionMessageContent === 'function'
    ? deps.buildVisionMessageContent
    : ((text) => text);
  const normalizeMessageForToolLoop = typeof deps.normalizeMessageForToolLoop === 'function'
    ? deps.normalizeMessageForToolLoop
    : ((message) => message);
  const requestAssistantMessageImpl = typeof deps.requestAssistantMessageImpl === 'function'
    ? deps.requestAssistantMessageImpl
    : (async () => ({ role: 'assistant', content: '' }));
  const compileDirectChatToolCallsToPlan = typeof deps.compileDirectChatToolCallsToPlan === 'function'
    ? deps.compileDirectChatToolCallsToPlan
    : ((toolCalls, plan) => ({ ...plan, steps: toolCalls }));
  const computeEffectiveAllowedTools = typeof deps.computeEffectiveAllowedTools === 'function'
    ? deps.computeEffectiveAllowedTools
    : (() => []);
  const resolveToolLoopReply = typeof deps.resolveToolLoopReply === 'function'
    ? deps.resolveToolLoopReply
    : (async () => ({ text: '' }));
  const synthesizeImpl = typeof deps.synthesizeImpl === 'function'
    ? deps.synthesizeImpl
    : (async () => '');
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const buildToolEvidenceBundleImpl = typeof deps.buildToolEvidenceBundle === 'function'
    ? deps.buildToolEvidenceBundle
    : buildToolEvidenceBundle;
  const isPureToolCallMarkup = typeof deps.isPureToolCallMarkup === 'function'
    ? deps.isPureToolCallMarkup
    : ((text = '') => /^<tool_calls>[\s\S]*<\/tool_calls>$/i.test(String(text || '').trim()));

  function extractAssistantContentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      }).join('');
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.content === 'string') return content.content;
    }
    return '';
  }

  function isStableToolFollowupReply(message = {}) {
    const text = extractAssistantContentText(message?.content).trim();
    if (!text) return { ok: false, text: '', reason: 'empty_reply' };
    if (normalizeArray(message?.tool_calls).length > 0) {
      return { ok: false, text, reason: 'unexpected_tool_calls' };
    }
    if (isPureToolCallMarkup(text)) {
      return { ok: false, text, reason: 'pure_tool_markup' };
    }
    return { ok: true, text, reason: '' };
  }

  return async function draftReplyNode(state) {
    const draftStartedAt = Date.now();
    const request = normalizeObject(state.request, {});
    const events = [createEvent('node_start', { node: 'draft_reply' })];
    let followupModelCalls = 0;
    let synthesisModelCalls = 0;
    let nextMemory = {
      ...state.memory
    };
    if (state.memory?.dirty) {
      const refreshed = await buildDynamicPromptImpl(
        request.userInfo,
        request.userId,
        request.question,
        request.customPrompt,
        {
          routePrompt: request.routePrompt,
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          reviewMode: request.reviewMode,
          routeMeta: request.routeMeta,
          customPrompt: request.customPrompt,
          disableTools: !request.allowTools,
          modelConfig: request.modelConfig,
          memoryCliTurn: state.execution?.memoryCliTurn
        }
      );
      nextMemory = {
        ...nextMemory,
        dynamicPrompt: refreshed.dynamicPrompt,
        stableSystemBlocks: Array.isArray(refreshed.stableSystemBlocks) ? refreshed.stableSystemBlocks : [],
        dynamicContextBlocks: Array.isArray(refreshed.dynamicContextBlocks) ? refreshed.dynamicContextBlocks : [],
        assistantOnlyContextBlocks: Array.isArray(refreshed.assistantOnlyContextBlocks) ? refreshed.assistantOnlyContextBlocks : [],
        promptSnapshot: refreshed.promptSnapshot || nextMemory.promptSnapshot || null,
        promptSegments: refreshed.promptSegments || nextMemory.promptSegments || null,
        affinity: refreshed.affinity,
        context: refreshed.memoryContext || null,
        dirty: false
      };
      events.push(createEvent('checkpoint', {
        node: 'draft_reply',
        stage: 'prompt_refreshed'
      }));
    }
    const finalPlan = state.plan?.finalPlan || rebuildFinalPlanFromSteps(state);
    const toolEvidenceBundle = buildToolEvidenceBundleImpl(state);
    const finalExecLogs = normalizeArray(toolEvidenceBundle.execLogs).length > 0
      ? normalizeArray(toolEvidenceBundle.execLogs)
      : normalizeArray(state.plan?.finalExecLogs);
    const synthesisDynamicPrompt = [
      String(nextMemory.dynamicPrompt || '').trim(),
      String(nextMemory.globalToolEvidence || state.memory?.globalToolEvidence || '').trim()
    ].filter(Boolean).join('\n\n');
    const continuityStateMessage = buildContinuitySystemMessage({
      ...state,
      memory: nextMemory
    });
    const directChatCompileMeta = normalizeObject(state.execution?.directChatToolCompile, {});
    let draftReply = '';
    if (directChatCompileMeta.enabled) {
      const compiledAssistantMessage = normalizeObject(directChatCompileMeta.assistantMessage, {});
      const toolResultMessages = normalizeArray(state.execution?.toolResults).map((item) => ({
        role: 'tool',
        tool_call_id: String(item?.tool_call_id || '').trim(),
        content: String(item?.result || '')
      }));
      const followupMessages = normalizeArray(state.messages).length > 0
        ? normalizeArray(state.messages)
        : normalizeArray([
          ...getMainConversationSystemMessages({
            ...state,
            memory: nextMemory
          }, {
            isReviewRoute: isReviewMode(request.reviewMode),
            disableMemoryCliInstruction: true
          }),
          ...buildDirectReplyMessages({
            ...state,
            memory: nextMemory
          }, request.imageUrl
            ? buildVisionMessageContent(request.question || '', request.imageUrl, request.imageUrls)
            : (request.question || ''), []).messages.filter((item) => String(item?.role || '').trim() !== 'system'),
          compiledAssistantMessage,
          ...toolResultMessages
        ]).filter(Boolean);
      const assistantFollowup = normalizeMessageForToolLoop(await requestAssistantMessageImpl(followupMessages, {
        ...normalizeObject(directChatCompileMeta.directContext, {}),
        dispatchBranch: 'tool_plan',
        triggerBranch: 'draft_reply.followup_after_tools',
        disableTools: true,
        allowedTools: []
      }));
      const followupToolCalls = normalizeArray(assistantFollowup.tool_calls);
      if (followupToolCalls.length > 0) {
        const appendedPlan = compileDirectChatToolCallsToPlan(
          followupToolCalls,
          state.plan,
          {
            append: true,
            allowedTools: computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn)
          }
        );
        const followupEvents = events.concat(
          followupToolCalls.map((toolCall) => createEvent('tool_call_detected', {
            node: 'draft_reply',
            tool_name: String(toolCall?.function?.name || '').trim(),
            tool_call_id: String(toolCall?.id || '').trim()
          })),
          [createEvent('node_complete', { node: 'draft_reply' })]
        );
        return saveAndEmit({
          ...state,
          plan: appendedPlan,
          execution: {
            ...state.execution,
            status: 'repairing',
            currentNode: 'draft_reply',
            retryQueue: []
          },
          events: followupEvents
        }, 'draft_reply', 'running', followupEvents);
      }
      const resolvedReply = await resolveToolLoopReply(
        assistantFollowup,
        followupMessages,
        normalizeObject(directChatCompileMeta.directContext, {}),
        'post_tool_empty_reply',
        normalizeArray(state.execution?.toolResults),
        {
          telemetry: {
            onEvent(event) {
              if (event) events.push(event);
            },
            rawErrorMessage: ''
          }
        }
      );
      draftReply = String(resolvedReply.text || '').trim();
      events.push(createEvent('tool_loop_forced_answer', {
        node: 'draft_reply',
        reason: 'compiled_tool_plan_followup'
      }));
    } else {
      const hasToolMessages = normalizeArray(toolEvidenceBundle.toolMessages).length > 0
        && toolEvidenceBundle.assistantToolCallMessage;
      let fallbackReason = '';
      if (hasToolMessages) {
        const followupMessages = normalizeArray([
          ...getMainConversationSystemMessages({
            ...state,
            memory: nextMemory
          }, {
            isReviewRoute: isReviewMode(request.reviewMode),
            disableMemoryCliInstruction: true
          }),
          ...(continuityStateMessage ? [continuityStateMessage] : []),
          ...buildDirectReplyMessages({
            ...state,
            memory: nextMemory
          }, request.imageUrl
            ? buildVisionMessageContent(request.question || '', request.imageUrl, request.imageUrls)
            : (request.question || ''), []).messages.filter((item) => String(item?.role || '').trim() !== 'system'),
          toolEvidenceBundle.assistantToolCallMessage,
          ...toolEvidenceBundle.toolMessages
        ]).filter(Boolean);
        try {
          followupModelCalls += 1;
          const assistantFollowup = normalizeMessageForToolLoop(await requestAssistantMessageImpl(followupMessages, {
            question: request.question,
            userId: request.userId,
            dynamicPrompt: synthesisDynamicPrompt,
            modelConfig: request.modelConfig,
            routePolicyKey: request.routePolicyKey,
            routeDebugKey: request.routeDebugKey || request.routeMeta?.routeDebugKey,
            reviewMode: request.reviewMode,
            routeMeta: request.routeMeta,
            requestTrace: request.requestTrace || request.routeMeta?.requestTrace,
            topRouteType: request.topRouteType,
            customPrompt: request.customPrompt,
            source: 'draft_reply',
            dispatchBranch: 'tool_plan',
            triggerBranch: 'draft_reply.followup_after_tools',
            disableTools: true,
            allowedTools: []
          }));
          const stable = isStableToolFollowupReply(assistantFollowup);
          if (stable.ok) {
            draftReply = stable.text;
            events.push(createEvent('tool_result_injected', {
              node: 'draft_reply',
              track: 'tool_messages',
              toolResultCount: toolEvidenceBundle.toolResultCount,
              globalEvidenceCount: toolEvidenceBundle.globalEvidenceCount
            }));
          } else {
            fallbackReason = stable.reason || 'unstable_tool_followup';
          }
        } catch (error) {
          fallbackReason = `tool_message_followup_error:${String(error?.message || error || 'unknown').slice(0, 160)}`;
        }
      } else if (normalizeArray(finalExecLogs).length > 0) {
        fallbackReason = 'missing_tool_messages';
      }

      if (!draftReply) {
        if (fallbackReason) {
          events.push(createEvent('tool_result_injection_fallback', {
            node: 'draft_reply',
            reason: fallbackReason,
            toolResultCount: toolEvidenceBundle.toolResultCount,
            globalEvidenceCount: toolEvidenceBundle.globalEvidenceCount
          }));
        }
        synthesisModelCalls += 1;
        draftReply = await synthesizeImpl(
          request.question || '',
          synthesisDynamicPrompt,
          finalPlan,
          finalExecLogs,
          state.plan?.verification || null,
          request.modelConfig,
          continuityStateMessage ? { systemMessages: [continuityStateMessage] } : null
        );
      }
    }
    const nextEvents = events.concat([
      createEvent('draft_reply', {
        preview: String(draftReply || '').slice(0, 180)
      }),
      createEvent('node_complete', { node: 'draft_reply' })
    ]);
    return saveAndEmit({
      ...state,
      output: {
        ...state.output,
        draftReply: String(draftReply || '')
      },
      memory: nextMemory,
      execution: {
        ...state.execution,
        currentNode: 'draft_reply',
        latencyBreakdown: {
          ...normalizeObject(state.execution?.latencyBreakdown, {}),
          model: {
            ...normalizeObject(state.execution?.latencyBreakdown?.model, {}),
            draft_reply_followup_calls: followupModelCalls,
            draft_reply_synthesis_calls: synthesisModelCalls,
            total_model_calls: Number(state.execution?.latencyBreakdown?.model?.total_model_calls || 0)
              + followupModelCalls
              + synthesisModelCalls,
            draft_reply_ms: Math.max(0, Date.now() - draftStartedAt)
          }
        }
      },
      events: nextEvents
    }, 'draft_reply', 'running', nextEvents);
  };
}

function createRouteAfterDraftReply() {
  return function routeAfterDraftReply(state) {
    return String(state.execution?.status || '').trim() === 'repairing' ? 'dispatch' : 'humanize';
  };
}

module.exports = {
  createDraftReplyNode,
  createRouteAfterDraftReply
};
