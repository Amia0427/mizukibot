const { normalizeToolNames } = require('../utils/localToolAccess');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function buildRouteMetaEnvelope(route = {}, routeExecutionPlan = {}, metadata = {}, maybeExtraMeta = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const extraMeta = maybeExtraMeta && typeof maybeExtraMeta === 'object' && !Array.isArray(maybeExtraMeta)
    ? maybeExtraMeta
    : (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {});
  const safeRouteMeta = { ...routeMeta };
  delete safeRouteMeta.toolPlanner;
  delete safeRouteMeta.directChatPlanner;
  delete safeRouteMeta.executablePlan;
  delete safeRouteMeta.planSteps;
  delete safeRouteMeta.plannerValidation;
  const routePolicyKey = normalizeText(routeExecutionPlan.policyKey || routeExecutionPlan.routePolicyKey || routeMeta.routePolicyKey);
  const routeDebugKey = normalizeText(routeExecutionPlan.routeDebugKey || routeMeta.routeDebugKey || routePolicyKey);
  const allowedTools = normalizeToolNames(routeExecutionPlan.allowedTools || routeMeta.allowedTools || []);
  return {
    ...safeRouteMeta,
    ...extraMeta,
    topRouteType: normalizeText(routeExecutionPlan.topRouteType || route?.topRouteType || routeMeta.topRouteType || 'direct_chat'),
    routePolicyKey,
    routeDebugKey,
    routeExecutor: normalizeText(routeExecutionPlan.executor || routeMeta.routeExecutor || 'direct'),
    routeFallbackReason: normalizeText(routeExecutionPlan.unavailableReason || routeMeta.routeFallbackReason || routeMeta.fallbackReason || ''),
    routeTrace: routeExecutionPlan.routeTrace || routeMeta.routeTrace || null,
    allowedTools
  };
}

module.exports = {
  buildRouteMetaEnvelope
};
