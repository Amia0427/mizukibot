const fs = require('fs');
const path = require('path');
const config = require('../config');

const FEW_SHOT_INDEX_PATH = path.join(config.PROMPTS_DIR, 'persona', '05_examples.index.json');
const FEW_SHOT_EXAMPLES_PATH = path.join(config.PROMPTS_DIR, 'persona', '05_examples.txt');

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  const raw = safeReadText(FEW_SHOT_INDEX_PATH, '').trim();
  if (!raw) {
    return { version: 1, max_examples: 0, examples: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, max_examples: 0, examples: [] };
    }
    return {
      version: Number(parsed.version || 1) || 1,
      max_examples: Math.max(0, Number(parsed.max_examples || 0) || 0),
      examples: Array.isArray(parsed.examples) ? parsed.examples : []
    };
  } catch (_) {
    return { version: 1, max_examples: 0, examples: [] };
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

  const emotionalIntensity = classifyEmotionalIntensity(context);
  const cappedBase = Math.min(baseMaxExamples, emotionalIntensity === 'high' ? 2 : 1);
  if (!shouldUseExtraFewShotSlot(context) && emotionalIntensity !== 'medium') return cappedBase;
  if ((Number(context.contextDensity || 0) || 0) > 1200) return Math.min(cappedBase, 1);
  return Math.min(cappedBase + 1, 2);
}

function scoreKeywords(text, keywords = [], weight = 14) {
  let score = 0;
  for (const keyword of keywords) {
    const needle = normalizeText(keyword).toLowerCase();
    if (!needle) continue;
    if (text.includes(needle)) score += weight;
  }
  return score;
}

function scoreRegexes(rawText, regexList = [], weight = 18) {
  let score = 0;
  for (const item of regexList) {
    const source = String(item || '').trim();
    if (!source) continue;
    try {
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

  if (!text) return 0;

  const routeTypes = Array.isArray(match.route_types)
    ? match.route_types.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (routeTypes.length > 0 && routeKey && !routeTypes.includes(routeKey)) return 0;

  const excludeKeywords = Array.isArray(match.exclude_keywords)
    ? match.exclude_keywords.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : [];
  if (excludeKeywords.some((needle) => text.includes(needle))) return 0;

  let score = Number(example.priority || 0) || 0;
  score += scoreKeywords(text, match.keywords_any, 14);
  score += scoreKeywords(text, match.keywords_all, 10);
  score += scoreRegexes(rawQuestion, match.regex_any, 18);
  score += scoreContinuitySignals(context);
  score += scoreContextDensity(context);

  const emotion = classifyEmotionalIntensity(context);
  if (emotion === 'high') score += 12;
  else if (emotion === 'medium') score += 5;

  const keywordsAll = Array.isArray(match.keywords_all)
    ? match.keywords_all.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : [];
  if (keywordsAll.length > 0 && keywordsAll.some((needle) => !text.includes(needle))) return 0;

  if (Array.isArray(match.keywords_any) && match.keywords_any.length > 0 && score <= Number(example.priority || 0)) {
    return 0;
  }

  return score;
}

function selectDynamicFewShotExamples(context = {}) {
  const index = loadFewShotIndex();
  const scored = index.examples
    .map((example) => ({
      example,
      score: scoreFewShotExample(example, context)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.example.id || '').localeCompare(String(b.example.id || '')));

  const maxExamples = resolveFewShotMaxExamples(context, index);
  return scored.slice(0, maxExamples).map((item) => item.example);
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

module.exports = {
  FEW_SHOT_INDEX_PATH,
  FEW_SHOT_EXAMPLES_PATH,
  buildDynamicFewShotPrompt,
  loadFewShotIndex,
  resolveFewShotMaxExamples,
  scoreFewShotExample,
  selectDynamicFewShotExamples,
  shouldUseExtraFewShotSlot
};
