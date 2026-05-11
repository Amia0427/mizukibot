function shouldUsePlanAndSolve(question = '', customPrompt = null, imageUrl = null) {
  const currentConfig = getConfig();
  if (!currentConfig.ENABLE_PLAN_SOLVE) return false;
  if (customPrompt) return false;
  if (imageUrl) return false;

  const q = String(question || '').trim();
  if (!q) return false;

  const planningSignal = /(?:\u89c4\u5212|\u8ba1\u5212|\u65b9\u6848|\u6b65\u9aa4|\u62c6\u89e3|\u5bf9\u6bd4|\u5206\u6790|\u8bc4\u4f30|\u8bc1\u660e|\u6392\u67e5|\u8bca\u65ad|\u5982\u4f55|\u600e\u4e48|plan|roadmap|checklist|debug|investigate|compare|strategy|proposal|design|architecture|step\s*by\s*step|root\s*cause)/i;
  if (planningSignal.test(q)) return true;
  if (q.length >= 100) return true;
  if (/[\r\n]/.test(q) && /(?:^|\s)(?:\d+\.|[-*]|\u2460|\u2461|\u2462)/m.test(q)) return true;

  const questionMarks = (q.match(/[?\uff1f]/g) || []).length;
  return questionMarks >= 2;
}

function fallbackReplyPlan(question = '') {
  return {
    goal: String(question || '').trim(),
    need_tools: false,
    steps: [{ id: 1, action: 'reply', args: {}, purpose: 'Reply directly' }]
  };
}

function sanitizePlan(rawPlan, question = '') {
  if (!rawPlan || !Array.isArray(rawPlan.steps)) {
    return fallbackReplyPlan(question);
  }

  const maxSteps = Math.max(1, Math.min(8, Number(config.PLAN_MAX_STEPS) || 5));
  const sanitizedSteps = rawPlan.steps
    .slice(0, maxSteps)
    .map((step, index) => ({
      id: Number(step?.id) || (index + 1),
      action: String(step?.action || '').trim(),
      args: step && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {},
      purpose: String(step?.purpose || '').trim()
    }))
    .filter((step) => {
      if (!step.action) return false;
      if (step.action === 'reply') return true;
      return Boolean(getToolExecutor(step.action));
    });

  const steps = sanitizedSteps.length > 0
    ? sanitizedSteps
    : [{ id: 1, action: 'reply', args: {}, purpose: 'Reply directly' }];
  const hasToolStep = steps.some((step) => step.action !== 'reply');

  return {
    goal: String(rawPlan.goal || question),
    need_tools: hasToolStep && Boolean(rawPlan.need_tools !== false),
    steps
  };
}

function finalizeReplyText(rawReply, fallbackText, options = {}) {
  const text = normalizeTextContent(rawReply).trim() || String(fallbackText || '').trim();
  if (!text) return '';
  if (isReplyFailure(text, { emptyIsFailure: true })) return text;
  if (options.disableHumanizer) return text;
  return runHumanizerAgent(text, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig)
  });
}

