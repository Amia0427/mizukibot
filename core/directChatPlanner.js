const planning = require('../api/runtimeV2/planning/service');
const { enqueueResearchTask } = require('./researchTaskQueue');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');
const { resolvePolicyKey } = require('./routeExecution');
const { routeHasExplicitWebSearchRequirement } = require('../utils/webSearchRequirement');
const {
  attachExecutablePlanToPlannerDecision,
  buildExecutablePlanFromPlannerDecision,
  buildExecutablePlanFromPolicy
} = require('./executablePlan');
const {
  buildCanonicalRouteContract
} = require('./routeSchema');
const { extractFirstSupportedSharedLink } = require('../api/skills_native/sharedLink/url');

function hasOwnValue(source = {}, key = '') {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function hasMeaningfulObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function pickObjectOption(options = {}, routeMeta = {}, key = '', fallback = {}) {
  if (hasOwnValue(options, key) && hasMeaningfulObject(options[key])) return options[key];
  if (hasOwnValue(routeMeta, key) && hasMeaningfulObject(routeMeta[key])) return routeMeta[key];
  if (hasOwnValue(options, key) && options[key] && typeof options[key] === 'object' && !Array.isArray(options[key])) return options[key];
  if (hasOwnValue(routeMeta, key) && routeMeta[key] && typeof routeMeta[key] === 'object' && !Array.isArray(routeMeta[key])) return routeMeta[key];
  return fallback;
}

function pickArrayOption(options = {}, routeMeta = {}, key = '') {
  if (Array.isArray(options[key]) && options[key].length > 0) return options[key];
  if (Array.isArray(routeMeta[key]) && routeMeta[key].length > 0) return routeMeta[key];
  if (Array.isArray(options[key])) return options[key];
  if (Array.isArray(routeMeta[key])) return routeMeta[key];
  return [];
}

function pickTextOption(options = {}, routeMeta = {}, key = '') {
  return options[key] || routeMeta[key] || '';
}

function maybeEnqueueBackgroundResearch(route = {}, decision = {}, options = {}) {
  const meta = decision?.plannerMeta && typeof decision.plannerMeta === 'object' ? decision.plannerMeta : {};
  if (meta.backgroundResearchRequested !== true) return { enqueued: false, reason: 'not-requested' };
  const userId = String(options?.userId || route?.meta?.userId || '').trim();
  const sessionKey = String(options?.sessionKey || route?.meta?.sessionKey || route?.meta?.session_key || resolveShortTermSessionKey(userId, route?.meta || {}) || '').trim();
  return enqueueResearchTask({
    query: meta.backgroundResearchQuery || route?.cleanText || route?.question || '',
    sessionKey,
    userId,
    routeMeta: route?.meta || {}
  });
}

function shouldBypassImageSummaryPlanner(route = {}, _available = {}, options = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const chatMode = String(routeMeta.chatMode || '').trim().toLowerCase();
  if (chatMode !== 'image_summary') return false;
  if (String(routeMeta.toolIntent || '').trim().toLowerCase() === 'force_tools') return false;
  if (routeHasExplicitWebSearchRequirement(route)) return false;
  const explicitAllowedTools = Array.isArray(options?.allowedTools)
    ? options.allowedTools
    : (Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : null);
  if (Array.isArray(explicitAllowedTools) && explicitAllowedTools.length > 0) return false;
  return true;
}

function hasExplicitAllowedTools(route = {}, options = {}) {
  if (Array.isArray(options?.allowedTools) && options.allowedTools.length > 0) return true;
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  return Array.isArray(routeMeta.allowedTools) && routeMeta.allowedTools.length > 0;
}

function shouldBypassPlainChatPlanner(route = {}, _available = {}, options = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const contract = buildCanonicalRouteContract(route);
  if (contract.topRouteType !== 'direct_chat') return false;
  if (contract.chatMode !== 'text_chat') return false;
  if (contract.toolIntent !== 'none') return false;
  if (contract.intent.needsMemory === true) return false;
  if (contract.intent.needsPlanning === true) return false;
  if (resolvePolicyKey(route) !== 'chat/default') return false;
  if (contract.facets.sourceScope !== 'none') return false;
  if (routeHasExplicitWebSearchRequirement(route)) return false;
  if (hasExplicitAllowedTools(route, options)) return false;
  if (routeMeta.needsMemoryReason || routeMeta.recallFacet) return false;
  return true;
}

function shouldBypassNotebookChatOnlyPlanner(route = {}, _available = {}, options = {}) {
  const routeMeta = route?.meta && typeof route.meta === 'object' ? route.meta : {};
  const contract = buildCanonicalRouteContract(route);
  if (contract.topRouteType !== 'direct_chat') return false;
  if (contract.chatMode !== 'text_chat') return false;
  if (contract.toolIntent === 'force_tools') return false;
  if (contract.intent.needsMemory === true) return false;
  if (contract.intent.needsPlanning === true) return false;
  if (resolvePolicyKey(route) !== 'lookup/notebook-answer') return false;
  if (contract.facets.sourceScope !== 'notebook' && contract.facets.domain !== 'personal') return false;
  if (routeHasExplicitWebSearchRequirement(route)) return false;
  if (hasExplicitAllowedTools(route, options)) return false;
  if (routeMeta.needsMemoryReason || routeMeta.recallFacet) return false;
  return true;
}

function buildChatOnlyPlannerDecision(route = {}, available = {}, options = {}) {
  const policyKey = resolvePolicyKey(route);
  const decision = planning.normalizePlannerDecisionV2({
    mode: 'chat_only',
    taskShape: 'fast_reply',
    allowedToolNames: [],
    steps: [],
    plannerMeta: {
      decisionVersion: planning.PLANNER_DECISION_VERSION,
      plannerVersion: planning.DIRECT_CHAT_PLANNER_VERSION,
      reason: String(options.reason || 'no planner tools available').trim(),
      plannerModel: planning.getPlannerModelName(),
      decisionSource: String(options.decisionSource || 'rule_preflight_no_tools').trim(),
      fallbackUsed: false,
      semanticConfidence: 0.92,
      needsSemanticRefinement: false,
      semanticAssessment: {
        intentSummary: String(options.intentSummary || 'direct chat reply').trim() || 'direct chat reply',
        sourceScope: String(options.sourceScope || 'current_context').trim() || 'current_context',
        contextDependencies: [],
        ambiguity: [],
        confidence: 0.92,
        needsRefinement: false
      }
    }
  }, route, {
    ...options,
    toolCatalog: available.toolCatalog,
    fallbackUsed: false
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, {
    toolCatalog: available.toolCatalog
  });
  return attachExecutablePlanToPlannerDecision(
    directChatDecision,
    buildExecutablePlanFromPlannerDecision(directChatDecision, policyKey, route)
  );
}

function buildSharedLinkPlannerDecision(route = {}, available = {}, options = {}) {
  const contract = buildCanonicalRouteContract(route);
  if (contract.topRouteType !== 'direct_chat') return null;
  if (!available.allowedToolNames.includes('read_shared_link')) return null;
  const url = extractFirstSupportedSharedLink(route?.question || route?.cleanText || '');
  if (!url) return null;
  const policyKey = resolvePolicyKey(route);
  const decision = planning.normalizePlannerDecisionV2({
    mode: 'tool_plan',
    taskShape: 'tool_augmented_reply',
    allowedToolNames: ['read_shared_link'],
    steps: [{
      id: 'read_shared_link_1',
      tool: 'read_shared_link',
      args: { url },
      purpose: '读取用户本轮分享链接的公开内容，供主回复结合当前对话回应',
      successCriteria: '返回公开内容或明确的不可用说明'
    }],
    plannerMeta: {
      decisionVersion: planning.PLANNER_DECISION_VERSION,
      plannerVersion: planning.DIRECT_CHAT_PLANNER_VERSION,
      reason: 'supported shared link detected after reply routing',
      plannerModel: planning.getPlannerModelName(),
      decisionSource: 'rule_preflight_shared_link',
      fallbackUsed: false,
      semanticConfidence: 1,
      needsSemanticRefinement: false
    }
  }, route, {
    ...options,
    toolCatalog: available.toolCatalog,
    fallbackUsed: false
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, {
    toolCatalog: available.toolCatalog
  });
  return attachExecutablePlanToPlannerDecision(
    directChatDecision,
    buildExecutablePlanFromPlannerDecision(directChatDecision, policyKey, route)
  );
}

function getRouteCardContexts(route = {}) {
  const contexts = Array.isArray(route?.meta?.cardContexts) ? route.meta.cardContexts : [];
  return contexts.filter((card) => card && typeof card === 'object');
}

function getOrderedCardUrls(route = {}, cardContexts = []) {
  const urls = [];
  const seen = new Set();
  const primaryUrls = new Set(cardContexts.map((card) => String(card.primaryUrl || '').trim()).filter(Boolean));
  const candidates = [
    ...(Array.isArray(route?.meta?.qqCardUrls)
      ? route.meta.qqCardUrls.filter((url) => primaryUrls.has(String(url || '').trim()))
      : []),
    ...cardContexts.map((card) => card.primaryUrl)
  ];
  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function hasExplicitCardReadRequest(text = '') {
  return /(查看|看看|读一下|读取|总结|摘要|概括|评价|点评|分析|比较|对比|区别|哪个好|怎么样|讲了什么|内容是什么)/i.test(String(text || ''));
}

function buildCardChatOnlyDecision(route = {}, available = {}, options = {}, details = {}) {
  return buildChatOnlyPlannerDecision(route, available, {
    ...options,
    reason: details.reason,
    decisionSource: details.decisionSource,
    intentSummary: details.intentSummary || 'respond to shared card metadata',
    sourceScope: 'current_card_metadata'
  });
}

function buildCardPlannerDecision(route = {}, available = {}, options = {}) {
  const contract = buildCanonicalRouteContract(route);
  if (contract.topRouteType !== 'direct_chat') return null;
  const cardContexts = getRouteCardContexts(route);
  if (cardContexts.length === 0) return null;
  if (cardContexts.length > 3) {
    return buildCardChatOnlyDecision(route, available, options, {
      reason: 'more than three cards require user narrowing',
      decisionSource: 'rule_preflight_card_limit',
      intentSummary: 'ask user to narrow shared cards to at most three'
    });
  }

  const urls = getOrderedCardUrls(route, cardContexts);
  if (urls.length === 0) {
    return buildCardChatOnlyDecision(route, available, options, {
      reason: 'card metadata has no readable public url',
      decisionSource: 'rule_preflight_card_metadata'
    });
  }

  const chatType = String(route?.meta?.chatType || '').trim().toLowerCase();
  const text = route?.question || route?.cleanText || '';
  const shouldRead = urls.length > 1
    || hasExplicitCardReadRequest(text)
    || (chatType === 'private' && route?.meta?.cardOnly === true);
  if (!shouldRead || !available.allowedToolNames.includes('web_fetch')) {
    return buildCardChatOnlyDecision(route, available, options, {
      reason: shouldRead ? 'card fetch tool unavailable' : 'ordinary card share does not require network reading',
      decisionSource: shouldRead ? 'rule_preflight_card_tool_unavailable' : 'rule_preflight_card_chat_only'
    });
  }

  const policyKey = resolvePolicyKey(route);
  const decision = planning.normalizePlannerDecisionV2({
    mode: 'tool_plan',
    taskShape: 'tool_augmented_reply',
    allowedToolNames: ['web_fetch'],
    steps: urls.map((url, index) => ({
      id: `qq_card_fetch_${index + 1}`,
      tool: 'web_fetch',
      args: { url },
      kind: 'tool',
      dependsOn: [],
      parallelGroup: urls.length > 1 ? 'qq_card_fetch' : '',
      sideEffect: false,
      purpose: `读取第 ${index + 1} 张分享卡片的公开页面，供主回复结合当前对话回应`,
      successCriteria: '返回公开页面正文或明确的不可用说明'
    })),
    plannerMeta: {
      decisionVersion: planning.PLANNER_DECISION_VERSION,
      plannerVersion: planning.DIRECT_CHAT_PLANNER_VERSION,
      reason: urls.length > 1 ? 'read two or three shared cards in parallel' : 'read requested shared card',
      plannerModel: planning.getPlannerModelName(),
      decisionSource: 'rule_preflight_qq_card',
      fallbackUsed: false,
      semanticConfidence: 1,
      needsSemanticRefinement: false
    }
  }, route, {
    ...options,
    toolCatalog: available.toolCatalog,
    fallbackUsed: false
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, {
    toolCatalog: available.toolCatalog
  });
  return attachExecutablePlanToPlannerDecision(
    directChatDecision,
    buildExecutablePlanFromPlannerDecision(directChatDecision, policyKey, route)
  );
}

async function planDirectChat(route = {}, options = {}) {
  const available = planning.collectAvailableToolSummary(route, options);
  const cardDecision = buildCardPlannerDecision(route, available, options);
  if (cardDecision) return cardDecision;
  const sharedLinkDecision = buildSharedLinkPlannerDecision(route, available, options);
  if (sharedLinkDecision) return sharedLinkDecision;
  if (shouldBypassImageSummaryPlanner(route, available, options)) {
    return buildChatOnlyPlannerDecision(route, available, {
      ...options,
      reason: 'image_summary has no explicit tool requirement; skip remote planner',
      decisionSource: 'rule_preflight_image_summary'
    });
  }
  if (shouldBypassPlainChatPlanner(route, available, options)) {
    return buildChatOnlyPlannerDecision(route, available, {
      ...options,
      reason: 'plain chat/default has no tool or memory dependency; skip remote planner',
      decisionSource: 'rule_preflight_plain_chat',
      intentSummary: 'plain private chat direct reply',
      sourceScope: 'current_context'
    });
  }
  if (shouldBypassNotebookChatOnlyPlanner(route, available, options)) {
    return buildChatOnlyPlannerDecision(route, available, {
      ...options,
      reason: 'notebook-answer route has no explicit notebook/memory dependency; skip remote planner',
      decisionSource: 'rule_preflight_notebook_chat_only',
      intentSummary: 'notebook-labeled direct reply without retrieval',
      sourceScope: 'notebook_route_without_retrieval'
    });
  }
  const policyKey = resolvePolicyKey(route);
  const routeMeta = route?.meta || {};
  const explicitAllowedTools = Array.isArray(options?.allowedTools)
    ? options.allowedTools
    : (Array.isArray(routeMeta.allowedTools) ? routeMeta.allowedTools : undefined);
  const decision = await planning.planRequestV2({
    question: route?.question || route?.cleanText || '',
    cleanText: route?.cleanText || route?.question || '',
    imageUrl: route?.imageUrl || null,
    topRouteType: route?.topRouteType || 'direct_chat',
    routeMeta,
    route: {
      ...route,
      question: route?.question || route?.cleanText || '',
      cleanText: route?.cleanText || route?.question || ''
    },
    intent: route?.intent || {},
    facets: route?.facets || {},
    userId: options?.userId || route?.meta?.userId || '',
    ...(explicitAllowedTools ? { allowedTools: explicitAllowedTools } : {}),
    toolCatalog: available.toolCatalog,
    contextSummary: options?.contextSummary || route?.meta?.contextSummary || route?.meta?.conversationSummary || '',
    directedContext: options?.directedContext || routeMeta.directedContext || null,
    continuitySignals: pickObjectOption(options, routeMeta, 'continuitySignals'),
    memoryContext: pickObjectOption(options, routeMeta, 'memoryContext'),
    availableContextSignals: pickObjectOption(options, routeMeta, 'availableContextSignals'),
    personaModuleCatalog: pickArrayOption(options, routeMeta, 'personaModuleCatalog'),
    dynamicPromptBlockCatalog: pickArrayOption(options, routeMeta, 'dynamicPromptBlockCatalog'),
    dynamicPromptGuide: pickTextOption(options, routeMeta, 'dynamicPromptGuide'),
    dynamicFewShotPrompt: pickTextOption(options, routeMeta, 'dynamicFewShotPrompt'),
    mainReplyPromptMode: pickTextOption(options, routeMeta, 'mainReplyPromptMode'),
    memoryCliTurn: pickObjectOption(options, routeMeta, 'memoryCliTurn'),
    schedulerInjection: options?.schedulerInjection || routeMeta.schedulerInjection || routeMeta.lifeSchedulerInjection,
    sharedShortTermContext: pickObjectOption(options, routeMeta, 'sharedShortTermContext'),
    personaMemoryState: pickObjectOption(options, routeMeta, 'personaMemoryState'),
    userInfo: pickObjectOption(options, routeMeta, 'userInfo'),
    constraints: options?.constraints || {},
    requestTrace: options?.requestTrace || routeMeta.requestTrace || null,
    planner: options?.planner
  });
  const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, {
    toolCatalog: available.toolCatalog
  });
  const backgroundResearch = maybeEnqueueBackgroundResearch(route, decision, options);
  const decisionWithResearch = {
    ...directChatDecision,
    backgroundResearch
  };
  return attachExecutablePlanToPlannerDecision(
    decisionWithResearch,
    buildExecutablePlanFromPlannerDecision(decisionWithResearch, policyKey, route)
  );
}

module.exports = {
  DIRECT_CHAT_PLANNER_VERSION: planning.DIRECT_CHAT_PLANNER_VERSION,
  PLANNER_DECISION_VERSION: planning.PLANNER_DECISION_VERSION,
  TOOL_BUCKETS: planning.TOOL_BUCKETS,
  TASK_SHAPES: planning.TASK_SHAPES,
  buildPlannerPrompt: planning.buildPlannerPrompt,
  buildRuleBasedPlan: planning.buildRuleBasedPlannerDecision,
  buildExecutionPlan({ shouldUseTools = false, allowedToolNames = [], route = {}, toolCatalog = [] } = {}) {
    return planning.buildLegacyExecutionPlanFromSteps(
      shouldUseTools
        ? planning.buildPlannerStepGraphSequence(route, allowedToolNames, toolCatalog, { contextEvidence: false })
        : []
    );
  },
  buildExecutablePlanFromPolicy,
  buildExecutablePlanFromPlannerDecision,
  collectAvailableToolSummary: planning.collectAvailableToolSummary,
  deriveToolArgs: planning.deriveToolArgs,
  deriveMemoryOpenArgs: planning.deriveMemoryOpenArgs,
  finalizePlannerDecision(plan = {}, route = {}, options = {}) {
    const toolCatalog = Array.isArray(options?.toolCatalog) ? options.toolCatalog : planning.collectAvailableToolSummary(route, options).toolCatalog;
    const decision = planning.normalizePlannerDecisionV2({
      mode: plan?.shouldUseTools ? 'tool_plan' : 'chat_only',
      taskShape: plan?.taskShape,
      allowedToolNames: plan?.allowedToolNames || [],
      steps: Array.isArray(plan?.executionPlan?.steps)
        ? plan.executionPlan.steps.map((step) => ({
            id: step?.id,
            tool: step?.action,
            args: step?.args,
            purpose: step?.purpose,
            successCriteria: step?.purpose
          }))
        : [],
      plannerMeta: {
        decisionVersion: planning.PLANNER_DECISION_VERSION,
        plannerVersion: planning.DIRECT_CHAT_PLANNER_VERSION,
        reason: plan?.reason || '',
        plannerModel: plan?.plannerModel || planning.getPlannerModelName(),
        decisionSource: 'planner'
      }
    }, route, {
      ...options,
      toolCatalog,
      fallbackUsed: Boolean(options?.plannerFallbackUsed)
    });
    const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, { toolCatalog });
    return attachExecutablePlanToPlannerDecision(
      directChatDecision,
      buildExecutablePlanFromPlannerDecision(directChatDecision, resolvePolicyKey(route), route)
    );
  },
  getPlannerDecisionVersion: planning.getPlannerDecisionVersion,
  normalizePlannerOutput(output = {}, route = {}, options = {}) {
    const toolCatalog = planning.collectAvailableToolSummary(route, options).toolCatalog;
    const decision = planning.normalizePlannerDecisionV2(output, route, {
      ...options,
      toolCatalog,
      fallbackUsed: false
    });
    const directChatDecision = planning.convertPlannerDecisionToDirectChatDecision(decision, route, { toolCatalog });
    return attachExecutablePlanToPlannerDecision(
      directChatDecision,
      buildExecutablePlanFromPlannerDecision(directChatDecision, resolvePolicyKey(route), route)
    );
  },
  maybeEnqueueBackgroundResearch,
  planDirectChat,
  prefersMemoryRecall: planning.prefersMemoryRecall,
  requiresToolEvidence: planning.requiresToolEvidence,
  pickMinimalToolAllowlist: planning.pickMinimalToolAllowlist,
  buildPlannerUserPayload: planning.buildPlannerUserPayload,
  callPlannerSubagent: planning.callPlannerSubagentV2
};
