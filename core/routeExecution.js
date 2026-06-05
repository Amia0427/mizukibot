const {
  buildCanonicalRouteContract,
  sanitizeTopRouteType
} = require('./routeSchema');
const { normalizeToolNames } = require('../utils/localToolAccess');
const { getPolicyDefinition: getPolicyDefinitionFromProfiles } = require('./routeProfiles');
const { getPolicy } = require('../utils/toolPolicy');
const {
  buildExecutablePlanFromPlannerDecision,
  summarizeExecutablePlan,
  validateExecutablePlanTools
} = require('./executablePlan');
const config = require('../config');
const { filterCompanionAllowedTools } = require('../utils/companionTools');
const { isAdminUserId, isPrivateChatAccessAllowed } = require('../utils/privilegedPrivateChat');
const {
  WEB_LOOKUP_ALLOWED_TOOLS,
  routeHasExplicitWebSearchRequirement
} = require('../utils/webSearchRequirement');

// routeExecution consumes only canonical contract data plus planner output.
// It must not infer a new top route type or treat routeProfiles as routing truth.

const EXECUTORS = Object.freeze([
  'ignore',
  'refuse',
  'admin',
  'direct',
  'background_direct'
]);

function getToolPlanner(route = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  if (routeMeta.toolPlanner && typeof routeMeta.toolPlanner === 'object') return routeMeta.toolPlanner;
  if (routeMeta.directChatPlanner && typeof routeMeta.directChatPlanner === 'object') return routeMeta.directChatPlanner;
  return null;
}

function hasQqFixedAction(route = {}) {
  return Boolean(resolveQqActionTools(route).length > 0);
}

function getCapabilityForExecutor(executor = 'direct') {
  const normalized = String(executor || '').trim();
  if (normalized === 'ignore') return 'ignore';
  if (normalized === 'refuse') return 'refuse';
  if (normalized === 'admin') return 'admin';
  return 'direct';
}

function buildRouteDebugKey(route = {}) {
  const contract = buildCanonicalRouteContract(route);
  const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  if (contract.topRouteType === 'ignore') return 'ignore/default';
  if (contract.topRouteType === 'refuse') return 'refuse/default';
  if (contract.topRouteType === 'admin') {
    if (command) {
      return `admin/${command}`;
    }
    return 'admin/default';
  }
  if (qqActionKey === 'qq_publish_qzone') return 'act/qq-publish-qzone';
  if (qqActionKey === 'qq_schedule_message') return 'act/qq-schedule-message';
  if (qqActionKey === 'qq_schedule_qzone') return 'act/qq-schedule-qzone';
  if (qqActionKey === 'qq_list_scheduled') return 'act/qq-list-scheduled';
  if (qqActionKey === 'qq_cancel_scheduled') return 'act/qq-cancel-scheduled';
  return `direct_chat/${contract.chatMode}/${contract.responseIntent}`;
}

function resolvePolicyKey(route = {}) {
  const contract = buildCanonicalRouteContract(route);
  const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  const sourceScope = String(contract?.facets?.sourceScope || '').trim().toLowerCase();
  const domain = String(contract?.facets?.domain || '').trim().toLowerCase();
  const outputKind = String(contract?.facets?.outputKind || '').trim().toLowerCase();
  const toolIntent = String(contract?.toolIntent || '').trim().toLowerCase();
  const chatMode = String(contract?.chatMode || '').trim().toLowerCase();

  if (contract.topRouteType === 'ignore') return 'ignore/default';
  if (contract.topRouteType === 'refuse') return 'refuse/default';
  if (contract.topRouteType === 'admin') {
    return 'admin/default';
  }

  if (qqActionKey === 'qq_publish_qzone') return 'act/qq-publish-qzone';
  if (qqActionKey === 'qq_schedule_message') return 'act/qq-schedule-message';
  if (qqActionKey === 'qq_schedule_qzone') return 'act/qq-schedule-qzone';
  if (qqActionKey === 'qq_list_scheduled') return 'act/qq-list-scheduled';
  if (qqActionKey === 'qq_cancel_scheduled') return 'act/qq-cancel-scheduled';

  if (chatMode === 'image_summary') return 'transform/vision-summary';
  if (chatMode === 'image_qa') return 'lookup/vision-answer';

  if (sourceScope === 'notebook' || domain === 'personal') {
    if (outputKind === 'answer') return 'lookup/notebook-answer';
    if (outputKind === 'summary' || outputKind === 'rewrite') return 'transform/notebook-summary';
  }

  if (domain === 'weather') return 'lookup/weather-live';
  if (domain === 'finance') return 'lookup/finance-live';
  if (domain === 'location') return 'lookup/location-web';
  if (domain === 'music') return 'lookup/music-web';

  if (outputKind === 'quiz') return 'transform/quiz';
  if ((outputKind === 'summary' || outputKind === 'rewrite') && (sourceScope === 'web' || sourceScope === 'mixed')) {
    return 'transform/web-summary';
  }
  if ((outputKind === 'plan' || outputKind === 'report') && domain === 'research') return 'plan/research';
  if ((outputKind === 'plan' || outputKind === 'report') && toolIntent === 'none') return 'plan/general-direct';
  if (outputKind === 'plan' || outputKind === 'report') return 'plan/general';
  if (outputKind === 'action' || toolIntent === 'force_tools') return 'act/default';
  return 'chat/default';
}