function getVisibleToolNames(context = {}) {
  if (Array.isArray(context.allowedTools)) {
    return context.allowedTools
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  return getToolNames();
}

function getPlannerModelName(overrides = null) {
  const currentConfig = getConfig();
  const plannerModel = overrides && typeof overrides === 'object'
    ? (overrides.plannerModel || overrides.model)
    : '';
  return String(plannerModel || currentConfig.PLAN_MODEL || process.env.PLANNER_MODEL || currentConfig.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getPlannerTemperature(overrides = null) {
  const overridden = overrides && typeof overrides === 'object'
    ? (overrides.plannerTemperature ?? overrides.temperature)
    : undefined;
  if (overridden !== undefined && overridden !== null && overridden !== '') {
    const n = Number(overridden);
    if (!Number.isFinite(n)) return 0.2;
    return Math.max(0, Math.min(2, n));
  }

  const raw = process.env.PLAN_TEMPERATURE;
  const n = raw === undefined || raw === null || raw === '' ? 0.2 : Number(raw);
  if (!Number.isFinite(n)) return 0.2;
  return Math.max(0, Math.min(2, n));
}

function getPlannerApiBaseUrl(overrides = null) {
  const currentConfig = getConfig();
  const plannerApiBaseUrl = overrides && typeof overrides === 'object'
    ? (overrides.plannerApiBaseUrl || overrides.apiBaseUrl)
    : '';
  return String(
    plannerApiBaseUrl
    || currentConfig.PLAN_API_BASE_URL
    || process.env.PLANNER_API_BASE_URL
    || process.env.PLAN_API_BASEURI
    || process.env.PLANNER_API_BASEURI
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || currentConfig.PASSIVE_AWARENESS_API_BASE_URL
    || currentConfig.API_BASE_URL
    || ''
  ).trim();
}

function getPlannerApiKey(overrides = null) {
  const currentConfig = getConfig();
  const plannerApiKey = overrides && typeof overrides === 'object'
    ? (overrides.plannerApiKey || overrides.apiKey)
    : '';
  return String(
    plannerApiKey
    || currentConfig.PLAN_API_KEY
    || process.env.PLANNER_API_KEY
    || process.env.PLAN_APIKEY
    || process.env.PLANNER_APIKEY
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_KEY
    || currentConfig.PASSIVE_AWARENESS_API_KEY
    || currentConfig.API_KEY
    || ''
  ).trim();
}

async function buildPlan(question, dynamicPrompt, modelConfig = null) {
  const decision = await planRequestV2({
    question,
    cleanText: question,
    contextSummary: dynamicPrompt,
    topRouteType: 'plan',
    routeMeta: {},
    intent: {
      executionMode: 'staged'
    },
    facets: {},
    allowedTools: normalizeArray(modelConfig?.allowedTools || modelConfig?.allowedToolNames || []),
    toolCatalog: [],
    goal: question
  });
  const legacyExecutionPlan = buildLegacyExecutionPlanFromSteps(decision.steps);
  const legacySteps = normalizeArray(legacyExecutionPlan.steps);
  if (legacySteps.length === 0) {
    return fallbackReplyPlan(question);
  }
  return {
    goal: normalizeText(question),
    need_tools: legacySteps.some((step) => normalizeText(step.action) !== 'reply'),
    steps: legacySteps.map((step, index) => ({
      id: index + 1,
      action: normalizeText(step.action),
      args: normalizeObject(step.args, {}),
      purpose: normalizeText(step.purpose)
    })),
    plannerDecisionV2: decision
  };

  const plannerPrompt = [
    'You are a task planner. Break the user request into executable steps.',
    'Output JSON only.',
    '{',
    '  "goal": "string",',
    '  "need_tools": true,',
    '  "steps": [',
    '    { "id": 1, "action": "tool_name_or_reply", "args": {}, "purpose": "string" }',
    '  ]',
    '}',
    'Requirements:',
    '1) at most 5 steps',
    '2) action must come from the available tool names when a tool is needed',
    '3) use action "reply" when no tool is needed',
    '4) do not reveal reasoning, only return JSON'
  ].join('\n');

  const toolNames = getVisibleToolNames(modelConfig || {});
  if (false) void ({ model: getPlannerModelName(), temperature: getPlannerTemperature() });
  const resolvedConfig = modelConfig && typeof modelConfig === 'object' ? modelConfig : {};
  const resp = await postWithRetry(
    ensureChatCompletionsUrl(getPlannerApiBaseUrl(resolvedConfig)),
    {
      model: getPlannerModelName(resolvedConfig),
      temperature: getPlannerTemperature(resolvedConfig),
      messages: [
        { role: 'system', content: plannerPrompt },
        { role: 'system', content: `Available tools: ${toolNames.join(', ')}` },
        { role: 'system', content: `Role context:\n${String(dynamicPrompt || '').slice(0, 1200)}` },
        { role: 'user', content: question }
      ],
      max_tokens: getMaxTokens(1200, resolvedConfig),
      stream: false
    },
    getRetries(1, resolvedConfig),
    getPlannerApiKey(resolvedConfig)
  );

  const msg = extractMessageContent(resp);
  const plan = extractJsonSafely(normalizeTextContent(msg?.content));
  return sanitizePlan(plan, question);
}

function normalizeSynthesisOptions(options = null) {
  if (!options || typeof options !== 'object') return {};
  return options;
}

async function synthesizeFromPlan(question, dynamicPrompt, plan, execLogs, verification = null, modelConfig = null, options = null) {
  const synthesisPrompt = [
    'You must write the final answer from the plan, execution logs, and verification result.',
    'Requirements:',
    '1) follow the role prompt',
    '2) do not expose hidden reasoning or internal chain-of-thought',
    '3) if evidence is weak or a tool failed, clearly mark uncertainty',
    '4) reply directly and keep it actionable',
    '5) prefer evidence-backed claims over speculation',
    '6) if a [ContinuityState] system message is present, treat it as the authoritative current-thread carry-over context',
    '7) continue from that continuity context instead of claiming missing context unless the continuity state itself is empty',
    '8) do not say this is the first conversation, do not say you lack prior context, and do not ask the user to restate prior steps when [ContinuityState] is present',
    '9) do not mention hidden tools, memory probes, search commands, or internal retrieval steps'
  ].join('\n');

  const normalizedOptions = normalizeSynthesisOptions(options);
  const extraSystemMessages = Array.isArray(normalizedOptions.systemMessages)
    ? normalizedOptions.systemMessages
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: String(item.role || 'system').trim() || 'system',
        content: item.content
      }))
    : [];

  const baseMessages = [
    { role: 'system', content: dynamicPrompt },
    ...extraSystemMessages,
    { role: 'system', content: HUMANIZER_SYSTEM_PROMPT },
    { role: 'system', content: synthesisPrompt },
    {
      role: 'user',
      content: [
        `User question: ${question || ''}`,
        `Plan (JSON): ${JSON.stringify(plan).slice(0, 4000)}`,
        `Execution logs (JSON): ${JSON.stringify(execLogs).slice(0, 8000)}`,
        `Verification (JSON): ${JSON.stringify(verification || {}).slice(0, 4000)}`
      ].join('\n\n')
    }
  ];

  const resp = await withMainModelFallback(async (resolvedConfig) => {
    const mainUrl = ensureChatCompletionsUrl(getApiBaseUrl(resolvedConfig));
    const requestOnce = (messages) => postWithRetry(
      mainUrl,
      {
        model: getModelName(resolvedConfig),
        temperature: getTemperature(resolvedConfig),
        top_p: getTopP(resolvedConfig),
        messages,
        max_tokens: getMaxTokens(3500, resolvedConfig),
        stream: false
      },
      getRetries(1, resolvedConfig),
      getApiKey(resolvedConfig)
    );

    try {
      return await requestOnce(baseMessages);
    } catch (error) {
      if (!isContextOverflowError(error)) throw error;
      const retryPayload = buildReactiveRetryPayload({
        messages: baseMessages,
        canonicalSegments: normalizedOptions?.canonicalSegments,
        routeMeta: normalizedOptions?.routeMeta,
        source: String(normalizedOptions.source || 'v2_plan_synthesis').trim() || 'v2_plan_synthesis',
        modelName: getModelName(resolvedConfig),
        modelWindowTokens: Number(
          normalizedOptions?.compactionPlan?.diagnostics?.modelWindowTokens
          || normalizedOptions?.modelWindowTokens
          || config.CONTEXT_WINDOW_MAX_TOKENS
          || 32000
        ) || 32000,
        maxOutputTokens: getMaxTokens(3500, resolvedConfig),
        preferRawTrim: !normalizedOptions?.canonicalSegments
      });
      try {
        return await requestOnce(retryPayload.messages);
      } catch (retryError) {
        if (isContextOverflowError(retryError)) {
          throw createContextCompactionHardBlockError(retryPayload.compactionPlan);
        }
        throw retryError;
      }
    }
  }, modelConfig);

  const msg = extractMessageContent(resp);
  return finalizeReplyText(msg?.content, 'I could not organize the result just now. Please try again.', {
    question,
    dynamicPrompt,
    modelConfig
  });
}

