const fs = require('fs');
const path = require('path');
const config = require('../config');

const FEW_SHOT_INDEX_PATH = path.join(config.PROMPTS_DIR, 'persona', '05_examples.index.json');
const FEW_SHOT_EXAMPLES_PATH = path.join(config.PROMPTS_DIR, 'persona', '05_examples.txt');
let fewShotIndexCache = null;

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function safeStatFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat && stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function emptyFewShotIndex() {
  return { version: 1, max_examples: 0, examples: [] };
}

function normalizeStringList(value = []) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : [];
}

function compileRegexList(value = []) {
  if (!Array.isArray(value)) return [];
  const compiled = [];
  for (const item of value) {
    const source = String(item || '').trim();
    if (!source) continue;
    try {
      compiled.push(new RegExp(source, 'i'));
    } catch (_) {}
  }
  return compiled;
}

function normalizeFewShotExample(example = {}) {
  const source = example && typeof example === 'object' && !Array.isArray(example) ? example : {};
  const match = source.match && typeof source.match === 'object' && !Array.isArray(source.match)
    ? source.match
    : {};
  const normalized = { ...source };
  Object.defineProperty(normalized, '__fewShotRuntime', {
    value: {
      priority: Number(source.priority || 0) || 0,
      routeTypes: normalizeStringList(match.route_types),
      excludeKeywords: normalizeStringList(match.exclude_keywords),
      keywordsAny: normalizeStringList(match.keywords_any),
      keywordsAll: normalizeStringList(match.keywords_all),
      regexAny: compileRegexList(match.regex_any),
      worldbookIds: normalizeStringList(match.worldbook_ids || source.worldbookIds),
      tags: normalizeStringList(source.tags)
    },
    enumerable: false,
    configurable: true
  });
  return normalized;
}

function normalizeFewShotIndex(parsed = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyFewShotIndex();
  return {
    version: Number(parsed.version || 1) || 1,
    max_examples: Math.max(0, Number(parsed.max_examples || 0) || 0),
    examples: Array.isArray(parsed.examples) ? parsed.examples.map(normalizeFewShotExample) : []
  };
}

const HIGH_EMOTION_KEYWORDS = [
  '秘密',
  '真相',
  '害怕',
  '怕',
  '接纳',
  '认同',
  '同情',
  '怜悯',
  '负担',
  '逃避',
  '说不出口',
  '不敢',
  '回不去',
  '离开你',
  '换一种眼神'
];

const HIGH_EMOTION_PATTERNS = [
  /(秘密|真相).{0,8}(发现|知道|说出来|被问)/i,
  /(害怕|怕).{0,8}(被看见|被发现|说出来|换一种眼神)/i,
  /(同情|怜悯|可怜).{0,8}(我|你|留下)/i,
  /(接纳|认同).{0,8}(我|你自己|以后)/i,
  /(负担|回不去|说不出口|逃避)/i
];

function loadFewShotIndex() {
  const stat = safeStatFile(FEW_SHOT_INDEX_PATH);
  const fileVersion = stat ? `${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}` : 'missing';
  if (
    fewShotIndexCache
    && fewShotIndexCache.filePath === FEW_SHOT_INDEX_PATH
    && fewShotIndexCache.fileVersion === fileVersion
  ) {
    return fewShotIndexCache.index;
  }

  const raw = stat ? safeReadText(FEW_SHOT_INDEX_PATH, '').trim() : '';
  if (!raw) {
    const index = emptyFewShotIndex();
    fewShotIndexCache = { filePath: FEW_SHOT_INDEX_PATH, fileVersion, index };
    return index;
  }

  try {
    const parsed = JSON.parse(raw);
    const index = normalizeFewShotIndex(parsed);
    fewShotIndexCache = { filePath: FEW_SHOT_INDEX_PATH, fileVersion, index };
    return index;
  } catch (_) {
    const index = emptyFewShotIndex();
    fewShotIndexCache = { filePath: FEW_SHOT_INDEX_PATH, fileVersion, index };
    return index;
  }
}

