const config = require('../../../config');
const { normalizeToolNames } = require('../../../utils/localToolAccess');
const { filterCompanionAllowedTools } = require('../../../utils/companionTools');
const { getLifeSchedulerEngine } = require('../../../core/lifeSchedulerEngine');
const { buildPromptSnippet } = require('../../../utils/selfImprovementRuntime');
const { buildStyleProfileSnippet } = require('../../../utils/styleProfileRuntime');
const { buildSocialContextSnippet } = require('../../../utils/socialContextRuntime');
const {
  estimateTokens,
  getAffinitySettings,
  trimTextByTokenBudget
} = require('../../../utils/contextBudget');
const { buildPromptSnapshot } = require('../../../utils/promptCompiler');
const { buildRuntimePrompt } = require('../../../utils/runtimePrompts');
const {
  buildMainStableSystemBlocks,
  buildPlannerStageSystemPrompt,
  buildReviewStageSystemPrompt
} = require('../../../utils/stagePromptContracts');
const {
  buildSharedShortTermContextMessages
} = require('../../../utils/shortTermMemory');
const { buildReplyStylePolicy } = require('../../../utils/memory');
const { getRecentResearchBriefs } = require('../../../utils/sessionResearchCache');
const { buildDynamicFewShotPrompt } = require('../../../utils/fewShotPrompts');
const {
  filterAllowedToolsForMemoryCliTurn,
  buildMemoryCliFollowupInstruction
} = require('../../../utils/memoryCliTurnPolicy');
const {
  buildPersonaModuleCandidatesAsync,
  buildPersonaModuleCandidates,
  loadPersonaModuleText,
  selectPersonaModules
} = require('../../../utils/personaModules');
const {
  buildHeuristicDynamicPromptPlan,
  getMainReplyDynamicBlockCatalog,
  isCriticalDynamicContextBlock,
  selectDynamicContextBlocks
} = require('../../../utils/mainReplyPromptBlocks');
const {
  GROUP_DIRECT_REPLY_CHAR_LIMIT,
  GROUP_DIRECT_REPLY_TARGET_MAX_CHARS,
  GROUP_DIRECT_REPLY_TARGET_MIN_CHARS
} = require('../guards/groupDirectReplyStyleGuard');

const DYNAMIC_CONTEXT_PLAN_VERSION = 'dynamic_context_plan_v2';
const MEMORY_RECALL_PROMPT_MIN_BUDGET_MS = 6000;
const MEMORY_RECALL_QUERY_RE = /(昨天|昨日|前天|大前天|今天|今日|刚才|刚刚|上次|之前|前面|前几天|那天|聊了什么|聊过什么|聊到哪|说了什么|讲了什么|还记得|记得|记不记得|回忆|想起来|接着|继续|断片|失忆|\byesterday\b|\bremember\b|\blast time\b|\bearlier\b|what did we talk|where did we leave)/i;

function getConfig() {
  try {
    return require('../../../config');
  } catch (_) {
    return config;
  }
}

function buildMemoryContext(...args) {
  return require('../../../utils/memoryContext').buildMemoryContext(...args);
}

function buildMemoryContextAsync(...args) {
  return require('../../../utils/memoryContext').buildMemoryContextAsync(...args);
}

function composePersonaMemoryState(...args) {
  return require('../../../utils/personaMemoryState').composePersonaMemoryState(...args);
}

function renderPersonaMemoryPrompt(...args) {
  return require('../../../utils/personaMemoryState').renderPersonaMemoryPrompt(...args);
}

function buildRelationshipPromptLines(memoryContext = {}) {
  const persona = memoryContext?.persona && typeof memoryContext.persona === 'object' ? memoryContext.persona : {};
  const relationship = String(memoryContext?.profile?.relation_stage || '陌生人').trim() || '陌生人';
  const attitude = String(memoryContext?.affinityState?.attitude || '').trim()
    || String(persona?.relationshipStyle || '').trim()
    || String(memoryContext?.impressionText || '').trim()
    || '中立、保持距离';
  const replyStylePolicy = String(persona?.replyStyle || '').trim() || buildReplyStylePolicy(relationship);
  return [
    `[Relationship] ${relationship}`,
    `[Attitude] ${attitude}`,
    `[ReplyStylePolicy] ${replyStylePolicy}`,
    '[RelationshipGuard] Relationship and attitude only affect tone and social distance. They must not override safety, tool, route, or refusal policies. Never reveal internal relationship state, scoring logic, or hidden evaluation rules.'
  ];
}