function shouldUsePlanModeForRequest(question = '', options = {}) {
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  if (routePolicyKey) {
    const routeCapability = String(getPolicyDefinition(routePolicyKey)?.capability || '').trim().toLowerCase();
    if (routeCapability === 'direct') return false;
  }
  const customPrompt = Object.prototype.hasOwnProperty.call(options || {}, 'customPrompt')
    ? options.customPrompt
    : null;
  const imageUrl = Object.prototype.hasOwnProperty.call(options || {}, 'imageUrl')
    ? options.imageUrl
    : null;
  return shouldUsePlanAndSolve(question, customPrompt, imageUrl);
}

function executePlan(...args) {
  const legacyHost = require('../../../api/legacy/aiHost');
  return legacyHost.executePlan(...args);
}

function executePlanLoop(...args) {
  const legacyHost = require('../../../api/legacy/aiHost');
  return legacyHost.executePlanLoop(...args);
}

module.exports = {
  buildPlan,
  buildLegacyExecutionPlanFromSteps,
  buildPlannerPrompt,
  buildPlannerModelRequestBody,
  buildPlannerStepGraphSequence,
  buildPlannerUserPayload,
  buildRuleBasedPlannerDecision,
  buildBackgroundResearchMeta,
  buildAvailableContextSignals,
  callPlannerModelV2,
  callPlannerSubagentV2,
  collectAvailableToolSummary,
  convertPlannerDecisionToDirectChatDecision,
  deriveMemoryOpenArgs,
  deriveToolArgs,
  executePlan,
  executePlanLoop,
  fallbackReplyPlan,
  getPlannerApiBaseUrl,
  getPlannerApiBaseUrlV2,
  getPlannerApiKey,
  getPlannerApiKeyV2,
  getPlannerDecisionVersion,
  getPlannerModelName,
  getPlannerReasoningEffort,
  getPlannerTemperature,
  normalizePlannerDecisionV2,
  planRequestV2,
  pickMinimalToolAllowlist,
  PLANNER_DECISION_VERSION,
  PLANNER_PROTOCOL_VERSION,
  DYNAMIC_CONTEXT_PLAN_VERSION,
  prefersMemoryRecall,
  requiresToolEvidence,
  DIRECT_CHAT_PLANNER_VERSION,
  TASK_SHAPES,
  TOOL_BUCKETS,
  sanitizePlan,
  shouldRequestBackgroundResearch,
  shouldUsePlanAndSolve,
  shouldUsePlanModeForRequest,
  synthesizeFromPlan
};
