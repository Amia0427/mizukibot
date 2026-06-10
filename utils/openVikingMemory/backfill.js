const config = require('../../config');
const {
  loadEpisodeProjection,
  loadMemoryNodes,
  loadSessionProjection
} = require('../memory-v3/storage');
const {
  buildMessage,
  estimateTokens,
  userTextPart
} = require('./parts');
const {
  buildIdentity
} = require('./identity');
const {
  getDefaultClient,
  getDefaultScheduler,
  buildAuth
} = require('./ingest');
const {
  clampText,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./text');

function collectBackfillRows(userId = '', options = {}) {
  const targetUserId = normalizeText(userId);
  const rows = [];
  for (const node of loadMemoryNodes()) {
    const item = normalizeObject(node, {});
    if (targetUserId && normalizeText(item.userId) !== targetUserId) continue;
    const text = normalizeText(item.text);
    if (!text) continue;
    rows.push({
      source: 'memory_node',
      userId: normalizeText(item.userId || targetUserId),
      groupId: normalizeText(item.groupId),
      text,
      updatedAt: Number(item.updatedAt || item.createdAt || 0) || 0
    });
  }
  const sessions = loadSessionProjection().sessions || {};
  for (const session of Object.values(sessions)) {
    const item = normalizeObject(session, {});
    if (targetUserId && normalizeText(item.userId) !== targetUserId) continue;
    const text = [
      item.activeTopic ? `topic: ${item.activeTopic}` : '',
      item.summary ? `summary: ${item.summary}` : '',
      normalizeArray(item.openLoops).length ? `open: ${normalizeArray(item.openLoops).join(' | ')}` : ''
    ].filter(Boolean).join('\n');
    if (!text) continue;
    rows.push({
      source: 'session_projection',
      userId: normalizeText(item.userId || targetUserId),
      groupId: normalizeText(item.groupId),
      text,
      updatedAt: Number(item.updatedAt || 0) || 0
    });
  }
  const episodes = loadEpisodeProjection().users || {};
  for (const [episodeUserId, bucket] of Object.entries(episodes)) {
    if (targetUserId && normalizeText(episodeUserId) !== targetUserId) continue;
    for (const episode of normalizeArray(bucket?.items)) {
      const item = normalizeObject(episode, {});
      const text = normalizeText(item.text);
      if (!text) continue;
      rows.push({
        source: 'episode_projection',
        userId: normalizeText(episodeUserId),
        groupId: '',
        text,
        updatedAt: Number(item.updatedAt || 0) || 0
      });
    }
  }
  return rows
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
    .slice(0, Math.max(1, Number(options.limit || config.OPENVIKING_BACKFILL_LIMIT || 500) || 500));
}

async function runOpenVikingBackfill(options = {}) {
  const cfg = options.config || config;
  const dryRun = options.dryRun !== undefined
    ? options.dryRun !== false
    : cfg.OPENVIKING_BACKFILL_DRY_RUN_DEFAULT !== false;
  const rows = collectBackfillRows(options.userId || '', options);
  if (dryRun || cfg.OPENVIKING_ENABLED !== true || cfg.OPENVIKING_BACKFILL_ENABLED !== true) {
    return {
      ok: true,
      dryRun: true,
      considered: rows.length,
      written: 0,
      rows: rows.slice(0, Math.min(20, rows.length)).map((row) => ({
        source: row.source,
        userId: row.userId,
        groupId: row.groupId,
        textPreview: clampText(row.text, 120)
      })),
      reason: dryRun ? 'dry_run' : 'backfill_disabled'
    };
  }
  const client = options.client || getDefaultClient();
  const scheduler = options.scheduler || getDefaultScheduler();
  let written = 0;
  for (const row of rows) {
    const identity = buildIdentity(cfg, {
      userId: row.userId,
      senderId: row.userId,
      groupId: row.groupId,
      platform: options.platform || 'qq'
    });
    const auth = buildAuth(cfg, { ...options, openVikingUserId: identity.openVikingUserId });
    const payload = buildMessage('user', [userTextPart(`[backfill:${row.source}] ${row.text}`, {
      isGroup: identity.isGroup,
      senderName: row.userId,
      senderId: row.userId
    })]);
    await client.addMessage(identity.sessionId, payload, auth);
    scheduler.recordMessage(identity.sessionId, estimateTokens(row.text), auth);
    written += 1;
  }
  return { ok: true, dryRun: false, considered: rows.length, written };
}

module.exports = {
  collectBackfillRows,
  runOpenVikingBackfill
};