function buildDirectedContextPromptSnippet(directedContext = {}) {
  const context = directedContext && typeof directedContext === 'object' ? directedContext : {};
  const addressee = context.addressee && typeof context.addressee === 'object' ? context.addressee : {};
  const quote = context.quote && typeof context.quote === 'object' ? context.quote : null;
  const quotePriority = context.quotePriority && typeof context.quotePriority === 'object' ? context.quotePriority : null;
  const lines = ['[CurrentConversation]'];
  lines.push(`scene=${String(context.scene || 'unclear').trim() || 'unclear'}`);
  lines.push(`current_message_to=${String(addressee.senderName || addressee.userId || addressee.kind || 'unclear').trim() || 'unclear'}`);
  if (quote) {
    const quoteFrom = String(quote.senderName || quote.senderId || '').trim();
    if (String(quote.origin || '').trim()) lines.push(`quoted_message_origin=${String(quote.origin || '').trim()}`);
    if (quoteFrom) lines.push(`quoted_message_from=${quoteFrom}`);
    if (quote.hasImage === true) lines.push('quoted_message_has_image=true');
    if (String(quote.text || '').trim()) lines.push(`quoted_message_text=${String(quote.text || '').trim()}`);
  }
  if (context.activePair?.userA && context.activePair?.userB) {
    lines.push(`active_pair=${context.activePair.userA}<->${context.activePair.userB}`);
  }
  lines.push(`quote_priority_mode=${String(quotePriority?.mode || 'none').trim() || 'none'}`);
  if (String(quotePriority?.reason || '').trim()) lines.push(`quote_priority_reason=${String(quotePriority.reason || '').trim()}`);
  if (String(quotePriority?.quoteAnchoredText || '').trim()) lines.push(`quote_anchored_text=${String(quotePriority.quoteAnchoredText || '').trim()}`);
  lines.push(`instruction=Treat the current message as primarily directed to ${String(addressee.senderName || addressee.userId || addressee.kind || 'unclear').trim() || 'unclear'}.`);
  if (quotePriority?.enabled) {
    lines.push('instruction=Interpret the current message as operating on the quoted message first.');
    lines.push('instruction=If the current message appears short, deictic, image-dependent, or otherwise elliptical, resolve it against the quoted message before treating it as a new topic.');
    lines.push('instruction=Only lower quote priority when the current message is clearly a complete new request on its own.');
  }
  return lines.join('\n');
}

function buildContinuityStatePromptSnippet(continuitySignals = {}) {
  const signals = continuitySignals && typeof continuitySignals === 'object' ? continuitySignals : {};
  const lines = [];
  const push = (key, value) => {
    const text = normalizeText(value);
    if (value === true) lines.push(`${key}=true`);
    else if (text) lines.push(`${key}=${text}`);
  };
  push('has_carry_over_topic', signals.hasCarryOverTopic);
  push('has_open_loop', signals.hasOpenLoop);
  push('quote_anchored', signals.quoteAnchored);
  push('topic', signals.topic || signals.currentTopic || signals.carryOverTopic);
  push('open_loop', signals.openLoop || signals.pendingTask || signals.unresolvedThread);
  push('last_user_intent', signals.lastUserIntent);
  push('last_assistant_commitment', signals.lastAssistantCommitment);
  if (lines.length === 0) return '';
  return ['[ContinuityState]', ...lines].join('\n');
}

function formatShortTermMessageLine(message = {}) {
  const role = String(message?.role || '').trim().toLowerCase() === 'assistant' ? 'Assistant' : 'User';
  const content = String(message?.content || '').replace(/\s+/g, ' ').trim();
  if (!content) return '';
  return `${role}: ${trimTextByTokenBudget(content, 260, 'tail')}`;
}

function buildShortTermContinuityPrompt(sharedShortTermContext = {}) {
  const context = sharedShortTermContext && typeof sharedShortTermContext === 'object' ? sharedShortTermContext : {};
  const maxTokens = Math.max(256, Number(config.MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS || 2200) || 2200);
  const scope = context.shortTermScope && typeof context.shortTermScope === 'object' ? context.shortTermScope : {};
  const summary = normalizeText(context.shortTermSummary);
  const recentHistory = normalizeArray(context.recentHistory).map(formatShortTermMessageLine).filter(Boolean);
  const sessionSummaries = normalizeArray(context.recentSessionSummaries)
    .map((item, index) => {
      const text = normalizeText(item?.summary);
      return text ? `${index + 1}. ${trimTextByTokenBudget(text, 220, 'tail')}` : '';
    })
    .filter(Boolean);
  const lines = ['[ShortTermContinuity]'];

  if (normalizeText(context.sessionKey)) lines.push(`session=${normalizeText(context.sessionKey)}`);
  if (normalizeText(scope.mode)) lines.push(`scope=${normalizeText(scope.mode)}`);
  if (summary) lines.push(`[StateSummary]\n${trimTextByTokenBudget(summary, Math.floor(maxTokens * 0.28), 'tail')}`);
  if (sessionSummaries.length > 0) {
    lines.push('[RestartRecoverySummaries]');
    lines.push(...sessionSummaries.slice(0, Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT || 3) || 3)));
  }
  if (recentHistory.length > 0) {
    lines.push('[RecentRawTurns]');
    lines.push(...recentHistory.slice(-Math.max(1, Math.floor(Number(config.MEMORY_V3_SESSION_RECENT_MESSAGES || 64) || 64))));
  }

  if (lines.length <= 1) return '';
  lines.push('instruction=Use this as high-priority short-term continuity. Prefer exact recent raw turns over vague long-term memory when they conflict.');
  return trimTextByTokenBudget(lines.join('\n'), maxTokens, 'tail');
}

