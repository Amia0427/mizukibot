const { isMaimaiEnabled } = require('./feature-flags');

const MAIMAI_TOOLS = Object.freeze([
  'maimai_chart_search',
  'maimai_chart_analyze',
  'maimai_player_analysis'
]);

const EXPLICIT_DOMAIN_SIGNAL = /(舞萌(?:\s*DX)?|maimai|mai\s*mai)/i;
const CHART_TYPE_SIGNAL = /(?:\bDX\b|标准|\bSD\b)/i;
const DIFFICULTY_SIGNAL = /(?:[绿黄红紫白]\s*谱|(?:Basic|Advanced|Expert|Master|Re\s*:?\s*Master)\s*谱)/i;
const COMPOSITE_CHART_SIGNAL = /(?:[绿黄红紫白]{2,}\s*谱|Re\s*:?\s*Master\s*谱)/i;
const CHART_METRIC_SIGNAL = /(谱面|定数|物量|note|bpm|谱师|难度|等级)/i;
const CHART_SUBJECT_SIGNAL = /(谱面|[绿黄红紫白]\s*谱|(?:DX|标准|SD)\s*谱|Re\s*:?\s*Master\s*谱|曲目|曲名|这首歌|这张谱|定数|物量|note|bpm|谱师)/i;
const SEARCH_SIGNAL = /(找|查|搜|筛|推荐|列出|有哪些|几张|谱单|比较|对比|以上|以下|区间|范围)/i;
const MULTI_CHART_SIGNAL = /(?:\d+\s*张|\d+(?:\.\d+)?\s*(?:到|至|[-~～])\s*\d+(?:\.\d+)?|[绿黄红紫白]\s*谱.{0,20}[绿黄红紫白]\s*谱)/i;
const ANALYZE_SIGNAL = /(分析|谱面特征|手法|纵连|交互|滑键|双押|Break|掉音|哪里难|难点|代表(?:高强度)?段|峰值|密度|变速)/i;
const FIRST_PERSON_SIGNAL = /(我的|我自己|个人)/i;
const PLAYER_DATA_SIGNAL = /(成绩|分数|rating|表现|弱项|擅长|不擅长|达成率|残差)/i;

function hasStrongChartCombination(text) {
  const hasType = CHART_TYPE_SIGNAL.test(text);
  const hasDifficulty = DIFFICULTY_SIGNAL.test(text);
  const hasMetric = CHART_METRIC_SIGNAL.test(text);
  const difficultyCount = new Set(
    Array.from(text.matchAll(/[绿黄红紫白]\s*谱/gi), (match) => match[0].replace(/\s+/g, ''))
  ).size;
  return COMPOSITE_CHART_SIGNAL.test(text)
    || difficultyCount >= 2
    || (hasType && hasDifficulty)
    || (hasDifficulty && hasMetric);
}

function classifyMaimaiIntent(text = '') {
  const cleanText = String(text || '').normalize('NFKC').trim();
  if (!cleanText) return { matched: false, intent: 'none', tool: '', reason: 'empty' };

  const explicitDomain = EXPLICIT_DOMAIN_SIGNAL.test(cleanText);
  const strongCombination = hasStrongChartCombination(cleanText);
  if (!explicitDomain && !strongCombination) {
    return { matched: false, intent: 'none', tool: '', reason: 'no_domain' };
  }

  const domainReason = explicitDomain ? 'explicit_game_name' : 'strong_chart_combination';
  if (FIRST_PERSON_SIGNAL.test(cleanText) && PLAYER_DATA_SIGNAL.test(cleanText)) {
    return {
      matched: true,
      intent: 'player',
      tool: 'maimai_player_analysis',
      reason: `${domainReason}:current_player`
    };
  }

  const hasChartSubject = CHART_SUBJECT_SIGNAL.test(cleanText);
  const hasSearchIntent = SEARCH_SIGNAL.test(cleanText) || MULTI_CHART_SIGNAL.test(cleanText);
  if (!hasChartSubject && !hasSearchIntent) {
    return { matched: false, intent: 'none', tool: '', reason: `${domainReason}:no_data_intent` };
  }

  if (hasSearchIntent) {
    return {
      matched: true,
      intent: 'search',
      tool: 'maimai_chart_search',
      reason: `${domainReason}:multi_or_search`
    };
  }

  if (ANALYZE_SIGNAL.test(cleanText)) {
    return {
      matched: true,
      intent: 'analyze',
      tool: 'maimai_chart_analyze',
      reason: `${domainReason}:single_chart_analysis`
    };
  }

  return {
    matched: true,
    intent: 'search',
    tool: 'maimai_chart_search',
    reason: `${domainReason}:chart_lookup`
  };
}

function isMaimaiQuestion(text = '') {
  return classifyMaimaiIntent(text).matched;
}

function chooseMaimaiTool(text = '', allowedToolNames = []) {
  const allowed = new Set(
    (Array.isArray(allowedToolNames) ? allowedToolNames : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean)
  );
  const decision = classifyMaimaiIntent(text);
  return decision.matched && allowed.has(decision.tool) ? [decision.tool] : [];
}

function applyMaimaiToolRouting(route = {}, options = {}) {
  if (!route || typeof route !== 'object' || route.topRouteType !== 'direct_chat') return route;
  const meta = route.meta && typeof route.meta === 'object' ? route.meta : {};
  const currentText = String(route.cleanText || route.question || route.rawText || '').trim();
  const existingTools = (Array.isArray(meta.allowedTools) ? meta.allowedTools : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const nonMaimaiTools = existingTools.filter((name) => !MAIMAI_TOOLS.includes(name));
  const hadMaimaiTool = nonMaimaiTools.length !== existingTools.length;
  const enabled = options.enabled === undefined ? isMaimaiEnabled() : options.enabled === true;
  const decision = enabled
    ? classifyMaimaiIntent(currentText)
    : { matched: false, intent: 'none', tool: '', reason: 'feature_disabled' };

  if (!decision.matched) {
    if (!hadMaimaiTool) return route;
    return {
      ...route,
      meta: {
        ...meta,
        allowedTools: nonMaimaiTools,
        toolIntent: meta.toolIntent === 'force_tools' && nonMaimaiTools.length === 0
          ? 'none'
          : meta.toolIntent
      }
    };
  }

  return {
    ...route,
    meta: {
      ...meta,
      allowedTools: Array.from(new Set([...nonMaimaiTools, decision.tool])),
      toolIntent: 'force_tools',
      maimaiIntent: decision.intent,
      maimaiRouteReason: decision.reason
    }
  };
}

module.exports = {
  MAIMAI_TOOLS,
  applyMaimaiToolRouting,
  chooseMaimaiTool,
  classifyMaimaiIntent,
  isMaimaiQuestion
};
