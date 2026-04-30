const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const httpClient = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../api/parser');
const { getApiProvider } = require('../utils/modelProvider');
const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const memeStore = require('../utils/memeStore');
const { classifyReplyFailure } = require('../utils/replyFailure');
const { getRecentMessages } = require('../utils/groupAwarenessState');
const { normalizeResponseIntent } = require('./routeSchema');
const { isAdmin } = require('./router');
const { assertSafeHttpUrl } = require('../utils/networkSafety');

const uploadSessions = new Map();
const followupRuntime = new Map();
let runtimeStoreCache = { groups: {}, assets: {} };
const reindexQueue = [];
const reindexQueueSet = new Set();
const reindexState = {
  running: false,
  activeTask: null,
  processed: 0,
  failed: 0,
  lastError: '',
  lastStartedAt: 0,
  lastFinishedAt: 0
};

const MOOD_ALIASES = new Map([
  ['praise', 'praise'],
  ['夸奖', 'praise'],
  ['认同', 'praise'],
  ['表扬', 'praise'],
  ['playful', 'playful'],
  ['调皮', 'playful'],
  ['玩笑', 'playful'],
  ['可爱', 'playful'],
  ['轻松', 'playful'],
  ['confused', 'confused'],
  ['疑惑', 'confused'],
  ['装傻', 'confused'],
  ['没懂', 'confused'],
  ['comfort', 'comfort'],
  ['安慰', 'comfort'],
  ['难过', 'comfort'],
  ['伤心', 'comfort'],
  ['annoyed', 'annoyed'],
  ['嫌弃', 'annoyed'],
  ['生气', 'annoyed'],
  ['不爽', 'annoyed'],
  ['none', 'none']
]);

const INTENSITY_ALIASES = new Map([
  ['low', 'low'],
  ['低', 'low'],
  ['medium', 'medium'],
  ['中', 'medium'],
  ['high', 'high'],
  ['高', 'high']
]);

function ensureChatCompletionsUrl(url) {
  const raw = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

const ASSET_ANALYSIS_FIELDS = Object.freeze([
  'summary',
  'primaryMood',
  'secondaryMoods',
  'intensity',
  'confidence',
  'expressionTags',
  'sceneTags',
  'styleTags',
  'subjectTags',
  'textContent',
  'textTags',
  'preferredContexts',
  'avoidContexts'
]);

function getSelectorBaseUrl() {
  return String(config.AI_ROUTER_BASE_URL || config.API_BASE_URL || '').trim();
}

function getSelectorApiKey() {
  return String(config.AI_ROUTER_API_KEY || config.API_KEY || '').trim() || null;
}

function getSelectorModel() {
  return String(config.AI_ROUTER_MODEL || config.AI_MODEL || '').trim() || 'gpt-5.4';
}

function getAssetAnalysisBaseUrl() {
  return String(config.IMAGE_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getAssetAnalysisApiKey() {
  return String(config.IMAGE_API_KEY || config.API_KEY || '').trim() || null;
}

function getAssetAnalysisModel() {
  return String(config.MEME_MANAGER_ASSET_ANALYSIS_MODEL || config.IMAGE_MODEL || '').trim();
}

function ensureRuntimeStoreShape(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const groupsInput = source.groups && typeof source.groups === 'object' ? source.groups : {};
  const assetsInput = source.assets && typeof source.assets === 'object' ? source.assets : {};
  const groups = {};
  const assets = {};

  for (const [groupId, state] of Object.entries(groupsInput)) {
    groups[String(groupId || '').trim()] = {
      lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0),
      recentAssetIds: (Array.isArray(state?.recentAssetIds) ? state.recentAssetIds : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
      recentCategoryNames: (Array.isArray(state?.recentCategoryNames) ? state.recentCategoryNames : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
      lastMood: String(state?.lastMood || '').trim()
    };
  }

  for (const [assetId, state] of Object.entries(assetsInput)) {
    assets[String(assetId || '').trim()] = {
      sentCount: Math.max(0, Number(state?.sentCount) || 0),
      lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0)
    };
  }

  return { groups, assets };
}

function safeReadRuntimeStore() {
  try {
    if (!fs.existsSync(config.MEME_MANAGER_RUNTIME_FILE)) {
      return ensureRuntimeStoreShape();
    }
    const raw = fs.readFileSync(config.MEME_MANAGER_RUNTIME_FILE, 'utf8').trim();
    if (!raw) return ensureRuntimeStoreShape();
    return ensureRuntimeStoreShape(JSON.parse(raw));
  } catch (error) {
    console.error('[meme-manager] failed to read runtime store:', error?.message || String(error));
    return ensureRuntimeStoreShape();
  }
}

function persistRuntimeStore() {
  const serialized = JSON.stringify(runtimeStoreCache, null, 2);
  const target = config.MEME_MANAGER_RUNTIME_FILE;
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, serialized, 'utf8');
  fs.renameSync(temp, target);
}

function loadRuntimeStore() {
  runtimeStoreCache = safeReadRuntimeStore();
  return runtimeStoreCache;
}

function normalizeContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => normalizeContentText(item)).join('');
  if (!content || typeof content !== 'object') return String(content || '');
  if (typeof content.text === 'string') return content.text;
  if (content.text && typeof content.text === 'object') return normalizeContentText(content.text);
  if (typeof content.value === 'string') return content.value;
  if (typeof content.output_text === 'string') return content.output_text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) return normalizeContentText(content.content);
  if (content.content && typeof content.content === 'object') return normalizeContentText(content.content);
  if (Array.isArray(content.parts)) return normalizeContentText(content.parts);
  return '';
}

function previewSelectorText(rawText, limit = 240) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function extractSelectorResponseText(response) {
  const message = extractMessageContent(response);
  const rawData = response?.data;
  const candidates = [
    message?.content,
    typeof rawData === 'string' ? rawData : '',
    response?.data?.choices?.[0]?.message?.content,
    response?.data?.output_text,
    response?.data?.text,
    response?.data?.output,
    response?.data?.content
  ];

  for (const candidate of candidates) {
    const text = normalizeContentText(candidate).trim();
    if (text) return text;
  }

  return '';
}

function uniqueStrings(list = []) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeMoodAlias(value = '', { allowNone = false } = {}) {
  const normalized = MOOD_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
  if (!normalized) return '';
  if (normalized === 'none' && !allowNone) return '';
  return normalized;
}

function normalizeIntensityAlias(value = '') {
  return INTENSITY_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
}

function parseCsvAliases(raw = '', normalizer) {
  return uniqueStrings(
    String(raw || '')
      .split(',')
      .flatMap((item) => String(item || '').split('，'))
      .map((item) => normalizer(item))
      .filter(Boolean)
  );
}

