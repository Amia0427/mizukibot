function toSafeSessionPart(value, fallback = 'unknown') {
  const safe = String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe || fallback;
}

function toSafeSessionSuffix(value, fallback = 'extra') {
  const safe = String(value || fallback).replace(/[^a-zA-Z0-9_:-]/g, '_');
  return safe || fallback;
}

function normalizeSessionChannel(value = '', fallback = 'mizuki') {
  return toSafeSessionPart(value || fallback, fallback);
}

function normalizeSessionChatId(value = '', fallback = 'unknown') {
  return toSafeSessionPart(value || fallback, fallback);
}

function normalizeSessionSuffix(value = '', fallback = 'extra') {
  return toSafeSessionSuffix(value || fallback, fallback);
}

function buildWorkerSessionSuffix(workerId = '') {
  const normalizedWorkerId = normalizeSessionSuffix(workerId || 'w1', 'w1');
  return `full:${normalizedWorkerId}`;
}

function buildSessionParts(userId = '', options = {}) {
  const sessionChannel = normalizeSessionChannel(options?.sessionChannel || 'mizuki', 'mizuki');
  const sessionChatId = String(options?.sessionChatId || '').trim();
  const sessionSuffix = String(options?.sessionSuffix || '').trim();
  return {
    sessionChannel,
    sessionChatId: sessionChatId ? normalizeSessionChatId(sessionChatId) : '',
    sessionSuffix: sessionSuffix ? normalizeSessionSuffix(sessionSuffix) : '',
    normalizedUserId: normalizeSessionChatId(userId || 'unknown')
  };
}

function buildSessionId(userId = '', options = {}) {
  const parts = buildSessionParts(userId, options);
  const suffix = parts.sessionSuffix ? `:${parts.sessionSuffix}` : '';
  if (parts.sessionChatId) {
    return `${parts.sessionChannel}:${parts.sessionChatId}${suffix}`;
  }
  return `mizuki:${parts.normalizedUserId}${suffix}`;
}

module.exports = {
  buildSessionId,
  buildSessionParts,
  buildWorkerSessionSuffix,
  normalizeSessionChannel,
  normalizeSessionChatId,
  normalizeSessionSuffix
};