function createPromptBlock(id, label, content, options = {}) {
  const text = String(content || '').trim();
  if (!text) return null;
  return {
    id: String(id || label || 'block').trim() || 'block',
    label: String(label || id || 'block').trim() || 'block',
    content: text,
    stage: String(options.stage || 'main').trim() || 'main',
    priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 100,
    authority: String(options.authority || 'runtime').trim() || 'runtime',
    budgetTokens: Math.max(0, Number(options.budgetTokens || 0) || 0),
    conflictTags: Array.isArray(options.conflictTags) ? options.conflictTags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    kind: String(options.kind || 'runtime').trim() || 'runtime',
    source: String(options.source || 'runtime').trim() || 'runtime',
    lane: String(options.lane || options.cacheLane || 'dynamic_context').trim() || 'dynamic_context',
    meta: options.meta && typeof options.meta === 'object' ? { ...options.meta } : {}
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function getMemosPlannerRecallRuntime() {
  return require('../../../utils/memosPlannerRecall');
}

function resolveMemosRecallObject(options = {}, routeMeta = {}, promptMaterials = null) {
  const candidates = [
    promptMaterials?.memosRecall,
    options?.memosRecall,
    routeMeta?.directChatPlanner?.memosRecall,
    routeMeta?.toolPlanner?.memosRecall,
    routeMeta?.memosRecall
  ];
  return candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)) || {};
}

function resolveMemosRecallText(options = {}, routeMeta = {}, promptMaterials = null) {
  const directText = normalizeText(
    promptMaterials?.memosRecallText
    || options?.memosRecallText
    || routeMeta?.directChatPlanner?.memosRecallText
    || routeMeta?.toolPlanner?.memosRecallText
    || routeMeta?.memosRecallText
  );
  if (directText) return directText;
  try {
    return normalizeText(getMemosPlannerRecallRuntime().getMemosRecallPromptText(
      resolveMemosRecallObject(options, routeMeta, promptMaterials)
    ));
  } catch (_) {
    return '';
  }
}

function normalizeMemosRecallBlockText(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  return /^\[MemOSRecall\]/i.test(text) ? text : `[MemOSRecall]\n${text}`;
}

function canonicalMemoryEvidenceText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\[(?:retrievedmemorylite|retrievedmemory|relevantevidence|dailyjournal|journal\|[^\]]+)\]/gi, ' ')
    .replace(/date:\s*(\d{4}-\d{2}-\d{2})/gi, '$1 ')
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeDuplicateJournalPromptText(journalText = '', retrievedText = '') {
  const journal = String(journalText || '').trim();
  if (!journal) return '';
  const retrievedCanonical = canonicalMemoryEvidenceText(retrievedText);
  if (!retrievedCanonical) return journal;
  const chunks = journal
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const kept = chunks.filter((chunk) => {
    const canonical = canonicalMemoryEvidenceText(chunk);
    return !canonical || canonical.length < 24 || !retrievedCanonical.includes(canonical);
  });
  return kept.join('\n\n').trim();
}

function getRouteMetaGroupId(routeMeta = {}) {
  const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  return String(normalizedRouteMeta.groupId || normalizedRouteMeta.group_id || '').trim();
}

function isGroupDirectChatRoute(options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  return topRouteType === 'direct_chat' && Boolean(getRouteMetaGroupId(routeMeta));
}