function shouldUseExtraFewShotSlot(context = {}) {
  const routeKey = String(context.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(context.topRouteType || '').trim().toLowerCase();

  if (routeKey && routeKey !== 'chat/default' && routeKey !== 'chat') return false;
  if (!routeKey && topRouteType && topRouteType !== 'chat') return false;

  const question = normalizeText(context.question || '').toLowerCase();
  if (!question) return false;

  return HIGH_EMOTION_KEYWORDS.some((needle) => question.includes(needle))
    || HIGH_EMOTION_PATTERNS.some((pattern) => pattern.test(question));
}

function classifyEmotionalIntensity(context = {}) {
  const question = normalizeText(context.question || '').toLowerCase();
  if (!question) return 'low';
  if (HIGH_EMOTION_KEYWORDS.some((needle) => question.includes(needle))) return 'high';
  if (HIGH_EMOTION_PATTERNS.some((pattern) => pattern.test(question))) return 'high';
  if (/(难受|失眠|委屈|崩溃|压力|好累|撑不住|烦死|很痛苦)/i.test(question)) return 'medium';
  return 'low';
}

function scoreContinuitySignals(context = {}) {
  const continuitySignals = context.continuitySignals && typeof context.continuitySignals === 'object'
    ? context.continuitySignals
    : {};
  let score = 0;
  if (continuitySignals.hasCarryOverTopic) score += 10;
  if (continuitySignals.hasOpenLoop) score += 10;
  if (continuitySignals.quoteAnchored) score += 6;
  return score;
}

function scoreContextDensity(context = {}) {
  const density = Number(context.contextDensity || 0) || 0;
  if (density >= 1200) return -18;
  if (density >= 800) return -12;
  if (density >= 400) return -6;
  return 0;
}

function resolveFewShotMaxExamples(context = {}, index = null) {
  const baseMaxExamples = Math.max(
    0,
    Number(context.maxExamples ?? index?.max_examples ?? 0) || 0
  );
  if (baseMaxExamples <= 0) return 0;
  const hasWorldbookLinkedExamples = normalizeStringList(context.preferredExampleIds).length > 0
    || normalizeStringList(context.activeWorldbookIds).length > 0;

  const emotionalIntensity = classifyEmotionalIntensity(context);
  const cappedBase = Math.min(baseMaxExamples, emotionalIntensity === 'high' ? 2 : 1);
  if (hasWorldbookLinkedExamples) {
    if ((Number(context.contextDensity || 0) || 0) > 1200) return Math.min(cappedBase, 1);
    return Math.min(baseMaxExamples, 2);
  }
  if (!shouldUseExtraFewShotSlot(context) && emotionalIntensity !== 'medium') return cappedBase;
  if ((Number(context.contextDensity || 0) || 0) > 1200) return Math.min(cappedBase, 1);
  return Math.min(cappedBase + 1, 2);
}

function scoreKeywords(text, keywords = [], weight = 14) {
  let score = 0;
  for (const keyword of keywords) {
    const needle = String(keyword || '').trim();
    if (!needle) continue;
    if (text.includes(needle)) score += weight;
  }
  return score;
}

function scoreRegexes(rawText, regexList = [], weight = 18) {
  let score = 0;
  for (const item of regexList) {
    if (item instanceof RegExp) {
      if (item.test(rawText)) score += weight;
      continue;
    }
    try {
      const source = String(item || '').trim();
      if (!source) continue;
      const re = new RegExp(source, 'i');
      if (re.test(rawText)) score += weight;
    } catch (_) {}
  }
  return score;
}

function scoreFewShotExample(example = {}, context = {}) {
  const rawQuestion = String(context.question || '').trim();
  const routeKey = String(context.routePolicyKey || context.topRouteType || '').trim().toLowerCase();
  const routePrompt = String(context.routePrompt || '').trim();
  const text = normalizeText(`${rawQuestion}\n${routePrompt}`).toLowerCase();
  const match = example && typeof example.match === 'object' ? example.match : {};
  const runtime = example && typeof example.__fewShotRuntime === 'object' ? example.__fewShotRuntime : {};
  const activeWorldbookIds = normalizeStringList(context.activeWorldbookIds);
  const preferredExampleIds = normalizeStringList(context.preferredExampleIds);

  if (!text) return 0;

  if (preferredExampleIds.includes(normalizeText(example.id).toLowerCase())) return Number(runtime.priority ?? example.priority ?? 0) + 80;

  const routeTypes = Array.isArray(runtime.routeTypes) ? runtime.routeTypes : normalizeStringList(match.route_types);
  if (routeTypes.length > 0 && routeKey && !routeTypes.includes(routeKey)) return 0;

  const excludeKeywords = Array.isArray(runtime.excludeKeywords) ? runtime.excludeKeywords : normalizeStringList(match.exclude_keywords);
  if (excludeKeywords.some((needle) => text.includes(needle))) return 0;

  let score = Number(runtime.priority ?? example.priority ?? 0) || 0;
  const worldbookIds = Array.isArray(runtime.worldbookIds) ? runtime.worldbookIds : normalizeStringList(match.worldbook_ids || example.worldbookIds);
  if (activeWorldbookIds.length > 0 && worldbookIds.some((id) => activeWorldbookIds.includes(id))) score += 55;
  score += scoreKeywords(text, Array.isArray(runtime.keywordsAny) ? runtime.keywordsAny : normalizeStringList(match.keywords_any), 14);
  score += scoreKeywords(text, Array.isArray(runtime.keywordsAll) ? runtime.keywordsAll : normalizeStringList(match.keywords_all), 10);
  score += scoreRegexes(rawQuestion, Array.isArray(runtime.regexAny) ? runtime.regexAny : match.regex_any, 18);
  score += scoreContinuitySignals(context);
  score += scoreContextDensity(context);

  const emotion = classifyEmotionalIntensity(context);
  if (emotion === 'high') score += 12;
  else if (emotion === 'medium') score += 5;

  const keywordsAll = Array.isArray(runtime.keywordsAll) ? runtime.keywordsAll : normalizeStringList(match.keywords_all);
  if (keywordsAll.length > 0 && keywordsAll.some((needle) => !text.includes(needle))) return 0;

  const keywordsAny = Array.isArray(runtime.keywordsAny) ? runtime.keywordsAny : normalizeStringList(match.keywords_any);
  if (keywordsAny.length > 0 && score <= Number(runtime.priority ?? example.priority ?? 0)) {
    return 0;
  }

  return score;
}

function selectDynamicFewShotExamples(context = {}) {
  const index = loadFewShotIndex();
  const maxExamples = resolveFewShotMaxExamples(context, index);
  if (maxExamples <= 0) return [];

  const preferredExampleIds = normalizeStringList(context.preferredExampleIds);
  const activeWorldbookIds = normalizeStringList(context.activeWorldbookIds);
  const preferred = index.examples
    .map((example) => ({
      example,
      score: scoreFewShotExample(example, {
        ...context,
        preferredExampleIds,
        activeWorldbookIds
      })
    }))
    .filter((item) => item.score > 0)
    .filter((item) => {
      const id = normalizeText(item.example.id).toLowerCase();
      const runtime = item.example && typeof item.example.__fewShotRuntime === 'object' ? item.example.__fewShotRuntime : {};
      const worldbookIds = Array.isArray(runtime.worldbookIds) ? runtime.worldbookIds : [];
      return preferredExampleIds.includes(id) || worldbookIds.some((entry) => activeWorldbookIds.includes(entry));
    })
    .sort((a, b) => b.score - a.score || String(a.example.id || '').localeCompare(String(b.example.id || '')))
    .slice(0, Math.min(1, maxExamples))
    .map((item) => item.example);
  const preferredIds = new Set(preferred.map((example) => normalizeText(example.id).toLowerCase()));
  const scored = index.examples
    .map((example) => ({
      example,
      score: scoreFewShotExample(example, context)
    }))
    .filter((item) => item.score > 0)
    .filter((item) => !preferredIds.has(normalizeText(item.example.id).toLowerCase()))
    .sort((a, b) => b.score - a.score || String(a.example.id || '').localeCompare(String(b.example.id || '')));

  return preferred.concat(scored.slice(0, Math.max(0, maxExamples - preferred.length)).map((item) => item.example));
}

function buildDynamicFewShotPrompt(context = {}) {
  const examples = selectDynamicFewShotExamples(context);
  if (!examples.length) return '';

  const blocks = examples.map((example) => {
    const user = normalizeText(example.user || '');
    const assistant = normalizeText(example.assistant || '');
    if (!user || !assistant) return '';

    return [
      `[示例:${String(example.id || 'example').trim() || 'example'}]`,
      `用户：${user}`,
      `瑞希：${assistant}`
    ].join('\n');
  }).filter(Boolean);

  if (!blocks.length) return '';

  return [
    '[动态示例参考]',
    '以下示例只用于帮助你贴近语气、节奏和分寸，不要照抄内容，也不要假装发生过相同经历。',
    blocks.join('\n\n')
  ].join('\n');
}

function clearFewShotIndexCache() {
  fewShotIndexCache = null;
}

module.exports = {
  FEW_SHOT_INDEX_PATH,
  FEW_SHOT_EXAMPLES_PATH,
  buildDynamicFewShotPrompt,
  clearFewShotIndexCache,
  loadFewShotIndex,
  resolveFewShotMaxExamples,
  scoreFewShotExample,
  selectDynamicFewShotExamples,
  shouldUseExtraFewShotSlot
};
