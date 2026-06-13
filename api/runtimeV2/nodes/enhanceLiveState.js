const { buildLiveStateForState } = require('../../../utils/liveState');

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function appendEvents(state = {}, events = []) {
  const previousEvents = Array.isArray(state.events) ? state.events : [];
  return previousEvents.concat(events);
}

function createEnhanceLiveStateNode(deps = {}) {
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const buildLiveState = typeof deps.buildLiveStateForState === 'function'
    ? deps.buildLiveStateForState
    : buildLiveStateForState;

  return async function enhanceLiveStateNode(state) {
    const request = normalizeObject(state.request);
    const existing = String(request.liveStateContext || state.memory?.liveStateContext || '').trim();
    const route = String(request.topRouteType || request.routePolicyKey || '').trim().toLowerCase();
    const events = [createEvent('node_start', { node: 'enhance_live_state' })];

    if (existing || route === 'ignore' || route === 'refuse') {
      const nextState = {
        ...state,
        thread: {
          ...normalizeObject(state.thread),
          currentNode: 'enhance_live_state',
          updatedAt: Date.now()
        },
        memory: {
          ...normalizeObject(state.memory),
          liveStateContext: existing || String(state.memory?.liveStateContext || '').trim(),
          liveStateInjected: Boolean(existing || state.memory?.liveStateInjected)
        }
      };
      events.push(createEvent('live_state_enhancement_skipped', {
        node: 'enhance_live_state',
        reason: existing ? 'already_built' : 'route_skip'
      }));
      events.push(createEvent('node_complete', { node: 'enhance_live_state' }));
      return saveAndEmit({ ...nextState, events: appendEvents(nextState, events) }, 'enhance_live_state', 'running', events);
    }

    try {
      const liveState = await buildLiveState(state);
      const nextState = {
        ...state,
        request: {
          ...request,
          liveStateContext: liveState.context,
          liveStateMeta: {
            relationship: liveState.relationship?.level || 'stranger',
            tokens: liveState.tokens,
            durationMs: liveState.durationMs,
            truncated: Boolean(liveState.truncated)
          }
        },
        thread: {
          ...normalizeObject(state.thread),
          currentNode: 'enhance_live_state',
          updatedAt: Date.now()
        },
        memory: {
          ...normalizeObject(state.memory),
          liveStateContext: liveState.context,
          liveStateInjected: true,
          liveStateMeta: {
            relationship: liveState.relationship?.level || 'stranger',
            tokens: liveState.tokens,
            durationMs: liveState.durationMs,
            truncated: Boolean(liveState.truncated)
          }
        }
      };
      events.push(createEvent('live_state_enhanced', {
        node: 'enhance_live_state',
        relationship: liveState.relationship?.level || 'stranger',
        tokens: liveState.tokens,
        durationMs: liveState.durationMs,
        truncated: Boolean(liveState.truncated)
      }));
      events.push(createEvent('node_complete', { node: 'enhance_live_state' }));
      return saveAndEmit({ ...nextState, events: appendEvents(nextState, events) }, 'enhance_live_state', 'running', events);
    } catch (error) {
      const nextState = {
        ...state,
        thread: {
          ...normalizeObject(state.thread),
          currentNode: 'enhance_live_state',
          updatedAt: Date.now()
        }
      };
      events.push(createEvent('live_state_enhancement_failed', {
        node: 'enhance_live_state',
        error: error?.message || String(error)
      }));
      events.push(createEvent('node_complete', { node: 'enhance_live_state' }));
      return saveAndEmit({ ...nextState, events: appendEvents(nextState, events) }, 'enhance_live_state', 'running', events);
    }
  };
}

module.exports = {
  createEnhanceLiveStateNode
};