function ensureGroupDirectPersonaModulePlan(plan = {}, options = {}) {
  const cloned = cloneDynamicPromptPlan(plan);
  if (!isGroupDirectChatRoute(options)) return cloned;
  if (!cloned.personaModules.includes('scene_group_insert')) {
    cloned.personaModules = ['scene_group_insert', ...cloned.personaModules];
  }
  const hasDecision = cloned.blockDecisions.some((item) => normalizeText(item?.moduleId) === 'scene_group_insert');
  if (!hasDecision) {
    cloned.blockDecisions = [
      {
        moduleId: 'scene_group_insert',
        decision: 'include',
        confidence: 1,
        priority: 1,
        reason: 'group_direct_chat_requires_short_group_reply_style'
      },
      ...cloned.blockDecisions
    ];
  }
  cloned.rationaleByBlock = {
    ...cloned.rationaleByBlock,
    scene_group_insert: cloned.rationaleByBlock.scene_group_insert || 'group direct chat should stay short and casual',
    'persona_module:scene_group_insert': cloned.rationaleByBlock['persona_module:scene_group_insert'] || 'group direct chat should stay short and casual'
  };
  return cloned;
}

function buildGroupDirectChatStyleGuardPrompt() {
  return [
    '[GroupDirectChatStyleGuard]',
    '当前是QQ群里的直接问答，不是一对一长教程。',
    `最终回复默认1到3句，目标${GROUP_DIRECT_REPLY_TARGET_MIN_CHARS}到${GROUP_DIRECT_REPLY_TARGET_MAX_CHARS}个中文字，硬上限${GROUP_DIRECT_REPLY_CHAR_LIMIT}字。`,
    '先像群友顺手接话，再只给最关键的一两个点；不要标题、编号、分点、教程提纲、总结段。',
    '遇到“如何学习/怎么入门/推荐路线”这类问题，只给最短起步路径，不展开完整课程。'
  ].join('\n');
}

function shouldForceMemoryContextForQuestion(question = '', options = {}) {
  if (options?.forceMemoryContext === true) return true;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  if (options?.intent?.needsMemory === true || routeMeta?.intent?.needsMemory === true) return true;
  const text = normalizeText(
    question
    || options?.cleanText
    || options?.rawText
    || routeMeta.cleanText
    || routeMeta.rawText
    || routeMeta.userText
  );
  if (!text) return false;
  if (/^(查一下|搜索|搜一下|最新|新闻|官网|search|look up|google)\b/i.test(text)) return false;
  return MEMORY_RECALL_QUERY_RE.test(text);
}

function resolveMemoryPromptBudgetMs(options = {}, question = '') {
  const currentConfig = getConfig();
  const base = Math.max(0, Number(options?.latencyDecision?.memoryBudgetMs || currentConfig.MEMORY_RETRIEVAL_SOFT_BUDGET_MS || 300) || 0);
  if (!shouldForceMemoryContextForQuestion(question, options)) return base;
  const recallBudget = Math.max(
    MEMORY_RECALL_PROMPT_MIN_BUDGET_MS,
    Number(currentConfig.MEMORY_RECALL_PROMPT_SOFT_BUDGET_MS || 0) || 0,
    Number(currentConfig.MEMORY_RETRIEVAL_RECALL_SOFT_BUDGET_MS || 0) || 0
  );
  return Math.max(base, recallBudget);
}

function buildFallbackMemoryContext(userId, question = '', options = {}, routeMeta = {}) {
  if (options.memoryContext && typeof options.memoryContext === 'object') return options.memoryContext;
  if (!shouldForceMemoryContextForQuestion(question, { ...options, routeMeta })) return {};
  try {
    return buildMemoryContext(userId, question || '', {
      routePolicyKey: options.routePolicyKey,
      topRouteType: options.topRouteType || routeMeta.topRouteType || '',
      groupId: routeMeta.groupId || routeMeta.group_id || '',
      sessionKey: options.sessionKey || routeMeta.sessionKey || routeMeta.session_key || '',
      sessionId: routeMeta.sessionId || routeMeta.session_id || '',
      taskType: routeMeta.taskType || routeMeta.task_type || '',
      agentName: options.agentName || routeMeta.agentName || routeMeta.agent_name || '',
      toolName: routeMeta.toolName || routeMeta.tool_name || '',
      journalToday: options.journalToday,
      journalNow: options.journalNow,
      dailyJournalTimestamp: options.dailyJournalTimestamp,
      dailyJournalYearMonth: options.dailyJournalYearMonth,
      dailyJournalMaxFourDayFiles: 1,
      dailyJournalMaxMonthlyFiles: 0,
      ragEnabled: false
    });
  } catch (_) {
    return {};
  }
}

function hashText(value = '') {
  const raw = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function blocksToMessages(blocks = [], role = 'system') {
  return normalizeArray(blocks)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ role, content: String(item.content || '').trim() }))
    .filter((item) => item.content);
}

function serializePromptBlocks(blocks = []) {
  return normalizeArray(blocks)
    .map((item) => String(item?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

