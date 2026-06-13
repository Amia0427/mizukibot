const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_PATH = path.join(__dirname, '..', 'data', 'gemini-recent-style-signals.json');
const MAX_RECORDS = 120;
const DEFAULT_LOOKBACK_RECORDS = 18;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const OPENING_PATTERNS = [
  { value: '诶——', pattern: /^\s*诶[—\-~～…]+/u },
  { value: '欸——', pattern: /^\s*欸[—\-~～…]+/u },
  { value: '呜哇', pattern: /^\s*呜哇[，,、!！。.]?/u },
  { value: '哈——', pattern: /^\s*哈[—\-~～…]+/u },
  { value: '唔', pattern: /^\s*唔[，,、~～…]*/u },
  { value: '嗯哼', pattern: /^\s*嗯哼[，,、~～…]*/u },
  { value: '哎呀', pattern: /^\s*哎呀[，,、~～…]*/u },
  { value: '你这', pattern: /^\s*你这(?:个|样|话|也)?/u }
];

const STOCK_PHRASES = [
  { value: '特殊奖励', pattern: /特殊奖励/u },
  { value: '秘密小彩蛋', pattern: /秘密小彩蛋/u },
  { value: '小彩蛋', pattern: /小彩蛋/u },
  { value: '犯规', pattern: /犯规/u },
  { value: '安全距离', pattern: /安全距离/u },
  { value: '给你太多甜头', pattern: /给你太多甜头/u },
  { value: '上瘾到停不下来', pattern: /上瘾到停不下来/u },
  { value: '胆子也太大', pattern: /胆子也太大/u },
  { value: '查户口', pattern: /查户口/u },
  { value: '找个台阶下', pattern: /找个台阶下/u },
  { value: '逻辑大崩坏', pattern: /逻辑大崩坏/u },
  { value: '我懂你的意思', pattern: /我懂你的意思/u },
  { value: '认真放在心上', pattern: /认真放在心上/u },
  { value: '被接住', pattern: /被接住/u },
  { value: '慢慢说给我听', pattern: /慢慢说给我听/u }
];

function normalizeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueValues(values = [], maxItems = 8) {
  const seen = new Set();
  const result = [];
  for (const value of normalizeArray(values)) {
    const text = normalizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function isGeminiModelName(modelName = '') {
  return normalizeText(modelName).toLowerCase().includes('gemini');
}

function getRuntimeConfig(runtimeConfig = null) {
  if (runtimeConfig && typeof runtimeConfig === 'object') return runtimeConfig;
  try {
    return require('../config');
  } catch (_) {
    return {};
  }
}

function resolveChatType(options = {}) {
  const routeMeta = normalizeObject(options.routeMeta, {});
  return normalizeText(
    options.chatType
    || options.chat_type
    || routeMeta.chatType
    || routeMeta.chat_type
  ).toLowerCase();
}

function isAdminLikeRequest(options = {}) {
  const routeMeta = normalizeObject(options.routeMeta, {});
  if (
    options.isAdmin === true
    || options.admin === true
    || options.adminPromptContext === true
    || routeMeta.isAdmin === true
    || routeMeta.admin === true
    || normalizeText(options.userRole).toLowerCase() === 'admin'
  ) {
    return true;
  }

  const userId = normalizeText(
    options.userId
    || options.user_id
    || routeMeta.userId
    || routeMeta.user_id
    || routeMeta.senderId
    || routeMeta.sender_id
  );
  if (!userId) return false;

  const adminIds = normalizeArray(getRuntimeConfig(options.config).ADMIN_USER_IDS)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (!adminIds.includes(userId)) return false;

  const chatType = resolveChatType(options);
  return chatType === 'private' || chatType === 'direct';
}

function isGeminiRecentStyleGuardEligible(options = {}) {
  const modelName = normalizeText(options.modelName || options.model_name || options.model);
  if (!isGeminiModelName(modelName)) return false;
  if (isAdminLikeRequest(options)) return false;
  if (normalizeText(options.reviewMode || options.review_mode).toLowerCase()) return false;
  if (options.systemInitiated === true || options.system_initiated === true) return false;
  return true;
}

function extractGeminiRecentStyleSignal(text = '', options = {}) {
  const reply = normalizeText(text || options.assistantText || options.finalReply || options.reply);
  if (!reply) return null;
  const compact = reply.replace(/\s+/g, ' ').trim();
  const openingAnchors = [];
  const tailParticles = [];
  const stockPhrases = [];

  for (const item of OPENING_PATTERNS) {
    if (item.pattern.test(compact)) openingAnchors.push(item.value);
  }
  for (const item of STOCK_PHRASES) {
    if (item.pattern.test(compact)) stockPhrases.push(item.value);
  }

  const tailText = compact.replace(/[”」』）)\]】]+$/u, '').trim();
  const tailMatch = tailText.match(/([呢喔哦嘛啦吧呀呐哟噢欸啊])(?:[。.!！?？~～…]*)$/u);
  if (tailMatch) tailParticles.push(tailMatch[1]);
  if (/♪\s*$/u.test(compact)) tailParticles.push('♪');

  const signal = {
    openingAnchors: uniqueValues(openingAnchors, 4),
    tailParticles: uniqueValues(tailParticles, 4),
    stockPhrases: uniqueValues(stockPhrases, 8)
  };
  if (
    signal.openingAnchors.length === 0
    && signal.tailParticles.length === 0
    && signal.stockPhrases.length === 0
  ) {
    return null;
  }
  return signal;
}

