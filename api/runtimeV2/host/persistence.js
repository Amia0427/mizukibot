function createRuntimePersistence({
  appendRequestTraceEvent,
  emitEvents,
  nextTracePhase,
  normalizeRequestTrace,
  nowTs,
  snapshotState,
  store
}) {
  function normalizeEvents(events) {
    return (Array.isArray(events) ? events : []).filter(Boolean);
  }

  function publishEvents(state, events) {
    if (events.length === 0) return;
    const requestTrace = normalizeRequestTrace(state?.request?.requestTrace)
      || normalizeRequestTrace(state?.request?.routeMeta?.requestTrace);
    if (requestTrace) {
      for (const event of events) {
        const eventType = String(event?.type || 'event').trim() || 'event';
        appendRequestTraceEvent(nextTracePhase(requestTrace, `runtime_v2_${eventType}`, {
          tracePhase: `runtime_v2_${eventType}`,
          stage: String(event?.type || 'runtime_v2_event').trim() || 'runtime_v2_event',
          source: 'runtimeV2',
          node: String(event?.node || state?.thread?.currentNode || '').trim(),
          routePolicyKey: String(state?.request?.routePolicyKey || state?.request?.routeMeta?.routePolicyKey || '').trim(),
          routeDebugKey: String(state?.request?.routeDebugKey || state?.request?.routeMeta?.routeDebugKey || '').trim(),
          topRouteType: String(state?.request?.topRouteType || state?.request?.routeMeta?.topRouteType || '').trim(),
          dispatchBranch: String(state?.request?.dispatchBranch || event?.dispatchBranch || '').trim(),
          triggerBranch: String(event?.triggerBranch || '').trim(),
          durationMs: Number.isFinite(Number(event?.durationMs)) ? Math.max(0, Math.floor(Number(event.durationMs))) : null,
          finalErrorCode: String(event?.finalErrorCode || event?.errorCode || '').trim(),
          error: String(event?.error || event?.rawErrorMessage || '').trim().slice(0, 400)
        }));
      }
    }
    emitEvents(events, state?.request || {});
  }

  function checkpointPayload(state, nodeName, status) {
    return {
      status,
      node: nodeName,
      updatedAt: nowTs(),
      state: snapshotState(state)
    };
  }

  function persistCheckpoint(state, nodeName, status = 'running') {
    const threadId = String(state?.thread?.threadId || '').trim();
    if (!threadId) return;
    store.saveCheckpoint(threadId, checkpointPayload(state, nodeName, status));
  }

  function appendRuntimeEvents(state, events = []) {
    const normalized = normalizeEvents(events);
    if (normalized.length === 0) return;
    const threadId = String(state?.thread?.threadId || '').trim();
    if (threadId) store.appendEvents(threadId, normalized);
    publishEvents(state, normalized);
  }

  function saveTransition(state, nodeName, status = 'running', events = []) {
    const normalized = normalizeEvents(events);
    const threadId = String(state?.thread?.threadId || '').trim();
    if (threadId) {
      store.saveTransition(
        threadId,
        checkpointPayload(state, nodeName, status),
        normalized
      );
    }
    publishEvents(state, normalized);
  }

  return {
    appendRuntimeEvents,
    persistCheckpoint,
    saveTransition
  };
}

module.exports = {
  createRuntimePersistence
};
