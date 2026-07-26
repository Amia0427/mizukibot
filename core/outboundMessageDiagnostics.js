const { appendPerfEvent } = require('../utils/perfRuntime');
const {
  appendRequestTraceEvent,
  nextTracePhase,
  normalizeRequestTrace
} = require('../utils/requestTrace');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function buildOutboundMessageMeta(input = {}, defaults = {}) {
  const routeMeta = input.routeMeta && typeof input.routeMeta === 'object' ? input.routeMeta : {};
  const telemetry = input.telemetry && typeof input.telemetry === 'object' ? input.telemetry : {};
  const source = firstText(
    input.source,
    telemetry.source,
    routeMeta.source,
    routeMeta.initiativeSource,
    defaults.source
  ) || 'unknown';
  const routePolicyKey = firstText(
    input.routePolicyKey,
    telemetry.routePolicyKey,
    routeMeta.routePolicyKey,
    defaults.routePolicyKey
  ) || 'unknown';
  const triggerReason = firstText(
    input.triggerReason,
    input.reason,
    telemetry.triggerReason,
    telemetry.reason,
    routeMeta.triggerReason,
    routeMeta.initiativeReason,
    routeMeta.routeReason,
    routeMeta.reason,
    routeMeta.replyPath,
    defaults.triggerReason,
    defaults.reason
  ) || 'unspecified';

  return {
    source,
    routePolicyKey,
    triggerReason,
    topRouteType: firstText(input.topRouteType, telemetry.topRouteType, routeMeta.topRouteType, defaults.topRouteType),
    requestTrace: normalizeRequestTrace(input.requestTrace)
      || normalizeRequestTrace(telemetry.requestTrace)
      || normalizeRequestTrace(routeMeta.requestTrace)
      || normalizeRequestTrace(defaults.requestTrace)
  };
}

function recordOutboundMessageEvent(phase = '', meta = {}, payload = {}) {
  const normalizedPhase = normalizeText(phase) || 'event';
  const normalizedMeta = buildOutboundMessageMeta(meta);
  const event = {
    category: 'outbound_message',
    type: `outbound_message_${normalizedPhase}`,
    stage: `outbound_message_${normalizedPhase}`,
    source: normalizedMeta.source,
    routePolicyKey: normalizedMeta.routePolicyKey,
    triggerReason: normalizedMeta.triggerReason,
    ...(normalizedMeta.topRouteType ? { topRouteType: normalizedMeta.topRouteType } : {}),
    ...payload
  };
  appendPerfEvent(event);
  if (normalizedMeta.requestTrace) {
    appendRequestTraceEvent(nextTracePhase(normalizedMeta.requestTrace, event.stage, event));
  }
  if (normalizedPhase === 'send_success' || normalizedPhase === 'send_failure') {
    console.log('[outbound-message]', event);
  }
  return event;
}

module.exports = {
  buildOutboundMessageMeta,
  recordOutboundMessageEvent
};