function resolveStorePath(options = {}) {
  return normalizeText(options.storePath || process.env.GEMINI_RECENT_STYLE_STORE_PATH, DEFAULT_STORE_PATH);
}

function readStore(options = {}) {
  if (options.store && typeof options.store === 'object') {
    return {
      records: normalizeArray(options.store.records)
    };
  }
  const storePath = resolveStorePath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return {
      records: normalizeArray(parsed.records)
    };
  } catch (_) {
    return { records: [] };
  }
}

function writeStore(store = {}, options = {}) {
  const safeStore = {
    schemaVersion: 1,
    records: normalizeArray(store.records)
  };
  if (options.store && typeof options.store === 'object') {
    options.store.schemaVersion = safeStore.schemaVersion;
    options.store.records = safeStore.records;
    return;
  }
  const storePath = resolveStorePath(options);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(safeStore, null, 2)}\n`, 'utf8');
}

function normalizeTimestampMs(value = null) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function resolveScopeKey(options = {}) {
  const routeMeta = normalizeObject(options.routeMeta, {});
  const groupId = normalizeText(options.groupId || options.group_id || routeMeta.groupId || routeMeta.group_id);
  if (groupId) return `group:${groupId}`;
  const sessionKey = normalizeText(options.sessionKey || options.session_key || routeMeta.sessionKey || routeMeta.session_key);
  if (sessionKey) return `session:${sessionKey}`;
  const userId = normalizeText(options.userId || options.user_id || routeMeta.userId || routeMeta.user_id || routeMeta.senderId || routeMeta.sender_id);
  if (userId) return `user:${userId}`;
  const routePolicyKey = normalizeText(options.routePolicyKey || options.route_policy_key || routeMeta.routePolicyKey || routeMeta.route_policy_key);
  return routePolicyKey ? `route:${routePolicyKey}` : 'global';
}

function pruneRecords(records = [], nowMs = Date.now(), options = {}) {
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS) || DEFAULT_MAX_AGE_MS);
  return normalizeArray(records)
    .filter((record) => record && typeof record === 'object')
    .filter((record) => {
      const createdAtMs = normalizeTimestampMs(record.createdAt);
      return !maxAgeMs || (nowMs - createdAtMs) <= maxAgeMs;
    })
    .slice(-Math.max(1, Number(options.maxRecords || MAX_RECORDS) || MAX_RECORDS));
}

function recordGeminiRecentStyleSignal(options = {}) {
  if (!isGeminiRecentStyleGuardEligible(options)) {
    return { recorded: false, reason: 'not_eligible' };
  }
  const signal = extractGeminiRecentStyleSignal(options.assistantText || options.finalReply || options.reply || '');
  if (!signal) return { recorded: false, reason: 'no_signal' };

  const nowMs = normalizeTimestampMs(options.now);
  const record = {
    createdAt: new Date(nowMs).toISOString(),
    modelName: normalizeText(options.modelName || options.model_name || options.model).slice(0, 80),
    scopeKey: resolveScopeKey(options),
    routePolicyKey: normalizeText(options.routePolicyKey || options.route_policy_key || options.routeMeta?.routePolicyKey || options.routeMeta?.route_policy_key).slice(0, 80),
    topRouteType: normalizeText(options.topRouteType || options.top_route_type || options.routeMeta?.topRouteType || options.routeMeta?.top_route_type).slice(0, 80),
    openings: signal.openingAnchors,
    tails: signal.tailParticles,
    stockPhrases: signal.stockPhrases
  };

  try {
    const store = readStore(options);
    store.records = pruneRecords(normalizeArray(store.records).concat([record]), nowMs, options);
    writeStore(store, options);
    return {
      recorded: true,
      record,
      signal
    };
  } catch (error) {
    return {
      recorded: false,
      reason: 'write_failed',
      error: normalizeText(error?.message || error).slice(0, 200)
    };
  }
}

function collectRecentRecords(options = {}) {
  const store = readStore(options);
  const nowMs = normalizeTimestampMs(options.now);
  const lookbackRecords = Math.max(1, Number(options.lookbackRecords || DEFAULT_LOOKBACK_RECORDS) || DEFAULT_LOOKBACK_RECORDS);
  const scopeKey = resolveScopeKey(options);
  const recent = pruneRecords(store.records, nowMs, options).slice().reverse();
  const sameScope = recent.filter((record) => normalizeText(record.scopeKey) === scopeKey);
  const scopedFirst = sameScope.concat(recent.filter((record) => normalizeText(record.scopeKey) !== scopeKey));
  return scopedFirst.slice(0, lookbackRecords);
}

function rankSignals(records = [], field = '', maxItems = 4) {
  const counts = new Map();
  normalizeArray(records).forEach((record, recordIndex) => {
    for (const value of uniqueValues(record?.[field], 8)) {
      const current = counts.get(value) || { value, count: 0, firstSeen: recordIndex };
      current.count += 1;
      current.firstSeen = Math.min(current.firstSeen, recordIndex);
      counts.set(value, current);
    }
  });
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen || a.value.localeCompare(b.value))
    .slice(0, Math.max(1, Number(maxItems || 4) || 4));
}

function formatRankedSignals(items = []) {
  return normalizeArray(items)
    .map((item) => `${item.value}${item.count > 1 ? `x${item.count}` : ''}`)
    .join('、');
}

function buildGeminiRecentStyleGuardPrompt(options = {}) {
  if (!isGeminiRecentStyleGuardEligible(options)) return '';

  let records = [];
  try {
    records = collectRecentRecords(options);
  } catch (_) {
    records = [];
  }
  if (records.length === 0) return '';

  const openings = rankSignals(records, 'openings', 4);
  const tails = rankSignals(records, 'tails', 5);
  const stockPhrases = rankSignals(records, 'stockPhrases', 6);
  if (openings.length === 0 && tails.length === 0 && stockPhrases.length === 0) return '';

  const lines = [
    '[GeminiRecentStyleGuard]',
    '最近 Gemini 回复已经出现这些口吻锚点，本轮避开重复：'
  ];
  if (openings.length > 0) lines.push(`起手：${formatRankedSignals(openings)}`);
  if (tails.length > 0) lines.push(`句尾/尾音：${formatRankedSignals(tails)}`);
  if (stockPhrases.length > 0) lines.push(`固定短语：${formatRankedSignals(stockPhrases)}`);
  lines.push('做法：直接换一种贴合当前消息的自然短句；不要解释这条规则；不要为了规避而把回复写长。');
  return lines.join('\n');
}

module.exports = {
  buildGeminiRecentStyleGuardPrompt,
  extractGeminiRecentStyleSignal,
  isAdminLikeRequest,
  isGeminiModelName,
  isGeminiRecentStyleGuardEligible,
  recordGeminiRecentStyleSignal,
  resolveScopeKey
};
