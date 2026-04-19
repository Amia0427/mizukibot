const {
  buildCanonicalRouteContract,
  sanitizeTopRouteType
} = require('./routeSchema');
const { normalizeToolNames } = require('../utils/localToolAccess');
const { getPolicyDefinition: getPolicyDefinitionFromProfiles } = require('./routeProfiles');
const { getPolicy } = require('../utils/toolPolicy');
const config = require('../config');

// routeExecution consumes only canonical contract data plus planner output.
// It must not infer a new top route type or treat routeProfiles as routing truth.

const EXECUTORS = Object.freeze([
  'ignore',
  'refuse',
  'admin',
  'direct',
  'background_direct',
  'full_subagent'
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
  if (normalized === 'admin' || normalized === 'full_subagent') return 'admin';
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
      if (command === 'full' && route?.meta?.admin !== true) return 'admin/unauthorized';
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
    if (command === 'full') return 'admin/full';
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
  if (qqActionKey === 'qq_publish_qzone') return ['publish_qzone'];
  if (qqActionKey === 'qq_schedule_message') return ['schedule_group_message', 'create_scheduled_command'];
  if (qqActionKey === 'qq_schedule_qzone') return ['create_scheduled_command'];
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

function isPrivateSafeTool(toolName = '') {
  const normalized = String(toolName || '').trim();
  if (!normalized) return false;

  const blockedByName = new Set([
    'publish_qzone',
    'schedule_group_message',
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

function filterAllowedToolsForChatType(route = {}, allowedTools = []) {
  const normalizedTools = normalizeToolNames(allowedTools);
  if (normalizeChatType(route) !== 'private') return normalizedTools;
  return normalizedTools.filter((toolName) => isPrivateSafeTool(toolName));
}

function resolvePrivateRestrictionReason(route = {}, normalizedAllowedTools = [], originalAllowedTools = []) {
  if (normalizeChatType(route) !== 'private') return '';
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
  return {
    executor: 'direct',
    topRouteType,
    policyKey: resolvePolicyKey(route),
    routeDebugKey: buildRouteDebugKey(route),
    allowTools: false,
    allowedTools: [],
    allowedToolBuckets: [],
    allowStream: topRouteType === 'direct_chat' && !route?.imageUrl,
    needsBackground: false,
    unavailableReason: ''
  };
}

function resolveDirectChatExecution(route = {}) {
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
    return {
      ...base,
      executor: 'direct',
      policyKey: resolvePolicyKey(route),
      routeDebugKey: buildRouteDebugKey(route),
      allowStream: false,
      needsBackground: false,
      unavailableReason: 'planner-missing'
    };
  }

  const plannerAllowedTools = normalizeToolNames(
    Array.isArray(executionPlan?.steps)
      ? executionPlan.steps.map((step) => step?.action)
      : plannerDecision?.allowedToolNames || []
  );
  const rawAllowedTools = qqActionTools.length > 0
    ? plannerAllowedTools.filter((toolName) => qqActionTools.includes(toolName))
    : plannerAllowedTools;
  const allowedTools = filterAllowedToolsForChatType(route, rawAllowedTools);
  const shouldUseTools = String(executionPlan?.mode || '').trim() === 'tool_plan' && allowedTools.length > 0;
  const needsBackground = Boolean(plannerDecision?.needsBackground);
  const routeDebugKey = buildRouteDebugKey(route);
  const policyKey = resolvePolicyKey(route);
  const privateRestrictionReason = resolvePrivateRestrictionReason(route, allowedTools, rawAllowedTools);
  const chatMode = String(route?.meta?.chatMode || '').trim().toLowerCase();
  const visionDirectReply = normalizeChatType(route) === 'private'
    && (chatMode === 'image_qa' || chatMode === 'image_summary')
    && rawAllowedTools.length === 0;

  if (!shouldUseTools) {
    if (visionDirectReply) {
      return {
        ...base,
        executor: needsBackground ? 'background_direct' : 'direct',
        policyKey,
        routeDebugKey,
        allowStream: false,
        needsBackground,
        unavailableReason: ''
      };
    }
    if (toolIntent === 'force_tools') {
      return {
        ...base,
        executor: needsBackground ? 'background_direct' : 'direct',
        policyKey,
        routeDebugKey,
        allowStream: false,
        needsBackground,
        unavailableReason: privateRestrictionReason || 'no-allowed-tools'
      };
    }
    return {
      ...base,
      executor: needsBackground ? 'background_direct' : 'direct',
      policyKey,
      routeDebugKey,
      allowStream: !needsBackground && !route?.imageUrl,
      needsBackground
    };
  }

  return {
    ...base,
    executor: needsBackground ? 'background_direct' : 'direct',
    policyKey,
    routeDebugKey,
    allowTools: true,
    allowedTools,
    allowedToolBuckets: normalizeAllowedToolBuckets(route, allowedTools),
    allowStream: false,
    needsBackground,
    unavailableReason: ''
  };
}

function resolveRouteExecution(route = {}, _config = {}, _options = {}) {
  const contract = buildCanonicalRouteContract(route);
  const base = buildBasePlan(route);
  const chatType = normalizeChatType(route);

  if (contract.topRouteType === 'ignore') {
    return {
      ...base,
      executor: 'ignore',
      allowStream: false
    };
  }

  if (contract.topRouteType === 'refuse') {
    return {
      ...base,
      executor: 'refuse',
      allowStream: false
    };
  }

  if (contract.topRouteType === 'admin') {
    if (chatType === 'private') {
      return {
        ...base,
        executor: 'direct',
        routeDebugKey: buildRouteDebugKey(route),
        allowStream: false,
        unavailableReason: 'private-group-only'
      };
    }
    const command = String(route?.meta?.command?.cmd || '').trim().toLowerCase();
    if (command === 'full' && route?.meta?.admin === true) {
      return {
        ...base,
        executor: 'full_subagent',
        policyKey: 'admin/full',
        routeDebugKey: 'admin/full',
        allowStream: false,
        needsBackground: true
      };
    }

    return {
      ...base,
      executor: 'admin',
      routeDebugKey: buildRouteDebugKey(route),
      allowStream: false
    };
  }

  if (contract.topRouteType === 'direct_chat') {
    return resolveDirectChatExecution(route);
  }

  return {
    ...base,
    executor: 'direct',
    routeDebugKey: buildRouteDebugKey(route)
  };
}

function shouldUseToolRoute(route = {}) {
  const topRouteType = sanitizeTopRouteType(route?.topRouteType || 'direct_chat');
  if (topRouteType !== 'direct_chat') return false;
  return String(getToolPlanner(route)?.executionPlan?.mode || '').trim() === 'tool_plan';
}

function shouldUseSubagentToolRoute(route = {}) {
  return sanitizeTopRouteType(route?.topRouteType || '') === 'admin'
    && String(route?.meta?.command?.cmd || '').trim().toLowerCase() === 'full'
    && route?.meta?.admin === true;
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
  getPolicyDefinition,
  resolvePolicyKey,
  resolveRouteExecution,
  shouldUseSubagentToolRoute,
  shouldUseToolRoute
};