function parseLooseSelectorOutput(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  let send = null;
  const sendFieldMatch = text.match(/["']?send["']?\s*[:=]\s*(true|false)/i);
  if (sendFieldMatch) send = sendFieldMatch[1].toLowerCase() === 'true';

  let confidence = Number.NaN;
  const confidenceMatch = text.match(/["']?confidence["']?\s*[:=]\s*["']?(-?\d+(?:\.\d+)?)/i)
    || text.match(/\b(0(?:\.\d+)?|1(?:\.0+)?)\b/);
  if (confidenceMatch) confidence = Number(confidenceMatch[1]);

  let mood = '';
  const moodFieldMatch = text.match(/["']?mood["']?\s*[:=]\s*["']?([^,;"'\n}\]]+)/i);
  if (moodFieldMatch) mood = normalizeMoodAlias(moodFieldMatch[1], { allowNone: true });

  let intensity = '';
  const intensityFieldMatch = text.match(/["']?intensity["']?\s*[:=]\s*["']?([^,;"'\n}\]]+)/i);
  if (intensityFieldMatch) intensity = normalizeIntensityAlias(intensityFieldMatch[1]);

  let reason = '';
  const reasonFieldMatch = text.match(/["']?reason["']?\s*[:=]\s*["']?([^"\n}]+)["']?/i);
  if (reasonFieldMatch) {
    reason = String(reasonFieldMatch[1] || '').trim();
  } else {
    reason = text.replace(/\s+/g, ' ').trim();
  }

  if (send === null && mood) send = mood !== 'none';
  if (send === null) return null;
  if (!mood) mood = send ? '' : 'none';
  if (!intensity) intensity = 'low';

  return {
    send,
    mood,
    intensity,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason
  };
}

function normalizeSelectorResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.send !== true && parsed.send !== false) return null;

  const confidence = Number(parsed.confidence);
  const reason = String(parsed.reason || '').trim();
  if (parsed.send === false) {
    return {
      send: false,
      mood: 'none',
      intensity: normalizeIntensityAlias(parsed.intensity) || 'low',
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reason: reason || 'clearly unsuitable for meme'
    };
  }

  const mood = normalizeMoodAlias(parsed.mood, { allowNone: false });
  if (!mood) return null;

  return {
    send: true,
    mood,
    intensity: normalizeIntensityAlias(parsed.intensity) || 'low',
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason
  };
}

function isPositiveMemeTone(text = '') {
  return /开心|高兴|快乐|夸奖|夸夸|赞|棒|真棒|厉害|优秀|可爱|喜欢|好耶|太好了|不错|得意|轻松|认同|表扬|奖励|状态很好|心情很好|哈哈|playful|praise|cute|great|awesome|nice|love/i.test(String(text || ''));
}

function truncateText(value = '', limit = 120) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return `${chars.slice(0, limit).join('')}...`;
}

function stripCqSegments(value = '') {
  return String(value || '').replace(/\[CQ:[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeRecentTurnRole(senderId = '', botId = '') {
  const sid = String(senderId || '').trim();
  const bid = String(botId || '').trim();
  return sid && bid && sid === bid ? 'assistant_hint' : 'user';
}

function buildRecentTurns({ groupId = '', recentMessagesOverride = null, userText = '', limit = 4 }) {
  const source = Array.isArray(recentMessagesOverride)
    ? recentMessagesOverride
    : (groupId ? getRecentMessages(groupId) : []);
  const cleanUserText = stripCqSegments(userText);
  const botId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  const turns = [];

  for (const item of source.slice(-Math.max(2, limit + 2))) {
    const text = truncateText(stripCqSegments(item?.text || ''), 120);
    if (!text) continue;
    if (cleanUserText && text === cleanUserText) continue;
    const role = normalizeRecentTurnRole(item?.sender_id, botId);
    turns.push({
      role,
      name: String(item?.sender_name || '').trim() || (role === 'assistant_hint' ? 'bot' : 'user'),
      text
    });
  }

  return turns.slice(-Math.max(0, limit));
}

function extractReplyId(rawMessage = '') {
  const match = String(rawMessage || '').match(/\[CQ:reply,id=([^,\]]+)/i);
  return match ? String(match[1] || '').trim() : '';
}

function buildQuoteText({ rawMessage = '', replyToMessageId = '', recentMessages = [] }) {
  const targetId = String(replyToMessageId || '').trim() || extractReplyId(rawMessage);
  if (!targetId) return '';

  const source = Array.isArray(recentMessages) ? recentMessages : [];
  const directHit = source.find((item) => String(item?.message_id || item?.id || '').trim() === targetId);
  if (directHit?.text) return truncateText(stripCqSegments(directHit.text), 120);

  const fallback = source
    .slice()
    .reverse()
    .find((item) => Boolean(stripCqSegments(item?.text || '')));
  return fallback?.text ? truncateText(stripCqSegments(fallback.text), 120) : '';
}

function buildLengthBucket(text = '') {
  const length = Array.from(String(text || '').replace(/\s+/g, '')).length;
  if (length >= 140) return 'long';
  if (length >= 36) return 'medium';
  return 'short';
}

function detectToolLikeReply(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  if (/^#{1,6}\s|\n[-*]\s|\n\d+\.\s/m.test(normalized)) return true;
  return /(步骤|方案|总结|排查|配置|命令|日志|接口|参数|代码|实现|部署|status|error|trace|stack|json|yaml|sql|api|curl|npm|node|python)/i.test(normalized);
}

function detectQuestionReply(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return /[?？]/.test(normalized) || /^(要不要|是不是|要不|或者|你想|你要)/.test(normalized);
}

function detectCue(text = '', patterns = []) {
  const normalized = String(text || '');
  return patterns.some((pattern) => pattern.test(normalized));
}

function buildPunctuationIntensity(text = '') {
  const normalized = String(text || '');
  const score = (normalized.match(/[!！~～]/g) || []).length * 2
    + (normalized.match(/[?？]/g) || []).length
    + (/(哈哈|hhh|233|耶|哇|诶|欸|呀|啦|嘛|哦|噢)/i.test(normalized) ? 1 : 0)
    + (/([!！?？~～])\1/.test(normalized) ? 2 : 0);
  if (score >= 5) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function buildReplyMeta({ replyText = '', routeMeta = null }) {
  const failure = classifyReplyFailure(replyText);
  const responseIntent = normalizeResponseIntent(routeMeta?.responseIntent, 'answer');
  return {
    responseIntent,
    isFailureReply: failure.type !== 'none',
    failureType: failure.type,
    isToolLike: detectToolLikeReply(replyText),
    lengthBucket: buildLengthBucket(replyText),
    asksQuestion: detectQuestionReply(replyText),
    isQuestionReply: detectQuestionReply(replyText),
    hasPraiseCue: detectCue(replyText, [
      /夸|表扬|认同|厉害|真棒|太强|牛|可爱|喜欢|nice|great|awesome|cute|love/i
    ]),
    hasConfusedCue: detectCue(replyText, [
      /疑惑|装傻|没懂|什么鬼|啊\?|啊？|哈\?|哈？|why|what\??|confused/i
    ]),
    hasComfortCue: detectCue(replyText, [
      /安慰|抱抱|摸摸|别难过|没事|会好的|辛苦|心疼|hug|comfort|sad/i
    ]),
    hasAnnoyedCue: detectCue(replyText, [
      /嫌弃|生气|不爽|无语|烦|annoyed|angry/i
    ]),
    punctuationIntensity: buildPunctuationIntensity(replyText)
  };
}

function buildPassiveContext(surface = '', passiveDecisionMeta = null) {
  if (surface !== 'passive') return {};
  const meta = passiveDecisionMeta && typeof passiveDecisionMeta === 'object' ? passiveDecisionMeta : {};
  return {
    presenceState: String(meta.presenceState || '').trim(),
    presenceAction: String(meta.presenceAction || '').trim(),
    presenceReason: String(meta.presenceReason || '').trim(),
    lastAddressee: String(meta.addressee || meta.lastAddressee || '').trim()
  };
}

function buildContextSourceFlags({ quoteText = '', recentTurns = [], replyMeta = null, passiveContext = {}, surface = '' }) {
  return {
    quoteText: Boolean(String(quoteText || '').trim()),
    recentTurns: Array.isArray(recentTurns) && recentTurns.length > 0,
    replyMeta: Boolean(replyMeta && typeof replyMeta === 'object'),
    passiveContext: surface === 'passive' && Object.values(passiveContext || {}).some(Boolean)
  };
}

function computeKeywordHits(category, haystack = '') {
  const keywords = Array.isArray(category?.keywords) ? category.keywords : [];
  const text = String(haystack || '').trim();
  if (!text || !keywords.length) return [];
  return uniqueStrings(keywords.filter((keyword) => keyword && text.includes(keyword)).slice(0, 3));
}

function clampProbability(value) {
  return Math.max(0.05, Math.min(0.8, Number(value) || 0));
}

function getIntensityDistance(left = '', right = '') {
  const order = ['low', 'medium', 'high'];
  const leftIndex = order.indexOf(String(left || '').trim());
  const rightIndex = order.indexOf(String(right || '').trim());
  if (leftIndex < 0 || rightIndex < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(leftIndex - rightIndex);
}

function trimRecentWindow(list = [], limit = 0) {
  const normalizedLimit = Math.max(0, Number(limit) || 0);
  if (normalizedLimit === 0) return [];
  return list.slice(-normalizedLimit);
}

function getFollowupRuntime(groupId = '') {
  const key = String(groupId || '').trim() || '__default__';
  const runtime = followupRuntime.get(key) || runtimeStoreCache.groups[key];
  if (runtime && typeof runtime === 'object') {
    return {
      lastSentAt: Math.max(0, Number(runtime.lastSentAt) || 0),
      recentAssetIds: Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds.slice() : [],
      recentCategoryNames: Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames.slice() : [],
      lastMood: String(runtime.lastMood || '').trim()
    };
  }
  return {
    lastSentAt: 0,
    recentAssetIds: [],
    recentCategoryNames: [],
    lastMood: ''
  };
}

function setFollowupRuntime(groupId = '', runtime = {}) {
  const key = String(groupId || '').trim() || '__default__';
  const normalized = {
    lastSentAt: Math.max(0, Number(runtime.lastSentAt) || 0),
    recentAssetIds: Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds.slice() : [],
    recentCategoryNames: Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames.slice() : [],
    lastMood: String(runtime.lastMood || '').trim()
  };
  followupRuntime.set(key, normalized);
  runtimeStoreCache.groups[key] = {
    ...normalized,
    recentAssetIds: normalized.recentAssetIds.slice(),
    recentCategoryNames: normalized.recentCategoryNames.slice()
  };
  persistRuntimeStore();
}

function buildRuntimeSummary(groupId = '', now = Date.now()) {
  const runtime = getFollowupRuntime(groupId);
  const cooldownMs = Math.max(0, Number(config.MEME_MANAGER_GROUP_COOLDOWN_MS) || 0);
  const cooldownRemainingMs = Math.max(0, cooldownMs - Math.max(0, now - runtime.lastSentAt));
  return {
    ...runtime,
    cooldownRemainingMs
  };
}

function updateFollowupRuntime(groupId = '', selection = {}, asset = {}, now = Date.now()) {
  const previous = getFollowupRuntime(groupId);
  const recentAssetWindow = Math.max(0, Number(config.MEME_MANAGER_RECENT_ASSET_WINDOW) || 0);
  const recentCategoryWindow = Math.max(0, Number(config.MEME_MANAGER_RECENT_CATEGORY_WINDOW) || 0);
  const nextAssetIds = trimRecentWindow(
    [...previous.recentAssetIds, String(asset?.id || '').trim()].filter(Boolean),
    recentAssetWindow
  );
  const nextCategoryNames = trimRecentWindow(
    [...previous.recentCategoryNames, String(selection?.selectedCategory || '').trim()].filter(Boolean),
    recentCategoryWindow
  );
  setFollowupRuntime(groupId, {
    lastSentAt: Math.max(0, Number(now) || Date.now()),
    recentAssetIds: nextAssetIds,
    recentCategoryNames: nextCategoryNames,
    lastMood: String(selection?.mood || '').trim()
  });
  const assetId = String(asset?.id || '').trim();
  if (assetId) {
    const currentAssetRuntime = runtimeStoreCache.assets[assetId] || { sentCount: 0, lastSentAt: 0 };
    runtimeStoreCache.assets[assetId] = {
      sentCount: Math.max(0, Number(currentAssetRuntime.sentCount) || 0) + 1,
      lastSentAt: Math.max(0, Number(now) || Date.now())
    };
    persistRuntimeStore();
  }
}

function evaluateMemeGate({
  surface = '',
  groupId = '',
  selection = {},
  replyMeta = {},
  now = Date.now(),
  randomValue = Math.random()
} = {}) {
  const runtime = getFollowupRuntime(groupId);
  const cooldownMs = Math.max(0, Number(config.MEME_MANAGER_GROUP_COOLDOWN_MS) || 0);
  const elapsedMs = Math.max(0, Number(now) - runtime.lastSentAt);
  const cooldownRemainingMs = Math.max(0, cooldownMs - elapsedMs);
  if (runtime.lastSentAt > 0 && cooldownRemainingMs > 0) {
    return {
      allowed: false,
      reason: 'cooldown-active',
      probability: 0,
      cooldownRemainingMs
    };
  }

  let probability = Number(config.MEME_MANAGER_SEND_BASE_PROBABILITY || 0.3);
  if (replyMeta?.lengthBucket === 'short') probability += 0.2;
  if (replyMeta?.lengthBucket === 'medium') probability -= 0.1;
  if (Number(selection?.confidence || 0) >= 0.8) probability += 0.1;
  if (['praise', 'playful', 'confused'].includes(String(selection?.mood || '').trim())) probability += 0.05;
  if (replyMeta?.isQuestionReply === true) probability -= 0.15;
  if (String(surface || '').trim() === 'passive') probability -= 0.1;
  const recentCategories = Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames : [];
  if (
    String(selection?.selectedCategory || '').trim()
    && recentCategories[recentCategories.length - 1] === String(selection.selectedCategory).trim()
  ) {
    probability -= 0.15;
  }
  probability = clampProbability(probability);
  const draw = Math.max(0, Math.min(1, Number(randomValue)));
  if (draw > probability) {
    return {
      allowed: false,
      reason: 'probability-rejected',
      probability,
      cooldownRemainingMs: 0
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    probability,
    cooldownRemainingMs: 0
  };
}

function scoreCategory(category, selectorResult, combinedText = '', recentCategoryNames = []) {
  const keywordHits = computeKeywordHits(category, combinedText);
  const keywordScore = Math.min(keywordHits.length, 3);
  const specificityScore = Array.isArray(category?.moods) && category.moods.length === 1 ? 1 : 0;
  const intensities = Array.isArray(category?.intensities) ? category.intensities : [];
  let intensityScore = 0;
  if (intensities.length === 0) {
    intensityScore = 1;
  } else if (intensities.includes(selectorResult.intensity)) {
    intensityScore = 3;
  } else {
    const nearestDistance = intensities.reduce((best, item) => {
      const distance = getIntensityDistance(item, selectorResult.intensity);
      return distance < best ? distance : best;
    }, Number.POSITIVE_INFINITY);
    intensityScore = nearestDistance === 1 ? 1 : -2;
  }
  const normalizedCategoryName = String(category?.name || '').trim();
  const normalizedRecentCategoryNames = (Array.isArray(recentCategoryNames) ? recentCategoryNames : [])
    .map((item) => String(item || '').trim());
  const recentPenaltyIndex = normalizedRecentCategoryNames.lastIndexOf(normalizedCategoryName);
  let recentPenalty = 0;
  if (recentPenaltyIndex >= 0) {
    recentPenalty = recentPenaltyIndex === normalizedRecentCategoryNames.length - 1 ? -4 : -2;
  }

  return {
    category,
    keywordHits,
    keywordScore,
    specificityScore,
    intensityScore,
    recentPenalty,
    totalScore: keywordScore * 2 + specificityScore + intensityScore + recentPenalty
  };
}

function compareCategoryScores(left, right) {
  if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
  if (right.keywordScore !== left.keywordScore) return right.keywordScore - left.keywordScore;
  const leftMoodCount = Array.isArray(left.category?.moods) ? left.category.moods.length : 0;
  const rightMoodCount = Array.isArray(right.category?.moods) ? right.category.moods.length : 0;
  if (leftMoodCount !== rightMoodCount) return leftMoodCount - rightMoodCount;
  const leftAssets = Number(left.category?.assetCount) || 0;
  const rightAssets = Number(right.category?.assetCount) || 0;
  if (rightAssets !== leftAssets) return rightAssets - leftAssets;
  return String(left.category?.name || '').localeCompare(String(right.category?.name || ''), 'zh-Hans-CN-u-co-pinyin');
}

function chooseCategoryBySelector(categories = [], selectorResult, context = {}) {
  const available = Array.isArray(categories) ? categories : [];
  if (!selectorResult?.send) {
    return { selectedCategory: '', candidateScores: [], keywordHits: [] };
  }

  const combinedText = [
    String(context.userText || '').trim(),
    String(context.replyText || '').trim(),
    String(context.quoteText || '').trim(),
    ...(Array.isArray(context.recentTurns) ? context.recentTurns.map((item) => String(item?.text || '').trim()) : []),
    String(selectorResult.reason || '').trim()
  ].filter(Boolean).join('\n');
  const candidates = available.filter((category) => {
    const moods = Array.isArray(category.moods) ? category.moods : [];
    if (!moods.includes(selectorResult.mood)) return false;
    return true;
  });

  const recentCategoryNames = Array.isArray(context.recentCategoryNames) ? context.recentCategoryNames : [];
  const scored = candidates.map((category) => scoreCategory(category, selectorResult, combinedText, recentCategoryNames));
  scored.sort(compareCategoryScores);
  return {
    selectedCategory: scored[0]?.category?.name || '',
    candidateScores: scored,
    keywordHits: scored[0]?.keywordHits || []
  };
}

function inferCategoryByLocalHeuristics(categories = [], context = {}) {
  const available = Array.isArray(categories) ? categories : [];
  if (!available.length) return null;

  const replyMeta = context.replyMeta && typeof context.replyMeta === 'object' ? context.replyMeta : {};
  if (replyMeta.isFailureReply || replyMeta.isToolLike || replyMeta.lengthBucket === 'long') {
    return null;
  }

  const combined = [
    String(context.userText || '').trim(),
    String(context.replyText || '').trim(),
    String(context.quoteText || '').trim(),
    ...(Array.isArray(context.recentTurns) ? context.recentTurns.map((item) => String(item?.text || '').trim()) : [])
  ].filter(Boolean).join('\n');
  if (!combined.trim()) return null;

  const ruleDefs = [
    {
      match: (text) => /开心|高兴|快乐|夸奖|夸夸|赞|棒|真棒|厉害|优秀|可爱|喜欢|好耶|太好了|不错|得意|轻松|认同|表扬|奖励|状态很好|心情很好|哈哈|playful|praise|cute|great|awesome|nice|love/i.test(text),
      aliases: ['开心', '夸奖', '可爱']
    },
    {
      match: (text) => /看不懂|没看懂|不懂|什么鬼|什么意思|疑惑|困惑|装傻|无语|迷惑|啊这|啊？|哈？|没听懂|不太确定|不明白|why|confused|what\?/i.test(text),
      aliases: ['装傻', '疑惑']
    },
    {
      match: (text) => /伤心|难过|低落|委屈|痛苦|崩溃|想哭|悲伤|心碎|沮丧|失落|可怜|难受|sad|cry|upset|depressed/i.test(text),
      aliases: ['伤心', '难过', '悲伤']
    },
    {
      match: (text) => /嫌弃|生气|不爽|烦|无语|annoyed|angry/i.test(text),
      aliases: ['嫌弃', '生气']
    }
  ];

  for (const rule of ruleDefs) {
    if (!rule.match(combined)) continue;
    const hit = available.find((item) => rule.aliases.includes(String(item.name || '').trim()));
    if (!hit) continue;
    return {
      send: true,
      mood: Array.isArray(hit.moods) && hit.moods[0] ? hit.moods[0] : 'playful',
      intensity: Array.isArray(hit.intensities) && hit.intensities[0] ? hit.intensities[0] : 'low',
      confidence: Math.max(Number(config.MEME_MANAGER_MIN_CONFIDENCE || 0.45), 0.46),
      reason: 'local-heuristic-fallback',
      selectedCategory: hit.name,
      decisionSource: 'local-heuristic-fallback',
      keywordHits: []
    };
  }

  return null;
}

function normalizeSurfaceList() {
  const items = String(config.MEME_MANAGER_SURFACES || '')
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  return new Set(items);
}

function isSurfaceEnabled(surface) {
  const store = memeStore.getStore();
  const surfaceSet = normalizeSurfaceList();
  if (!store.enabled || !config.MEME_MANAGER_ENABLED) return false;
  if (!surfaceSet.has(String(surface || '').trim().toLowerCase())) return false;
  if (surface === 'direct') return store.surfaces.direct !== false;
  if (surface === 'passive') return store.surfaces.passive !== false;
  if (surface === 'scheduled') return store.surfaces.scheduled !== false;
  return false;
}

function getSessionKey(groupId, userId) {
  return `${String(groupId || '').trim()}:${String(userId || '').trim()}`;
}

function cleanupExpiredSessions(now = Date.now()) {
  for (const [key, session] of uploadSessions.entries()) {
    if (!session || Number(session.expiresAt || 0) <= now) {
      uploadSessions.delete(key);
    }
  }
}

function startUploadSession({ groupId, userId, categoryName }) {
  cleanupExpiredSessions();
  const sessionKey = getSessionKey(groupId, userId);
  const session = {
    key: sessionKey,
    groupId: String(groupId || '').trim(),
    userId: String(userId || '').trim(),
    categoryName: String(categoryName || '').trim(),
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(1000, Number(config.MEME_MANAGER_UPLOAD_WINDOW_MS || 60000)),
    importedCount: 0
  };
  uploadSessions.set(sessionKey, session);
  return { ...session };
}

function getUploadSession(groupId, userId) {
  cleanupExpiredSessions();
  const session = uploadSessions.get(getSessionKey(groupId, userId));
  return session ? { ...session } : null;
}

function endUploadSession(groupId, userId) {
  uploadSessions.delete(getSessionKey(groupId, userId));
}

function listCategorySummaryLines() {
  const categories = memeStore.listCategories();
  if (!categories.length) return ['当前图库为空。'];
  return categories.map((category) => (
    `${category.name} | ${category.assetCount} 张 | ${category.description}`
  ));
}

function formatFilesList(categoryName) {
  const files = memeStore.listCategoryFiles(categoryName);
  if (!files.length) return '该分类当前没有图片。';
  return files
    .map((file) => {
      const resolved = resolveAssetAnalysis(file).resolved;
      const feedback = file.feedback || {};
      return [
        file.id,
        file.mime || 'unknown',
        `${file.size}B`,
        new Date(file.createdAt).toISOString(),
        `analysisStatus=${file.analysis?.status || 'pending'}`,
        `primaryMood=${resolved.primaryMood || 'none'}`,
        `intensity=${resolved.intensity || 'low'}`,
        `blocked=${feedback.blocked === true}`,
        `feedback=${JSON.stringify({
          likes: Math.max(0, Number(feedback.likes) || 0),
          dislikes: Math.max(0, Number(feedback.dislikes) || 0),
          skips: Math.max(0, Number(feedback.skips) || 0)
        })}`
      ].join(' | ');
    })
    .join('\n');
}

function formatCategoryDetails(categoryName) {
  const category = memeStore.getCategory(categoryName);
  if (!category) throw new Error('Category not found.');
  return [
    `name: ${category.name}`,
    `description: ${category.description || '(empty)'}`,
    `moods: ${(category.moods || []).join(', ') || '(empty)'}`,
    `intensities: ${(category.intensities || []).join(', ') || '(all)'}`,
    `keywords: ${(category.keywords || []).join(', ') || '(empty)'}`,
    `assetCount: ${Array.isArray(category.assets) ? category.assets.length : 0}`,
    `enabled: ${category.enabled !== false}`
  ].join('\n');
}

function formatAssetDetails(categoryName, assetId) {
  const asset = memeStore.getAsset(categoryName, assetId);
  if (!asset) throw new Error('Asset not found.');
  const analysis = resolveAssetAnalysis(asset);
  return [
    `category: ${categoryName}`,
    `assetId: ${asset.id}`,
    `fileName: ${asset.fileName}`,
    `mime: ${asset.mime || 'unknown'}`,
    `size: ${asset.size}`,
    `analysisStatus: ${analysis.status}`,
    `analysisVersion: ${analysis.version}`,
    `analysisModel: ${analysis.model || '(empty)'}`,
    `analyzedAt: ${analysis.analyzedAt ? new Date(analysis.analyzedAt).toISOString() : '(never)'}`,
    `primaryMood: ${analysis.resolved.primaryMood || 'none'}`,
    `intensity: ${analysis.resolved.intensity || 'low'}`,
    `blocked: ${asset.feedback?.blocked === true}`,
    `feedback: ${JSON.stringify(asset.feedback || {})}`,
    `resolvedAnalysis: ${JSON.stringify(analysis.resolved)}`,
    `overrides: ${JSON.stringify(analysis.overrides || {})}`,
    `lastError: ${analysis.lastError || '(empty)'}`
  ].join('\n');
}

function buildHelpText() {
  return [
    '可用命令：',
    '/meme help',
    '/meme status',
    '/meme on',
    '/meme off',
    '/meme categories',
    '/meme category add <分类> <描述>',
    '/meme category desc <分类> <描述>',
    '/meme category show <分类>',
    '/meme category moods <分类> <csv>',
    '/meme category intensity <分类> <csv>',
    '/meme category keywords <分类> <csv>',
    '/meme category remove <分类>',
    '/meme test <replyText>',
    '/meme add <分类>',
    '/meme done',
    '/meme cancel',
    '/meme files <分类>',
    '/meme delete <分类> <assetId>',
    '/meme asset show <分类> <assetId>',
    '/meme asset patch <分类> <assetId> <json>',
    '/meme asset relabel <分类> <assetId>',
    '/meme asset feedback <分类> <assetId> like|dislike|skip|block|unblock',
    '/meme reindex pending',
    '/meme reindex category <分类>',
    '/meme reindex all',
    '/meme reindex status'
  ].join('\n');
}

function splitCommandArgs(text = '') {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function parseMemeCommand(raw = '') {
  const text = String(raw || '').trim();
  if (!/^\/meme(?:\s|$)/i.test(text)) return null;

  const args = splitCommandArgs(text);
  if (args.length === 1) return { action: 'help' };
  if (args[1] === 'help') return { action: 'help' };
  if (args[1] === 'status') return { action: 'status' };
  if (args[1] === 'on') return { action: 'on' };
  if (args[1] === 'off') return { action: 'off' };
  if (args[1] === 'categories') return { action: 'categories' };
  if (args[1] === 'done') return { action: 'done' };
  if (args[1] === 'cancel') return { action: 'cancel' };
  if (args[1] === 'test') {
    const payloadText = text.split(/\s+/).slice(2).join(' ').trim();
    let jsonPayload = null;
    if (/^\s*\{[\s\S]*\}\s*$/.test(payloadText)) {
      try {
        jsonPayload = JSON.parse(payloadText);
      } catch (_) {}
    }
    return {
      action: 'test',
      replyText: payloadText,
      payload: jsonPayload
    };
  }
  if (args[1] === 'add') return { action: 'add-session', categoryName: String(args[2] || '').trim() };
  if (args[1] === 'files') return { action: 'files', categoryName: String(args[2] || '').trim() };
  if (args[1] === 'delete') {
    return {
      action: 'delete-file',
      categoryName: String(args[2] || '').trim(),
      assetId: String(args[3] || '').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'show') {
    return {
      action: 'asset-show',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'patch') {
    return {
      action: 'asset-patch',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim(),
      payloadText: text.split(/\s+/).slice(5).join(' ').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'relabel') {
    return {
      action: 'asset-relabel',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'feedback') {
    return {
      action: 'asset-feedback',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim(),
      feedbackAction: String(args[5] || '').trim().toLowerCase()
    };
  }
  if (args[1] === 'reindex' && args[2] === 'pending') return { action: 'reindex-pending' };
  if (args[1] === 'reindex' && args[2] === 'all') return { action: 'reindex-all' };
  if (args[1] === 'reindex' && args[2] === 'status') return { action: 'reindex-status' };
  if (args[1] === 'reindex' && args[2] === 'category') {
    return {
      action: 'reindex-category',
      categoryName: String(args[3] || '').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'add') {
    return {
      action: 'category-add',
      categoryName: String(args[3] || '').trim(),
      description: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'desc') {
    return {
      action: 'category-desc',
      categoryName: String(args[3] || '').trim(),
      description: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'show') {
    return { action: 'category-show', categoryName: String(args[3] || '').trim() };
  }
  if (args[1] === 'category' && args[2] === 'moods') {
    return {
      action: 'category-moods',
      categoryName: String(args[3] || '').trim(),
      csv: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'intensity') {
    return {
      action: 'category-intensity',
      categoryName: String(args[3] || '').trim(),
      csv: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'keywords') {
    return {
      action: 'category-keywords',
      categoryName: String(args[3] || '').trim(),
      csv: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'remove') {
    return { action: 'category-remove', categoryName: String(args[3] || '').trim() };
  }
  return { action: 'unknown' };
}

function inferImageExtFromUrl(url = '') {
  const clean = String(url || '').split('?')[0].trim();
  const ext = path.extname(clean).toLowerCase();
  return ext || '.jpg';
}

function inferMimeFromResponse(url = '', headers = {}) {
  const contentType = String(headers?.['content-type'] || headers?.['Content-Type'] || '').trim().toLowerCase();
  if (contentType.startsWith('image/')) return contentType;
  const ext = inferImageExtFromUrl(url);
  return memeStore.inferMimeFromExt(`file${ext}`);
}

async function consumePendingUploadFromMessage(msg = {}) {
  cleanupExpiredSessions();
  if (String(msg.post_type || '') !== 'message' || String(msg.message_type || '') !== 'group') {
    return { consumed: false };
  }

  const groupId = String(msg.group_id || '').trim();
  const userId = String(msg.user_id || '').trim();
  const sessionKey = getSessionKey(groupId, userId);
  const session = uploadSessions.get(sessionKey);
  if (!session) return { consumed: false };

  const rawText = String(msg.raw_message || '');
  const match = rawText.match(/\[CQ:image,.*?url=([^,\]]+).*?\]/);
  if (!match) return { consumed: false };

  const imageUrl = String(match[1] || '').replace(/&amp;/g, '&').trim();
  if (!imageUrl) return { consumed: false };

  const maxImages = Math.max(1, Number(config.MEME_MANAGER_MAX_IMAGES_PER_SESSION || 20));
  if (session.importedCount >= maxImages) {
    uploadSessions.delete(sessionKey);
    return {
      consumed: true,
      replyText: `上传窗口已达到上限 ${maxImages} 张，已自动结束。`
    };
  }

  try {
    try {
      await assertSafeHttpUrl(imageUrl);
    } catch (_) {
      return {
        consumed: true,
        replyText: '图片来源地址不安全，已拒绝导入。'
      };
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: Math.max(1000, Number(config.MEME_MANAGER_TIMEOUT_MS || 8000)),
      proxy: false,
      maxRedirects: 0
    });
    const buffer = Buffer.from(response.data || []);
    const maxBytes = Math.max(1, Number(config.MEME_MANAGER_MAX_FILE_SIZE_MB || 10)) * 1024 * 1024;
    if (buffer.length > maxBytes) {
      return {
        consumed: true,
        replyText: `图片过大，超过 ${(maxBytes / (1024 * 1024)).toFixed(0)}MB 限制。`
      };
    }

    const ext = inferImageExtFromUrl(imageUrl);
    const asset = memeStore.importAsset(session.categoryName, buffer, {
      ext,
      mime: inferMimeFromResponse(imageUrl, response.headers || {})
    });
    let analysisReplySuffix = '';
    try {
      const analysisResult = await analyzeMemeAsset({
        categoryName: session.categoryName,
        assetId: asset.id
      });
      memeStore.updateAssetAnalysis(session.categoryName, asset.id, {
        status: 'ready',
        version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
        analyzedAt: Date.now(),
        model: analysisResult.model,
        lastError: '',
        auto: analysisResult.parsed
      });
    } catch (analysisError) {
      memeStore.updateAssetAnalysis(session.categoryName, asset.id, {
        status: 'failed',
        version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
        analyzedAt: Date.now(),
        model: getAssetAnalysisModel(),
        lastError: analysisError?.message || String(analysisError)
      });
      analysisReplySuffix = ` (analysis failed: ${analysisError?.message || String(analysisError)})`;
    }

    session.importedCount += 1;
    session.expiresAt = Date.now() + Math.max(1000, Number(config.MEME_MANAGER_UPLOAD_WINDOW_MS || 60000));
    uploadSessions.set(sessionKey, session);

    console.log('[meme-manager] asset imported', {
      groupId,
      userId,
      category: session.categoryName,
      assetId: asset.id,
      size: asset.size
    });

    return {
      consumed: true,
      replyText: `已导入 ${session.categoryName}: ${asset.id}${analysisReplySuffix}`
    };
  } catch (error) {
    return {
      consumed: true,
      replyText: `导入失败: ${error?.message || String(error)}`
    };
  }
}

function shouldSkipFollowup(replyText = '') {
  const text = String(replyText || '').trim();
  if (!text) return 'empty-reply';
  if (/刚才.*(小问题|网络)|请再发一次|重试链路/i.test(text)) return 'failure-reply';
  return '';
}

function getHardSkipReason(replyText = '', replyMeta = null) {
  const baseReason = shouldSkipFollowup(replyText);
  if (baseReason) return baseReason;
  const meta = replyMeta && typeof replyMeta === 'object' ? replyMeta : {};
  if (meta.isFailureReply) return 'failure-reply';
  if (meta.isToolLike && meta.lengthBucket === 'long') return 'tool-like-long-reply';
  if (
    ['summary', 'plan', 'action_guidance'].includes(String(meta.responseIntent || '').trim())
    && String(meta.lengthBucket || '').trim() !== 'short'
  ) {
    return 'intent-long-reply';
  }
  return '';
}

function toBase64ImageFile(absolutePath) {
  const data = fs.readFileSync(absolutePath);
  return `base64://${data.toString('base64')}`;
}

function toInlineImagePart(absolutePath, mime = '') {
  const data = fs.readFileSync(absolutePath);
  return {
    type: 'input_image',
    media_type: String(mime || memeStore.inferMimeFromExt(absolutePath) || 'image/jpeg').trim() || 'image/jpeg',
    data: data.toString('base64')
  };
}

function buildAssetAnalyzerPrompt() {
  return buildRuntimePrompt('meme-asset-analyzer');
}

function getAssetAnalysisResolvedFields(asset = {}) {
  const analysis = asset?.analysis && typeof asset.analysis === 'object' ? asset.analysis : {};
  const auto = analysis.auto && typeof analysis.auto === 'object'
    ? analysis.auto
    : memeStore.defaultResolvedAssetAnalysis();
  const overrides = analysis.overrides && typeof analysis.overrides === 'object' ? analysis.overrides : {};
  const resolved = { ...auto };
  for (const field of ASSET_ANALYSIS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, field)) continue;
    const value = overrides[field];
    const hasValue = Array.isArray(value) ? value.length > 0 : String(value || '').trim() !== '' || typeof value === 'number';
    if (hasValue) resolved[field] = value;
  }
  return resolved;
}

function resolveAssetAnalysis(asset = {}) {
  return {
    status: String(asset?.analysis?.status || 'pending').trim() || 'pending',
    version: Math.max(1, Number(asset?.analysis?.version) || 1),
    analyzedAt: Math.max(0, Number(asset?.analysis?.analyzedAt) || 0),
    model: String(asset?.analysis?.model || '').trim(),
    lastError: String(asset?.analysis?.lastError || '').trim(),
    resolved: getAssetAnalysisResolvedFields(asset),
    overrides: asset?.analysis?.overrides && typeof asset.analysis.overrides === 'object' ? asset.analysis.overrides : {},
    auto: asset?.analysis?.auto && typeof asset.analysis.auto === 'object' ? asset.analysis.auto : memeStore.defaultResolvedAssetAnalysis()
  };
}

function buildAssetAnalysisRequestContent(asset = {}, absolutePath = '') {
  return [
    { type: 'text', text: 'Analyze this meme asset for follow-up meme selection.' },
    { type: 'text', text: `assetId=${String(asset?.id || '').trim() || 'unknown'}` },
    toInlineImagePart(absolutePath, asset?.mime || '')
  ];
}

async function analyzeMemeAsset({ categoryName = '', assetId = '' } = {}) {
  if (!config.MEME_MANAGER_ASSET_ANALYSIS_ENABLED) {
    throw new Error('asset-analysis-disabled');
  }
  const category = String(categoryName || '').trim();
  const asset = memeStore.getAsset(category, assetId);
  if (!asset) throw new Error('Asset not found.');

  const absolutePath = memeStore.getAssetAbsolutePath(category, assetId);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new Error('Asset file not found.');
  }

  const apiBaseUrl = ensureChatCompletionsUrl(getAssetAnalysisBaseUrl());
  const model = getAssetAnalysisModel();
  if (!apiBaseUrl || !model) {
    throw new Error('asset-analysis-model-missing');
  }

  const response = await httpClient.postWithRetry(
    apiBaseUrl,
    {
      model,
      temperature: 0.1,
      max_tokens: 600,
      stream: false,
      messages: [
        { role: 'system', content: buildAssetAnalyzerPrompt() },
        {
          role: 'user',
          content: buildAssetAnalysisRequestContent(asset, absolutePath)
        }
      ],
      __timeoutMs: Math.max(1000, Number(config.MEME_MANAGER_ASSET_ANALYSIS_TIMEOUT_MS || 20000)),
      __trace: {
        source: 'meme_manager',
        phase: 'asset_analysis',
        purpose: 'meme_asset_analysis',
        routePolicyKey: 'meme/asset-analysis',
        topRouteType: 'vision'
      }
    },
    1,
    getAssetAnalysisApiKey()
  );

  const rawText = extractSelectorResponseText(response);
  const parsed = extractJsonSafely(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid-asset-analysis-json');
  }
  return {
    model,
    parsed: memeStore.normalizeAssetAnalysisPayload(parsed),
    rawText
  };
}

function getReindexTaskKey(categoryName = '', assetId = '') {
  return `${String(categoryName || '').trim()}::${String(assetId || '').trim()}`;
}

function getReindexStatus() {
  return {
    queued: reindexQueue.length,
    running: reindexState.running,
    activeTask: reindexState.activeTask ? { ...reindexState.activeTask } : null,
    processed: reindexState.processed,
    failed: reindexState.failed,
    lastError: reindexState.lastError,
    lastStartedAt: reindexState.lastStartedAt,
    lastFinishedAt: reindexState.lastFinishedAt
  };
}

function enqueueReindexTasks(tasks = []) {
  let enqueued = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const categoryName = String(task?.categoryName || '').trim();
    const assetId = String(task?.assetId || '').trim();
    if (!categoryName || !assetId) continue;
    const key = getReindexTaskKey(categoryName, assetId);
    if (reindexQueueSet.has(key)) continue;
    reindexQueue.push({ categoryName, assetId });
    reindexQueueSet.add(key);
    enqueued += 1;
  }
  void drainReindexQueue();
  return enqueued;
}

async function processReindexTask(task = {}) {
  const categoryName = String(task.categoryName || '').trim();
  const assetId = String(task.assetId || '').trim();
  const now = Date.now();
  try {
    const analysisResult = await analyzeMemeAsset({ categoryName, assetId });
    memeStore.updateAssetAnalysis(categoryName, assetId, {
      status: 'ready',
      version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
      analyzedAt: now,
      model: analysisResult.model,
      lastError: '',
      auto: analysisResult.parsed
    });
    reindexState.processed += 1;
    return { ok: true };
  } catch (error) {
    memeStore.updateAssetAnalysis(categoryName, assetId, {
      status: 'failed',
      version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
      analyzedAt: now,
      model: getAssetAnalysisModel(),
      lastError: error?.message || String(error)
    });
    reindexState.failed += 1;
    reindexState.lastError = error?.message || String(error);
    return { ok: false, error };
  }
}

async function drainReindexQueue() {
  if (reindexState.running) return;
  reindexState.running = true;
  reindexState.lastStartedAt = Date.now();
  try {
    while (reindexQueue.length > 0) {
      const task = reindexQueue.shift();
      const key = getReindexTaskKey(task?.categoryName, task?.assetId);
      reindexQueueSet.delete(key);
      reindexState.activeTask = task ? { ...task } : null;
      await processReindexTask(task);
    }
  } finally {
    reindexState.activeTask = null;
    reindexState.running = false;
    reindexState.lastFinishedAt = Date.now();
  }
}

function buildSelectorPrompt() {
  return buildRuntimePrompt('meme-emotion-selector');
}

function tokenizeOverlapTerms(value = '') {
  const normalized = String(value || '').toLowerCase();
  const matches = normalized.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,}/g) || [];
  return uniqueStrings(matches);
}

function getReplyContextTags({ surface = '', replyMeta = {}, routePolicyKey = '', topRouteType = '' } = {}) {
  const tags = new Set();
  if (replyMeta?.responseIntent === 'summary') tags.add('formal_status');
  if (replyMeta?.responseIntent === 'plan' || replyMeta?.responseIntent === 'action_guidance') tags.add('technical_help');
  if (replyMeta?.isFailureReply) tags.add('failure_recovery');
  if (replyMeta?.isToolLike) tags.add('technical_help');
  if (replyMeta?.hasPraiseCue) tags.add('praise');
  if (replyMeta?.hasConfusedCue) tags.add('confusion_reaction');
  if (replyMeta?.hasComfortCue) tags.add('comfort');
  if (replyMeta?.hasAnnoyedCue) tags.add('annoyance');
  if (replyMeta?.isQuestionReply) tags.add('technical_help');
  if (replyMeta?.lengthBucket === 'short' && ['praise', 'playful', 'confused'].includes(String(routePolicyKey || '').trim())) {
    tags.add('playful_banter');
  }
  if (String(surface || '').trim() === 'direct') tags.add('greeting');
  if (String(topRouteType || '').trim() === 'chat') tags.add('playful_banter');
  return [...tags];
}

function getAssetGlobalUsage(assetId = '') {
  const key = String(assetId || '').trim();
  const state = runtimeStoreCache.assets[key];
  return {
    sentCount: Math.max(0, Number(state?.sentCount) || 0),
    lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0)
  };
}

function scoreAssetKeywordOverlap(resolved = {}, combinedText = '') {
  const terms = new Set(tokenizeOverlapTerms(combinedText));
  if (!terms.size) return { score: 0, hits: [] };
  const candidates = [
    resolved.summary,
    resolved.textContent,
    ...(Array.isArray(resolved.expressionTags) ? resolved.expressionTags : []),
    ...(Array.isArray(resolved.sceneTags) ? resolved.sceneTags : []),
    ...(Array.isArray(resolved.styleTags) ? resolved.styleTags : []),
    ...(Array.isArray(resolved.subjectTags) ? resolved.subjectTags : []),
    ...(Array.isArray(resolved.textTags) ? resolved.textTags : [])
  ];
  const hits = [];
  for (const candidate of candidates) {
    const words = tokenizeOverlapTerms(candidate);
    for (const word of words) {
      if (!terms.has(word) || hits.includes(word)) continue;
      hits.push(word);
      if (hits.length >= 5) break;
    }
    if (hits.length >= 5) break;
  }
  return { score: hits.length, hits };
}

function compareAssetScores(left, right) {
  if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
  if (left.globalSentCount !== right.globalSentCount) return left.globalSentCount - right.globalSentCount;
  if (right.analysisReadyScore !== left.analysisReadyScore) return right.analysisReadyScore - left.analysisReadyScore;
  return String(left.asset?.id || '').localeCompare(String(right.asset?.id || ''));
}

function pickBestAssetForSelection({
  groupId = '',
  selection = {},
  replyText = '',
  userText = '',
  quoteText = '',
  recentTurns = [],
  selectorReason = '',
  replyMeta = {},
  surface = '',
  routePolicyKey = '',
  topRouteType = ''
} = {}) {
  const category = memeStore.getCategory(selection?.selectedCategory || '');
  if (!category || !Array.isArray(category.assets) || category.assets.length === 0) return null;

  const runtime = getFollowupRuntime(groupId);
  const recentAssetIds = Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds : [];
  const recentLatestId = recentAssetIds[recentAssetIds.length - 1] || '';
  const contextTags = getReplyContextTags({ surface, replyMeta, routePolicyKey, topRouteType });
  const combinedText = [
    String(replyText || '').trim(),
    String(userText || '').trim(),
    String(quoteText || '').trim(),
    ...(Array.isArray(recentTurns) ? recentTurns.map((item) => String(item?.text || '').trim()) : []),
    String(selectorReason || '').trim()
  ].filter(Boolean).join('\n');

  const scored = category.assets
    .filter((asset) => asset?.feedback?.blocked !== true)
    .map((asset) => {
      const analysis = resolveAssetAnalysis(asset);
      const resolved = analysis.resolved;
      const globalUsage = getAssetGlobalUsage(asset.id);
      let totalScore = 0;
      let analysisReadyScore = 0;

      if (analysis.status === 'ready') {
        analysisReadyScore = 2;
        totalScore += 2;
      }
      if (resolved.primaryMood === selection.mood) totalScore += 4;
      if (Array.isArray(resolved.secondaryMoods) && resolved.secondaryMoods.includes(selection.mood)) totalScore += 2;

      const intensityDistance = getIntensityDistance(resolved.intensity, selection.intensity);
      if (intensityDistance === 0) totalScore += 2;
      else if (intensityDistance === 1) totalScore += 1;
      else if (Number.isFinite(intensityDistance)) totalScore -= 2;

      const preferredMatches = (Array.isArray(resolved.preferredContexts) ? resolved.preferredContexts : [])
        .filter((item) => contextTags.includes(item))
        .slice(0, 2);
      const avoidMatches = (Array.isArray(resolved.avoidContexts) ? resolved.avoidContexts : [])
        .filter((item) => contextTags.includes(item))
        .slice(0, 2);
      totalScore += preferredMatches.length * 3;
      totalScore -= avoidMatches.length * 4;

      const overlap = scoreAssetKeywordOverlap(resolved, combinedText);
      totalScore += overlap.score;

      const feedback = asset.feedback || {};
      totalScore += Math.max(0, Number(feedback.likes) || 0);
      totalScore -= Math.max(0, Number(feedback.dislikes) || 0) * 2;
      totalScore -= Math.max(0, Number(feedback.skips) || 0);

      const assetId = String(asset.id || '').trim();
      if (assetId && recentLatestId === assetId) totalScore -= 5;
      else if (assetId && recentAssetIds.includes(assetId)) totalScore -= 3;

      return {
        asset: {
          ...asset,
          category: category.name,
          absolutePath: memeStore.getAssetAbsolutePath(category.name, asset.id)
        },
        totalScore,
        analysisReadyScore,
        overlapHits: overlap.hits,
        preferredMatches,
        avoidMatches,
        globalSentCount: globalUsage.sentCount
      };
    });

  scored.sort(compareAssetScores);
  return scored[0] || null;
}

function buildSelectorPayload({
  surface,
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  quoteText,
  recentTurns,
  replyMeta,
  passiveContext,
  categories
}) {
  return JSON.stringify({
    surface,
    routePolicyKey: String(routePolicyKey || '').trim() || 'chat/default',
    topRouteType: String(topRouteType || '').trim() || 'chat',
    userText: String(userText || '').trim(),
    replyText: String(replyText || '').trim(),
    quoteText: String(quoteText || '').trim(),
    recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
    replyMeta: replyMeta && typeof replyMeta === 'object' ? replyMeta : {},
    passiveContext: passiveContext && typeof passiveContext === 'object' ? passiveContext : {},
    categories: categories.map((item) => ({
      name: item.name,
      description: item.description,
      moods: Array.isArray(item.moods) ? item.moods : [],
      intensities: Array.isArray(item.intensities) ? item.intensities : [],
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      assetCount: item.assetCount
    }))
  });
}

async function runSelector({
  surface,
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  quoteText,
  recentTurns,
  replyMeta,
  passiveContext,
  categories
}) {
  const prompt = buildSelectorPrompt();
  const apiBaseUrl = ensureChatCompletionsUrl(getSelectorBaseUrl());
  const model = getSelectorModel();
  const provider = getApiProvider(apiBaseUrl, model);

  const response = await httpClient.postWithRetry(
    apiBaseUrl,
    {
      model,
      temperature: Number(config.MEME_MANAGER_TEMPERATURE || 0.2),
      max_tokens: Math.max(64, Number(config.MEME_MANAGER_MAX_TOKENS || 200)),
      stream: false,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: buildSelectorPayload({
            surface,
            routePolicyKey,
            topRouteType,
            userText,
            replyText,
            quoteText,
            recentTurns,
            replyMeta,
            passiveContext,
            categories
          })
        }
      ],
      __timeoutMs: Math.max(1000, Number(config.MEME_MANAGER_TIMEOUT_MS || 8000)),
      __trace: {
        source: 'meme_manager',
        phase: 'selector',
        purpose: 'meme_emotion_selection',
        routePolicyKey: String(routePolicyKey || '').trim(),
        topRouteType: String(topRouteType || '').trim(),
        userId: ''
      }
    },
    1,
    getSelectorApiKey()
  );

  const rawText = extractSelectorResponseText(response);
  const parsed = normalizeSelectorResult(extractJsonSafely(rawText) || parseLooseSelectorOutput(rawText));
  return { parsed, rawText, provider };
}

async function selectCategory({
  surface,
  groupId = '',
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  quoteText = '',
  recentTurns = [],
  replyMeta = {},
  passiveContext = {}
}) {
  const categories = memeStore.getSelectorCategories();
  const available = categories.filter((item) => item.assetCount > 0 && item.enabled !== false);
  const availableCategoryNames = available.map((item) => item.name);
  if (!available.length) {
    return { skipped: true, reason: 'no-assets', selection: null, availableCategoryNames };
  }
  if (!getSelectorBaseUrl() || !getSelectorModel()) {
    return { skipped: true, reason: 'router-missing', selection: null, availableCategoryNames };
  }

  const { parsed, rawText, provider } = await runSelector({
    surface,
    routePolicyKey,
    topRouteType,
    userText,
    replyText,
    quoteText,
    recentTurns,
    replyMeta,
    passiveContext,
    categories: available
  });

  if (!parsed) {
    console.log('[meme-manager] selector raw response', {
      surface,
      provider,
      rawTextPreview: previewSelectorText(rawText)
    });
    return { skipped: true, reason: 'invalid-json', selection: null, provider, availableCategoryNames };
  }

  const minConfidence = Number(config.MEME_MANAGER_MIN_CONFIDENCE || 0.45);
  if (!parsed.send) {
    return {
      skipped: true,
      reason: parsed.reason || 'none-selected',
      provider,
      availableCategoryNames,
      selection: {
        send: false,
        mood: 'none',
        intensity: parsed.intensity,
        confidence: parsed.confidence,
        reason: parsed.reason,
        selectedCategory: '',
        decisionSource: 'llm-structured',
        keywordHits: []
      }
    };
  }

  if (!Number.isFinite(parsed.confidence) || parsed.confidence < minConfidence) {
    return {
      skipped: true,
      reason: 'below-threshold',
      provider,
      availableCategoryNames,
      selection: {
        send: true,
        mood: parsed.mood,
        intensity: parsed.intensity,
        confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0,
        reason: parsed.reason,
        selectedCategory: '',
        decisionSource: 'llm-structured',
        keywordHits: []
      }
    };
  }

  const selectorContext = {
    userText,
    replyText,
    quoteText,
    recentTurns,
    replyMeta,
    passiveContext,
    recentCategoryNames: buildRuntimeSummary(groupId).recentCategoryNames
  };
  const ranked = chooseCategoryBySelector(available, parsed, selectorContext);
  if (ranked.selectedCategory) {
    return {
      skipped: false,
      reason: parsed.reason,
      provider,
      availableCategoryNames,
      selection: {
        send: true,
        mood: parsed.mood,
        intensity: parsed.intensity,
        confidence: parsed.confidence,
        reason: parsed.reason,
        selectedCategory: ranked.selectedCategory,
        decisionSource: 'llm-structured',
        keywordHits: ranked.keywordHits
      }
    };
  }

  const localFallback = inferCategoryByLocalHeuristics(available, selectorContext);
  if (localFallback) {
    return {
      skipped: false,
      reason: localFallback.reason,
      provider,
      availableCategoryNames,
      selection: localFallback
    };
  }

  return {
    skipped: true,
    reason: 'no-category-match',
    provider,
    availableCategoryNames,
    selection: {
      send: true,
      mood: parsed.mood,
      intensity: parsed.intensity,
      confidence: parsed.confidence,
      reason: parsed.reason,
      selectedCategory: '',
      decisionSource: 'llm-structured',
      keywordHits: []
    }
  };
}

async function runMemeTest({
  surface = 'direct',
  groupId = '',
  routePolicyKey = 'chat/default',
  topRouteType = 'chat',
  userText = '',
  replyText = '',
  quoteText = '',
  recentTurns = [],
  replyMeta = null,
  passiveContext = {}
}) {
  const normalizedReplyMeta = replyMeta && typeof replyMeta === 'object'
    ? { ...buildReplyMeta({ replyText, routeMeta: { responseIntent: replyMeta.responseIntent } }), ...replyMeta }
    : buildReplyMeta({ replyText, routeMeta: {} });
  const selectionResult = await selectCategory({
    surface,
    groupId,
    routePolicyKey,
    topRouteType,
    userText,
    replyText,
    quoteText,
    recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
    replyMeta: normalizedReplyMeta,
    passiveContext: passiveContext && typeof passiveContext === 'object' ? passiveContext : {}
  });

  const selection = selectionResult.selection || {};
  const gatePreview = selectionResult.skipped || !selection.selectedCategory
    ? {
        allowed: false,
        reason: selectionResult.reason || 'selector-skipped',
        probability: 0,
        cooldownRemainingMs: 0
      }
    : evaluateMemeGate({
        surface,
        groupId,
        selection,
        replyMeta: normalizedReplyMeta,
        now: Date.now(),
        randomValue: 0
      });
  const assetPreview = selectionResult.skipped || !selection.selectedCategory
    ? null
    : pickBestAssetForSelection({
        groupId,
        selection,
        replyText,
        userText,
        quoteText,
        recentTurns,
        selectorReason: selection.reason,
        replyMeta: normalizedReplyMeta,
        surface,
        routePolicyKey,
        topRouteType
      });
  return {
    send: !selectionResult.skipped && selection.send === true && Boolean(selection.selectedCategory),
    mood: String(selection.mood || 'none'),
    intensity: String(selection.intensity || 'low'),
    confidence: Number(selection.confidence || 0),
    selectedCategory: String(selection.selectedCategory || ''),
    decisionSource: String(selection.decisionSource || 'llm-structured'),
    reason: String(selection.reason || selectionResult.reason || ''),
    availableCategoryNames: Array.isArray(selectionResult.availableCategoryNames) ? selectionResult.availableCategoryNames : [],
    keywordHits: Array.isArray(selection.keywordHits) ? selection.keywordHits : [],
    selectedAssetId: assetPreview?.asset?.id || '',
    assetScore: Number(assetPreview?.totalScore || 0),
    contextUsed: buildContextSourceFlags({
      quoteText,
      recentTurns,
      replyMeta: normalizedReplyMeta,
      passiveContext,
      surface
    }),
    gatePreview
  };
}

async function handleAdminCommand({ rawText, groupId, userId }) {
  const command = parseMemeCommand(rawText);
  if (!command) return null;

  if (!isAdmin(userId)) {
    return { handled: true, replyText: '仅管理员可用。' };
  }

  try {
    if (command.action === 'help') return { handled: true, replyText: buildHelpText() };
    if (command.action === 'status') {
      const store = memeStore.getStore();
      const session = getUploadSession(groupId, userId);
      const categories = memeStore.listCategories();
      const runtime = buildRuntimeSummary(groupId);
      const reindexStatus = getReindexStatus();
      const surfaceFlags = [
        `direct=${store.surfaces.direct !== false}`,
        `passive=${store.surfaces.passive !== false}`,
        `scheduled=${store.surfaces.scheduled !== false}`
      ].join(', ');
      return {
        handled: true,
        replyText: [
          `meme manager: ${store.enabled && config.MEME_MANAGER_ENABLED ? 'on' : 'off'}`,
          `surfaces: ${surfaceFlags}`,
          `categories: ${categories.length}`,
          session ? `uploading: ${session.categoryName} (${Math.max(0, session.expiresAt - Date.now())}ms left)` : 'uploading: none',
          `cooldownRemainingMs: ${runtime.cooldownRemainingMs}`,
          `recentAssetIds: ${runtime.recentAssetIds.join(', ') || '(empty)'}`,
          `recentCategoryNames: ${runtime.recentCategoryNames.join(', ') || '(empty)'}`,
          `lastMood: ${runtime.lastMood || '(empty)'}`,
          `reindex: running=${reindexStatus.running}, queued=${reindexStatus.queued}, processed=${reindexStatus.processed}, failed=${reindexStatus.failed}`
        ].join('\n')
      };
    }
    if (command.action === 'on') {
      memeStore.setEnabled(true);
      return { handled: true, replyText: 'meme manager 已开启。' };
    }
    if (command.action === 'off') {
      memeStore.setEnabled(false);
      return { handled: true, replyText: 'meme manager 已关闭。' };
    }
    if (command.action === 'categories') return { handled: true, replyText: listCategorySummaryLines().join('\n') };
    if (command.action === 'category-add') {
      memeStore.addCategory(command.categoryName, command.description);
      return { handled: true, replyText: `已创建分类：${command.categoryName}` };
    }
    if (command.action === 'category-desc') {
      memeStore.updateCategoryDescription(command.categoryName, command.description);
      return { handled: true, replyText: `已更新分类描述：${command.categoryName}` };
    }
    if (command.action === 'category-show') return { handled: true, replyText: formatCategoryDetails(command.categoryName) };
    if (command.action === 'category-moods') {
      const moods = parseCsvAliases(command.csv, (item) => normalizeMoodAlias(item));
      memeStore.updateCategoryMoods(command.categoryName, moods);
      return { handled: true, replyText: `已更新 moods：${command.categoryName} -> ${moods.join(', ')}` };
    }
    if (command.action === 'category-intensity') {
      const intensities = parseCsvAliases(command.csv, normalizeIntensityAlias);
      memeStore.updateCategoryIntensities(command.categoryName, intensities);
      return { handled: true, replyText: `已更新 intensities：${command.categoryName} -> ${intensities.join(', ') || '(all)'}` };
    }
    if (command.action === 'category-keywords') {
      const keywords = uniqueStrings(
        String(command.csv || '')
          .split(',')
          .flatMap((item) => String(item || '').split('，'))
          .map((item) => item.trim())
          .filter(Boolean)
      );
      memeStore.updateCategoryKeywords(command.categoryName, keywords);
      return { handled: true, replyText: `已更新 keywords：${command.categoryName} -> ${keywords.join(', ') || '(empty)'}` };
    }
    if (command.action === 'category-remove') {
      memeStore.removeCategory(command.categoryName);
      return { handled: true, replyText: `已删除空分类：${command.categoryName}` };
    }
    if (command.action === 'test') {
      const result = command.payload && typeof command.payload === 'object'
        ? await runMemeTest({
            surface: command.payload.surface || 'direct',
            routePolicyKey: command.payload.routePolicyKey || 'chat/default',
            topRouteType: command.payload.topRouteType || 'chat',
            userText: String(command.payload.userText || '').trim(),
            replyText: String(command.payload.replyText || '').trim(),
            quoteText: String(command.payload.quoteText || '').trim(),
            recentTurns: Array.isArray(command.payload.recentTurns) ? command.payload.recentTurns : [],
            replyMeta: command.payload.replyMeta && typeof command.payload.replyMeta === 'object' ? command.payload.replyMeta : null,
            passiveContext: command.payload.passiveContext && typeof command.payload.passiveContext === 'object' ? command.payload.passiveContext : {}
          })
        : await runMemeTest({ replyText: command.replyText });
      return {
        handled: true,
        replyText: [
          `send: ${result.send}`,
          `mood: ${result.mood}`,
          `intensity: ${result.intensity}`,
          `confidence: ${result.confidence}`,
          `selectedCategory: ${result.selectedCategory || '(none)'}`,
          `selectedAssetId: ${result.selectedAssetId || '(none)'}`,
          `decisionSource: ${result.decisionSource}`,
          `reason: ${result.reason || '(empty)'}`,
          `contextUsed: ${JSON.stringify(result.contextUsed || {})}`,
          `gatePreview: ${JSON.stringify(result.gatePreview || {})}`
        ].join('\n')
      };
    }
    if (command.action === 'add-session') {
      if (!command.categoryName) return { handled: true, replyText: '请提供分类名。' };
      const category = memeStore.getCategory(command.categoryName);
      if (!category) return { handled: true, replyText: '分类不存在。' };
      const session = startUploadSession({ groupId, userId, categoryName: command.categoryName });
      return {
        handled: true,
        replyText: `已开启上传窗口：${session.categoryName}\n60 秒内直接发送图片即可导入，完成后发 /meme done。`
      };
    }
    if (command.action === 'done') {
      const session = getUploadSession(groupId, userId);
      if (!session) return { handled: true, replyText: '当前没有进行中的上传窗口。' };
      endUploadSession(groupId, userId);
      return { handled: true, replyText: `已结束上传窗口：${session.categoryName}` };
    }
    if (command.action === 'cancel') {
      const session = getUploadSession(groupId, userId);
      if (!session) return { handled: true, replyText: '当前没有进行中的上传窗口。' };
      endUploadSession(groupId, userId);
      return { handled: true, replyText: `已取消上传窗口：${session.categoryName}` };
    }
    if (command.action === 'files') {
      if (!command.categoryName) return { handled: true, replyText: '请提供分类名。' };
      return { handled: true, replyText: formatFilesList(command.categoryName) };
    }
    if (command.action === 'delete-file') {
      if (!command.categoryName || !command.assetId) {
        return { handled: true, replyText: '请提供分类名和 assetId。' };
      }
      memeStore.deleteAsset(command.categoryName, command.assetId);
      return { handled: true, replyText: `已删除：${command.assetId}` };
    }
    if (command.action === 'asset-show') {
      return { handled: true, replyText: formatAssetDetails(command.categoryName, command.assetId) };
    }
    if (command.action === 'asset-patch') {
      const payload = JSON.parse(String(command.payloadText || '').trim() || '{}');
      memeStore.patchAssetOverrides(command.categoryName, command.assetId, payload);
      return { handled: true, replyText: formatAssetDetails(command.categoryName, command.assetId) };
    }
    if (command.action === 'asset-relabel') {
      enqueueReindexTasks([{ categoryName: command.categoryName, assetId: command.assetId }]);
      return { handled: true, replyText: `queued relabel: ${command.categoryName}/${command.assetId}` };
    }
    if (command.action === 'asset-feedback') {
      memeStore.applyAssetFeedback(command.categoryName, command.assetId, command.feedbackAction);
      return { handled: true, replyText: formatAssetDetails(command.categoryName, command.assetId) };
    }
    if (command.action === 'reindex-pending') {
      const tasks = memeStore.listAssetsNeedingAnalysis().map((item) => ({
        categoryName: item.categoryName,
        assetId: item.asset.id
      }));
      return { handled: true, replyText: `queued pending assets: ${enqueueReindexTasks(tasks)}` };
    }
    if (command.action === 'reindex-category') {
      const tasks = memeStore.listAssetsNeedingAnalysis({ categoryName: command.categoryName }).map((item) => ({
        categoryName: item.categoryName,
        assetId: item.asset.id
      }));
      return { handled: true, replyText: `queued category assets: ${enqueueReindexTasks(tasks)}` };
    }
    if (command.action === 'reindex-all') {
      const tasks = memeStore.listAllAssets().map((item) => ({
        categoryName: item.categoryName,
        assetId: item.asset.id
      }));
      return { handled: true, replyText: `queued all assets: ${enqueueReindexTasks(tasks)}` };
    }
    if (command.action === 'reindex-status') {
      return { handled: true, replyText: JSON.stringify(getReindexStatus()) };
    }
    return { handled: true, replyText: '未知 meme 管理命令，输入 /meme help 查看。' };
  } catch (error) {
    return { handled: true, replyText: `操作失败: ${error?.message || String(error)}` };
  }
}

async function maybeSendMemeFollowup({
  surface,
  groupId,
  senderId,
  sendWithRetry,
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  rawMessage = '',
  routeMeta = null,
  replyToMessageId = '',
  recentMessagesOverride = null,
  passiveDecisionMeta = null
}) {
  try {
    if (!isSurfaceEnabled(surface)) {
      console.log('[meme-manager] selector skipped', { surface, reason: 'surface-disabled' });
      return { sent: false, reason: 'surface-disabled' };
    }

    const replyMeta = buildReplyMeta({ replyText, routeMeta });
    const skipReason = getHardSkipReason(replyText, replyMeta);
    if (skipReason) {
      console.log('[meme-manager] selector skipped', { surface, reason: skipReason });
      return { sent: false, reason: skipReason };
    }

    const recentTurns = surface === 'scheduled'
      ? []
      : buildRecentTurns({ groupId, recentMessagesOverride, userText });
    const recentMessages = Array.isArray(recentMessagesOverride)
      ? recentMessagesOverride
      : (groupId ? getRecentMessages(groupId) : []);
    const quoteText = buildQuoteText({
      rawMessage,
      replyToMessageId,
      recentMessages
    });
    const passiveContext = buildPassiveContext(surface, passiveDecisionMeta);
    const contextSourceFlags = buildContextSourceFlags({
      quoteText,
      recentTurns,
      replyMeta,
      passiveContext,
      surface
    });

    const selectionResult = await selectCategory({
      surface,
      groupId,
      routePolicyKey,
      topRouteType,
      userText,
      replyText,
      quoteText,
      recentTurns,
      replyMeta,
      passiveContext
    });

    const selection = selectionResult.selection || null;
    if (selectionResult.skipped || !selection || !selection.selectedCategory) {
      console.log('[meme-manager] selector skipped', {
        surface,
        reason: selectionResult.reason,
        availableCategoryNames: selectionResult.availableCategoryNames || [],
        mood: selection?.mood || 'none',
        intensity: selection?.intensity || 'low',
        confidence: Number(selection?.confidence || 0),
        selectedCategory: selection?.selectedCategory || '',
        decisionSource: selection?.decisionSource || 'llm-structured',
        keywordHits: Array.isArray(selection?.keywordHits) ? selection.keywordHits : [],
        quoteTextPreview: previewSelectorText(quoteText),
        recentTurnCount: recentTurns.length,
        replyMeta,
        passiveContext,
        contextSourceFlags
      });
      return { sent: false, reason: selectionResult.reason || 'selector-skipped' };
    }

    const gate = evaluateMemeGate({
      surface,
      groupId,
      selection,
      replyMeta,
      now: Date.now()
    });
    if (!gate.allowed) {
      console.log('[meme-manager] selector skipped', {
        surface,
        reason: gate.reason,
        availableCategoryNames: selectionResult.availableCategoryNames || [],
        mood: selection.mood,
        intensity: selection.intensity,
        confidence: selection.confidence,
        selectedCategory: selection.selectedCategory,
        decisionSource: selection.decisionSource,
        keywordHits: selection.keywordHits,
        probability: gate.probability,
        cooldownRemainingMs: gate.cooldownRemainingMs,
        quoteTextPreview: previewSelectorText(quoteText),
        recentTurnCount: recentTurns.length,
        replyMeta,
        passiveContext,
        contextSourceFlags
      });
      return { sent: false, reason: gate.reason };
    }

    const assetDecision = pickBestAssetForSelection({
      groupId,
      selection,
      replyText,
      userText,
      quoteText,
      recentTurns,
      selectorReason: selection.reason,
      replyMeta,
      surface,
      routePolicyKey,
      topRouteType
    });
    const asset = assetDecision?.asset || null;
    if (!asset || !asset.absolutePath) {
      console.log('[meme-manager] selector skipped', {
        surface,
        reason: 'no-asset-for-category',
        availableCategoryNames: selectionResult.availableCategoryNames || [],
        mood: selection.mood,
        intensity: selection.intensity,
        confidence: selection.confidence,
        selectedCategory: selection.selectedCategory,
        decisionSource: selection.decisionSource,
        keywordHits: selection.keywordHits,
        assetScore: assetDecision?.totalScore || 0,
        quoteTextPreview: previewSelectorText(quoteText),
        recentTurnCount: recentTurns.length,
        replyMeta,
        passiveContext,
        contextSourceFlags
      });
      return { sent: false, reason: 'no-asset-for-category' };
    }

    console.log('[meme-manager] selector selected', {
      surface,
      availableCategoryNames: selectionResult.availableCategoryNames || [],
      mood: selection.mood,
      intensity: selection.intensity,
      confidence: selection.confidence,
      selectedCategory: selection.selectedCategory,
      decisionSource: selection.decisionSource,
      keywordHits: selection.keywordHits,
      assetId: asset.id,
      assetScore: assetDecision?.totalScore || 0,
      probability: gate.probability,
      quoteTextPreview: previewSelectorText(quoteText),
      recentTurnCount: recentTurns.length,
      replyMeta,
      passiveContext,
      contextSourceFlags
    });

    const ok = await sendWithRetry({
      action: 'send_group_msg',
      params: {
        group_id: groupId,
        message: [{ type: 'image', data: { file: toBase64ImageFile(asset.absolutePath) } }]
      }
    }, 1, 300);

    console.log(`[meme-manager] followup send ${ok ? 'ok' : 'failed'}`, {
      surface,
      groupId,
      senderId,
      availableCategoryNames: selectionResult.availableCategoryNames || [],
      mood: selection.mood,
      intensity: selection.intensity,
      confidence: selection.confidence,
      selectedCategory: selection.selectedCategory,
      decisionSource: selection.decisionSource,
      keywordHits: selection.keywordHits,
      assetScore: assetDecision?.totalScore || 0,
      probability: gate.probability,
      quoteTextPreview: previewSelectorText(quoteText),
      recentTurnCount: recentTurns.length,
      replyMeta,
      passiveContext,
      contextSourceFlags,
      assetId: asset.id
    });
    if (ok) {
      updateFollowupRuntime(groupId, selection, asset, Date.now());
    }
    return { sent: ok, reason: ok ? 'ok' : 'send-failed' };
  } catch (error) {
    console.log('[meme-manager] selector skipped', {
      surface,
      reason: error?.message || String(error)
    });
    return { sent: false, reason: error?.message || String(error) };
  }
}

function initializeMemeManager() {
  const current = memeStore.initializeStore();
  followupRuntime.clear();
  loadRuntimeStore();
  if (config.MEME_MANAGER_REINDEX_ON_STARTUP) {
    const tasks = memeStore.listAssetsNeedingAnalysis().map((item) => ({
      categoryName: item.categoryName,
      assetId: item.asset.id
    }));
    enqueueReindexTasks(tasks);
  }
  console.log('[meme-manager] initialized', {
    enabled: current.enabled,
    categoryCount: Object.keys(current.categories || {}).length,
    reindexQueued: reindexQueue.length
  });
  return current;
}

module.exports = {
  analyzeMemeAsset,
  cleanupExpiredSessions,
  consumePendingUploadFromMessage,
  drainReindexQueue,
  getReindexStatus,
  handleAdminCommand,
  initializeMemeManager,
  isSurfaceEnabled,
  maybeSendMemeFollowup,
  parseMemeCommand,
  pickBestAssetForSelection,
  resolveAssetAnalysis,
  runMemeTest,
  selectCategory,
  startUploadSession,
  evaluateMemeGate
};
