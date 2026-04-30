const { getApiProvider } = require('./modelProvider');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function safeHost(url = '') {
  try {
    return new URL(String(url || '')).host || '';
  } catch (_) {
    return '';
  }
}

function buildModelRouteDiagnostics(input = {}) {
  const routeMeta = input?.routeMeta && typeof input.routeMeta === 'object' ? input.routeMeta : {};
  const existing = input?.modelRouteDiagnostic && typeof input.modelRouteDiagnostic === 'object'
    ? input.modelRouteDiagnostic
    : {};
  const model = normalizeText(input.model || input.requestModel);
  const apiBaseUrl = normalizeText(input.apiBaseUrl || input.requestUrl);
  const provider = normalizeText(input.provider || existing.provider || getApiProvider(apiBaseUrl || existing.apiBaseUrl, model || existing.model)) || 'openai_compatible';
  const branch = normalizeText(
    input.branch
    || input.dispatchBranch
    || input.replyBranch
    || existing.branch
    || routeMeta.dispatchBranch
    || routeMeta.replyBranch
    || ''
  );
  const routeDebugKey = normalizeText(
    input.routeDebugKey
    || existing.routeDebugKey
    || routeMeta.routeDebugKey
    || routeMeta.route_debug_key
    || input.routePolicyKey
    || routeMeta.routePolicyKey
  );
  const routePolicyKey = normalizeText(
    input.routePolicyKey
    || existing.routePolicyKey
    || routeMeta.routePolicyKey
    || routeMeta.route_policy_key
    || ''
  );
  const topRouteType = normalizeText(
    input.topRouteType
    || existing.topRouteType
    || routeMeta.topRouteType
    || routeMeta.top_route_type
    || ''
  );
  const fallbackReason = normalizeText(
    input.fallbackReason
    || input.mainFallbackReason
    || existing.fallbackReason
    || routeMeta.routeFallbackReason
    || routeMeta.fallbackReason
    || routeMeta.reason
    || ''
  );
  return {
    routeDebugKey,
    routePolicyKey,
    topRouteType,
    branch,
    triggerBranch: normalizeText(input.triggerBranch || existing.triggerBranch || input.stage || branch),
    provider,
    apiBaseUrl: apiBaseUrl || normalizeText(existing.apiBaseUrl),
    apiBaseUrlHost: safeHost(apiBaseUrl || existing.apiBaseUrl),
    model: model || normalizeText(existing.model),
    modelSource: normalizeText(input.modelSource || existing.modelSource),
    apiBaseUrlSource: normalizeText(input.apiBaseUrlSource || existing.apiBaseUrlSource),
    apiKeySource: normalizeText(input.apiKeySource || existing.apiKeySource),
    fallbackReason,
    fallbackScope: normalizeText(input.fallbackScope || input.mainFallbackScope || existing.fallbackScope),
    fallbackActive: input.fallbackActive === true || input.mainFallbackActive === true || existing.fallbackActive === true,
    fallbackForced: input.fallbackForced === true || input.mainFallbackForced === true || existing.fallbackForced === true
  };
}

function pickModelRouteDiagnosticFields(input = {}) {
  const diagnostics = input && typeof input === 'object' ? input : {};
  return {
    routeDebugKey: normalizeText(diagnostics.routeDebugKey),
    routePolicyKey: normalizeText(diagnostics.routePolicyKey),
    topRouteType: normalizeText(diagnostics.topRouteType),
    branch: normalizeText(diagnostics.branch),
    triggerBranch: normalizeText(diagnostics.triggerBranch),
    provider: normalizeText(diagnostics.provider),
    apiBaseUrl: normalizeText(diagnostics.apiBaseUrl),
    apiBaseUrlHost: normalizeText(diagnostics.apiBaseUrlHost || safeHost(diagnostics.apiBaseUrl)),
    model: normalizeText(diagnostics.model),
    modelSource: normalizeText(diagnostics.modelSource),
    apiBaseUrlSource: normalizeText(diagnostics.apiBaseUrlSource),
    apiKeySource: normalizeText(diagnostics.apiKeySource),
    fallbackReason: normalizeText(diagnostics.fallbackReason || diagnostics.mainFallbackReason),
    fallbackScope: normalizeText(diagnostics.fallbackScope),
    fallbackActive: diagnostics.fallbackActive === true,
    fallbackForced: diagnostics.fallbackForced === true
  };
}

function createModelRouteTracePatch(diagnostics = {}) {
  const picked = pickModelRouteDiagnosticFields(diagnostics);
  return {
    routeDebugKey: picked.routeDebugKey,
    routePolicyKey: picked.routePolicyKey,
    topRouteType: picked.topRouteType,
    dispatchBranch: picked.branch,
    triggerBranch: picked.triggerBranch,
    provider: picked.provider,
    apiBaseUrl: picked.apiBaseUrl,
    apiBaseUrlHost: picked.apiBaseUrlHost,
    model: picked.model,
    modelSource: picked.modelSource,
    apiBaseUrlSource: picked.apiBaseUrlSource,
    apiKeySource: picked.apiKeySource,
    fallbackReason: picked.fallbackReason,
    mainFallbackScope: picked.fallbackScope,
    mainFallbackActive: picked.fallbackActive,
    mainFallbackForced: picked.fallbackForced,
    modelRouteDiagnostic: picked
  };
}

module.exports = {
  buildModelRouteDiagnostics,
  createModelRouteTracePatch,
  pickModelRouteDiagnosticFields,
  safeHost
};
