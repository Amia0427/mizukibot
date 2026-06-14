const { estimateTokens, trimTextByTokenBudget } = require('../contextBudget');
const { formatDateInTz, formatTimeInTz, formatWeekdayInTz, getTimezone } = require('../time');
const { getAntiAIRules } = require('./antiAIRules');
const { getCurrentActivity } = require('./currentActivity');
const { getRelationshipBoundaryWithSource } = require('./relationshipBoundary');
const { getRecentContextSummaryWithSource } = require('./recentContext');

const LIVE_STATE_TOKEN_LIMIT = 800;

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getLatestMessageLength(state = {}) {
  const request = normalizeObject(state.request);
  const messages = normalizeArray(state.messages);
  const latest = messages[messages.length - 1];
  return String(
    latest?.content
    || request.runtimeQuestionText
    || request.question
    || ''
  ).length;
}

function getRecentTurnCount(state = {}) {
  const continuity = normalizeObject(state.memory?.continuityState?.payload);
  const shortTerm = normalizeObject(state.memory?.preparedMainConversationContext);
  const segments = normalizeArray(shortTerm.mainConversationSnapshot?.segments || shortTerm.segments);
  const recentSegment = segments.find((item) => item?.name === 'recent_history' || item?.name === 'short_term_continuity');
  return Math.max(
    normalizeArray(continuity.recentTurns).length,
    normalizeArray(recentSegment?.messages).length,
    normalizeArray(state.messages).length
  );
}

function resolveLiveStateInput(state = {}) {
  const request = normalizeObject(state.request);
  return {
    userId: request.userId || state.userId || '',
    route: request.topRouteType || request.routePolicyKey || state.route || '',
    allowedTools: normalizeArray(request.allowedTools || state.allowedTools),
    userMessageLength: getLatestMessageLength(state),
    recentTurnCount: getRecentTurnCount(state)
  };
}

function formatCurrentTime(date = new Date(), timezone = getTimezone()) {
  return `${formatDateInTz(date, timezone)} ${formatTimeInTz('zh-CN', date, timezone)} ${formatWeekdayInTz('zh-CN', date, timezone)}`;
}

function buildLiveStateContext(input = {}) {
  const relationship = normalizeObject(input.relationship);
  const activity = normalizeObject(input.activity);
  const antiAIRules = normalizeObject(input.antiAIRules);
  const currentTime = input.currentTime instanceof Date ? input.currentTime : new Date();
  const timezone = input.timezone || getTimezone();
  const parts = [];

  parts.push('【生活状态补充】');
  parts.push(`当前时间：${formatCurrentTime(currentTime, timezone)}`);
  parts.push('');

  if (activity.activity) {
    parts.push('【当前可能在做什么】');
    parts.push(activity.activity);
    if (activity.mood) parts.push(`情绪状态：${activity.mood}`);
    if (activity.constraints) parts.push(`注意：${activity.constraints}`);
    parts.push('');
  }

  parts.push('【与这个用户的关系】');
  parts.push(relationship.boundary || '未建立明确关系；保持礼貌距离，不假设亲密度，根据当前对话逐步建立信任。');
  if (normalizeArray(relationship.tags).length > 0) {
    parts.push(`关系标签：${normalizeArray(relationship.tags).join('、')}`);
  }
  parts.push('');

  if (input.recentContext) {
    parts.push('【最近聊过什么】');
    parts.push(String(input.recentContext || '').trim());
    parts.push('');
  }

  parts.push(antiAIRules.core || '');
  if (normalizeArray(antiAIRules.scenario).length > 0) {
    parts.push('');
    parts.push('【当前场景额外约束】');
    normalizeArray(antiAIRules.scenario).forEach((rule, index) => {
      parts.push(`${index + 1}. ${rule}`);
    });
  }

  return parts.filter((line) => line !== '').join('\n');
}

