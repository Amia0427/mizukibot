const config = require('../../config');
const {
  assistantTextPart,
  buildMessage,
  estimateTokens,
  toolCallPart,
  toolResultPart,
  userTextPart
} = require('./parts');
const { createOpenVikingClient } = require('./client');
const { buildIdentity } = require('./identity');
const { OpenVikingCommitScheduler } = require('./scheduler');
const {
  clampText,
  normalizeObject,
  normalizeText
} = require('./text');

let defaultClient = null;
let defaultScheduler = null;

function getDefaultClient() {
  if (!defaultClient) defaultClient = createOpenVikingClient(config);
  return defaultClient;
}

function getDefaultScheduler() {
  if (!defaultScheduler) defaultScheduler = new OpenVikingCommitScheduler(getDefaultClient(), config);
  return defaultScheduler;
}

function isIngestEnabled(cfg = config) {
  return cfg.OPENVIKING_ENABLED === true && cfg.OPENVIKING_INGEST_ENABLED === true;
}

function buildAuth(cfg = config, options = {}) {
  return {
    apiKey: normalizeText(options.apiKey || cfg.OPENVIKING_API_KEY || cfg.OPENVIKING_ADMIN_API_KEY),
    userId: normalizeText(options.openVikingUserHeader || options.openVikingUserId)
  };
}

async function addMessageSafe(client, sessionId, payload, auth, cfg = config) {
  try {
    return await client.addMessage(sessionId, payload, auth);
  } catch (error) {
    if (cfg.ENABLE_DEBUG_LOG) {
      console.warn('[openviking] add_message failed:', error?.message || error);
    }
    return false;
  }
}

async function ingestTurn(input = {}, options = {}) {
  const cfg = options.config || config;
  if (!isIngestEnabled(cfg)) return { ok: false, reason: cfg.OPENVIKING_ENABLED === true ? 'ingest_disabled' : 'openviking_disabled' };
  const identity = buildIdentity(cfg, {
    userId: input.userId,
    senderId: input.senderId || input.userId,
    groupId: input.groupId,
    platform: input.platform || input.channel || 'qq'
  });
  if (identity.bypassed) return { ok: false, reason: 'bypassed_venue', identity };
  const userText = normalizeText(input.userText || input.question);
  const assistantText = normalizeText(input.assistantText || input.finalReply);
  if (!userText && !assistantText) return { ok: false, reason: 'empty_turn', identity };
  const client = options.client || getDefaultClient();
  const scheduler = options.scheduler || getDefaultScheduler();
  const auth = buildAuth(cfg, { ...options, openVikingUserId: identity.openVikingUserId });
  let writes = 0;
  if (userText) {
    const payload = buildMessage('user', [userTextPart(userText, {
      isGroup: identity.isGroup,
      senderName: input.senderName || input.userName,
      senderId: input.userId
    })]);
    if (await addMessageSafe(client, identity.sessionId, payload, auth, cfg)) {
      writes += 1;
      scheduler.recordMessage(identity.sessionId, estimateTokens(userText), auth);
    }
  }
  if (assistantText) {
    const payload = buildMessage('assistant', [assistantTextPart(assistantText)]);
    if (await addMessageSafe(client, identity.sessionId, payload, auth, cfg)) {
      writes += 1;
      scheduler.recordMessage(identity.sessionId, estimateTokens(assistantText), auth);
    }
  }
  return { ok: writes > 0, writes, identity };
}

function ingestTurnAsync(input = {}, options = {}) {
  Promise.resolve()
    .then(() => ingestTurn(input, options))
    .catch((error) => {
      const cfg = options.config || config;
      if (cfg.ENABLE_DEBUG_LOG) {
        console.warn('[openviking] async ingest failed:', error?.message || error);
      }
    });
}

async function ingestToolIo(input = {}, options = {}) {
  const cfg = options.config || config;
  if (!isIngestEnabled(cfg) || cfg.OPENVIKING_CAPTURE_TOOL_IO !== true) return { ok: false, reason: 'tool_io_disabled' };
  const identity = buildIdentity(cfg, {
    userId: input.userId,
    senderId: input.senderId || input.userId,
    groupId: input.groupId,
    platform: input.platform || input.channel || 'qq'
  });
  if (identity.bypassed) return { ok: false, reason: 'bypassed_venue', identity };
  const toolName = normalizeText(input.toolName);
  if (!toolName) return { ok: false, reason: 'missing_tool_name', identity };
  const client = options.client || getDefaultClient();
  const scheduler = options.scheduler || getDefaultScheduler();
  const auth = buildAuth(cfg, { ...options, openVikingUserId: identity.openVikingUserId });
  const parts = [];
  if (input.toolInput !== undefined) parts.push(toolCallPart(toolName, clampText(typeof input.toolInput === 'string' ? input.toolInput : JSON.stringify(normalizeObject(input.toolInput)), 500)));
  if (input.toolOutput !== undefined) parts.push(toolResultPart(toolName, clampText(typeof input.toolOutput === 'string' ? input.toolOutput : JSON.stringify(normalizeObject(input.toolOutput)), 500)));
  if (parts.length === 0) return { ok: false, reason: 'empty_tool_io', identity };
  const payload = buildMessage('assistant', parts);
  const ok = await addMessageSafe(client, identity.sessionId, payload, auth, cfg);
  if (ok) scheduler.recordMessage(identity.sessionId, estimateTokens(JSON.stringify(parts)), auth);
  return { ok, identity };
}

function getOpenVikingIngestStatus(sessionInput = {}, options = {}) {
  const cfg = options.config || config;
  const identity = buildIdentity(cfg, {
    userId: sessionInput.userId,
    senderId: sessionInput.senderId || sessionInput.userId,
    groupId: sessionInput.groupId,
    platform: sessionInput.platform || sessionInput.channel || 'qq'
  });
  return {
    enabled: isIngestEnabled(cfg),
    identity,
    scheduler: getDefaultScheduler().getStatus(identity.sessionId)
  };
}

module.exports = {
  buildAuth,
  getDefaultClient,
  getDefaultScheduler,
  getOpenVikingIngestStatus,
  ingestToolIo,
  ingestTurn,
  ingestTurnAsync,
  isIngestEnabled
};
