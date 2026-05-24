const { normalizeExecutionEnvelope } = require('../contracts');
const { buildMemoryToolTelemetry } = require('../runtime/memoryToolTelemetry');

function createDispatchNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const stableHash = typeof deps.stableHash === 'function'
    ? deps.stableHash
    : ((value) => JSON.stringify(value || {}));
  const isCompletedSideEffectStep = typeof deps.isCompletedSideEffectStep === 'function'
    ? deps.isCompletedSideEffectStep
    : (() => false);
  const findEvidenceEnvelope = typeof deps.findEvidenceEnvelope === 'function'
    ? deps.findEvidenceEnvelope
    : (() => null);
  const isDirectChatRequest = typeof deps.isDirectChatRequest === 'function'
    ? deps.isDirectChatRequest
    : (() => false);
  const buildDirectChatExecutionBatches = typeof deps.buildDirectChatExecutionBatches === 'function'
    ? deps.buildDirectChatExecutionBatches
    : (() => []);
  const canRunStepsInParallel = typeof deps.canRunStepsInParallel === 'function'
    ? deps.canRunStepsInParallel
    : (() => false);
  const buildExecutionBatches = typeof deps.buildExecutionBatches === 'function'
    ? deps.buildExecutionBatches
    : ((steps) => [{ mode: canRunStepsInParallel(steps) ? 'parallel' : 'serial', items: normalizeArray(steps) }]);
  const buildLiveMainConversationSnapshot = typeof deps.buildLiveMainConversationSnapshot === 'function'
    ? deps.buildLiveMainConversationSnapshot
    : (() => null);
  const computeEffectiveAllowedTools = typeof deps.computeEffectiveAllowedTools === 'function'
    ? deps.computeEffectiveAllowedTools
    : (() => []);
  const createMemoryCliTurnState = typeof deps.createMemoryCliTurnState === 'function'
    ? deps.createMemoryCliTurnState
    : ((value) => value || null);
  const persistCheckpoint = typeof deps.persistCheckpoint === 'function'
    ? deps.persistCheckpoint
    : () => {};
  const appendRuntimeEvents = typeof deps.appendRuntimeEvents === 'function'
    ? deps.appendRuntimeEvents
    : () => {};
  const updatePlanStepsWithEnvelope = typeof deps.updatePlanStepsWithEnvelope === 'function'
    ? deps.updatePlanStepsWithEnvelope
    : ((steps) => steps);
  const getPolicy = typeof deps.getPolicy === 'function'
    ? deps.getPolicy
    : (() => ({}));
  const isSideEffectPolicy = typeof deps.isSideEffectPolicy === 'function'
    ? deps.isSideEffectPolicy
    : (() => false);
  const executeBatch = typeof deps.executeBatch === 'function'
    ? deps.executeBatch
    : (async () => []);
  const runCapabilityPreflight = typeof deps.runCapabilityPreflight === 'function'
    ? deps.runCapabilityPreflight
    : (async () => ({ skipped: true, results: [], evidenceMessage: '', memoryCliTurn: null }));
  const rebuildFinalPlanFromSteps = typeof deps.rebuildFinalPlanFromSteps === 'function'
    ? deps.rebuildFinalPlanFromSteps
    : ((state) => state.plan || {});
  const buildExecLogsFromSteps = typeof deps.buildExecLogsFromSteps === 'function'
    ? deps.buildExecLogsFromSteps
    : (() => []);
  const mergeAllowedToolsWithMemoryCli = typeof deps.mergeAllowedToolsWithMemoryCli === 'function'
    ? deps.mergeAllowedToolsWithMemoryCli
    : ((allowed) => normalizeArray(allowed));
  const requiresToolEvidence = typeof deps.requiresToolEvidence === 'function'
    ? deps.requiresToolEvidence
    : (() => false);
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const normalizeExecutionEnvelopeImpl = typeof deps.normalizeExecutionEnvelope === 'function'
    ? deps.normalizeExecutionEnvelope
    : normalizeExecutionEnvelope;
  const config = deps.config || {};

  return async function dispatchNode(state) {
    const request = normalizeObject(state.request, {});
    const dispatchStartedAt = Date.now();
    const allSteps = normalizeArray(state.plan?.steps).map((step) => ({ ...step }));
    const normalizeStepDependencies = (step = {}) => {
      const deps = normalizeArray(step.dependsOn || step.depends_on || step.dependencies)
        .map((item) => String(typeof item === 'string' ? item : item?.id || item?.step_id || '').trim())
        .filter(Boolean);
      const runtimeSourceStepId = String(step.runtimeBinding?.sourceStepId || '').trim();
      return Array.from(new Set(runtimeSourceStepId ? deps.concat([runtimeSourceStepId]) : deps));
    };
    const withImplicitDependencies = (step = {}) => ({
      ...step,
      dependsOn: normalizeStepDependencies(step)
    });
    const resolveRuntimeBoundStep = (step, currentSteps = allSteps) => {
      const binding = normalizeObject(step?.runtimeBinding, null);
      if (!binding) return { ...step };
      const sourceStepId = String(binding.sourceStepId || '').trim();
      const sourceStep = normalizeArray(currentSteps).find((candidate) => String(candidate?.id || '').trim() === sourceStepId);
      const sourceEnvelope = normalizeArray(sourceStep?.evidence).slice(-1)[0] || null;
      if (!sourceEnvelope || String(sourceEnvelope?.status || '').trim() !== 'completed') {
        return {
          ...step,
          blockingReason: `runtime_binding_waiting:${sourceStepId || String(binding.sourceTool || '').trim() || 'dependency'}`
        };
      }
      const sourceResult = String(sourceEnvelope?.result || '').trim();
      if (String(binding.type || '').trim() === 'best_url_from_previous_search') {
        const url = sourceResult.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line));
        if (!url) {
          return {
            ...step,
            blockingReason: 'runtime_binding_unresolved:web_fetch_url'
          };
        }
        return {
          ...step,
          inputs: {
            ...normalizeObject(step.inputs, {}),
            [String(binding.targetArg || 'url').trim() || 'url']: url
          }
        };
      }
      if (String(binding.type || '').trim() === 'memory_ref_from_previous_search') {
        let parsed = null;
        try {
          parsed = JSON.parse(sourceResult);
        } catch (_) {
          parsed = null;
        }
        const ref = String(parsed?.results?.[0]?.ref || '').trim();
        if (!ref) {
          return {
            ...step,
            blockingReason: 'runtime_binding_unresolved:memory_ref'
          };
        }
        return {
          ...step,
          inputs: {
            ...normalizeObject(step.inputs, {}),
            [String(binding.targetArg || 'command').trim() || 'command']: `mem open --ref ${JSON.stringify(ref)}`
          }
        };
      }
      return { ...step };
    };
    const toolSteps = allSteps.filter((step) => ['tool', 'memory_cli'].includes(String(step.kind || '').trim()));
    const pendingSteps = toolSteps.filter((step) => {
      const argsHash = stableHash(step.inputs || {});
      if (isCompletedSideEffectStep(step) && findEvidenceEnvelope(step, argsHash)) return false;
      return ['pending', 'failed'].includes(String(step.status || '').trim());
    });
    const retryQueueIds = new Set(normalizeArray(state.execution?.retryQueue).map((item) => String(item?.step_id || '').trim()).filter(Boolean));
    const selectedBase = retryQueueIds.size > 0
      ? pendingSteps.filter((step) => retryQueueIds.has(String(step.id || '').trim()))
      : pendingSteps;
    const dependencyCompletedIds = new Set(
      allSteps
        .filter((step) => String(step.status || '').trim() === 'completed')
        .map((step) => String(step.id || '').trim())
        .filter(Boolean)
    );
    const selectedSteps = [];
    const selectedIds = new Set();
    for (const step of selectedBase) {
      const deps = normalizeStepDependencies(step);
      if (!deps.every((dep) => dependencyCompletedIds.has(dep) || selectedIds.has(dep))) continue;
      selectedSteps.push(withImplicitDependencies(step));
      const stepId = String(step.id || '').trim();
      if (stepId) selectedIds.add(stepId);
      if (selectedSteps.length >= Math.max(1, Number(config.PLAN_MAX_STEPS) || 5)) break;
    }
    const selectedStepToolNames = Array.from(new Set(
      selectedSteps
        .map((step) => String(step?.tool || '').trim())
        .filter(Boolean)
    ));
    const latencyProfile = String(state.execution?.latencyDecision?.profile || '').trim().toLowerCase();
    const mustRunPreflight = Boolean(
      config.GLOBAL_TOOL_PREFLIGHT_CHAT_FAST === true
      || latencyProfile !== 'chat_fast'
      || requiresToolEvidence({
        question: String(request.question || '').trim(),
        cleanText: String(request.question || '').trim(),
        topRouteType: request.topRouteType,
        facets: normalizeObject(request.routeMeta?.facets, request.facets),
        intent: normalizeObject(request.routeMeta?.intent, request.intent),
        meta: normalizeObject(request.routeMeta, {})
      })
    );
    const selectedStepCount = selectedSteps.length;
    const preflightEvents = [createEvent('node_start', {
      node: 'dispatch',
      stepCount: selectedStepCount,
      preflightRequired: mustRunPreflight
    })];
    const preflightStartedAt = Date.now();
    const preflightCalls = mustRunPreflight ? 1 : 0;
    if (mustRunPreflight) {
      preflightEvents.push(createEvent('dispatch_preflight_start', {
        node: 'dispatch',
        allowedTools: selectedStepToolNames,
        stepCount: selectedStepCount
      }));
      appendRuntimeEvents(state, preflightEvents);
    }
    const preflight = mustRunPreflight
      ? await runCapabilityPreflight(request.question || '', {
        question: String(request.question || '').trim(),
        userId: request.userId,
        routePolicyKey: request.routePolicyKey,
        topRouteType: request.topRouteType,
        routePrompt: request.routePrompt,
        routeMeta: request.routeMeta,
        reviewMode: request.reviewMode,
        allowedGlobalTools: selectedStepToolNames,
        memoryCliTurn: state.execution?.memoryCliTurn,
        policy: {
          allowGlobalTools: Boolean(request.allowTools),
          allowedGlobalTools: selectedStepToolNames
        }
      })
      : {
        skipped: true,
        reason: 'chat_fast_skip',
        results: [],
        evidenceMessage: '',
        memoryCliTurn: state.execution?.memoryCliTurn || null
      };
    const preflightDurationMs = Math.max(0, Date.now() - preflightStartedAt);
    if (mustRunPreflight) {
      appendRuntimeEvents(state, [createEvent('dispatch_preflight_complete', {
        node: 'dispatch',
        durationMs: preflightDurationMs,
        skipped: Boolean(preflight?.skipped),
        reason: String(preflight?.reason || '').trim(),
        resultCount: normalizeArray(preflight?.results).length
      })]);
    }
    const hasExplicitDependencies = selectedSteps.some((step) => normalizeStepDependencies(step).length > 0);
    const directChatBatchExecution = isDirectChatRequest(request) && !hasExplicitDependencies;
    const directChatBatches = directChatBatchExecution
      ? buildDirectChatExecutionBatches(selectedSteps, (step) => step)
      : [];
    const directChatBatchByStepId = new Map();
    for (const batch of directChatBatches) {
      for (const step of normalizeArray(batch.items)) {
        const stepId = String(step?.id || '').trim();
        if (!stepId) continue;
        directChatBatchByStepId.set(stepId, {
          batchId: String(batch.batchId || '').trim(),
          batchIndex: Number.isFinite(Number(batch.batchIndex)) ? Number(batch.batchIndex) : null
        });
      }
    }
    const scheduledBatches = directChatBatchExecution ? [] : buildExecutionBatches(selectedSteps);
    const parallelExecution = directChatBatchExecution
      ? directChatBatches.some((batch) => batch.mode === 'parallel' && normalizeArray(batch.items).length > 1)
      : scheduledBatches.some((batch) => batch.mode === 'parallel' && normalizeArray(batch.items).length > 1);
    const events = mustRunPreflight ? [] : preflightEvents;
    events.push(createEvent('dispatch_schedule_ready', {
      node: 'dispatch',
      stepCount: selectedSteps.length,
      parallelExecution,
      preflightRequired: mustRunPreflight,
      preflightDurationMs
    }));
    if (String(preflight?.evidenceMessage || '').trim()) {
      events.push(createEvent('dispatch_preflight', {
        node: 'dispatch',
        resultCount: normalizeArray(preflight?.results).length
      }));
    }
    const dispatchRuntimeOptions = {
      node: 'dispatch',
      requestTrace: request.requestTrace || request.routeMeta?.requestTrace,
      routeMeta: request.routeMeta,
      mainConversationSnapshot: state.memory?.mainConversationSnapshot && typeof state.memory.mainConversationSnapshot === 'object'
        ? state.memory.mainConversationSnapshot
        : buildLiveMainConversationSnapshot(state, {
            affinity: state.memory?.affinity,
            allowedTools: computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn),
            source: 'dispatch'
          })
    };

    const nextSteps = allSteps.map((step) => {
      const stepId = String(step?.id || '').trim();
      const batchMeta = directChatBatchByStepId.get(stepId);
      return {
        ...step,
        ...(batchMeta?.batchId ? { batchId: batchMeta.batchId } : {}),
        ...(batchMeta && batchMeta.batchIndex !== null ? { batchIndex: batchMeta.batchIndex } : {}),
        evidence: normalizeArray(step.evidence).map((item) => ({ ...item }))
      };
    });
    const toolResults = [];
    let nextMemoryCliTurn = createMemoryCliTurnState(state.execution?.memoryCliTurn);
    let memoryDirty = Boolean(state.memory?.dirty);

    const buildDispatchState = () => ({
      ...state,
      plan: {
        ...state.plan,
        steps: nextSteps
      },
      execution: {
        ...state.execution,
        toolResults,
        memoryCliTurn: nextMemoryCliTurn
      }
    });
    const isRuntimeBindingUnresolved = (step = {}) => (
      String(step.blockingReason || '').trim().startsWith('runtime_binding_unresolved:')
    );
    const buildRuntimeBindingFailureEnvelope = (step = {}) => ({
      tool_call_id: `${step.id}_binding_${Date.now()}`,
      step_id: String(step.id || '').trim(),
      tool_name: String(step.tool || '').trim(),
      args_hash: stableHash(step.inputs || {}),
      args: step.inputs || {},
      status: 'failed',
      result: `Tool error: ${step.blockingReason}`,
      side_effect: false,
      retryable: true,
      attempt: Number(step.attempts || 0) + 1,
      duration_ms: 0,
      source: 'dispatch',
      unsatisfiedRequirement: step.blockingReason,
      runtimeBinding: step.runtimeBinding
    });

    const persistDispatchCheckpoint = (pendingInterrupt) => {
      persistCheckpoint({
        ...buildDispatchState(),
        execution: {
          ...state.execution,
          toolResults,
          memoryCliTurn: nextMemoryCliTurn,
          currentNode: 'dispatch',
          pendingInterrupt: Boolean(pendingInterrupt)
        }
      }, 'dispatch', 'running');
    };

    const checkpointBeforeSideEffect = (step) => {
      const preEvents = [createEvent('checkpoint', {
        node: 'dispatch',
        stage: 'before_side_effect',
        step_id: step.id,
        tool_name: step.tool
      })];
      appendRuntimeEvents(state, preEvents);
      persistDispatchCheckpoint(true);
    };

    const checkpointAfterSideEffect = (envelope) => {
      const postEvents = [createEvent('checkpoint', {
        node: 'dispatch',
        stage: 'after_side_effect',
        step_id: envelope.step_id,
        tool_name: envelope.tool_name,
        status: envelope.status
      })];
      appendRuntimeEvents(state, postEvents);
      persistDispatchCheckpoint(false);
    };

    const normalizeDispatchEnvelope = (envelope = {}) => {
      const fallbackStep = nextSteps.find((step) => String(step?.id || '').trim() === String(envelope?.step_id || envelope?.stepId || '').trim())
        || selectedSteps.find((step) => String(step?.id || '').trim() === String(envelope?.step_id || envelope?.stepId || '').trim())
        || {};
      return normalizeExecutionEnvelopeImpl(envelope, fallbackStep, {
        stableHash,
        source: envelope?.source || 'dispatch'
      });
    };

    const applyEnvelope = (envelope) => {
      const normalizedEnvelope = normalizeDispatchEnvelope(envelope);
      toolResults.push(normalizedEnvelope);
      const updatedSteps = updatePlanStepsWithEnvelope(nextSteps, normalizedEnvelope);
      nextSteps.splice(0, nextSteps.length, ...updatedSteps);
      if (normalizedEnvelope.memoryCliTurn) {
        nextMemoryCliTurn = createMemoryCliTurnState(normalizedEnvelope.memoryCliTurn);
      }
      if (normalizedEnvelope.invalidateMemoryPrompt) {
        memoryDirty = true;
      }
      if (normalizedEnvelope.side_effect) {
        checkpointAfterSideEffect(normalizedEnvelope);
      }
    };

    for (const step of selectedSteps) {
      const policy = getPolicy(step.tool);
      const argsHash = stableHash(step.inputs || {});
      const reusableEnvelope = findEvidenceEnvelope(step, argsHash);
      if (String(step.status || '').trim() === 'completed' && reusableEnvelope && reusableEnvelope.side_effect) {
        toolResults.push(normalizeDispatchEnvelope({
          ...reusableEnvelope,
          ...(String(reusableEnvelope?.batch_id || step.batchId || '').trim()
            ? { batch_id: String(reusableEnvelope?.batch_id || step.batchId).trim() }
            : {}),
          ...(
            Number.isFinite(Number(reusableEnvelope?.batch_index))
              ? { batch_index: Number(reusableEnvelope.batch_index) }
              : (Number.isFinite(Number(step.batchIndex)) ? { batch_index: Number(step.batchIndex) } : {})
          ),
          reused: true
        }));
        continue;
      }

      if (directChatBatchExecution) continue;
      if (parallelExecution) continue;

      const preparedStep = resolveRuntimeBoundStep(step, nextSteps);
      if (isRuntimeBindingUnresolved(preparedStep)) {
        applyEnvelope(buildRuntimeBindingFailureEnvelope(preparedStep));
        continue;
      }

      if (isSideEffectPolicy(policy)) {
        checkpointBeforeSideEffect(preparedStep);
      }

      const [envelope] = await executeBatch([preparedStep], buildDispatchState(), {
        ...dispatchRuntimeOptions,
        allowedTools: state.request?.allowedTools
      });
      applyEnvelope(envelope);
    }

    if (directChatBatchExecution && selectedSteps.length > 0) {
      for (const batch of directChatBatches) {
        const batchItems = normalizeArray(batch.items);
        if (batchItems.length === 0) continue;
        if (batch.mode !== 'parallel' || batchItems.length < 2) {
          for (const step of batchItems) {
            const runnableStep = resolveRuntimeBoundStep({
              ...step,
              ...(String(batch.batchId || '').trim() ? { batchId: String(batch.batchId).trim() } : {}),
              ...(Number.isFinite(Number(batch.batchIndex)) ? { batchIndex: Number(batch.batchIndex) } : {})
            }, nextSteps);
            if (isRuntimeBindingUnresolved(runnableStep)) {
              applyEnvelope(buildRuntimeBindingFailureEnvelope(runnableStep));
              continue;
            }
            if (isSideEffectPolicy(getPolicy(step.tool))) {
              checkpointBeforeSideEffect(runnableStep);
            }
            const [envelope] = await executeBatch([runnableStep], buildDispatchState(), {
              ...dispatchRuntimeOptions,
              allowedTools: state.request?.allowedTools,
              batches: [{
                mode: 'serial',
                items: [runnableStep]
              }]
            });
            applyEnvelope(envelope);
          }
          continue;
        }
        const resolvedBatchItems = batchItems.map((step) => resolveRuntimeBoundStep({
          ...step,
          ...(String(batch.batchId || '').trim() ? { batchId: String(batch.batchId).trim() } : {}),
          ...(Number.isFinite(Number(batch.batchIndex)) ? { batchIndex: Number(batch.batchIndex) } : {})
        }, nextSteps));
        for (const step of resolvedBatchItems.filter(isRuntimeBindingUnresolved)) {
          applyEnvelope(buildRuntimeBindingFailureEnvelope(step));
        }
        const runnableBatchItems = resolvedBatchItems.filter((step) => !isRuntimeBindingUnresolved(step));
        const sideEffectSteps = runnableBatchItems.filter((step) => isSideEffectPolicy(getPolicy(step.tool)));
        if (sideEffectSteps.length > 0) {
          const preEvents = sideEffectSteps.map((step) => createEvent('checkpoint', {
            node: 'dispatch',
            stage: 'before_side_effect',
            step_id: step.id,
            tool_name: step.tool
          }));
          appendRuntimeEvents(state, preEvents);
          persistDispatchCheckpoint(true);
        }
        const batchResults = await executeBatch(runnableBatchItems, buildDispatchState(), {
          ...dispatchRuntimeOptions,
          allowedTools: state.request?.allowedTools,
          batches: [{
            mode: 'parallel',
            items: runnableBatchItems
          }]
        });
        for (const envelope of batchResults) {
          applyEnvelope(envelope);
        }
      }
    } else if (parallelExecution && selectedSteps.length > 0) {
      for (const batch of scheduledBatches) {
        const resolvedBatchItems = normalizeArray(batch.items)
          .map((step) => resolveRuntimeBoundStep(step, nextSteps));
        for (const step of resolvedBatchItems.filter(isRuntimeBindingUnresolved)) {
          applyEnvelope(buildRuntimeBindingFailureEnvelope(step));
        }
        const runnableBatchItems = resolvedBatchItems.filter((step) => !isRuntimeBindingUnresolved(step));
        if (runnableBatchItems.length === 0) continue;
        for (const step of runnableBatchItems.filter((item) => isSideEffectPolicy(getPolicy(item.tool)))) {
          checkpointBeforeSideEffect(step);
        }
        const batchResults = await executeBatch(runnableBatchItems, buildDispatchState(), {
          ...dispatchRuntimeOptions,
          allowedTools: state.request?.allowedTools,
          batches: [{
            mode: batch.mode,
            items: runnableBatchItems
          }]
        });
        for (const envelope of batchResults) {
          applyEnvelope(envelope);
        }
      }
    }

    const nextEvents = events
      .concat(toolResults.map((item) => createEvent('tool_result', {
        ...item,
        ...buildMemoryToolTelemetry(item)
      })))
      .concat([createEvent('node_complete', { node: 'dispatch' })]);

    return saveAndEmit({
      ...state,
      plan: {
        ...state.plan,
        steps: nextSteps,
        currentStepId: nextSteps.find((step) => ['pending', 'failed'].includes(String(step.status || '').trim()))?.id || '',
        status: toolResults.some((item) => item.status !== 'completed') ? 'dispatch_partial' : 'dispatch_completed',
        finalPlan: rebuildFinalPlanFromSteps({
          ...state,
          plan: {
            ...state.plan,
            steps: nextSteps
          }
        }),
        finalExecLogs: buildExecLogsFromSteps(nextSteps)
      },
      execution: {
        ...state.execution,
        status: 'dispatched',
        currentNode: 'dispatch',
        parallelExecution,
        toolResults,
        retryQueue: [],
        memoryCliTurn: nextMemoryCliTurn,
        latencyBreakdown: {
          ...normalizeObject(state.execution?.latencyBreakdown, {}),
          dispatch: {
            tool_exec_ms: Math.max(0, Date.now() - dispatchStartedAt - preflightDurationMs),
            capability_preflight_ms: preflightDurationMs,
            capability_preflight_calls: preflightCalls,
            tool_result_count: toolResults.length,
            scheduled_batch_count: scheduledBatches.length,
            parallel_batch_count: scheduledBatches.filter((batch) => batch.mode === 'parallel').length
          },
          model: {
            ...normalizeObject(state.execution?.latencyBreakdown?.model, {}),
            global_preflight_calls: Number(state.execution?.latencyBreakdown?.model?.global_preflight_calls || 0)
              + preflightCalls,
            total_model_calls: Number(state.execution?.latencyBreakdown?.model?.total_model_calls || 0)
          }
        }
      },
      memory: {
        ...state.memory,
        dirty: memoryDirty,
        globalToolEvidence: String(preflight?.evidenceMessage || state.memory?.globalToolEvidence || '').trim(),
        globalToolResults: normalizeArray(preflight?.results).length > 0
          ? normalizeArray(preflight.results).map((item) => ({ ...item }))
          : normalizeArray(state.memory?.globalToolResults)
      },
      request: {
        ...state.request,
        allowedTools: mergeAllowedToolsWithMemoryCli(state.request?.allowedTools, {
          ...state.request,
          customPrompt: state.request?.customPrompt,
          disableTools: !state.request?.allowTools,
          memoryCliTurn: nextMemoryCliTurn
        })
      },
      events: nextEvents
    }, 'dispatch', 'running', nextEvents);
  };
}

module.exports = {
  createDispatchNode
};
