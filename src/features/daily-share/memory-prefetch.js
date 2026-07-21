'use strict';

const config = require('../../../config');
const { requestAssistantMessage } = require('../../../api/graphModelIO');
const { getQzoneDaypartTone } = require('../../../core/dailyShareContent');
const {
  QZONE_TARGET_ID,
  getDefaultRunMemoryCli,
  logDailyShare
} = require('./core');
const {
  buildQzoneDailyShareMemoryFallbackQuery,
  parsePlannerQueryResponse
} = require('./qzone');

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

  const effectiveRunMemoryCli = typeof runMemoryCli === 'function'
    ? runMemoryCli
    : getDefaultRunMemoryCli();

  if (!memoryOwner || typeof effectiveRunMemoryCli !== 'function' || typeof recordMemoryScope !== 'function') {
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
    searchPayload = await effectiveRunMemoryCli(`mem search --query ${JSON.stringify(meta.memoryQuery)} --source all --limit 6`, memoryContext);
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
      const openPayload = await effectiveRunMemoryCli(`mem open --ref ${JSON.stringify(String(openCandidate.ref).trim())}`, memoryContext);
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

module.exports = {
  buildQzoneMemoryPromptBlock,
  maskSensitiveText,
  pickQzoneMemoryOpenCandidate,
  planQzoneDailyShareMemoryQuery,
  prefetchQzoneDailyShareMemory,
  sanitizeQzoneMemoryEvidence,
  sanitizeQzoneMemoryEvidenceItem,
  sanitizeQzoneOpenedMemory
};
