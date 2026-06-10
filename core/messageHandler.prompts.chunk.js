function getSafeLifeSchedulerEngine() {
  try {
    const lifeModule = require('./lifeSchedulerEngine');
    if (lifeModule && typeof lifeModule.getLifeSchedulerEngine === 'function') {
      return lifeModule.getLifeSchedulerEngine();
    }
  } catch (error) {
    console.warn('[life-scheduler] unavailable', error?.message || error);
  }
  return {
    async handleAdminCommand() {
      return {
        handled: true,
        replyText: 'Life Scheduler 这边现在没接上。'
      };
    }
  };
}

function buildRouteContextForQqAction(route = {}, senderId = '', groupId = '') {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const qqActionTools = Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : [];
  return {
    ...route,
    meta: {
      ...routeMeta,
      userId: String(senderId || routeMeta.userId || '').trim(),
      groupId: String(groupId || routeMeta.groupId || '').trim(),
      allowedTools: qqActionTools
    }
  };
}

function getRouteDisplayType(route = {}, routeExecutionPlan = {}) {
  return String(
    routeExecutionPlan?.routeDebugKey
    || routeExecutionPlan?.topRouteType
    || route?.topRouteType
    || route?.type
    || 'direct_chat/text_chat/answer'
  ).trim() || 'direct_chat/text_chat/answer';
}

function buildToolGuidancePrompt(route) {
  const planner = route?.meta?.toolPlanner && typeof route.meta.toolPlanner === 'object'
    ? route.meta.toolPlanner
    : (route?.meta?.directChatPlanner && typeof route.meta.directChatPlanner === 'object'
      ? route.meta.directChatPlanner
      : null);
  const toolHints = Array.isArray(planner?.allowedToolNames)
    ? planner.allowedToolNames.filter(Boolean)
    : [];
  if (!toolHints.length) return null;

  const routeKey = getRouteDisplayType(route);
  const reason = String(route?.meta?.reason || '').trim();
  return buildRuntimePrompt('tool-guidance', {
    routeKey,
    toolHints: toolHints.join(', '),
    reasonLine: reason ? `路由原因: ${reason}` : ''
  });
}

function createRequestScopeCache(options = {}) {
  const maxEntries = Math.max(16, Number(options.maxEntries || 128) || 128);
  const store = new Map();
  return {
    getOrCompute(key, factory) {
      if (store.has(key)) return store.get(key);
      const value = typeof factory === 'function' ? factory() : undefined;
      store.set(key, value);
      if (store.size > maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) store.delete(oldestKey);
      }
      return value;
    }
  };
}

function normalizeVisualSummaryText(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildVisionCaptionTelemetryEvent(type = '', payload = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    type,
    ...payload
  };
}

function countCachedVisualRefs(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.url || '').trim().startsWith('cached-image://'))
    .length;
}

async function resolveStableVisualUrl(url = '', refMap = null) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return '';
  if (rawUrl.startsWith('cached-image://')) return rawUrl;

  const mapped = refMap && typeof refMap === 'object'
    ? String(refMap[rawUrl] || '').trim()
    : '';
  if (mapped) return mapped;

  const cached = await ensureCachedImageRef(rawUrl);
  return cached?.ok && cached.ref ? cached.ref : rawUrl;
}

function resolveLegacyVisionFallbackModelConfig(imageUrl = null, userId = '', routeMeta = {}) {
  if (!String(imageUrl || '').trim()) return null;
  return buildImageModelConfig(null, userId, { routeMeta });
}

