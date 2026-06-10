const { normalizeText } = require('./helpers');

function getLatestEventTs(events = []) {
  let latest = 0;
  for (const event of Array.isArray(events) ? events : []) {
    latest = Math.max(latest, Number(event?.ts || 0) || 0);
  }
  return latest;
}

function normalizeDirtyScopes(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const userIds = new Set();
  const sessionKeys = new Set();
  const groupIds = new Set();
  const add = (set, item) => {
    const text = normalizeText(item);
    if (text) set.add(text);
  };
  for (const item of Array.isArray(source.userIds) ? source.userIds : []) add(userIds, item);
  for (const item of Array.isArray(source.sessionKeys) ? source.sessionKeys : []) add(sessionKeys, item);
  for (const item of Array.isArray(source.groupIds) ? source.groupIds : []) add(groupIds, item);
  add(userIds, source.userId);
  add(sessionKeys, source.sessionKey);
  add(groupIds, source.groupId);
  return { userIds, sessionKeys, groupIds };
}

function countDirtyScopes(scopes = {}) {
  return Number(scopes.userIds?.size || 0) + Number(scopes.sessionKeys?.size || 0) + Number(scopes.groupIds?.size || 0);
}

function eventMatchesDirtyScopes(event = {}, scopes = {}) {
  const userId = normalizeText(event.userId);
  const sessionKey = normalizeText(event.sessionKey);
  const groupId = normalizeText(event.groupId);
  return Boolean(
    (userId && scopes.userIds?.has(userId))
    || (sessionKey && scopes.sessionKeys?.has(sessionKey))
    || (groupId && scopes.groupIds?.has(groupId))
  );
}

function mergeIncrementalProjection(fullProjection = {}, partialProjection = {}, key = 'users', dirtyKeys = new Set()) {
  const merged = {
    ...(fullProjection && typeof fullProjection === 'object' ? fullProjection : {}),
    ...(partialProjection && typeof partialProjection === 'object' ? partialProjection : {})
  };
  const existingItems = fullProjection?.[key] && typeof fullProjection[key] === 'object' ? fullProjection[key] : {};
  const partialItems = partialProjection?.[key] && typeof partialProjection[key] === 'object' ? partialProjection[key] : {};
  merged[key] = { ...existingItems };
  for (const dirtyKey of dirtyKeys || []) {
    delete merged[key][dirtyKey];
  }
  for (const [itemKey, value] of Object.entries(partialItems)) {
    merged[key][itemKey] = value;
  }
  return merged;
}

module.exports = {
  countDirtyScopes,
  eventMatchesDirtyScopes,
  getLatestEventTs,
  mergeIncrementalProjection,
  normalizeDirtyScopes
};
