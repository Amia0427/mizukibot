function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeIdList(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map((item) => normalizeText(item))
    .filter(Boolean));
}

function hasImageInput(input = {}) {
  const values = [
    input.imageUrl,
    input.route?.imageUrl,
    input.route?.meta?.imageUrl,
    input.route?.meta?.visualInput,
    input.visualContext?.imageUrl
  ];
  if (values.some((item) => normalizeText(item))) return true;
  const imageLists = [
    input.imageUrls,
    input.route?.imageUrls,
    input.route?.meta?.imageUrls,
    input.visualContext?.imageUrls
  ];
  return imageLists.some((items) => Array.isArray(items) && items.some((item) => normalizeText(item)));
}

function hasAllowedTools(input = {}) {
  const routeMeta = input.route?.meta && typeof input.route.meta === 'object' ? input.route.meta : {};
  const planner = routeMeta.toolPlanner && typeof routeMeta.toolPlanner === 'object'
    ? routeMeta.toolPlanner
    : (routeMeta.directChatPlanner && typeof routeMeta.directChatPlanner === 'object' ? routeMeta.directChatPlanner : null);
  const executionPlan = input.routeExecutionPlan || input.executionPlan || {};
  const candidateLists = [
    input.allowedTools,
    executionPlan.allowedTools,
    routeMeta.allowedTools,
    planner?.allowedToolNames,
    planner?.allowedTools
  ];
  if (candidateLists.some((items) => Array.isArray(items) && items.some((item) => normalizeText(item)))) return true;
  const plannerSteps = Array.isArray(planner?.executionPlan?.steps) ? planner.executionPlan.steps : [];
  return plannerSteps.some((step) => normalizeText(step?.action || step?.tool) && normalizeText(step?.action || step?.tool) !== 'reply');
}

function getRouteExecutionPlan(input = {}) {
  return input.routeExecutionPlan || input.executionPlan || {};
}

function getRouteText(input = {}) {
  return normalizeText(
    input.cleanText
    || input.requestText
    || input.runtimeQuestionText
    || input.route?.cleanText
    || input.route?.question
    || input.rawText
  );
}

function matchesBlockedIntent(text = '') {
  const t = normalizeText(text);
  if (!t) return { blocked: true, reason: 'empty_text' };
  if (/^\//.test(t)) return { blocked: true, reason: 'slash_command' };
  if (/(^|\s)(admin|sudo|root|shell|ssh|cmd|powershell|bash)(\s|$)/i.test(t)) {
    return { blocked: true, reason: 'admin_like_command' };
  }
  if (/(昨天|前天|刚才|上次|之前|前几天|还记得|记得吗|记不记得|聊了什么|做到哪|聊到哪|继续|接着|接上|回忆|remember|last time|earlier|where did we leave off|what were we talking about|continue|resume|pick back up)/i.test(t)) {
    return { blocked: true, reason: 'memory_recall_like' };
  }
  if (/(搜索|搜一下|查一下|查查|查询|最新|今天新闻|新闻|官网|链接|网址|web|search|google|bing|news|latest|current|price|weather|天气|汇率|股价|价格)/i.test(t)) {
    return { blocked: true, reason: 'search_or_freshness_like' };
  }
  if (/(计划|方案|总结|摘要|归纳|整理|改写|润色|翻译|部署|执行|创建|生成图|画图|发消息|定时|提醒|发布|群总结|做个|写代码|改代码|commit|pull request|pr\b|review\b|测试一下|跑测试)/i.test(t)) {
    return { blocked: true, reason: 'complex_task_like' };
  }
  return { blocked: false, reason: '' };
}

function resolveAdminChecker(runtimeConfig = {}, options = {}) {
  if (typeof options.isAdminUser === 'function') return options.isAdminUser;
  if (typeof runtimeConfig.isAdminUser === 'function') return runtimeConfig.isAdminUser;
  const adminUserIds = normalizeIdList(runtimeConfig.ADMIN_USER_IDS);
  return (userId) => adminUserIds.has(normalizeText(userId));
}

function buildNormalFastReplyDecision(input = {}, runtimeConfig = {}, options = {}) {
  if (runtimeConfig.NORMAL_FAST_REPLY_ENABLED === false) {
    return { eligible: false, reason: 'disabled' };
  }
  const userId = normalizeText(input.userId || input.senderId || input.route?.meta?.userId || input.route?.meta?.user_id);
  if (!userId) return { eligible: false, reason: 'missing_user_id' };
  const isAdminUser = resolveAdminChecker(runtimeConfig, options);
  if (isAdminUser(userId)) return { eligible: false, reason: 'admin_user' };

  const route = input.route || {};
  const routeExecutionPlan = getRouteExecutionPlan(input);
  const topRouteType = normalizeText(routeExecutionPlan.topRouteType || route.topRouteType || route.meta?.topRouteType || 'direct_chat');
  if (topRouteType !== 'direct_chat') return { eligible: false, reason: 'not_direct_chat' };

  const executor = normalizeText(routeExecutionPlan.executor || 'direct');
  if (executor && executor !== 'direct') return { eligible: false, reason: 'non_direct_executor' };
  if (normalizeText(routeExecutionPlan.unavailableReason)) return { eligible: false, reason: 'route_unavailable' };
  if (routeExecutionPlan.allowTools === true) return { eligible: false, reason: 'tools_allowed' };
  if (hasAllowedTools(input)) return { eligible: false, reason: 'tools_present' };
  if (hasImageInput(input)) return { eligible: false, reason: 'image_present' };

  const routeMeta = route.meta && typeof route.meta === 'object' ? route.meta : {};
  if (routeMeta.command || routeMeta.qqActionKey || routeMeta.safetyBoundary === true) {
    return { eligible: false, reason: 'route_action_or_safety' };
  }
  if (routeMeta.memoryCliTurn && Object.keys(routeMeta.memoryCliTurn || {}).length > 0) {
    return { eligible: false, reason: 'memory_cli_turn' };
  }
  const text = getRouteText(input);
  const blocked = matchesBlockedIntent(text);
  if (blocked.blocked) return { eligible: false, reason: blocked.reason };

  return {
    eligible: true,
    reason: 'eligible',
    userId,
    text
  };
}

function isNormalFastReplyEligible(input = {}, runtimeConfig = {}, options = {}) {
  return buildNormalFastReplyDecision(input, runtimeConfig, options).eligible === true;
}

module.exports = {
  buildNormalFastReplyDecision,
  isNormalFastReplyEligible,
  matchesBlockedIntent
};
