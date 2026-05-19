const crypto = require('crypto');

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function summarizeToolLogValue(value, maxLen = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 10);
}

function createEvent(type, payload = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    type,
    ...payload
  };
}

function emitEvents(events = [], request = {}) {
  const handler = typeof request?.onEvent === 'function' ? request.onEvent : null;
  if (!handler) return;
  for (const event of Array.isArray(events) ? events : []) {
    try {
      handler(event);
    } catch (_) {}
  }
}

function pickRouteMetaForPostReplyJob(routeMeta = {}) {
  const source = normalizeObject(routeMeta, {});
  return {
    groupId: String(source.groupId || source.group_id || '').trim(),
    sessionId: String(source.sessionId || source.session_id || '').trim(),
    taskType: String(source.taskType || source.task_type || '').trim(),
    agentName: String(source.agentName || source.agent_name || '').trim(),
    toolName: String(source.toolName || source.tool_name || '').trim(),
    channelId: String(source.channelId || source.channel_id || '').trim(),
    messageId: String(source.messageId || source.message_id || '').trim(),
    topRouteType: String(source.topRouteType || '').trim()
  };
}

module.exports = {
  createEvent,
  emitEvents,
  pickRouteMetaForPostReplyJob,
  stableHash,
  summarizeToolLogValue
};
