const config = require('../../config');
const { getAccessibleGroupIdsForUser } = require('../memoryScopeIndex');
const { classifyRecallFacet } = require('../recallHeuristics');
const { resolveJournalTargetDays } = require('../memory-v3/journalDocs');
const { formatJournalPromptItem } = require('../memory-v3/journalRecallPolicy');
const { sanitizeText } = require('./formatters');

function buildRouteMemoryFilter(options = {}) {
  return {
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType
  };
}

function resolveReadableGroupIds(userId = '', options = {}) {
  const explicitGroupIds = Array.isArray(options.groupIds)
    ? options.groupIds
    : [];
  const readableGroupIds = explicitGroupIds.length > 0
    ? explicitGroupIds
    : getAccessibleGroupIdsForUser(userId);
  const currentGroupId = sanitizeText(options.groupId);
  const deduped = [];
  const seen = new Set();

  for (const raw of [...readableGroupIds, currentGroupId]) {
    const groupId = sanitizeText(raw);
    if (!groupId || seen.has(groupId)) continue;
    seen.add(groupId);
    deduped.push(groupId);
  }

  deduped.sort();
  return deduped;
}

function buildUnifiedRecallOptions(options = {}) {
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(options.userId, options);
  return {
    ...buildRouteMemoryFilter(options),
    queryFacet: options.queryFacet || classifyRecallFacet(options.question || ''),
    taskType: options.taskType,
    agentName: options.agentName,
    toolName: options.toolName,
    sessionId: options.sessionId,
    channelId: options.channelId,
    participants: Array.isArray(options.participants) ? options.participants : [],
    groupId: options.groupId,
    groupIds: resolvedGroupIds,
    includeTask: true,
    includeGroup: resolvedGroupIds.length > 0,
    includeSignals: true,
    includeEpisodes: true
  };
}

function getRequestMemo(options = {}) {
  if (!options || typeof options !== 'object') return new Map();
  if (!(options.__memoryContextMemo instanceof Map)) {
    options.__memoryContextMemo = new Map();
  }
  return options.__memoryContextMemo;
}

function buildMemoKey(prefix, userId, question = '', options = {}) {
  const resolvedGroupIds = Array.isArray(options.resolvedGroupIds)
    ? options.resolvedGroupIds.map((item) => sanitizeText(item)).filter(Boolean)
    : resolveReadableGroupIds(userId, options);
  const kindMask = [
    options.includeTask !== false ? 'task' : '',
    options.includeGroup !== false && options.groupId ? `group:${options.groupId}` : '',
    options.includeGroup !== false && resolvedGroupIds.length > 0 ? `groups:${resolvedGroupIds.join(',')}` : '',
    options.includeSignals !== false ? 'signals' : '',
    options.includeEpisodes !== false ? 'episodes' : '',
    options.memoryKind || '',
    Array.isArray(options.memoryKinds) ? options.memoryKinds.join(',') : '',
    sanitizeText(options.sessionId) ? `session:${sanitizeText(options.sessionId)}` : '',
    sanitizeText(options.channelId) ? `channel:${sanitizeText(options.channelId)}` : '',
    sanitizeText(options.sharedShortTermSignature) ? `shared:${sanitizeText(options.sharedShortTermSignature)}` : ''
  ].filter(Boolean).join('|') || 'default';
  const lookback = String(options.dailyLookbackDays || options.lookbackDays || config.DAILY_JOURNAL_LOOKBACK_DAYS || '');
  const journalTarget = sanitizeText(options.dailyJournalTimestamp || options.dailyJournalYearMonth || '');
  const rawMode = options.includeActiveRaw ? 'active_raw' : '';
  return [
    prefix,
    sanitizeText(userId),
    sanitizeText(options.groupId),
    sanitizeText(options.taskType),
    sanitizeText(question),
    kindMask,
    lookback,
    journalTarget,
    rawMode
  ].join('|');
}

function memoizeValue(options, key, factory) {
  const memo = getRequestMemo(options);
  if (memo.has(key)) return memo.get(key);
  const value = factory();
  memo.set(key, value);
  return value;
}

function resolveDailyJournalTimestamp(question = '', options = {}) {
  const explicit = sanitizeText(options.dailyJournalTimestamp);
  if (explicit) return explicit;
  const targetDays = resolveJournalTargetDays(question, {
    today: options.journalToday,
    now: options.journalNow
  });
  return targetDays[0] || '';
}

function formatDailyJournalPromptItem(item = {}) {
  return formatJournalPromptItem(item);
}

function buildPromptJournalItems(bundle = {}) {
  const activeRaw = Array.isArray(bundle?.byLayer?.activeRaw) ? bundle.byLayer.activeRaw : [];
  const daily = Array.isArray(bundle?.byLayer?.daily) ? bundle.byLayer.daily : [];
  const fourDay = Array.isArray(bundle?.byLayer?.fourDay) ? bundle.byLayer.fourDay : [];
  const monthly = Array.isArray(bundle?.byLayer?.monthly) ? bundle.byLayer.monthly : [];
  if (activeRaw.length > 0) return activeRaw.concat(daily.slice(-1), fourDay.slice(-1), monthly.slice(-1));
  if (daily.length > 0) return daily.concat(fourDay.slice(-1), monthly.slice(-1));
  if (fourDay.length > 0) return fourDay.concat(monthly.slice(-1));
  return monthly;
}

module.exports = {
  buildMemoKey,
  buildPromptJournalItems,
  buildRouteMemoryFilter,
  buildUnifiedRecallOptions,
  formatDailyJournalPromptItem,
  getRequestMemo,
  memoizeValue,
  resolveDailyJournalTimestamp,
  resolveReadableGroupIds
};
