const config = require('../config');
const { publishQzonePost } = require('../api/qzoneClient');
const { formatDateInTz, getDatePartsInTz } = require('../utils/time');
const {
  appendRecentContentFingerprint,
  appendRecentKey,
  appendRecentShare,
  DAILY_SHARE_TYPES,
  QZONE_TARGET_ID,
  ensureStateEntry,
  ensureTarget,
  loadState,
  loadTargets,
  resetGroupState,
  saveState,
  saveTargets,
  WINDOW_KEYS
} = require('./dailyShareStore');
const dailyShareKnowledgeProvider = require('./dailyShareKnowledgeProvider');
const {
  createDailyShareContent,
  getQzoneDaypartTone,
  normalizeDailyShareFingerprint,
  validateDailyShareOutput
} = require('./dailyShareContent');
const {
  MAX_RETRIES,
  buildVariationConstraintPrompt,
  chooseQzoneTypeByWeight,
  evaluateQzoneGenerationCandidate,
  getModelConfigForQzoneAttempt,
  getRecentQzoneHistory,
  recordQzoneGenerationHistory,
  sampleVariationProfile
} = require('./qzoneGenerationState');
const {
  CANDIDATE_COUNT,
  PLAN_RETRY_LIMIT,
  appendQzoneGenerationLog,
  buildCandidatePrompt,
  buildPlanPrompt,
  buildQzonePlan,
  finalizeSuccessfulQzoneRecord,
  getRecentFailureLikeEntries,
  normalizeTelemetryPayload,
  pickBestCandidate,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
} = require('./qzoneGenerationPhase2');
const {
  buildDailyShareUserInfo,
  recordSystemGroupSend,
  sendGroupReply
} = require('./systemGroupReply');
const { getRecentMessages } = require('../utils/groupAwarenessState');
const {
  buildConversationWindow,
  analyzeConversationWindow
} = require('./passiveGroupAwareness');
const {
  acquireInitiativeLock,
  evaluateInitiativePolicy,
  releaseInitiativeLock
} = require('./initiativePolicyEngine');
const { markInitiativeSent, setLastCycleKey } = require('./initiativeState');
const { isAdmin } = require('./router');
const { runMemoryCli: defaultRunMemoryCli } = require('../utils/memoryCli');
const { recordMemoryScope: defaultRecordMemoryScope } = require('../utils/memoryScopeIndex');
const { requestAssistantMessage } = require('../api/graphModelIO');

const WINDOW_LABELS = Object.freeze({
  morning: '鏃╅棿',
  afternoon: '鍗堝悗',
  night: '澶滈棿'
});

const WINDOW_STATUS_LABELS = Object.freeze({
  pending: '待执行',
  sent: '已发送',
  deferred: '已延期',
  skipped: '已跳过',
  failed: '澶辫触'
});

const MAX_AUTO_SENDS_PER_WINDOW = 2;
const QZONE_DAILY_SHARE_TYPES = Object.freeze(['greeting', 'mood', 'recommendation']);

function logDailyShare({ groupId = '', windowKey = '', type = '', reason = '', source = '', event = '' } = {}) {
  const payload = {
    groupId: String(groupId || ''),
    windowKey: String(windowKey || ''),
    type: String(type || ''),
    reason: String(reason || '')
  };
  if (source) payload.source = String(source);
  console.log(`[daily-share] ${String(event || 'event')}`, payload);
}

function parseTimeToMinutes(text = '', fallback = 0) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return (hour * 60) + minute;
}

