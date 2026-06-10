const RECENT_PERF_EVENTS_LIMIT = 1000;
const RECENT_PERF_EVENTS_STATE_KEY = '__mizuki_perf_runtime_recent_events__';

function getRecentPerfEventState() {
  if (!global[RECENT_PERF_EVENTS_STATE_KEY]) {
    global[RECENT_PERF_EVENTS_STATE_KEY] = {
      events: []
    };
  }
  return global[RECENT_PERF_EVENTS_STATE_KEY];
}

function rememberPerfEvent(event = {}, limit = RECENT_PERF_EVENTS_LIMIT) {
  const payload = {
    recordedAt: new Date().toISOString(),
    processId: process.pid,
    ...event
  };
  const state = getRecentPerfEventState();
  state.events.push(payload);
  if (state.events.length > limit) {
    state.events.splice(0, state.events.length - limit);
  }
  return payload;
}

function getRecentPerfEvents(options = {}) {
  const sinceMs = Number(options.sinceMs || 0) || 0;
  const untilMs = Number(options.untilMs || Date.now()) || Date.now();
  const limit = Math.max(1, Number(options.limit || RECENT_PERF_EVENTS_LIMIT) || RECENT_PERF_EVENTS_LIMIT);
  return getRecentPerfEventState().events
    .filter((event) => {
      const ms = Date.parse(String(event?.recordedAt || ''));
      if (!Number.isFinite(ms)) return false;
      return (!sinceMs || ms >= sinceMs) && ms <= untilMs;
    })
    .slice(-limit)
    .map((event) => ({ ...event }));
}

module.exports = {
  RECENT_PERF_EVENTS_LIMIT,
  getRecentPerfEvents,
  getRecentPerfEventState,
  rememberPerfEvent
};