function resolveQqActionTools(route = {}) {
  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  if (qqActionKey === 'qq_publish_qzone') return ['qzone_draft'];
  if (qqActionKey === 'qq_schedule_message') return ['schedule_group_message', 'create_scheduled_command'];
  if (qqActionKey === 'qq_schedule_qzone') return ['create_qzone_auto_task', 'create_scheduled_command'];
  if (qqActionKey === 'qq_list_scheduled') return ['list_scheduled_tasks'];
  if (qqActionKey === 'qq_cancel_scheduled') return ['list_scheduled_tasks', 'cancel_scheduled_task', 'delete_scheduled_task'];
  return [];
}

function normalizeAllowedToolBuckets(route = {}, allowedTools = []) {
  const planner = getToolPlanner(route);
  const plannerBuckets = Array.isArray(planner?.toolBuckets)
    ? planner.toolBuckets.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (plannerBuckets.length > 0) return Array.from(new Set(plannerBuckets));

  const buckets = [];
  for (const toolName of normalizeToolNames(allowedTools)) {
    if (/^mcp_/i.test(toolName)) buckets.push('mcp');
    else if (/^skill_/i.test(toolName)) buckets.push('skills');
    else buckets.push('local_tools');
  }
  return Array.from(new Set(buckets));
}

function normalizeChatType(route = {}) {
  return String(route?.meta?.chatType || route?.meta?.messageType || 'group').trim().toLowerCase() === 'private'
    ? 'private'
    : 'group';
}

function isPrivateActionExempt(route = {}, runtimeConfig = config) {
  if (normalizeChatType(route) !== 'private') return false;
  const userId = String(route?.meta?.userId || route?.meta?.senderId || '').trim();
  if (!userId) return false;
  return isPrivateChatAccessAllowed({
    chatType: 'private',
    userId,
    config: runtimeConfig
  });
}

function isPrivateAdminUser(route = {}, runtimeConfig = config) {
  if (normalizeChatType(route) !== 'private') return false;
  const userId = String(route?.meta?.userId || route?.meta?.senderId || '').trim();
  return isAdminUserId(userId, runtimeConfig);
}

function isPrivateSafeTool(toolName = '') {
  const normalized = String(toolName || '').trim();
  if (!normalized) return false;

  const blockedByName = new Set([
    'publish_qzone',
    'qzone_draft',
    'schedule_group_message',
    'create_qzone_auto_task',
    'create_scheduled_command',
    'list_scheduled_tasks',
    'cancel_scheduled_task',
    'delete_scheduled_task'
  ]);
  if (blockedByName.has(normalized)) return false;

  const capability = String(getPolicy(normalized)?.capability || '').trim().toLowerCase();
  if (capability.includes('write')) return false;
  if (capability === 'local_read') return false;
  return true;
}

function filterAllowedToolsForChatType(route = {}, allowedTools = [], runtimeConfig = config) {
  const rawTools = normalizeToolNames(allowedTools);
  if (isPrivateAdminUser(route, runtimeConfig)) return rawTools;
  const companionTools = filterCompanionAllowedTools(rawTools, runtimeConfig);
  const normalizedTools = routeHasExplicitWebSearchRequirement(route)
    ? normalizeToolNames([
        ...companionTools,
        ...rawTools.filter((toolName) => WEB_LOOKUP_ALLOWED_TOOLS.includes(toolName))
      ])
    : companionTools;
  if (normalizeChatType(route) !== 'private') return normalizedTools;
  if (isPrivateActionExempt(route, runtimeConfig)) return normalizedTools;
  return normalizedTools.filter((toolName) => isPrivateSafeTool(toolName));
}

function resolvePrivateRestrictionReason(route = {}, normalizedAllowedTools = [], originalAllowedTools = [], runtimeConfig = config) {
  if (normalizeChatType(route) !== 'private') return '';
  if (isPrivateActionExempt(route, runtimeConfig)) return '';
  const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
  if (command) return 'private-group-only';
  const qqActionKey = String(route?.meta?.qqActionKey || '').trim().toLowerCase();
  if (qqActionKey) return 'private-write-disabled';
  const chatMode = String(route?.meta?.chatMode || '').trim().toLowerCase();
  if (chatMode === 'image_qa' || chatMode === 'image_summary') return '';
  if (Array.isArray(originalAllowedTools) && originalAllowedTools.length > 0 && normalizedAllowedTools.length === 0) {
    return 'private-write-disabled';
  }
  return '';
}

