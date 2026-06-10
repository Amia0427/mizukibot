const config = require('../../config');
const { createOpenVikingClient } = require('./client');
const {
  getOpenVikingRecallRuntimeState,
  recallOpenVikingForPrompt
} = require('./recall');
const {
  getOpenVikingIngestStatus
} = require('./ingest');
const {
  normalizeArray,
  normalizeText
} = require('./text');

async function diagnoseOpenVikingMemory(options = {}) {
  const cfg = options.config || config;
  const client = options.client || createOpenVikingClient(cfg, {
    timeoutMs: options.timeoutMs || cfg.OPENVIKING_RECALL_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const health = await client.health({
    apiKey: options.apiKey || cfg.OPENVIKING_API_KEY || cfg.OPENVIKING_ADMIN_API_KEY
  });
  const query = normalizeText(options.query || '长期记忆 偏好');
  const recall = query
    ? await recallOpenVikingForPrompt(query, {
        ...options,
        config: cfg,
        client,
        userId: options.userId || 'diagnostic-user',
        groupId: options.groupId || '',
        sessionKey: options.sessionKey || 'diagnostic-session'
      })
    : null;
  return {
    ok: cfg.OPENVIKING_ENABLED !== true || health || cfg.OPENVIKING_RECALL_ENABLED !== true,
    enabled: cfg.OPENVIKING_ENABLED === true,
    ingestEnabled: cfg.OPENVIKING_INGEST_ENABLED === true,
    recallEnabled: cfg.OPENVIKING_RECALL_ENABLED === true,
    baseUrl: cfg.OPENVIKING_BASE_URL || '',
    health,
    query,
    recall: recall
      ? {
          used: recall.used === true,
          rejectedReason: recall.rejectedReason || '',
          itemCount: normalizeArray(recall.items).length,
          diagnostics: recall.diagnostics || {}
        }
      : null,
    runtime: getOpenVikingRecallRuntimeState(cfg),
    ingest: getOpenVikingIngestStatus({
      userId: options.userId || 'diagnostic-user',
      groupId: options.groupId || '',
      sessionKey: options.sessionKey || 'diagnostic-session'
    }, {
      config: cfg
    })
  };
}

module.exports = {
  diagnoseOpenVikingMemory
};
