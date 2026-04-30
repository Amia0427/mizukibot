const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { normalizeText, safeReadJson } = require('./helpers');
const {
  defaultSessionProjection,
  defaultProfileProjection,
  defaultScopeProjection,
  defaultEpisodeProjection
} = require('./storage');
const { inspectMemoryEventReadSet } = require('./events');
const { readMaterializeLock, DEFAULT_STALE_MS: DEFAULT_MATERIALIZE_LOCK_STALE_MS } = require('./materializeLock');

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      file: path.basename(filePath),
      path: filePath,
      exists: true,
      mtimeMs: Number(stat.mtimeMs || 0) || 0,
      size: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      file: path.basename(String(filePath || '')),
      path: filePath,
      exists: false,
      mtimeMs: 0,
      size: 0
    };
  }
}

function projectionInfo(name = '', filePath = '', fallback = {}) {
  const stat = safeStat(filePath);
  const data = safeReadJson(filePath, fallback);
  return {
    name,
    file: stat.file,
    exists: stat.exists,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    updatedAt: Number(data?.updatedAt || 0) || 0,
    materializedAt: Number(data?.materializedAt || data?.updatedAt || 0) || 0,
    eventHighWatermarkTs: Number(data?.eventHighWatermarkTs || 0) || 0
  };
}

function inspectMaterializeLock() {
  const lockFile = config.MEMORY_V3_MATERIALIZE_LOCK_FILE || `${config.MEMORY_V3_PROJECTIONS_DIR}.materialize.lock`;
  const existing = readMaterializeLock(lockFile);
  const staleMs = Math.max(
    1000,
    Number(config.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS || DEFAULT_MATERIALIZE_LOCK_STALE_MS)
      || DEFAULT_MATERIALIZE_LOCK_STALE_MS
  );
  const acquiredAt = Number(existing?.acquiredAt || 0) || 0;
  const ageMs = acquiredAt ? Math.max(0, Date.now() - acquiredAt) : 0;
  return {
    file: path.basename(lockFile),
    path: lockFile,
    hit: Boolean(existing),
    pid: Number(existing?.pid || 0) || 0,
    acquiredAt,
    ageMs,
    staleMs,
    stale: Boolean(existing) && ageMs > staleMs
  };
}

function inspectSessionSnapshot(sessionKey = '') {
  const key = normalizeText(sessionKey);
  const projection = safeReadJson(config.MEMORY_V3_SESSION_PROJECTION_FILE, defaultSessionProjection());
  const session = key ? projection.sessions?.[key] : null;
  return {
    sessionKey: key,
    hit: Boolean(session),
    snapshotType: normalizeText(session?.snapshotType),
    sessionUpdatedAt: Number(session?.updatedAt || 0) || 0,
    projectionUpdatedAt: Number(projection?.updatedAt || 0) || 0,
    projectionEventHighWatermarkTs: Number(projection?.eventHighWatermarkTs || 0) || 0
  };
}

function maxProjectionValue(projections = [], key = '') {
  return Math.max(0, ...projections.map((item) => Number(item?.[key] || 0) || 0));
}

function diagnoseProjectionFreshness(options = {}) {
  const eventRead = inspectMemoryEventReadSet({
    userId: options.userId,
    sessionKey: options.sessionKey,
    groupId: options.groupId
  });
  const projections = [
    projectionInfo('session', config.MEMORY_V3_SESSION_PROJECTION_FILE, defaultSessionProjection()),
    projectionInfo('profile', config.MEMORY_V3_PROFILE_PROJECTION_FILE, defaultProfileProjection()),
    projectionInfo('scope', config.MEMORY_V3_SCOPE_PROJECTION_FILE, defaultScopeProjection()),
    projectionInfo('episode', config.MEMORY_V3_EPISODE_PROJECTION_FILE, defaultEpisodeProjection())
  ];
  const materializerUpdatedAt = maxProjectionValue(projections, 'materializedAt') || maxProjectionValue(projections, 'updatedAt');
  const projectionEventHighWatermarkTs = maxProjectionValue(projections, 'eventHighWatermarkTs');
  const latestEventTs = Number(eventRead.latestEventTs || 0) || 0;
  const latestRelevantEventTs = Number(eventRead.latestRelevantEventTs || 0) || 0;
  const staleByAllEvents = latestEventTs > 0 && projectionEventHighWatermarkTs > 0 && projectionEventHighWatermarkTs < latestEventTs;
  const staleByRelevantEvents = latestRelevantEventTs > 0 && projectionEventHighWatermarkTs > 0 && projectionEventHighWatermarkTs < latestRelevantEventTs;
  const missingProjectionWatermark = latestEventTs > 0 && projectionEventHighWatermarkTs <= 0;
  const lock = inspectMaterializeLock();
  const sessionSnapshot = inspectSessionSnapshot(options.sessionKey);
  const sessionSnapshotOlderThanRelevantEvent = Boolean(
    sessionSnapshot.hit
      && latestRelevantEventTs > 0
      && Number(sessionSnapshot.sessionUpdatedAt || 0) > 0
      && Number(sessionSnapshot.sessionUpdatedAt || 0) < latestRelevantEventTs
  );
  const usedOldSnapshot = Boolean(sessionSnapshotOlderThanRelevantEvent || staleByRelevantEvents || missingProjectionWatermark);

  return {
    checkedAt: Date.now(),
    eventRead,
    projections,
    materializerUpdatedAt,
    projectionEventHighWatermarkTs,
    latestEventTs,
    latestRelevantEventTs,
    projectionStale: Boolean(staleByAllEvents || staleByRelevantEvents || missingProjectionWatermark),
    projectionStaleReason: staleByRelevantEvents
      ? 'relevant_event_newer_than_projection'
      : staleByAllEvents
        ? 'event_newer_than_projection'
        : missingProjectionWatermark
          ? 'missing_projection_event_watermark'
          : '',
    materializeLock: lock,
    lockHit: lock.hit,
    sessionSnapshot,
    usedOldSnapshot,
    usedOldSnapshotReason: sessionSnapshotOlderThanRelevantEvent
      ? 'session_snapshot_older_than_relevant_event'
      : staleByRelevantEvents
        ? 'projection_older_than_relevant_event'
        : missingProjectionWatermark
          ? 'projection_missing_event_watermark'
          : ''
  };
}

module.exports = {
  diagnoseProjectionFreshness,
  inspectMaterializeLock,
  inspectSessionSnapshot
};