function buildBasePlan(route = {}) {
  const topRouteType = sanitizeTopRouteType(route?.topRouteType || 'direct_chat');
  const policyKey = resolvePolicyKey(route);
  const routeDebugKey = buildRouteDebugKey(route);
  return {
    executor: 'direct',
    topRouteType,
    policyKey,
    routeDebugKey,
    allowTools: false,
    allowedTools: [],
    allowedToolBuckets: [],
    allowStream: topRouteType === 'direct_chat' && !route?.imageUrl,
    needsBackground: false,
    unavailableReason: '',
    routeTrace: buildRouteTrace(route, {
      executor: 'direct',
      topRouteType,
      policyKey,
      routeDebugKey
    })
  };
}

function resolvePlannerSource(route = {}) {
  const planner = getToolPlanner(route);
  return String(
    planner?.executablePlan?.source
    || planner?.plannerSource
    || planner?.decisionSource
    || planner?.plannerMeta?.decisionSource
    || (planner ? 'planner' : '')
  ).trim();
}

function buildRouteTrace(route = {}, plan = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const topRouteType = String(plan.topRouteType || sanitizeTopRouteType(route?.topRouteType || 'direct_chat')).trim();
  const policyKey = String(plan.policyKey || resolvePolicyKey(route)).trim();
  const executor = String(plan.executor || 'direct').trim();
  const planner = getToolPlanner(route);
  return {
    topRouteType,
    policyKey,
    plannerSource: resolvePlannerSource(route),
    executor,
    confidence: Number.isFinite(Number(route?.confidence)) ? Number(route.confidence) : 0,
    fallbackReason: String(plan.unavailableReason || routeMeta.fallbackReason || routeMeta.reason || '').trim(),
    executablePlan: summarizeExecutablePlan(planner?.executablePlan || routeMeta.executablePlan || null)
  };
}

function withRouteTrace(route = {}, plan = {}) {
  return {
    ...plan,
    routeTrace: buildRouteTrace(route, plan)
  };
}

function resolveDirectChatExecution(route = {}, runtimeConfig = config) {
  const base = buildBasePlan(route);
  const plannerDecision = getToolPlanner(route);
  const toolIntent = String(route?.meta?.toolIntent || '').trim();
  const qqActionTools = resolveQqActionTools(route);
  const executionPlan = plannerDecision?.executionPlan && typeof plannerDecision.executionPlan === 'object'
    ? plannerDecision.executionPlan
    : null;
  const singleAuthorityEnabled = config.PLANNER_SINGLE_AUTHORITY_ENABLED === true;
  const isUserToolRoute = new Set(['maybe_tools', 'force_tools']).has(toolIntent);
  const shouldRequirePlanner = singleAuthorityEnabled && isUserToolRoute && !hasQqFixedAction(route);

  if (shouldRequirePlanner && !plannerDecision) {
    console.error('[routeExecution] missing toolPlanner for user tool route', {
      routeDebugKey: buildRouteDebugKey(route),
      toolIntent,
      responseIntent: String(route?.meta?.responseIntent || '').trim()
    });
    return withRouteTrace(route, {
      ...base,
      executor: 'direct',
      policyKey: resolvePolicyKey(route),
      routeDebugKey: buildRouteDebugKey(route),
      allowStream: false,
      needsBackground: false,
      unavailableReason: 'planner-missing'
    });
  }

  const plannerAllowedTools = normalizeToolNames(
    Array.isArray(plannerDecision?.allowedToolNames) && plannerDecision.allowedToolNames.length > 0
      ? plannerDecision.allowedToolNames
      : (Array.isArray(executionPlan?.steps) ? executionPlan.steps.map((step) => step?.action) : [])
  );
  const rawAllowedTools = qqActionTools.length > 0
    ? plannerAllowedTools.filter((toolName) => qqActionTools.includes(toolName))
    : plannerAllowedTools;
  const allowedTools = filterAllowedToolsForChatType(route, rawAllowedTools, runtimeConfig);
  const executablePlan = plannerDecision?.executablePlan || buildExecutablePlanFromPlannerDecision(plannerDecision || {}, resolvePolicyKey(route), route);
  const validation = validateExecutablePlanTools(executablePlan, allowedTools);
  const toolPlanAllowedSteps = validation.allowedPlanSteps.filter((step) => step.action && step.action !== 'reply');
  const shouldUseTools = String(executionPlan?.mode || '').trim() === 'tool_plan' && toolPlanAllowedSteps.length > 0;
  const needsBackground = Boolean(plannerDecision?.needsBackground);
  const routeDebugKey = buildRouteDebugKey(route);
  const policyKey = resolvePolicyKey(route);
  const privateRestrictionReason = resolvePrivateRestrictionReason(route, allowedTools, rawAllowedTools, runtimeConfig);
  const chatMode = String(route?.meta?.chatMode || '').trim().toLowerCase();
  const visionDirectReply = normalizeChatType(route) === 'private'
    && (chatMode === 'image_qa' || chatMode === 'image_summary')
    && rawAllowedTools.length === 0;

  if (!shouldUseTools) {
    if (visionDirectReply) {
      return withRouteTrace(route, {
        ...base,
        executor: needsBackground ? 'background_direct' : 'direct',
        policyKey,
        routeDebugKey,
      allowStream: false,
      needsBackground,
      executablePlan: validation.executablePlan,
      allowedPlanSteps: validation.allowedPlanSteps,
      blockedPlanSteps: validation.blockedPlanSteps,
      unavailableReason: ''
    });
    }
    if (toolIntent === 'force_tools') {
      return withRouteTrace(route, {
        ...base,
        executor: needsBackground ? 'background_direct' : 'direct',
        policyKey,
        routeDebugKey,
        allowStream: false,
        needsBackground,
        executablePlan: validation.executablePlan,
        allowedPlanSteps: validation.allowedPlanSteps,
        blockedPlanSteps: validation.blockedPlanSteps,
        unavailableReason: privateRestrictionReason || 'no-allowed-tools'
      });
    }
    return withRouteTrace(route, {
      ...base,
      executor: needsBackground ? 'background_direct' : 'direct',
      policyKey,
      routeDebugKey,
      allowStream: !needsBackground && !route?.imageUrl,
      needsBackground,
      executablePlan: validation.executablePlan,
      allowedPlanSteps: validation.allowedPlanSteps,
      blockedPlanSteps: validation.blockedPlanSteps
    });
  }

  return withRouteTrace(route, {
    ...base,
    executor: needsBackground ? 'background_direct' : 'direct',
    policyKey,
    routeDebugKey,
    allowTools: true,
    allowedTools,
    executablePlan: validation.executablePlan,
    allowedPlanSteps: validation.allowedPlanSteps,
    blockedPlanSteps: validation.blockedPlanSteps,
    allowedToolBuckets: normalizeAllowedToolBuckets(route, allowedTools),
    allowStream: false,
    needsBackground,
    unavailableReason: ''
  });
}

