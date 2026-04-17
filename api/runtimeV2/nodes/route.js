function createRouteNode(deps = {}) {
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const normalizeMode = typeof deps.normalizeMode === 'function'
    ? deps.normalizeMode
    : (() => 'chat');
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function routeNode(state) {
    const mode = String(state.execution?.mode || '').trim() || normalizeMode(state.request);
    const events = [
      createEvent('node_start', { node: 'route', mode }),
      createEvent('security_route_context', {
        node: 'route',
        securityLabels: Array.isArray(state.memory?.securityLabels) ? state.memory.securityLabels : []
      }),
      createEvent('node_complete', { node: 'route', mode })
    ];
    return saveAndEmit({
      ...state,
      execution: {
        ...state.execution,
        mode,
        route: mode,
        currentNode: 'route'
      },
      events
    }, 'route', 'running', events);
  };
}

function createRouteAfterRoute(deps = {}) {
  const normalizeMode = typeof deps.normalizeMode === 'function'
    ? deps.normalizeMode
    : (() => 'chat');

  return function routeAfterRoute(state) {
    return String(state.execution?.route || state.execution?.mode || normalizeMode(state.request)).trim() || 'chat';
  };
}

module.exports = {
  createRouteAfterRoute,
  createRouteNode
};