function parseWindowRange(text = '', fallbackStart, fallbackEnd) {
  const match = String(text || '').trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) {
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  const startMinutes = parseTimeToMinutes(match[1], fallbackStart);
  const endMinutes = parseTimeToMinutes(match[2], fallbackEnd);
  if (endMinutes <= startMinutes) {
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  return { startMinutes, endMinutes };
}

function getCurrentMinutes(date = new Date(), timezone = config.TIMEZONE) {
  const parts = getDatePartsInTz(date, timezone);
  return (parts.hour * 60) + parts.minute;
}

function stableMinute(seed = '', startMinutes, endMinutes) {
  const input = String(seed || '');
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  const span = Math.max(1, (endMinutes - startMinutes) + 1);
  return startMinutes + (Math.abs(hash) % span);
}

function minuteToTimestamp(date, minutes) {
  const day = formatDateInTz(date, config.TIMEZONE);
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return new Date(`${day}T${hour}:${minute}:00+08:00`).getTime();
}

function formatHm(timestamp = 0) {
  const value = Math.max(0, Number(timestamp || 0) || 0);
  if (!value) return '--:--';
  const parts = getDatePartsInTz(new Date(value), config.TIMEZONE);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function getWindowDefinitions(targetConfig) {
  const isQzone = String(targetConfig?.surface || '').trim().toLowerCase() === 'qzone';
  return WINDOW_KEYS.map((key) => {
    const fallback = isQzone
      ? (
        key === 'morning'
          ? { start: (7 * 60) + 30, end: 9 * 60 }
          : key === 'afternoon'
            ? { start: 13 * 60, end: 15 * 60 }
            : { start: 22 * 60, end: (23 * 60) + 40 }
      )
      : (
        key === 'morning'
          ? { start: 8 * 60, end: 10 * 60 }
          : key === 'afternoon'
            ? { start: 13 * 60, end: (15 * 60) + 30 }
            : { start: 20 * 60, end: (22 * 60) + 30 }
      );

    const parsed = parseWindowRange(targetConfig?.windows?.[key], fallback.start, fallback.end);
    return {
      key,
      label: WINDOW_LABELS[key],
      startMinutes: parsed.startMinutes,
      endMinutes: parsed.endMinutes
    };
  });
}

function formatWindowRange(windowDef) {
  const start = `${String(Math.floor(windowDef.startMinutes / 60)).padStart(2, '0')}:${String(windowDef.startMinutes % 60).padStart(2, '0')}`;
  const end = `${String(Math.floor(windowDef.endMinutes / 60)).padStart(2, '0')}:${String(windowDef.endMinutes % 60).padStart(2, '0')}`;
  return `${start}-${end}`;
}

function getWindowRemainingCapacity(schedule = {}) {
  return Math.max(0, MAX_AUTO_SENDS_PER_WINDOW - Math.max(0, Number(schedule?.sentCount || 0) || 0));
}

function ensureWindowSchedule(entry, targetId, windowDef, today, date) {
  const schedule = entry.scheduleByWindow[windowDef.key];
  if (schedule.plannedAt > 0 && getWindowRemainingCapacity(schedule) > 0) return schedule;
  const minute = stableMinute(`${targetId}:${today}:${windowDef.key}`, windowDef.startMinutes, windowDef.endMinutes);
  schedule.plannedAt = minuteToTimestamp(date, minute);
  schedule.completedAt = 0;
  schedule.skippedAt = 0;
  schedule.deferred = false;
  schedule.deferredAt = 0;
  logDailyShare({
    groupId: targetId,
    windowKey: windowDef.key,
    reason: `planned:${formatHm(schedule.plannedAt)}`,
    event: 'schedule generated'
  });
  return schedule;
}

function getLastHumanMessage(groupId) {
  const botId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  const recent = getRecentMessages(groupId).slice().reverse();
  return recent.find((item) => String(item?.sender_id || '').trim() !== botId) || null;
}

function analyzeGroupRhythm(groupId) {
  const recentMessages = getRecentMessages(groupId);
  const lastHuman = getLastHumanMessage(groupId);
  const senderId = String(lastHuman?.sender_id || '').trim();
  const text = String(lastHuman?.text || '').trim();
  const now = Date.now();
  const window = buildConversationWindow({ recentMessages, now });
  return {
    recentMessages,
    lastHuman,
    analysis: analyzeConversationWindow({
      window,
      senderId,
      text
    })
  };
}

function shouldDeferOrSkip({ groupId, targetConfig, windowDef, stateEntry, now = Date.now() }) {
  const { analysis, lastHuman } = analyzeGroupRhythm(groupId);
  const status = stateEntry.windowStatus[windowDef.key];
  const schedule = stateEntry.scheduleByWindow[windowDef.key];
  const lastHumanAt = Number(lastHuman?.timestamp || 0) || 0;
  const silenceMs = Math.max(1, Number(targetConfig.minSilenceMinutes || 20)) * 60 * 1000;
  const isTooSoon = lastHumanAt > 0 && (now - lastHumanAt) < silenceMs;
  const isFastChat = Boolean(analysis?.isTwoPersonRapidExchange || analysis?.isMultiPartyRapidExchange);

  if (!isTooSoon && !isFastChat) {
    return { allowed: true, reason: '' };
  }

  const reason = isFastChat
    ? (analysis?.isMultiPartyRapidExchange ? 'fast-multi-party-chat' : 'fast-two-person-chat')
    : 'recent-human-message';

  schedule.deferred = true;
  schedule.deferredAt = now + (Math.max(1, Number(targetConfig.deferMinutes || 8)) * 60 * 1000);
  status.status = 'deferred';
  status.lastReason = reason;
  status.lastAttemptAt = now;
  logDailyShare({ groupId, windowKey: windowDef.key, reason, event: 'gating defer' });
  return { allowed: false, deferred: true, reason };
}

function getAutoTypeForWindow(targetConfig, stateEntry, windowKey) {
  const sequence = Array.isArray(targetConfig?.sequences?.[windowKey]) ? targetConfig.sequences[windowKey] : [];
  if (!sequence.length) return null;
  if (String(targetConfig?.surface || '').trim().toLowerCase() === 'qzone') {
    return chooseQzoneTypeByWeight(
      sequence,
      getRecentQzoneHistory(),
      `${windowKey}:${stateEntry?.today || ''}:${Math.max(0, Number(stateEntry?.dailyCount || 0) || 0)}`
    );
  }
  const pointer = Math.max(0, Number(stateEntry?.sequencePointers?.[windowKey] || 0) || 0);
  return sequence[pointer % sequence.length];
}

function buildQzoneDailySharePromptFromPlan({ payload, plan, memoryBlock = '', retryNote = '' }) {
  return [
    typeof payload.buildPrompt === 'function'
      ? payload.buildPrompt({
        variationProfile: plan.variationProfile || {},
        recentHistory: require('./qzoneGenerationState').getRecentQzoneHistory()
      })
      : payload.prompt,
    buildPlanPrompt(plan, { type: payload.type || '' }),
    memoryBlock,
    retryNote
  ].filter(Boolean).join('\n\n');
}

function advanceWindowPointer(targetConfig, stateEntry, windowKey) {
  const sequence = Array.isArray(targetConfig?.sequences?.[windowKey]) ? targetConfig.sequences[windowKey] : [];
  if (!sequence.length) return 0;
  const next = (Math.max(0, Number(stateEntry?.sequencePointers?.[windowKey] || 0) || 0) + 1) % sequence.length;
  stateEntry.sequencePointers[windowKey] = next;
  return next;
}

function trimReplyText(value, maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function summarizeRecentShares(stateEntry, maxItems = 3) {
  return (Array.isArray(stateEntry?.recentShares) ? stateEntry.recentShares : [])
    .slice(-Math.max(1, Number(maxItems) || 3))
    .map((item) => `${item.type}: ${trimReplyText(item.summary || '', 80)}`)
    .filter(Boolean)
    .join('\n');
}

function safeJsonParse(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

function sanitizeMemoryQueryText(value = '', maxChars = 180) {
  let text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`|;&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const limit = Math.max(32, Number(maxChars) || 180);
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function stripCodeFences(text = '') {
  return String(text || '')
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function extractAssistantText(response) {
  if (typeof response === 'string') return response;
  return String(response?.content || '');
}

function parsePlannerQueryResponse(response) {
  const raw = stripCodeFences(extractAssistantText(response));
  if (!raw) return '';
  const direct = safeJsonParse(raw);
  if (direct && typeof direct.query === 'string') return sanitizeMemoryQueryText(direct.query);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return '';
  const parsed = safeJsonParse(match[0]);
  if (!parsed || typeof parsed.query !== 'string') return '';
  return sanitizeMemoryQueryText(parsed.query);
}

function buildQzoneDailyShareMemoryFallbackQuery({
  type,
  windowKey,
  topicLabel,
  recentShareSummaries
} = {}) {
  const pieces = [
    'qzone daily share',
    String(type || '').trim().toLowerCase(),
    String(windowKey || '').trim().toLowerCase(),
    trimReplyText(topicLabel || '', 48),
    trimReplyText(recentShareSummaries || '', 72)
  ].filter(Boolean);
  return sanitizeMemoryQueryText(pieces.join(' '), 180) || 'qzone daily share mood';
}

async function planQzoneDailyShareMemoryQuery(input = {}, options = {}) {
  const fallbackQuery = buildQzoneDailyShareMemoryFallbackQuery(input);
  const planner = typeof options.memoryQueryPlanner === 'function'
    ? options.memoryQueryPlanner
    : requestAssistantMessage;
  if (typeof planner !== 'function') {
    return { query: fallbackQuery, usedFallback: true, plannerError: 'planner-unavailable' };
  }

  const prompt = [
    '你只负责为 qzone daily share 规划一条 mem search 查询词。',
    '输出必须是严格 JSON。',
    'JSON 只能是 {"query":"..."}。',
    '不要输出 markdown，不要解释，不要输出命令。',
    'query 必须简短、泛化、适合检索，不要写成长句。',
    '不要放昵称、群聊原句、精确时间、链接、QQ号、手机号。',
    '',
    `[type]\n${String(input.type || '').trim().toLowerCase() || 'mood'}`,
    '',
    `[window]\n${String(input.windowKey || '').trim().toLowerCase() || 'unknown'} / ${String(input.windowLabel || '').trim() || 'unknown'}`,
    '',
    `[daypart_tone]\n${String(input.daypartTone || '').trim() || 'none'}`,
    '',
    `[topic_label]\n${String(input.topicLabel || '').trim() || 'none'}`,
    '',
    `[recent_qzone_summaries]\n${String(input.recentShareSummaries || '').trim() || 'none'}`
  ].join('\n');

  try {
    const response = await planner([
      { role: 'system', content: prompt },
      { role: 'user', content: '只输出严格 JSON。' }
    ], {
      disableTools: true,
      userId: String(config.BOT_QQ || '').trim(),
      routeMeta: {
        taskType: 'daily_share',
        surface: 'qzone',
        routePolicyKey: 'proactive/daily-share'
      }
    });
    const planned = parsePlannerQueryResponse(response);
    if (planned) return { query: planned, usedFallback: false, plannerError: '' };
  } catch (error) {
    return {
      query: fallbackQuery,
      usedFallback: true,
      plannerError: String(error?.message || error || 'planner-failed')
    };
  }

  return { query: fallbackQuery, usedFallback: true, plannerError: 'planner-invalid-json' };
}

const QZONE_MEMORY_OPEN_PRIORITY = Object.freeze([
  'recent',
  'journal',
  'personal',
  'style',
  'task',
  'profile',
  'jargon'
]);

function pickQzoneMemoryOpenCandidate(results = []) {
  const items = Array.isArray(results) ? results : [];
  for (const source of QZONE_MEMORY_OPEN_PRIORITY) {
    const found = items.find((item) => String(item?.source || '').trim().toLowerCase() === source && String(item?.ref || '').trim());
    if (found) return found;
  }
  return null;
}

function maskSensitiveText(value = '', maxChars = 220) {
  let text = String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/@[\w\u4e00-\u9fa5_-]+/g, '')
    .replace(/(^|[^\d])1\d{10}([^\d]|$)/g, '$1鏌愪釜鍙风爜$2')
    .replace(/(^|[^\d])\d{5,12}([^\d]|$)/g, '$1鏌愪釜缂栧彿$2')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '鏌愪釜鏃堕棿')
    .replace(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g, '鏌愬ぉ')
    .replace(/\d{1,2}月\d{1,2}日/g, '某天')
    .replace(/[“”"'`「」『』]/g, '')
    .replace(/(?:群里|有人|谁[^\n]{0,16}(?:说|问|提到|聊到)[^\n]{0,24})/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const limit = Math.max(60, Number(maxChars) || 220);
  return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
}

function sanitizeQzoneMemoryEvidenceItem(item = {}) {
  const source = String(item?.source || '').trim().toLowerCase();
  if (!source || source === 'group') return null;

  const summaryBase = source === 'recent'
    ? [item?.title, item?.preview, item?.shortTermSummary]
    : source === 'jargon'
      ? [item?.title, item?.type]
      : [item?.title, item?.preview, item?.text];

  const summary = maskSensitiveText(summaryBase.filter(Boolean).join(' | '), source === 'jargon' ? 90 : 180);
  if (!summary) return null;

  return {
    source,
    summary
  };
}

function sanitizeQzoneOpenedMemory(openPayload = {}, fallbackSource = '') {
  if (!openPayload || openPayload.ok !== true || openPayload.command !== 'open') return null;
  const source = String(openPayload.source || fallbackSource || '').trim().toLowerCase();
  if (!source || source === 'group') return null;
  const data = openPayload.data && typeof openPayload.data === 'object' ? openPayload.data : {};

  let summary = '';
  if (source === 'recent') {
    summary = maskSensitiveText([
      data.shortTermSummary,
      data.summary,
      data.title
    ].filter(Boolean).join(' | '), 180);
  } else if (source === 'jargon') {
    summary = maskSensitiveText([
      data.memoryKind,
      data.type,
      data.title
    ].filter(Boolean).join(' | '), 90);
  } else if (source === 'profile') {
    const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
    summary = maskSensitiveText([
      ...(Array.isArray(profile.likes) ? profile.likes.slice(0, 2) : []),
      ...(Array.isArray(profile.recent_topics) ? profile.recent_topics.slice(0, 2) : []),
      ...(Array.isArray(profile.personality_traits) ? profile.personality_traits.slice(0, 2) : []),
      data.summary,
      data.impression
    ].filter(Boolean).join(' | '), 180);
  } else {
    summary = maskSensitiveText([
      data.summary,
      data.impression,
      data.title,
      data.text
    ].filter(Boolean).join(' | '), 180);
  }

  if (!summary) return null;
  return { source, summary };
}

function sanitizeQzoneMemoryEvidence({
  searchPayload,
  openedMemory
} = {}) {
  const searchItems = (Array.isArray(searchPayload?.results) ? searchPayload.results : [])
    .map((item) => sanitizeQzoneMemoryEvidenceItem(item))
    .filter(Boolean);

  const digestItems = (Array.isArray(searchPayload?.digest) ? searchPayload.digest : [])
    .map((item) => maskSensitiveText(item, 140))
    .filter(Boolean)
    .slice(0, 4)
    .map((summary) => ({ source: 'digest', summary }));

  const evidenceItems = [];
  const seen = new Set();

  const pushItem = (item) => {
    if (!item?.summary) return;
    const key = `${item.source}:${item.summary}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    evidenceItems.push(item);
  };

  if (openedMemory) pushItem(openedMemory);
  searchItems.slice(0, 4).forEach(pushItem);
  digestItems.slice(0, 2).forEach(pushItem);

  return {
    items: evidenceItems.slice(0, 5),
    sources: Array.from(new Set(evidenceItems.map((item) => item.source).filter(Boolean)))
  };
}

function buildQzoneMemoryPromptBlock(memoryEvidence = {}) {
  const items = Array.isArray(memoryEvidence?.items) ? memoryEvidence.items : [];
  if (!items.length) return '';
  const lines = [
    '【可用记忆弱证据】',
    '这些内容只能作为背景倾向，不能复述原文，不能暴露来源，不能写成群聊细节。'
  ];
  items.forEach((item) => {
    lines.push(`- ${item.source}: ${item.summary}`);
  });
  return lines.join('\n');
}

async function prefetchQzoneDailyShareMemory({
  type,
  groupId,
  windowKey,
  windowLabel,
  today,
  stateEntry,
  recentShareSummaries,
  topicLabel,
  payload,
  runMemoryCli,
  recordMemoryScope,
  memoryQueryPlanner
} = {}) {
  const memoryOwner = String(config.BOT_QQ || '').trim();
  const daypartTone = getQzoneDaypartTone(windowKey);
  const meta = {
    memoryOwner,
    memoryQuery: '',
    memorySearchCount: 0,
    memoryOpenUsed: false,
    memoryOpenedSource: '',
    memoryPrefetchError: '',
    memoryEvidenceSources: []
  };

  if (!memoryOwner || typeof runMemoryCli !== 'function' || typeof recordMemoryScope !== 'function') {
    meta.memoryPrefetchError = !memoryOwner ? 'missing-memory-owner' : 'memory-prefetch-unavailable';
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  const planned = await planQzoneDailyShareMemoryQuery({
    type,
    windowKey,
    windowLabel,
    topicLabel: topicLabel || payload?.topicLabel || '',
    recentShareSummaries,
    daypartTone
  }, { memoryQueryPlanner });

  meta.memoryQuery = planned.query;
  if (planned.plannerError) meta.memoryPrefetchError = planned.plannerError;

  try {
    recordMemoryScope(memoryOwner, { groupId: String(groupId || '').trim() });
  } catch (error) {
    meta.memoryPrefetchError = String(error?.message || error || 'record-scope-failed');
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: meta.memoryPrefetchError,
      source: payload?.source || '',
      event: 'memory prefetch degraded'
    });
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  const memoryContext = {
    userId: memoryOwner,
    groupId: String(groupId || '').trim(),
    channelId: '__qzone__',
    taskType: 'daily_share',
    topRouteType: 'proactive',
    routePolicyKey: 'proactive/daily-share'
  };

  let searchPayload = null;
  try {
    searchPayload = await runMemoryCli(`mem search --query ${JSON.stringify(meta.memoryQuery)} --source all --limit 6`, memoryContext);
  } catch (error) {
    meta.memoryPrefetchError = String(error?.message || error || 'memory-search-failed');
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: meta.memoryPrefetchError,
      source: payload?.source || '',
      event: 'memory prefetch degraded'
    });
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  if (!searchPayload?.ok || searchPayload.command !== 'search') {
    meta.memoryPrefetchError = 'unexpected-memory-search-payload';
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: meta.memoryPrefetchError,
      source: payload?.source || '',
      event: 'memory prefetch degraded'
    });
    return { memoryEvidence: { items: [], sources: [] }, meta };
  }

  meta.memorySearchCount = Math.max(0, Number(searchPayload.count || 0) || 0);

  let openedMemory = null;
  const openCandidate = meta.memorySearchCount > 0 ? pickQzoneMemoryOpenCandidate(searchPayload.results) : null;
  if (openCandidate?.ref) {
    try {
      const openPayload = await runMemoryCli(`mem open --ref ${JSON.stringify(String(openCandidate.ref).trim())}`, memoryContext);
      openedMemory = sanitizeQzoneOpenedMemory(openPayload, openCandidate.source);
      if (openedMemory) {
        meta.memoryOpenUsed = true;
        meta.memoryOpenedSource = openedMemory.source;
      }
    } catch (_) {}
  }

  const memoryEvidence = sanitizeQzoneMemoryEvidence({
    searchPayload,
    openedMemory
  });

  meta.memoryEvidenceSources = memoryEvidence.sources.slice();
  if (!memoryEvidence.items.length && meta.memorySearchCount <= 0 && !meta.memoryPrefetchError) {
    meta.memoryPrefetchError = 'memory-search-empty';
  }

  logDailyShare({
    groupId: QZONE_TARGET_ID,
    windowKey,
    type,
    reason: memoryEvidence.items.length
      ? `hits=${meta.memorySearchCount};sources=${meta.memoryEvidenceSources.join(',') || 'none'}`
      : (meta.memoryPrefetchError || `hits=${meta.memorySearchCount}`),
    source: payload?.source || '',
    event: memoryEvidence.items.length ? 'memory prefetch ok' : 'memory prefetch degraded'
  });

  if (meta.memorySearchCount > memoryEvidence.items.length) {
    logDailyShare({
      groupId: QZONE_TARGET_ID,
      windowKey,
      type,
      reason: `search=${meta.memorySearchCount};kept=${memoryEvidence.items.length}`,
      source: payload?.source || '',
      event: 'memory evidence filtered'
    });
  }

  return { memoryEvidence, meta };
}

function findCurrentWindow(targetConfig, date) {
  const currentMinutes = getCurrentMinutes(date, config.TIMEZONE);
  return getWindowDefinitions(targetConfig).find((item) => currentMinutes >= item.startMinutes && currentMinutes <= item.endMinutes) || null;
}

function isManualDailyShareType(type) {
  return DAILY_SHARE_TYPES.includes(String(type || '').trim().toLowerCase());
}

function isManualQzoneDailyShareType(type) {
  return QZONE_DAILY_SHARE_TYPES.includes(String(type || '').trim().toLowerCase());
}

function getNextWindowInfo(targetConfig, entry, date) {
  const today = formatDateInTz(date, config.TIMEZONE);
  const windows = getWindowDefinitions(targetConfig);
  const pending = windows
    .map((windowDef) => {
      const schedule = entry.scheduleByWindow[windowDef.key];
      const status = entry.windowStatus[windowDef.key];
      return { windowDef, schedule, status };
    })
    .filter((item) => item.status.status !== 'skipped' && getWindowRemainingCapacity(item.schedule) > 0)
    .sort((a, b) => {
      const aTime = (a.schedule.deferred && a.schedule.deferredAt) ? a.schedule.deferredAt : a.schedule.plannedAt;
      const bTime = (b.schedule.deferred && b.schedule.deferredAt) ? b.schedule.deferredAt : b.schedule.plannedAt;
      return aTime - bTime;
    });

  if (!pending.length) return { label: '今日无后续窗口', time: '--:--', today };
  const next = pending[0];
  const when = (next.schedule.deferred && next.schedule.deferredAt) ? next.schedule.deferredAt : next.schedule.plannedAt;
  return {
    label: next.windowDef.label,
    time: formatHm(when),
    today
  };
}

function shouldRunWindowNow({ entry, windowDef, now, date }) {
  const schedule = entry.scheduleByWindow[windowDef.key];
  const status = entry.windowStatus[windowDef.key];
  const currentMinutes = getCurrentMinutes(date, config.TIMEZONE);
  if (currentMinutes > windowDef.endMinutes) {
    if (getWindowRemainingCapacity(schedule) > 0 && status.status !== 'skipped') {
      status.status = 'skipped';
      status.lastReason = 'window-expired';
      status.lastAttemptAt = now;
      schedule.skippedAt = now;
      logDailyShare({ groupId: '', windowKey: windowDef.key, reason: 'window-expired', event: 'window skip' });
    }
    return false;
  }
  if (status.status === 'skipped') return false;
  if (getWindowRemainingCapacity(schedule) <= 0) return false;
  if (schedule.deferred && schedule.deferredAt > now) return false;
  return schedule.plannedAt > 0 && now >= schedule.plannedAt;
}

function createDailyShareEngine({
  knowledgeProvider = dailyShareKnowledgeProvider,
  contentBuilder = null,
  qzonePublisher = publishQzonePost,
  runMemoryCli = defaultRunMemoryCli,
  recordMemoryScope = defaultRecordMemoryScope,
  memoryQueryPlanner = null
} = {}) {
  const resolvedContentBuilder = contentBuilder || createDailyShareContent({ knowledgeProvider });
  let targetsCache = null;
  let stateCache = null;

  function getToday(date = new Date()) {
    return formatDateInTz(date, config.TIMEZONE);
  }

  function ensureCaches(today = getToday()) {
    targetsCache = targetsCache || loadTargets();
    stateCache = stateCache || loadState(today);
    return { targets: targetsCache, state: stateCache };
  }

  function flush() {
    if (targetsCache) saveTargets(targetsCache);
    if (stateCache) saveState(stateCache);
  }

  function ensureTargetState(targetId, today = getToday()) {
    const { targets, state } = ensureCaches(today);
    return {
      target: ensureTarget(targets, targetId),
      stateEntry: ensureStateEntry(state, targetId, today)
    };
  }

  function ensureGroup(groupId, today = getToday()) {
    return ensureTargetState(groupId, today);
  }

  function ensureQzone(today = getToday()) {
    return ensureTargetState(QZONE_TARGET_ID, today);
  }

  function formatStatusForTarget(targetId, today = getToday(), date = new Date()) {
    const { target, stateEntry } = ensureTargetState(targetId, today);
    const currentWindow = findCurrentWindow(target, date);
    const windows = getWindowDefinitions(target);
    windows.forEach((windowDef) => ensureWindowSchedule(stateEntry, targetId, windowDef, today, date));
    const nextWindow = getNextWindowInfo(target, stateEntry, date);
    const title = String(target?.surface || '').trim().toLowerCase() === 'qzone' ? 'QZone Daily Share' : 'Daily Share';

    const lines = [
      `${title}: ${target.enabled ? '已启用' : '已禁用'}`,
      `今日自动发送：${stateEntry.dailyCount}/${target.maxPerDay}`,
      currentWindow
        ? `当前自动窗口：${currentWindow.label} ${formatWindowRange(currentWindow)}`
        : '当前自动窗口：当前无激活窗口',
      `下一次待执行：${nextWindow.label} ${nextWindow.time}`
    ];

    for (const windowDef of windows) {
      const schedule = stateEntry.scheduleByWindow[windowDef.key];
      const status = stateEntry.windowStatus[windowDef.key];
      const type = getAutoTypeForWindow(target, stateEntry, windowDef.key) || '无';
      lines.push(
        `${windowDef.label} ${formatWindowRange(windowDef)} | ${WINDOW_STATUS_LABELS[status.status] || status.status} | 自动类型 ${type} | 已发 ${Math.max(0, Number(schedule.sentCount || 0) || 0)}/${MAX_AUTO_SENDS_PER_WINDOW} | 计划 ${formatHm(schedule.plannedAt)} | 延期 ${formatHm(schedule.deferredAt)} | 最近成功 ${status.lastSuccessType || '无'} | 最近原因 ${status.lastReason || '无'}`
      );
    }
    return lines.join('\n');
  }

  function formatStatus(groupId, today = getToday(), date = new Date()) {
    return formatStatusForTarget(groupId, today, date);
  }

  async function generateValidatedShare({
    askAIByGraph,
    targetId,
    groupId,
    windowKey,
    type,
    payload,
    stateEntry,
    now,
    surface = 'group'
  }) {
    const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
    const userId = normalizedSurface === 'qzone' ? 'dailyshare:qzone' : `dailyshare:group:${groupId}`;
    const userInfo = buildDailyShareUserInfo(
      normalizedSurface === 'qzone' ? '' : groupId,
      {
        userId,
        level: normalizedSurface === 'qzone' ? 'self' : 'group',
        relationship: normalizedSurface === 'qzone' ? 'self' : 'group',
        surface: normalizedSurface
      }
    );
    let lastFailure = '';
    let lastFailureClass = '';
    let qzoneMemoryEvidence = { items: [], sources: [] };
    let qzoneMemoryMeta = {
      memoryOwner: '',
      memoryQuery: '',
      memorySearchCount: 0,
      memoryOpenUsed: false,
      memoryOpenedSource: '',
      memoryPrefetchError: '',
      memoryEvidenceSources: []
    };

    if (normalizedSurface === 'qzone') {
      const prefetched = await prefetchQzoneDailyShareMemory({
        type,
        groupId,
        windowKey,
        windowLabel: payload?.windowLabel || windowKey,
        today: formatDateInTz(new Date(now), config.TIMEZONE),
        stateEntry,
        recentShareSummaries: summarizeRecentShares(stateEntry, 3),
        topicLabel: payload?.topicLabel || '',
        payload,
        runMemoryCli,
        recordMemoryScope,
        memoryQueryPlanner
      });
      qzoneMemoryEvidence = prefetched.memoryEvidence || qzoneMemoryEvidence;
      qzoneMemoryMeta = prefetched.meta || qzoneMemoryMeta;
      const memoryBlock = buildQzoneMemoryPromptBlock(qzoneMemoryEvidence);
      if (memoryBlock) {
        payload.prompt = payload.prompt ? `${payload.prompt}\n\n${memoryBlock}` : memoryBlock;
      }
    }

    const recentQzoneHistory = normalizedSurface === 'qzone' ? getRecentQzoneHistory() : [];
    const recentFailureHistory = normalizedSurface === 'qzone' ? getRecentFailureLikeEntries() : [];

    if (normalizedSurface === 'qzone') {
      for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
        const plan = buildQzonePlan({
          source: 'daily_share',
          type,
          windowKey,
          groupId: targetId,
          today: stateEntry?.today || '',
          planAttempt,
          now,
          recentHistory: recentQzoneHistory,
          recentFailures: recentFailureHistory,
          allowImage: false,
          targetLength: type === 'greeting' ? '18-60' : (type === 'mood' ? '24-90' : '30-100')
        });
        const candidates = [];
        for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
          const prompt = buildCandidatePrompt(
            buildQzoneDailySharePromptFromPlan({
              payload,
              plan,
              memoryBlock: payload.prompt && payload.prompt.includes('[记忆证据块]') ? '' : payload.prompt,
              retryNote: candidateIndex > 0
                ? `这是第 ${candidateIndex + 1} 个候选，请明显拉开开头、叙事动势和收尾。`
                : ''
            }),
            plan,
            candidateIndex > 0 ? `上一个候选不够好，请重新组织语气和画面。` : ''
          );
          const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
            systemInitiated: true,
            topRouteType: 'proactive',
            routePolicyKey: 'proactive/daily-share',
            disableTools: true,
            disableStream: true,
            disableMemoryLearning: true,
            modelConfig: getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : ''),
            routeMeta: {
              groupId: String(groupId || ''),
              taskType: 'daily_share',
              channelId: String(targetId),
              windowKey,
              shareType: type,
              surface: normalizedSurface
            }
          });
          const text = trimReplyText(reply, 260);
          const validation = validateDailyShareOutput(text, type, normalizedSurface);
          candidates.push({
            plan,
            text,
            rejected: !validation.ok,
            rejectionReason: validation.ok ? '' : validation.reason
          });
        }
        const picked = pickBestCandidate(candidates, {
          source: type,
          recentHistory: recentQzoneHistory,
          plan
        });
        if (picked.selected) {
          appendQzoneGenerationLog(normalizeTelemetryPayload({
            source: 'daily_share',
            type,
            groupId: targetId,
            status: 'sent',
            selectedFingerprint: picked.selected.fingerprint,
            selectedScore: picked.selected.score,
            similarity: picked.selected.similarity,
            failureReasons: [],
            planSummary: {
              fingerprint: plan.fingerprint,
              topicKey: plan.theme?.key || payload.topicKey || '',
              topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
              lens: plan.variationProfile?.lens || '',
              anchor: plan.variationProfile?.anchor || '',
              structure: plan.variationProfile?.structure || '',
              arc: plan.variationProfile?.arc || '',
              tempo: plan.variationProfile?.tempo || '',
              distance: plan.variationProfile?.distance || ''
            },
            candidates: picked.ranked.map((item) => ({
              fingerprint: item.fingerprint,
              score: item.score,
              similarity: item.similarity,
              rejected: item.rejected,
              rejectionReason: item.rejectionReason
            }))
          }));
          return {
            text: picked.selected.text,
            fingerprint: picked.selected.fingerprint,
            variationProfile: plan.variationProfile || null,
            topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
            plan,
            candidates: picked.ranked,
            meta: {
              ...qzoneMemoryMeta,
              similarity: picked.selected.similarity,
              selectedScore: picked.selected.score,
              memoryEvidenceSources: Array.isArray(qzoneMemoryMeta.memoryEvidenceSources) && qzoneMemoryMeta.memoryEvidenceSources.length
                ? qzoneMemoryMeta.memoryEvidenceSources
                : (Array.isArray(qzoneMemoryEvidence.sources) ? qzoneMemoryEvidence.sources : [])
            }
          };
        }
        lastFailure = picked.ranked[0]?.rejectionReason || 'qzone_phase2_candidate_rejected';
        lastFailureClass = 'similarity';
        appendQzoneGenerationLog(normalizeTelemetryPayload({
          source: 'daily_share',
          type,
          groupId: targetId,
          status: 'failed',
          selectedFingerprint: '',
          selectedScore: 0,
          similarity: 0,
          failureReasons: picked.ranked.map((item) => item.rejectionReason).filter(Boolean),
          planSummary: {
            fingerprint: plan.fingerprint,
            topicKey: plan.theme?.key || payload.topicKey || '',
            topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
            lens: plan.variationProfile?.lens || '',
            anchor: plan.variationProfile?.anchor || '',
            structure: plan.variationProfile?.structure || '',
            arc: plan.variationProfile?.arc || '',
            tempo: plan.variationProfile?.tempo || '',
            distance: plan.variationProfile?.distance || ''
          },
          candidates: picked.ranked.map((item) => ({
            fingerprint: item.fingerprint,
            score: item.score,
            similarity: item.similarity,
            rejected: item.rejected,
            rejectionReason: item.rejectionReason
          }))
        }));
      }
      throw new Error(lastFailure || 'daily-share-validation-failed');
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const variationProfile = normalizedSurface === 'qzone'
        ? sampleVariationProfile({
          source: 'daily_share',
          type,
          windowKey,
          groupId: targetId,
          today: stateEntry?.today || '',
          attempt,
          now,
          recentHistory: recentQzoneHistory
        })
        : null;
      const promptBase = normalizedSurface === 'qzone' && typeof payload.buildPrompt === 'function'
        ? payload.buildPrompt({
          variationProfile,
          recentHistory: recentQzoneHistory
        })
        : payload.prompt;
      const prompt = attempt === 0
        ? [promptBase, payload.prompt].filter(Boolean).join('\n\n')
        : [
          promptBase,
          payload.prompt,
          buildVariationConstraintPrompt({ recentHistory: recentQzoneHistory }),
          `上一次结果不合格，失败原因：${lastFailure || 'unknown'}。这次必须避开相同问题并重新生成。`
        ].filter(Boolean).join('\n\n');
      const modelConfig = normalizedSurface === 'qzone'
        ? getModelConfigForQzoneAttempt(lastFailureClass)
        : null;
      const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
        systemInitiated: true,
        topRouteType: 'proactive',
        routePolicyKey: 'proactive/daily-share',
        disableTools: true,
        disableStream: true,
        disableMemoryLearning: true,
        modelConfig,
        routeMeta: {
          groupId: String(groupId || ''),
          taskType: 'daily_share',
          channelId: String(targetId),
          windowKey,
          shareType: type,
          surface: normalizedSurface
        }
      });

      const text = trimReplyText(reply, 260);
      if (!text) {
        lastFailure = 'empty-daily-share-reply';
        lastFailureClass = 'validation';
        continue;
      }

      const validation = validateDailyShareOutput(text, type, normalizedSurface);
      if (!validation.ok) {
        lastFailure = validation.reason;
        lastFailureClass = 'validation';
        logDailyShare({
          groupId: targetId,
          windowKey,
          type,
          reason: validation.reason,
          source: payload.source || '',
          event: attempt === 0 ? 'validator retry' : 'validator fail'
        });
        continue;
      }

      const fingerprint = normalizeDailyShareFingerprint(text);
      const recentFingerprints = (Array.isArray(stateEntry.recentContentFingerprints) ? stateEntry.recentContentFingerprints : [])
        .map((item) => String(item?.key || '').trim().toLowerCase())
        .filter(Boolean);
      if (fingerprint && recentFingerprints.includes(fingerprint)) {
        lastFailure = 'recent-content-duplicate';
        lastFailureClass = 'duplicate';
        logDailyShare({
          groupId: targetId,
          windowKey,
          type,
          reason: lastFailure,
          source: payload.source || '',
          event: attempt === 0 ? 'validator retry' : 'validator fail'
        });
        continue;
      }

      return {
        text,
        fingerprint,
        variationProfile: null,
        topicGroup: payload.topicGroup || '',
        meta: {
          ...qzoneMemoryMeta,
          memoryEvidenceSources: Array.isArray(qzoneMemoryMeta.memoryEvidenceSources) && qzoneMemoryMeta.memoryEvidenceSources.length
            ? qzoneMemoryMeta.memoryEvidenceSources
            : (Array.isArray(qzoneMemoryEvidence.sources) ? qzoneMemoryEvidence.sources : [])
        }
      };
    }

    throw new Error(lastFailure || 'daily-share-validation-failed');
  }

  async function sendShare({
    sendWithRetry,
    askAIByGraph,
    groupId,
    windowKey,
    type,
    today = getToday(),
    advancePointer = false,
    manual = false,
    now = Date.now(),
    surface = 'group'
  }) {
    const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
    const targetId = normalizedSurface === 'qzone' ? QZONE_TARGET_ID : groupId;
    const { target, stateEntry } = ensureTargetState(targetId, today);
    const windowDef = getWindowDefinitions(target).find((item) => item.key === windowKey) || {
      key: windowKey,
      label: windowKey,
      startMinutes: 0,
      endMinutes: 0
    };

    const payload = await resolvedContentBuilder.build({
      type,
      groupId,
      windowKey,
      windowLabel: windowDef.label,
      stateEntry,
      targetConfig: target,
      today,
      now,
      surface: normalizedSurface
    });
    payload.windowLabel = payload.windowLabel || windowDef.label;

    if (payload.topicRelaxed) {
      logDailyShare({
        groupId: targetId,
        windowKey,
        type,
        reason: 'topic-relaxed-7d',
        event: 'dedupe relaxed'
      });
    }

    const generated = await generateValidatedShare({
      askAIByGraph,
      targetId,
      groupId,
      windowKey,
      type,
      payload,
      stateEntry,
      now,
      surface: normalizedSurface
    });

    let initiativeLockOwner = '';
    let initiativePolicy = null;
    if (normalizedSurface === 'group') {
      initiativePolicy = evaluateInitiativePolicy({
        source: 'daily_share',
        groupId,
        userId: '',
        candidateReason: 'daily_share',
        contextHints: {
          primaryContext: type,
          secondaryContext: payload?.topicLabel || '',
          windowKey
        }
      }, now);
      if (!initiativePolicy.allowed) {
        const status = stateEntry.windowStatus[windowKey];
        const schedule = stateEntry.scheduleByWindow[windowKey];
        schedule.deferred = true;
        schedule.deferredAt = now + (Math.max(1, Number(target.deferMinutes || 8)) * 60 * 1000);
        status.status = 'deferred';
        status.lastReason = initiativePolicy.reason;
        status.lastAttemptAt = now;
        flush();
        return { sent: false, deferred: true, reason: initiativePolicy.reason, text: '' };
      }
      initiativeLockOwner = `daily_share:${groupId}:${windowKey}:${type}`;
      const initiativeLock = acquireInitiativeLock({
        groupId,
        owner: initiativeLockOwner,
        now
      });
      if (!initiativeLock.acquired) {
        return { sent: false, deferred: true, reason: initiativeLock.reason, text: '' };
      }
    }

    try {
      if (normalizedSurface === 'qzone') {
        const result = await qzonePublisher(generated.text);
        if (!result?.success) {
          throw new Error(String(result?.reason || 'daily-share-send-failed'));
        }
      } else {
        const sent = await sendGroupReply({
          sendWithRetry,
          groupId,
          senderId: '',
          replyText: generated.text,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        if (!sent) throw new Error('daily-share-send-failed');

        recordSystemGroupSend({
          groupId,
          senderId: '',
          text: generated.text,
          senderName: '鐟炲笇',
          updatePresence: true,
          updateBotPresence: true,
          now,
          source: 'daily_share',
          routePolicyKey: 'proactive/daily-share'
        });
        const dailyShareCycleKey = String(initiativePolicy.cycleKey || '').trim();
        markInitiativeSent(groupId, {
          source: 'daily_share',
          reason: 'daily_share',
          cycleKey: dailyShareCycleKey
        }, now);
        if (dailyShareCycleKey) {
          setLastCycleKey(groupId, dailyShareCycleKey, now);
        }
      }
    } finally {
      if (initiativeLockOwner) {
        releaseInitiativeLock({
          groupId,
          owner: initiativeLockOwner,
          now: Date.now()
        });
      }
    }

    if (!manual) {
      stateEntry.dailyCount = Math.max(0, Number(stateEntry.dailyCount || 0) || 0) + 1;
    }

    const status = stateEntry.windowStatus[windowKey];
    const schedule = stateEntry.scheduleByWindow[windowKey];
    if (!manual) {
      schedule.sentCount = Math.max(0, Number(schedule.sentCount || 0) || 0) + 1;
      schedule.lastSentAt = now;
      schedule.deferred = false;
      schedule.deferredAt = 0;
      schedule.completedAt = now;
      if (getWindowRemainingCapacity(schedule) > 0) {
        const nextPlan = now + (Math.max(1, Number(target.deferMinutes || 8)) * 60 * 1000);
        schedule.plannedAt = nextPlan;
        status.status = 'pending';
      } else {
        status.status = 'sent';
      }
    }

    status.lastReason = manual ? 'manual-send' : 'auto-send';
    status.lastAttemptAt = now;
    status.lastSuccessType = type;
    if (manual) {
      status.lastManualAt = now;
    }

    appendRecentShare(stateEntry, {
      at: now,
      windowKey,
      type,
      summary: trimReplyText(generated.text, 120),
      topicKey: payload.topicKey || '',
      contentKey: payload.contentKey || ''
    });
    appendRecentContentFingerprint(stateEntry, generated.fingerprint, now);
    if (normalizedSurface === 'qzone') {
      finalizeSuccessfulQzoneRecord({
        source: 'daily_share',
        text: generated.text,
        type,
        topicKey: payload.topicKey || '',
        topicGroup: payload.topicGroup || generated.topicGroup || '',
        variationProfile: generated.variationProfile || {},
        plan: generated.plan || null,
        at: now
      });
    }

    if (payload.topicKey) {
      stateEntry.recentTopicKeys = appendRecentKey(stateEntry.recentTopicKeys, payload.topicKey, now, 120);
    }
    if (advancePointer) {
      advanceWindowPointer(target, stateEntry, windowKey);
    }

    flush();
    logDailyShare({
      groupId: targetId,
      windowKey,
      type,
      reason: manual ? 'manual-send' : 'auto-send',
      source: payload.source || '',
      event: 'send success'
    });
    return { sent: true, text: generated.text, type, meta: generated.meta || {} };
  }

  async function runGroupShareCycle({ sendWithRetry, askAIByGraph, today, date, now }) {
    const { targets, state } = ensureCaches(today);

    for (const [groupId] of Object.entries(targets || {})) {
      if (groupId === QZONE_TARGET_ID) continue;

      const target = ensureTarget(targets, groupId);
      if (!target.enabled) continue;

      const stateEntry = ensureStateEntry(state, groupId, today);
      if (stateEntry.today !== today) {
        state[groupId] = resetGroupState(stateEntry, today);
      }
      const freshState = ensureStateEntry(state, groupId, today);
      if (freshState.dailyCount >= target.maxPerDay) {
        logDailyShare({ groupId, reason: 'daily-quota-reached', event: 'skip' });
        continue;
      }

      for (const windowDef of getWindowDefinitions(target)) {
        ensureWindowSchedule(freshState, groupId, windowDef, today, date);
        if (!shouldRunWindowNow({ entry: freshState, windowDef, now, date })) continue;

        const gate = shouldDeferOrSkip({
          groupId,
          targetConfig: target,
          windowDef,
          stateEntry: freshState,
          now
        });
        if (!gate.allowed) {
          flush();
          continue;
        }

        const type = getAutoTypeForWindow(target, freshState, windowDef.key);
        if (!type) continue;

        try {
          await sendShare({
            sendWithRetry,
            askAIByGraph,
            groupId,
            windowKey: windowDef.key,
            type,
            today,
            advancePointer: true,
            manual: false,
            now,
            surface: 'group'
          });
        } catch (error) {
          logDailyShare({
            groupId,
            windowKey: windowDef.key,
            type,
            reason: error?.message || String(error),
            event: 'send fail'
          });
          const status = freshState.windowStatus[windowDef.key];
          status.status = 'failed';
          status.lastReason = error?.message || String(error);
          status.lastAttemptAt = now;
          flush();
        }
      }
    }
  }

  async function runQzoneShareCycle({ sendWithRetry, askAIByGraph, today, date, now }) {
    const { targets, state } = ensureCaches(today);
    const target = ensureTarget(targets, QZONE_TARGET_ID);
    if (!target.enabled) return;

    const stateEntry = ensureStateEntry(state, QZONE_TARGET_ID, today);
    if (stateEntry.today !== today) {
      state[QZONE_TARGET_ID] = resetGroupState(stateEntry, today);
    }
    const freshState = ensureStateEntry(state, QZONE_TARGET_ID, today);
    if (freshState.dailyCount >= target.maxPerDay) {
      logDailyShare({ groupId: QZONE_TARGET_ID, reason: 'daily-quota-reached', event: 'skip' });
      return;
    }

    for (const windowDef of getWindowDefinitions(target)) {
      ensureWindowSchedule(freshState, QZONE_TARGET_ID, windowDef, today, date);
      if (!shouldRunWindowNow({ entry: freshState, windowDef, now, date })) continue;

      const type = getAutoTypeForWindow(target, freshState, windowDef.key);
      if (!type) continue;

      try {
        await sendShare({
          sendWithRetry,
          askAIByGraph,
          groupId: '',
          windowKey: windowDef.key,
          type,
          today,
          advancePointer: true,
          manual: false,
          now,
          surface: 'qzone'
        });
      } catch (error) {
        logDailyShare({
          groupId: QZONE_TARGET_ID,
          windowKey: windowDef.key,
          type,
          reason: error?.message || String(error),
          event: 'send fail'
        });
        const status = freshState.windowStatus[windowDef.key];
        status.status = 'failed';
        status.lastReason = error?.message || String(error);
        status.lastAttemptAt = now;
        flush();
      }
    }
  }

  async function runDailyShareCycle({ sendWithRetry, askAIByGraph, date = new Date() }) {
    if (!config.DAILY_SHARE_ENABLED) return { ran: false, reason: 'disabled' };

    const today = getToday(date);
    const now = date.getTime();
    await runGroupShareCycle({ sendWithRetry, askAIByGraph, today, date, now });
    await runQzoneShareCycle({ sendWithRetry, askAIByGraph, today, date, now });
    flush();
    return { ran: true };
  }

  async function handleAdminCommand({
    rawText,
    groupId,
    userId,
    sendWithRetry,
    askAIByGraph,
    date = new Date()
  }) {
    const text = String(rawText || '').trim();
    if (!/^\/dailyshare(?:\s|$)/i.test(text)) return null;
    if (!String(groupId || '').trim()) return { handled: true, replyText: '仅群聊可用。' };
    if (!isAdmin(userId)) return { handled: true, replyText: '仅管理员可用。' };

    const today = getToday(date);
    const parts = text.split(/\s+/).slice(1);
    const namespace = String(parts[0] || 'status').trim().toLowerCase();
    const isQzoneCommand = namespace === 'qzone';
    const targetId = isQzoneCommand ? QZONE_TARGET_ID : groupId;
    const { target, stateEntry } = isQzoneCommand ? ensureQzone(today) : ensureGroup(groupId, today);
    const sub = String(isQzoneCommand ? (parts[1] || 'status') : namespace).trim().toLowerCase();
    const runArgIndex = isQzoneCommand ? 2 : 1;

    if (sub === 'status') {
      flush();
      return { handled: true, replyText: formatStatusForTarget(targetId, today, date) };
    }

    if (isQzoneCommand && sub === 'debug') {
      return { handled: true, replyText: summarizeQzoneDebug(20) };
    }

    if (isQzoneCommand && sub === 'summary') {
      return { handled: true, replyText: summarizeQzoneWindowStats(7) };
    }

    if (sub === 'enable') {
      target.enabled = true;
      flush();
      return { handled: true, replyText: isQzoneCommand ? 'qzone daily share 已启用。' : 'daily share 已启用。' };
    }

    if (sub === 'disable') {
      target.enabled = false;
      flush();
      return { handled: true, replyText: isQzoneCommand ? 'qzone daily share 已禁用。' : 'daily share 已禁用。' };
    }

    if (sub === 'reset') {
      const { state } = ensureCaches(today);
      state[String(targetId)] = resetGroupState(stateEntry, today);
      flush();
      return { handled: true, replyText: isQzoneCommand ? 'qzone daily share 当前状态已重置。' : 'daily share 当前群当日状态已重置。' };
    }

    if (sub === 'run') {
      const requested = String(parts[runArgIndex] || 'auto').trim().toLowerCase();
      const typeAllowed = isQzoneCommand ? isManualQzoneDailyShareType(requested) : isManualDailyShareType(requested);
      if (requested !== 'auto' && !typeAllowed) {
        return {
          handled: true,
          replyText: isQzoneCommand
            ? '仅支持 `/dailyshare qzone run [auto|greeting|mood|recommendation]`。'
            : '仅支持 `/dailyshare run [auto|greeting|mood|knowledge|recommendation]`。'
        };
      }

      const currentWindow = findCurrentWindow(target, date);
      if (requested === 'auto' && !currentWindow) {
        return {
          handled: true,
          replyText: isQzoneCommand
            ? '当前不在任何 QZone 自动窗口内，`/dailyshare qzone run auto` 未执行。'
            : '当前不在任何自动窗口内，`/dailyshare run auto` 未执行。'
        };
      }

      const windowDef = currentWindow || getWindowDefinitions(target)[0];
      const type = requested === 'auto'
        ? getAutoTypeForWindow(target, stateEntry, windowDef.key)
        : requested;
      if (!type) {
        return { handled: true, replyText: '当前窗口没有可用的自动分享类型。' };
      }

      try {
        await sendShare({
          sendWithRetry,
          askAIByGraph,
          groupId: isQzoneCommand ? '' : groupId,
          windowKey: windowDef.key,
          type,
          today,
          advancePointer: requested === 'auto',
          manual: requested !== 'auto',
          now: date.getTime(),
          surface: isQzoneCommand ? 'qzone' : 'group'
        });
      } catch (error) {
        return {
          handled: true,
          replyText: `执行失败：${error?.message || String(error)}`
        };
      }

      return {
        handled: true,
        replyText: requested === 'auto'
          ? `已执行 auto，窗口 ${windowDef.label}，自动序列已推进。`
          : `已执行 ${type}，未修改自动序列指针。`
      };
    }

    return {
      handled: true,
      replyText: isQzoneCommand
        ? '可用命令：/dailyshare qzone status | debug | summary | enable | disable | run [auto|greeting|mood|recommendation] | reset'
        : '可用命令：/dailyshare status | enable | disable | run [auto|greeting|mood|knowledge|recommendation] | reset'
    };
  }

  return {
    formatStatus,
    handleAdminCommand,
    runDailyShareCycle
  };
}

let singleton = null;

function getDailyShareEngine() {
  if (!singleton) singleton = createDailyShareEngine();
  return singleton;
}

module.exports = {
  createDailyShareEngine,
  getDailyShareEngine
};