function resolveRouteExecution(route = {}, runtimeConfig = config, _options = {}) {
  const contract = buildCanonicalRouteContract(route);
  const base = buildBasePlan(route);
  const chatType = normalizeChatType(route);

  if (contract.topRouteType === 'ignore') {
    return withRouteTrace(route, {
      ...base,
      executor: 'ignore',
      allowStream: false
    });
  }

  if (contract.topRouteType === 'refuse') {
    return withRouteTrace(route, {
      ...base,
      executor: 'refuse',
      allowStream: false
    });
  }

  if (contract.topRouteType === 'admin') {
    if (chatType === 'private' && !isPrivateAdminUser(route, runtimeConfig || config)) {
      return withRouteTrace(route, {
        ...base,
        executor: 'direct',
        routeDebugKey: buildRouteDebugKey(route),
        allowStream: false,
        unavailableReason: 'private-group-only'
      });
    }
    return withRouteTrace(route, {
      ...base,
      executor: 'admin',
      routeDebugKey: buildRouteDebugKey(route),
      allowStream: false
    });
  }

  if (contract.topRouteType === 'direct_chat') {
    return resolveDirectChatExecution(route, runtimeConfig || config);
  }

  return withRouteTrace(route, {
    ...base,
    executor: 'direct',
    routeDebugKey: buildRouteDebugKey(route)
  });
}

function shouldUseToolRoute(route = {}) {
  return resolveRouteExecution(route).allowTools === true;
}

function shouldUseSubagentToolRoute(route = {}) {
  return false;
}

function getPolicyDefinition(policyKey = '') {
  const normalized = String(policyKey || '').trim();
  const profileDefinition = getPolicyDefinitionFromProfiles(normalized);
  if (profileDefinition) return profileDefinition;
  if (normalized.startsWith('ignore/')) return { capability: 'ignore' };
  if (normalized.startsWith('refuse/')) return { capability: 'refuse' };
  if (normalized.startsWith('admin/')) return { capability: 'admin' };
  return { capability: 'direct' };
}

module.exports = {
  EXECUTORS,
  buildRouteDebugKey,
  buildRouteTrace,
  getPolicyDefinition,
  resolvePolicyKey,
  resolveRouteExecution,
  shouldUseSubagentToolRoute,
  shouldUseToolRoute
};
