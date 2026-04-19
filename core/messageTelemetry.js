const fs = require('fs');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');
const { createCheckpointStore, resolveThreadId } = require('../utils/langgraphV2Store');
const { appendPerfEvent } = require('../utils/perfRuntime');
const { createJsonLineHotWriter } = require('../utils/jsonHotStore');

const timingLogWriters = new Map();

function getRawMessageTimestampMs(msg = {}) {
  const seconds = Number(msg?.time || 0);
  return seconds > 0 ? (seconds * 1000) : 0;
}

function appendInboundTimingLog(logFilePath, enableDebugLog, payload = {}) {
  if (!enableDebugLog) return;
  try {
    const normalized = payload && typeof payload === 'object' ? payload : {};
    const writerKey = String(logFilePath || '').trim();
    if (!writerKey) return;
    if (!timingLogWriters.has(writerKey)) {
      timingLogWriters.set(writerKey, createJsonLineHotWriter(writerKey, {
        debounceMs: 150,
        maxDelayMs: 1500
      }));
    }
    timingLogWriters.get(writerKey).append({
      recordedAt: new Date().toISOString(),
      processId: process.pid,
      ...normalized
    });
  } catch (_) {}
}

function createInboundTimingLogger(logFilePath, enableDebugLog) {
  return function logInboundTiming(payload = {}) {
    appendInboundTimingLog(logFilePath, enableDebugLog, payload);
    appendPerfEvent({
      category: 'inbound_timing',
      ...payload
    });
  };
}

function createReplyTelemetryBridge(runtimeConfig = {}) {
  const store = createCheckpointStore({
    checkpointDir: runtimeConfig.LANGGRAPH_V2_CHECKPOINT_DIR,
    eventDir: runtimeConfig.LANGGRAPH_V2_EVENT_DIR
  });

  return function buildReplyTelemetry({
    senderId = '',
    groupId = '',
    chatType = 'group',
    routePolicyKey = '',
    topRouteType = '',
    routeMeta = null
  } = {}) {
    const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object'
      ? {
          ...routeMeta,
          groupId: String(groupId || routeMeta.groupId || routeMeta.group_id || '').trim(),
          chatType: String(chatType || routeMeta.chatType || '').trim(),
          topRouteType: String(topRouteType || routeMeta.topRouteType || '').trim(),
          routePolicyKey: String(routePolicyKey || routeMeta.routePolicyKey || '').trim()
        }
      : {
          groupId: String(groupId || '').trim(),
          chatType: String(chatType || '').trim(),
          topRouteType: String(topRouteType || '').trim(),
          routePolicyKey: String(routePolicyKey || '').trim()
        };
    const sessionKey = resolveShortTermSessionKey(senderId, normalizedRouteMeta);
    const threadId = resolveThreadId({
      userId: senderId,
      routePolicyKey,
      reviewMode: '',
      routeMeta: normalizedRouteMeta,
      sessionKey,
      imageUrl: null,
      options: {
        routeMeta: normalizedRouteMeta
      }
    });

    return {
      threadId,
      routePolicyKey: String(routePolicyKey || '').trim(),
      topRouteType: String(topRouteType || '').trim(),
      onEvent(event = {}) {
        if (!threadId) return;
        const normalized = event && typeof event === 'object' ? event : {};
        store.appendEvents(threadId, [normalized]);
        appendPerfEvent({
          category: 'reply_event',
          threadId,
          routePolicyKey: String(routePolicyKey || '').trim(),
          topRouteType: String(topRouteType || '').trim(),
          ...normalized
        });
      }
    };
  };
}

function createMessageTelemetryCoordinator(deps = {}) {
  const {
    buildReplyTelemetry,
    runPersistInBackgroundFromCheckpoint
  } = deps;

  function maybeRunDeferredPersist(replyEnvelope = {}) {
    const replyOptions = replyEnvelope?.replyOptions && typeof replyEnvelope.replyOptions === 'object'
      ? replyEnvelope.replyOptions
      : null;
    if (replyOptions?.deferPersist !== true) return;
    const routeMeta = replyOptions?.routeMeta && typeof replyOptions.routeMeta === 'object'
      ? replyOptions.routeMeta
      : {};
    const userId = String(routeMeta.userId || routeMeta.user_id || '').trim();
    const sessionKey = resolveShortTermSessionKey(userId, routeMeta);
    const threadId = resolveThreadId({
      userId,
      routePolicyKey: String(replyOptions?.routePolicyKey || '').trim(),
      reviewMode: '',
      routeMeta,
      sessionKey,
      imageUrl: null,
      options: {
        routeMeta
      }
    });
    if (!threadId) return;

    const emitPersistBackgroundEvent = (type = '', payload = {}) => {
      const telemetry = buildReplyTelemetry({
        senderId: userId,
        groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
        chatType: String(routeMeta.chatType || '').trim(),
        routePolicyKey: String(replyOptions?.routePolicyKey || '').trim(),
        topRouteType: String(replyOptions?.topRouteType || '').trim(),
        routeMeta
      });
      if (typeof telemetry?.onEvent === 'function') {
        telemetry.onEvent({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: Date.now(),
          type: String(type || 'event').trim() || 'event',
          node: 'persist_background',
          threadId,
          ...payload
        });
      }
    };

    setTimeout(() => {
      emitPersistBackgroundEvent('persist_background_start');
      console.log('[persist-background] start', {
        threadId,
        routePolicyKey: String(replyOptions?.routePolicyKey || '').trim(),
        topRouteType: String(replyOptions?.topRouteType || '').trim()
      });
      const startedAt = Date.now();
      runPersistInBackgroundFromCheckpoint(threadId).catch((error) => {
        emitPersistBackgroundEvent('persist_background_failure', {
          durationMs: Math.max(0, Date.now() - startedAt),
          error: error?.message || String(error || '')
        });
        console.error('[persist-background] failed', {
          threadId,
          error: error?.message || String(error || '')
        });
      }).then((result) => {
        if (result) {
          emitPersistBackgroundEvent('persist_background_success', {
            durationMs: Math.max(0, Date.now() - startedAt)
          });
        }
      });
    }, 0);
  }

  return {
    maybeRunDeferredPersist
  };
}

module.exports = {
  appendInboundTimingLog,
  createInboundTimingLogger,
  createMessageTelemetryCoordinator,
  createReplyTelemetryBridge,
  getRawMessageTimestampMs
};