function fitLiveStateTokenBudget(context = '') {
  const text = String(context || '').trim();
  if (!text || estimateTokens(text) <= LIVE_STATE_TOKEN_LIMIT) return text;

  const headings = [
    '【生活状态补充】',
    '【当前可能在做什么】',
    '【与这个用户的关系】',
    '【最近聊过什么】',
    '【重要：真人反应约束】',
    '【当前场景额外约束】'
  ];
  const positions = headings
    .map((heading) => ({ heading, index: text.indexOf(heading) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (positions.length === 0) {
    return trimTextByTokenBudget(text, LIVE_STATE_TOKEN_LIMIT, 'head');
  }

  const sections = new Map();
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index];
    const next = positions[index + 1];
    sections.set(current.heading, text.slice(current.index, next ? next.index : text.length).trim());
  }

  const compose = (enabledHeadings = []) => headings
    .filter((heading) => enabledHeadings.includes(heading) && sections.get(heading))
    .map((heading) => sections.get(heading))
    .join('\n\n')
    .trim();
  const keep = headings.filter((heading) => (
    heading === '【生活状态补充】'
    || heading === '【与这个用户的关系】'
    || heading === '【重要：真人反应约束】'
  ) && sections.get(heading));
  for (const heading of ['【当前可能在做什么】', '【最近聊过什么】', '【当前场景额外约束】']) {
    if (!sections.get(heading)) continue;
    const candidate = compose(keep.concat(heading));
    if (estimateTokens(candidate) <= LIVE_STATE_TOKEN_LIMIT) keep.push(heading);
  }

  const priorityText = compose(keep);
  if (estimateTokens(priorityText) <= LIVE_STATE_TOKEN_LIMIT) return priorityText;
  const core = sections.get('【重要：真人反应约束】') || '';
  const relationship = sections.get('【与这个用户的关系】') || '';
  const intro = sections.get('【生活状态补充】') || '';
  const coreBudget = Math.max(240, Math.floor(LIVE_STATE_TOKEN_LIMIT * 0.62));
  const relationshipBudget = Math.max(120, LIVE_STATE_TOKEN_LIMIT - coreBudget - estimateTokens(intro) - 16);
  return [
    intro,
    trimTextByTokenBudget(relationship, relationshipBudget, 'head'),
    trimTextByTokenBudget(core, coreBudget, 'head')
  ].filter(Boolean).join('\n\n').trim();
}

async function buildLiveStateForState(state = {}, options = {}) {
  const input = resolveLiveStateInput(state);
  const route = String(input.route || '').trim().toLowerCase();
  if (route === 'ignore' || route === 'refuse' || route.startsWith('ignore/') || route.startsWith('refuse/')) {
    return {
      skipped: true,
      reason: 'route_skip',
      context: '',
      tokens: 0,
      durationMs: 0,
      truncated: false
    };
  }
  const startedAt = Date.now();
  const [relationshipResult, activity, recentContextResult, antiAIRules] = await Promise.all([
    getRelationshipBoundaryWithSource(input.userId, options),
    Promise.resolve(getCurrentActivity(options)),
    getRecentContextSummaryWithSource(input.userId, 5, options),
    Promise.resolve(getAntiAIRules({
      route: input.route,
      hasTools: input.allowedTools.length > 0,
      userMessageLength: input.userMessageLength,
      recentTurnCount: input.recentTurnCount
    }))
  ]);
  const relationship = normalizeObject(relationshipResult.boundary);
  const recentContext = recentContextResult.summary;

  const rawContext = buildLiveStateContext({
    relationship,
    activity,
    recentContext,
    antiAIRules,
    currentTime: options.now instanceof Date ? options.now : new Date(),
    timezone: options.timezone
  });
  const context = fitLiveStateTokenBudget(rawContext);
  const rawTokens = estimateTokens(rawContext);
  const finalTokens = estimateTokens(context);
  return {
    context,
    rawContext,
    relationship,
    activity,
    recentContext,
    antiAIRules,
    sourceDiagnostics: {
      relationshipBoundary: normalizeObject(relationshipResult.source),
      currentActivity: {
        sourceFile: 'utils/liveState/currentActivity.js',
        sourcePolicy: 'getCurrentActivity',
        dataSource: 'timezone_clock_bucket',
        found: Boolean(activity.activity),
        readOnly: true
      },
      recentContext: normalizeObject(recentContextResult.source),
      antiAIRules: {
        sourceFile: 'utils/liveState/antiAIRules.js',
        sourcePolicy: 'getAntiAIRules',
        dataSource: 'deterministic_route_and_turn_heuristics',
        found: Boolean(antiAIRules.core),
        readOnly: true
      }
    },
    rawTokens,
    tokens: finalTokens,
    durationMs: Math.max(0, Date.now() - startedAt),
    truncated: context !== rawContext,
    tokenLimit: LIVE_STATE_TOKEN_LIMIT
  };
}

module.exports = {
  LIVE_STATE_TOKEN_LIMIT,
  buildLiveStateContext,
  buildLiveStateForState,
  fitLiveStateTokenBudget,
  resolveLiveStateInput
};
