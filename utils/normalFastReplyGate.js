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

const FAST_REPLY_CHECKS = Object.freeze([
  { key: 'enabled', reason: 'disabled', label: 'NORMAL_FAST_REPLY_ENABLED=true', exitFlag: 'permission' },
  { key: 'has_user_id', reason: 'missing_user_id', label: 'user id present', exitFlag: 'permission' },
  { key: 'normal_user', reason: 'admin_user', label: 'not admin user', exitFlag: 'permission' },
  { key: 'direct_chat_route', reason: 'not_direct_chat', label: 'top route is direct_chat', exitFlag: 'route' },
  { key: 'direct_executor', reason: 'non_direct_executor', label: 'executor is direct', exitFlag: 'route' },
  { key: 'route_available', reason: 'route_unavailable', label: 'route execution is available', exitFlag: 'route' },
  { key: 'tools_not_allowed', reason: 'tools_allowed', label: 'route does not allow tools', exitFlag: 'tools' },
  { key: 'no_tools_present', reason: 'tools_present', label: 'no planner/tool allowlist present', exitFlag: 'tools' },
  { key: 'no_image_input', reason: 'image_present', label: 'no image or visual input', exitFlag: 'image' },
  { key: 'no_route_action_or_safety', reason: 'route_action_or_safety', label: 'no action/safety route metadata', exitFlag: 'permission' },
  { key: 'no_memory_cli_turn', reason: 'memory_cli_turn', label: 'no memory_cli turn state', exitFlag: 'continuity' },
  { key: 'text_present', reason: 'empty_text', label: 'text is not empty', exitFlag: 'continuity' },
  { key: 'not_slash_command', reason: 'slash_command', label: 'not a slash command', exitFlag: 'permission' },
  { key: 'not_admin_like_command', reason: 'admin_like_command', label: 'not admin-like command text', exitFlag: 'permission' },
  { key: 'no_memory_recall_request', reason: 'memory_recall_like', label: 'no memory/continuity recall request', exitFlag: 'continuity' },
  { key: 'no_search_or_freshness_request', reason: 'search_or_freshness_like', label: 'no search/freshness request', exitFlag: 'tools' },
  { key: 'not_complex_task', reason: 'complex_task_like', label: 'not a complex/planning task', exitFlag: 'continuity' }
]);

function findCheckByReason(reason = '') {
  const normalized = normalizeText(reason);
  return FAST_REPLY_CHECKS.find((item) => item.reason === normalized) || null;
}

function buildFastReplyExitFlags(failedChecks = []) {
  const flags = {
    tools: false,
    image: false,
    permission: false,
    continuity: false,
    route: false
  };
  for (const check of failedChecks || []) {
    const key = normalizeText(check?.exitFlag);
    if (Object.prototype.hasOwnProperty.call(flags, key)) flags[key] = true;
  }
  return flags;
}

function buildCheck(key = '', ok = false, extra = {}) {
  const def = FAST_REPLY_CHECKS.find((item) => item.key === key) || {};
  return {
    key,
    ok: ok === true,
    label: def.label || key,
    reason: ok === true ? '' : (extra.reason || def.reason || key),
    exitFlag: def.exitFlag || '',
    ...extra
  };
}

function resolveAdminChecker(runtimeConfig = {}, options = {}) {
  if (typeof options.isAdminUser === 'function') return options.isAdminUser;
  if (typeof runtimeConfig.isAdminUser === 'function') return runtimeConfig.isAdminUser;
  const adminUserIds = normalizeIdList(runtimeConfig.ADMIN_USER_IDS);
  return (userId) => adminUserIds.has(normalizeText(userId));
}

function explainNormalFastReplyDecision(input = {}, runtimeConfig = {}, options = {}) {
  const checks = [];
  const enabled = runtimeConfig.NORMAL_FAST_REPLY_ENABLED === true;
  checks.push(buildCheck('enabled', enabled));

  const userId = normalizeText(input.userId || input.senderId || input.route?.meta?.userId || input.route?.meta?.user_id);
  checks.push(buildCheck('has_user_id', Boolean(userId)));

  const isAdminUser = resolveAdminChecker(runtimeConfig, options);
  checks.push(buildCheck('normal_user', Boolean(userId) && !isAdminUser(userId)));

  const route = input.route || {};
  const routeExecutionPlan = getRouteExecutionPlan(input);
  const topRouteType = normalizeText(routeExecutionPlan.topRouteType || route.topRouteType || route.meta?.topRouteType || 'direct_chat');
  checks.push(buildCheck('direct_chat_route', topRouteType === 'direct_chat', { actual: topRouteType || 'unknown' }));

  const executor = normalizeText(routeExecutionPlan.executor || 'direct');
  checks.push(buildCheck('direct_executor', !executor || executor === 'direct', { actual: executor || 'direct' }));
  const unavailableReason = normalizeText(routeExecutionPlan.unavailableReason);
  checks.push(buildCheck('route_available', !unavailableReason, { actual: unavailableReason }));
  checks.push(buildCheck('tools_not_allowed', routeExecutionPlan.allowTools !== true));
  checks.push(buildCheck('no_tools_present', !hasAllowedTools(input)));
  checks.push(buildCheck('no_image_input', !hasImageInput(input)));

  const routeMeta = route.meta && typeof route.meta === 'object' ? route.meta : {};
  checks.push(buildCheck('no_route_action_or_safety', !(routeMeta.command || routeMeta.qqActionKey || routeMeta.safetyBoundary === true)));
  checks.push(buildCheck('no_memory_cli_turn', !(routeMeta.memoryCliTurn && Object.keys(routeMeta.memoryCliTurn || {}).length > 0)));

  const text = getRouteText(input);
  const blocked = matchesBlockedIntent(text);
  const blockedReason = normalizeText(blocked.reason);
  if (blocked.blocked) {
    const blockedCheck = findCheckByReason(blockedReason);
    if (blockedCheck) checks.push(buildCheck(blockedCheck.key, false, { reason: blockedReason }));
  } else {
    checks.push(buildCheck('text_present', true));
    checks.push(buildCheck('not_slash_command', true));
    checks.push(buildCheck('not_admin_like_command', true));
    checks.push(buildCheck('no_memory_recall_request', true));
    checks.push(buildCheck('no_search_or_freshness_request', true));
    checks.push(buildCheck('not_complex_task', true));
  }

  const firstFailed = checks.find((check) => check.ok !== true) || null;
  const failedChecks = checks.filter((check) => check.ok !== true);
  const eligible = !firstFailed;
  return {
    eligible,
    reason: eligible ? 'eligible' : firstFailed.reason,
    userId,
    text,
    checks,
    matchedConditions: checks.filter((check) => check.ok === true),
    missedConditions: failedChecks,
    exitFlags: buildFastReplyExitFlags(failedChecks)
  };
}

function buildNormalFastReplyDecision(input = {}, runtimeConfig = {}, options = {}) {
  const explanation = explainNormalFastReplyDecision(input, runtimeConfig, options);
  return {
    eligible: explanation.eligible,
    reason: explanation.reason,
    userId: explanation.userId,
    text: explanation.text
  };
}

function isNormalFastReplyEligible(input = {}, runtimeConfig = {}, options = {}) {
  return buildNormalFastReplyDecision(input, runtimeConfig, options).eligible === true;
}

module.exports = {
  buildNormalFastReplyDecision,
  explainNormalFastReplyDecision,
  FAST_REPLY_CHECKS,
  isNormalFastReplyEligible,
  matchesBlockedIntent
};
