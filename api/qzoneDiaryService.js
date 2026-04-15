const config = require('../config');
const { getGroupPresence, getRecentMessages } = require('../utils/groupAwarenessState');
const { getDatePartsInTz } = require('../utils/time');
const {
  MAX_RETRIES,
  describeGenericAutodraftRandomness,
  getModelConfigForQzoneAttempt,
  recordQzoneGenerationHistory,
  normalizeDailyShareFingerprint,
  sampleVariationProfile
} = require('../core/qzoneGenerationState');
const {
  CANDIDATE_COUNT,
  PLAN_RETRY_LIMIT,
  appendQzoneGenerationLog,
  buildCandidatePrompt,
  buildPlanPrompt,
  buildQzonePlan,
  buildVisualPromptHints,
  evaluateImageConsistency,
  finalizeSuccessfulQzoneRecord,
  getRecentFailureLikeEntries,
  normalizeTelemetryPayload,
  pickBestCandidate,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
} = require('../core/qzoneGenerationPhase2');

const INTERNAL_LEAK_TERMS = [
  'ai',
  '模型',
  '系统提示',
  '记忆',
  '日志',
  'planner',
  'agent',
  'tool',
  'napcat',
  'cookie',
  '权限',
  '边界'
];

const BOT_DIARY_MEMORY_OPEN_PRIORITY = [
  'recent',
  'journal',
  'personal',
  'group',
  'style',
  'jargon',
  'task',
  'profile'
];

function normalizeText(value) {
  return String(value || '').trim();
}

function uniqueBy(list = [], selector = (item) => item) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(selector(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function safeJsonParse(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

function stripCodeFences(text = '') {
  return String(text || '')
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function normalizeGeneratedQzoneContent(text = '') {
  let output = normalizeText(text);
  if (!output) return '';
  output = output.replace(/^```[\w-]*\s*/i, '').replace(/```$/i, '').trim();
  output = output.replace(/^[“"'`]+/, '').replace(/[”"'`]+$/, '').trim();
  return output;
}

function buildCompactPersonaPrompt(maxChars = 1200) {
  const source = normalizeText(config.SYSTEM_PROMPT);
  if (!source) return '';
  const lines = source
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (!lines.length) return '';
  const picked = [];
  const limit = Math.max(200, Number(maxChars) || 1200);
  let total = 0;
  for (const line of lines) {
    if (total >= limit) break;
    const nextLength = total + line.length + 1;
    if (nextLength > limit) break;
    picked.push(line);
    total = nextLength;
  }
  return picked.join('\n');
}

function detectQzonePostDraftMode(route = {}, cleanText = '') {
  const qqActionKey = normalizeText(route?.meta?.qqActionKey).toLowerCase();
  if (qqActionKey !== 'qq_publish_qzone') return 'manual';

  const text = normalizeText(cleanText);
  if (!text) return 'manual';

  if (/(把这段|这段话|以下内容|正文如下|内容如下|直接发|原样发)/i.test(text)) {
    return 'manual';
  }

  if (/(今天的日记|你自己的日记|bot日记|按你的口吻写并发(空间|说说)|你来写.*日记|帮我写.*日记.*发(空间|说说)|写一条.*日记.*发(空间|说说))/i.test(text)) {
    return 'bot_diary';
  }

  if (/(写一条|写一篇|帮我写|生成一条|生成一篇|日记|说说文案|空间文案)/i.test(text)) {
    return 'generic_autodraft';
  }

  return 'manual';
}

function getTimeBucket(parts = {}) {
  const hour = Number(parts.hour || 0);
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 12) return '上午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '夜里';
}

function formatWeekday(date = new Date(), timezone = config.TIMEZONE) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    weekday: 'long'
  }).format(date);
}

function classifyGroupMood(messages = []) {
  const joined = messages.map((item) => normalizeText(item?.text)).filter(Boolean).join('\n');
  const tags = [];
  if ((joined.match(/[!！]/g) || []).length >= 3) tags.push('情绪偏活跃');
  if ((joined.match(/[?？]/g) || []).length >= 3) tags.push('来回抛话题较多');
  if (/(困|睡|晚安|熬夜|不睡|睡觉)/.test(joined)) tags.push('有人带着困意硬撑');
  if (/(哈哈|笑死|乐|开心|好玩)/.test(joined)) tags.push('气氛偏闹腾');
  if (/(累|忙|烦|崩溃|压力|ddl|作业|考试|加班)/.test(joined)) tags.push('空气里有一点疲惫或压力');
  if (/(吃|饭|夜宵|奶茶|咖啡|零食)/.test(joined)) tags.push('生活碎碎念不少');
  return tags.slice(0, 3);
}

function classifyBotStyle(messages = []) {
  if (!messages.length) return ['最近我存在感不算高'];
  const joined = messages.map((item) => normalizeText(item?.text)).filter(Boolean).join('\n');
  const avgLength = Math.round(
    messages.reduce((sum, item) => sum + Array.from(normalizeText(item?.text)).length, 0) / messages.length
  );
  const tags = [];
  tags.push(avgLength <= 12 ? '最近我说话偏短促' : '最近我说话还算愿意多铺一点');
  if (/[~～]/.test(joined)) tags.push('尾音有点软');
  if (/[!！]/.test(joined)) tags.push('偶尔会冒出一点情绪起伏');
  if (/[?？]/.test(joined)) tags.push('会顺手追问一句');
  if (/\(|（|ฅ|^_|>_|哈/.test(joined)) tags.push('会带一点轻微卖乖或打趣');
  return tags.slice(0, 4);
}

function buildSimilarityWindows(text = '', minLength = 8) {
  const normalized = normalizeText(text).replace(/[\s"'“”‘’`，。！？!?,、:：;；【】\[\]()（）<>《》\-—_]/g, '');
  if (normalized.length < minLength) return [];
  const windows = new Set();
  for (let index = 0; index <= normalized.length - minLength; index += 1) {
    windows.add(normalized.slice(index, index + minLength));
  }
  return Array.from(windows);
}

function extractDiarySignals(groupId = '', options = {}) {
  const recentMessages = Array.isArray(options.recentMessages) ? options.recentMessages : getRecentMessages(groupId);
  const presence = options.presence && typeof options.presence === 'object' ? options.presence : getGroupPresence(groupId);
  const botId = normalizeText(options.botUserId || config.BOT_QQ);
  const botMessages = recentMessages.filter((item) => normalizeText(item?.sender_id) === botId);
  const humanMessages = recentMessages.filter((item) => normalizeText(item?.sender_id) !== botId);
  const now = options.now instanceof Date ? options.now : new Date();
  const parts = getDatePartsInTz(now, config.TIMEZONE);
  const timeBucket = getTimeBucket(parts);
  const weekday = formatWeekday(now, config.TIMEZONE);
  const groupMoodTags = classifyGroupMood(humanMessages);
  const botStyleTags = classifyBotStyle(botMessages);
  const recentNames = humanMessages
    .map((item) => normalizeText(item?.sender_name))
    .filter((item) => item && item.length <= 24)
    .slice(0, 12);
  const quoteWindows = humanMessages
    .flatMap((item) => buildSimilarityWindows(item?.text))
    .slice(0, 80);
  const sourceTypeParts = ['persona'];
  if (botMessages.length) sourceTypeParts.push('bot_recent');
  if (humanMessages.length) sourceTypeParts.push('group_signal');
  if (normalizeText(options.hint)) sourceTypeParts.push('hint');
  return {
    groupId: normalizeText(groupId),
    timeBucket,
    weekday,
    parts,
    presence,
    groupMoodTags,
    botStyleTags,
    recentNames,
    quoteWindows,
    sourceType: sourceTypeParts.join('+'),
    summaryLines: [
      `当前时段: ${weekday}${timeBucket}`,
      `最近群聊窗口: ${recentMessages.length} 条，其中我自己说过 ${botMessages.length} 条，其他人说过 ${humanMessages.length} 条`,
      `群聊节奏: ${humanMessages.length >= 8 ? '偏热闹' : humanMessages.length >= 4 ? '有来有回' : '比较稀薄'}`,
      `我的最近状态: ${botStyleTags.join('，') || '最近我更像在观察'}`,
      `群氛围抽象: ${groupMoodTags.join('，') || '氛围普通，没有明显单一主题'}`,
      `presence状态: state=${normalizeText(presence.state) || 'observing'}, last_action=${normalizeText(presence.last_action) || 'no_reply'}, human_turns_since_bot_reply=${Number(presence.human_turns_since_bot_reply || 0)}`
    ]
  };
}

function sanitizeMemoryQuery(value = '', maxChars = 180) {
  let text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`|;&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(32, Number(maxChars) || 180);
  if (text.length > limit) {
    text = text.slice(0, limit).trim();
  }
  return text;
}

function buildFallbackBotDiaryMemoryQuery(hint = '', signals = {}) {
  const pieces = [
    'bot diary',
    normalizeText(hint),
    `${normalizeText(signals.weekday)}${normalizeText(signals.timeBucket)}`,
    ...(Array.isArray(signals.groupMoodTags) ? signals.groupMoodTags : []),
    ...(Array.isArray(signals.botStyleTags) ? signals.botStyleTags : [])
  ]
    .map((item) => sanitizeMemoryQuery(item, 48))
    .filter(Boolean);

  const fallback = sanitizeMemoryQuery(pieces.join(' '), 180);
  return fallback || 'bot diary 当前群聊氛围 最近状态';
}

function extractAssistantText(response) {
  if (typeof response === 'string') return String(response);
  return String(response?.content || '');
}

function parsePlannerQueryFromResponse(response) {
  const raw = stripCodeFences(extractAssistantText(response));
  if (!raw) return '';

  const direct = safeJsonParse(raw);
  if (direct && typeof direct.query === 'string') {
    return sanitizeMemoryQuery(direct.query);
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return '';
  const parsed = safeJsonParse(jsonMatch[0]);
  if (!parsed || typeof parsed.query !== 'string') return '';
  return sanitizeMemoryQuery(parsed.query);
}

async function planBotDiaryMemoryQuery(input = {}, options = {}) {
  const requester = typeof options.requestAssistantMessage === 'function'
    ? options.requestAssistantMessage
    : require('./graphModelIO').requestAssistantMessage;

  const hint = normalizeText(input.hint);
  const signals = input.signals && typeof input.signals === 'object' ? input.signals : {};
  const fallbackQuery = buildFallbackBotDiaryMemoryQuery(hint, signals);
  const prompt = [
    '你现在只负责为 bot_diary 规划一条 memory_cli 搜索 query。',
    '输出必须是严格 JSON。',
    'JSON 对象只允许一个字段: {"query":"..."}',
    '不要输出 markdown，不要输出解释，不要输出命令，不要输出多余字段。',
    'query 应该短、泛化、像检索词，不要写完整叙事。',
    '宁可抽象，也不要带昵称、精确时间、可识别细节。',
    '',
    '[hint]',
    hint || '无',
    '',
    '[当前时间段]',
    `${normalizeText(signals.weekday)}${normalizeText(signals.timeBucket)}` || '未知',
    '',
    '[bot 最近状态]',
    Array.isArray(signals.botStyleTags) && signals.botStyleTags.length ? signals.botStyleTags.join('，') : '最近状态不明显',
    '',
    '[群氛围摘要]',
    Array.isArray(signals.groupMoodTags) && signals.groupMoodTags.length ? signals.groupMoodTags.join('，') : '群氛围普通',
    '',
    '[补充信号]',
    ...(Array.isArray(signals.summaryLines) ? signals.summaryLines.slice(0, 4) : [])
  ].join('\n');

  try {
    const response = await requester([
      { role: 'system', content: prompt },
      { role: 'user', content: '只输出严格 JSON。' }
    ], {
      disableTools: true,
      modelConfig: options.modelConfig || null
    });
    const plannedQuery = parsePlannerQueryFromResponse(response);
    if (plannedQuery) {
      return {
        query: plannedQuery,
        usedFallback: false
      };
    }
  } catch (_) {}

  return {
    query: fallbackQuery,
    usedFallback: true
  };
}

function redactMemoryEvidenceText(value = '', maxChars = 280) {
  let text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '某个时间')
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/g, '某一天')
    .replace(/(^|[^\d])\d{5,12}([^\d]|$)/g, '$1某串编号$2')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(80, Number(maxChars) || 280);
  if (text.length > limit) {
    text = `${text.slice(0, limit - 3).trim()}...`;
  }
  return text;
}

function buildBotDiaryMemoryContext(memoryUserId = '', groupId = '') {
  const safeUserId = normalizeText(memoryUserId);
  const safeGroupId = normalizeText(groupId);
  const sessionId = `${safeUserId}${safeGroupId}`;
  return {
    userId: safeUserId,
    groupId: safeGroupId,
    channelId: safeGroupId,
    sessionId,
    sessionKey: sessionId,
    routePolicyKey: 'qq_publish_qzone.bot_diary',
    topRouteType: 'qq_publish_qzone'
  };
}

function isExpectedMemorySearchPayload(payload) {
  return Boolean(
    payload
    && payload.ok === true
    && payload.command === 'search'
    && Array.isArray(payload.results)
    && Number.isFinite(Number(payload.count))
  );
}

function isExpectedMemoryOpenPayload(payload) {
  return Boolean(payload && payload.ok === true && payload.command === 'open' && payload.data);
}

function buildSearchDigestLines(searchPayload = {}) {
  if (Array.isArray(searchPayload.digest) && searchPayload.digest.length) {
    return searchPayload.digest.map((item) => redactMemoryEvidenceText(item, 120)).filter(Boolean).slice(0, 4);
  }
  if (!Array.isArray(searchPayload.results) || !searchPayload.results.length) {
    return ['无命中，按当前状态自然生成。'];
  }
  return searchPayload.results
    .slice(0, 4)
    .map((item) => {
      const source = normalizeText(item?.source) || 'memory';
      const preview = redactMemoryEvidenceText(item?.preview || item?.text || item?.title || '', 120);
      return preview ? `${source}: ${preview}` : '';
    })
    .filter(Boolean);
}

function pickBotDiaryOpenCandidate(results = []) {
  const items = Array.isArray(results) ? results : [];
  for (const source of BOT_DIARY_MEMORY_OPEN_PRIORITY) {
    const found = items.find((item) => normalizeText(item?.source).toLowerCase() === source && normalizeText(item?.ref));
    if (found) return found;
  }
  return null;
}

function summarizeOpenedMemory(openPayload = {}, fallbackSource = '') {
  const source = normalizeText(openPayload?.source || fallbackSource);
  const data = openPayload?.data && typeof openPayload.data === 'object' ? openPayload.data : {};
  const fragments = [];

  if (normalizeText(data.shortTermSummary)) fragments.push(data.shortTermSummary);
  if (normalizeText(data.summary)) fragments.push(data.summary);
  if (normalizeText(data.impression)) fragments.push(data.impression);
  if (normalizeText(data.text)) fragments.push(data.text);
  if (normalizeText(data.title)) fragments.push(data.title);

  if (data.profile && typeof data.profile === 'object') {
    const profileBits = [];
    const relationStage = normalizeText(data.profile.relation_stage);
    if (relationStage) profileBits.push(`关系阶段:${relationStage}`);
    for (const key of ['identities', 'personality_traits', 'likes', 'dislikes', 'recent_topics']) {
      const values = Array.isArray(data.profile[key]) ? data.profile[key].map((item) => normalizeText(item)).filter(Boolean).slice(0, 2) : [];
      if (values.length) profileBits.push(values.join('，'));
    }
    if (profileBits.length) fragments.push(profileBits.join('；'));
  }

  if (Array.isArray(data.facts) && data.facts.length) {
    fragments.push(data.facts.map((item) => normalizeText(item)).filter(Boolean).slice(0, 2).join('；'));
  }

  if (Array.isArray(data.recentMessages) && data.recentMessages.length && !fragments.length) {
    fragments.push(data.recentMessages.map((item) => normalizeText(item?.content)).filter(Boolean).slice(0, 2).join('；'));
  }

  const summary = redactMemoryEvidenceText(fragments.filter(Boolean).join('；'), 280);
  if (!summary) return source ? `${source}: 已打开一条记忆，但可用摘要为空。` : '已打开一条记忆，但可用摘要为空。';
  return source ? `${source}: ${summary}` : summary;
}

async function runBotDiaryMemoryPrefetch(input = {}, options = {}) {
  const runMemoryCli = typeof options.runMemoryCli === 'function'
    ? options.runMemoryCli
    : require('../utils/memoryCli').runMemoryCli;
  const recordMemoryScope = typeof options.recordMemoryScope === 'function'
    ? options.recordMemoryScope
    : require('../utils/memoryScopeIndex').recordMemoryScope;

  const memoryUserId = normalizeText(input.memoryUserId || config.BOT_QQ);
  const groupId = normalizeText(input.groupId);
  const query = sanitizeMemoryQuery(input.query);
  const memoryContext = buildBotDiaryMemoryContext(memoryUserId, groupId);

  if (typeof recordMemoryScope !== 'function') {
    return {
      ok: false,
      failureStage: 'record_scope',
      reason: 'recordMemoryScope unavailable',
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['记忆作用域初始化失败。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  if (typeof runMemoryCli !== 'function') {
    return {
      ok: false,
      failureStage: 'search',
      reason: 'runMemoryCli unavailable',
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['memory_cli 不可用。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  try {
    recordMemoryScope(memoryUserId, { groupId });
  } catch (error) {
    return {
      ok: false,
      failureStage: 'record_scope',
      reason: String(error?.message || error || 'record scope failed'),
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['记忆作用域初始化失败。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  const searchCommand = `mem search --query ${JSON.stringify(query)} --source all --limit 6`;
  let searchPayload = null;
  try {
    searchPayload = await runMemoryCli(searchCommand, memoryContext);
  } catch (error) {
    return {
      ok: false,
      failureStage: 'search',
      reason: String(error?.message || error || 'memory search failed'),
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['memory search 执行失败。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  if (!isExpectedMemorySearchPayload(searchPayload)) {
    return {
      ok: false,
      failureStage: 'search',
      reason: 'unexpected memory search payload',
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['memory search 返回结构异常。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: '',
      rawSearchPayload: searchPayload
    };
  }

  const searchCount = Number(searchPayload.count || 0) || 0;
  const searchDigestLines = buildSearchDigestLines(searchPayload);
  const openCandidate = searchCount > 0 ? pickBotDiaryOpenCandidate(searchPayload.results) : null;
  let openUsed = false;
  let openedRef = '';
  let openedMemorySummary = '';
  let memoryFailureStage = '';

  if (openCandidate && normalizeText(openCandidate.ref)) {
    const openCommand = `mem open --ref ${JSON.stringify(normalizeText(openCandidate.ref))}`;
    try {
      const openPayload = await runMemoryCli(openCommand, memoryContext);
      if (isExpectedMemoryOpenPayload(openPayload)) {
        openUsed = true;
        openedRef = normalizeText(openCandidate.ref);
        openedMemorySummary = summarizeOpenedMemory(openPayload, openCandidate.source);
      } else {
        memoryFailureStage = 'open';
      }
    } catch (_) {
      memoryFailureStage = 'open';
    }
  }

  return {
    ok: true,
    query,
    memoryOwner: memoryUserId,
    searchCount,
    searchDigestLines,
    searchPayload,
    openUsed,
    openedRef,
    openedMemorySummary,
    memoryFailureStage
  };
}

function buildMemoryEvidenceLines(memoryEvidence = {}) {
  const owner = normalizeText(memoryEvidence.memoryOwner) || normalizeText(config.BOT_QQ);
  const query = sanitizeMemoryQuery(memoryEvidence.query);
  const searchDigestLines = Array.isArray(memoryEvidence.searchDigestLines) && memoryEvidence.searchDigestLines.length
    ? memoryEvidence.searchDigestLines
    : ['无命中，按当前状态自然生成。'];
  const openedMemory = normalizeText(memoryEvidence.openedMemorySummary) || '未打开额外记忆。';

  return [
    '[记忆证据块]',
    `memory owner: ${owner}`,
    `query: ${query || '无'}`,
    'search digest:',
    ...searchDigestLines.map((item) => `- ${item}`),
    `opened memory: ${openedMemory}`,
    '使用规则: 这些内容只当弱回忆素材使用。',
    '绝对不要复述原文，不要暴露昵称、精确时间、可识别细节，不要做具体事件复盘。'
  ];
}

function buildBotDiaryPrompt({ hint = '', signals = {}, strict = false, memoryEvidence = {}, variationProfile = {}, recentHistory = [] } = {}) {
  const compactPersona = buildCompactPersonaPrompt(1200);
  const weakHint = normalizeText(hint);
  const promptLines = [
    '你现在只负责写一条可以直接发布到 QQ 空间的中文日记正文。',
    '这不是代写用户日记，而是 bot 自己的日记。',
    '必须使用第一人称“我”。',
    '长度固定在 80 到 180 字之间，2 到 5 句自然短句。',
    '内容重心必须放在我自己的感受、观察、别扭、轻微阴阳怪气和嘴硬式关怀。',
    '允许轻轻提到群里的人或群聊氛围，但只能泛化提及，不得出现可识别的个人信息。',
    '对他人的提及最多 1 到 2 个短分句，总占比不要超过约 30%。',
    '不要写标题、标签、项目符号、引号、括号说明，也不要解释规则。',
    '绝对禁止出现昵称、@、QQ号、手机号、链接、精确时间点、可回溯事件细节、用户原话或近似转述。',
    '绝对禁止出现 AI、模型、系统提示、记忆、日志、planner、agent、tool、NapCat、cookie、权限、边界 这类元信息。'
  ];
  if (strict) {
    promptLines.push('这次必须更保守：宁可更抽象、更像自言自语，也不要出现任何可识别对象或具体事件。');
    promptLines.push('如果想提别人，只能写成“群里有人”“某个夜猫子”“那个让我想翻白眼的人”这种泛化表达。');
  }
  promptLines.push('');
  promptLines.push('[主人格摘要]');
  promptLines.push(compactPersona || '自然、别扭、会关心人，但不直白邀功。');
  promptLines.push('');
  promptLines.push(buildVariationProfilePrompt(variationProfile || {}));
  promptLines.push('');
  promptLines.push(buildVariationConstraintPrompt({ recentHistory }));
  promptLines.push('');
  promptLines.push('[当前群抽象信号]');
  promptLines.push(...(Array.isArray(signals.summaryLines) ? signals.summaryLines : ['当前群信号不足，改写成偏自言自语的状态。']));
  promptLines.push('');
  promptLines.push('[管理员弱提示]');
  promptLines.push(weakHint ? `${weakHint}（只可作为很弱的方向提示，不能把管理员写成叙事主角）` : '无。素材不足时改写成时间段驱动的自述。');
  promptLines.push('');
  promptLines.push(...buildMemoryEvidenceLines(memoryEvidence));
  promptLines.push('');
  promptLines.push('只输出最终正文。');
  return promptLines.join('\n');
}

function buildBotDiaryPromptFromPlan({ hint = '', signals = {}, strict = false, memoryEvidence = {}, plan = {}, recentHistory = [] } = {}) {
  const compactPersona = buildCompactPersonaPrompt(1200);
  const weakHint = normalizeText(hint);
  const promptLines = [
    '你现在只负责写一条可以直接发布到 QQ 空间的中文日记正文。',
    '这不是代写用户日记，而是 bot 自己的日记。',
    '必须使用第一人称“我”。',
    '长度固定在 80 到 180 字之间，2 到 5 句自然短句。',
    '内容重心必须放在我自己的感受、观察、别扭、轻微阴阳怪气和嘴硬式关怀。',
    '允许轻轻提到群里的人或群聊氛围，但只能泛化提及，不得出现可识别的个人信息。',
    '对他人的提及最多 1 到 2 个短分句，总占比不要超过约 30%。',
    '不要写标题、标签、项目符号、引号、括号说明，也不要解释规则。',
    '绝对禁止出现昵称、@、QQ号、手机号、链接、精确时间点、可回溯事件细节、用户原话或近似转述。'
  ];
  if (strict) {
    promptLines.push('这次必须更保守：宁可更抽象、更像自言自语，也不要出现任何可识别对象或具体事件。');
  }
  promptLines.push('');
  promptLines.push('[主人格摘要]');
  promptLines.push(compactPersona || '自然、别扭、会关心人，但不直白邀功。');
  promptLines.push('');
  promptLines.push(buildPlanPrompt(plan, { type: 'bot_diary' }));
  promptLines.push('');
  promptLines.push('[当前群抽象信号]');
  promptLines.push(...(Array.isArray(signals.summaryLines) ? signals.summaryLines : ['当前群信号不足，改写成偏自言自语的状态。']));
  promptLines.push('');
  promptLines.push('[管理员弱提示]');
  promptLines.push(weakHint ? `${weakHint}（只可作为很弱的方向提示，不能把管理员写成叙事主角）` : '无。素材不足时改写成时间段驱动的自述。');
  promptLines.push('');
  promptLines.push(...buildMemoryEvidenceLines(memoryEvidence));
  promptLines.push('');
  promptLines.push(`最近失败原因: ${(Array.isArray(recentHistory) ? recentHistory : []).map((item) => item.reason).filter(Boolean).slice(-3).join(' / ') || '无'}`);
  promptLines.push('');
  promptLines.push('只输出最终正文。');
  return promptLines.join('\n');
}

function splitSentenceLike(text = '') {
  return normalizeText(text)
    .split(/[。！？!?]/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function findDiarySafetyIssues(content = '', signals = {}) {
  const text = normalizeGeneratedQzoneContent(content);
  if (!text) return ['empty'];
  const issues = [];
  const charCount = Array.from(text).length;
  const sentenceCount = splitSentenceLike(text).length;
  if (!/我/.test(text)) issues.push('not_first_person');
  if (charCount < 80 || charCount > 180) issues.push('length_out_of_range');
  if (sentenceCount < 2 || sentenceCount > 5) issues.push('sentence_count_out_of_range');
  if (/@|＠/.test(text)) issues.push('mention');
  if (/https?:\/\/|www\./i.test(text)) issues.push('link');
  if (/(^|[^\d])1\d{10}([^\d]|$)/.test(text)) issues.push('phone');
  if (/(^|[^\d])\d{5,12}([^\d]|$)/.test(text)) issues.push('qq_number');
  if (/\b\d{1,2}:\d{2}\b|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(text)) issues.push('exact_time');
  if (/[“”"'`「」『』]/.test(text)) issues.push('quotes');
  if (INTERNAL_LEAK_TERMS.some((term) => text.toLowerCase().includes(term.toLowerCase()))) issues.push('internal_meta');
  if (Array.isArray(signals.recentNames) && signals.recentNames.some((name) => name && text.includes(name))) issues.push('nickname');
  const normalized = text.replace(/[\s"'“”‘’`，。！？!?,、:：;；【】\[\]()（）<>《》\-—_]/g, '');
  if (Array.isArray(signals.quoteWindows) && signals.quoteWindows.some((window) => window && normalized.includes(window))) {
    issues.push('quote_like');
  }
  return Array.from(new Set(issues));
}

async function runDiaryDraftGeneration(prompt = '', options = {}) {
  const requester = typeof options.requestAssistantMessage === 'function'
    ? options.requestAssistantMessage
    : require('./graphModelIO').requestAssistantMessage;
  const response = await requester([
    { role: 'system', content: prompt },
    { role: 'user', content: '写成 bot 自己的空间日记正文。' }
  ], {
    disableTools: true,
    modelConfig: options.modelConfig || null
  });
  if (typeof response === 'string') return normalizeGeneratedQzoneContent(response);
  return normalizeGeneratedQzoneContent(response?.content || '');
}

function buildBotDiaryMeta(signals = {}, overrides = {}) {
  return {
    mode: 'bot_diary',
    sourceType: signals.sourceType || 'unknown',
    hour: Number(signals?.parts?.hour || 0),
    weekday: normalizeText(signals.weekday),
    timeBucket: normalizeText(signals.timeBucket),
    groupMoodTags: Array.isArray(signals.groupMoodTags) ? signals.groupMoodTags.slice(0, 3) : [],
    botStyleTags: Array.isArray(signals.botStyleTags) ? signals.botStyleTags.slice(0, 4) : [],
    charCount: 0,
    filterResult: 'blocked',
    memoryOwner: normalizeText(overrides.memoryOwner),
    memoryQuery: normalizeText(overrides.memoryQuery),
    memorySearchCount: Math.max(0, Number(overrides.memorySearchCount || 0) || 0),
    memoryOpenUsed: Boolean(overrides.memoryOpenUsed),
    memoryOpenedRef: normalizeText(overrides.memoryOpenedRef),
    memoryFailureStage: normalizeText(overrides.memoryFailureStage),
    topicGroup: normalizeText(overrides.topicGroup),
    topicKey: normalizeText(overrides.topicKey),
    lens: normalizeText(overrides.lens),
    emotion: normalizeText(overrides.emotion),
    anchor: normalizeText(overrides.anchor),
    structure: normalizeText(overrides.structure),
    ending: normalizeText(overrides.ending)
  };
}

async function generateBotDiaryDraft(input = {}, options = {}) {
  const groupId = normalizeText(input.groupId);
  if (!groupId) {
    return {
      ok: false,
      reason: 'groupId missing',
      meta: buildBotDiaryMeta({ sourceType: 'invalid' }, {
        memoryOwner: normalizeText(options.memoryUserId || config.BOT_QQ)
      })
    };
  }

  const hint = normalizeText(input.hint);
  const memoryUserId = normalizeText(options.memoryUserId || config.BOT_QQ);
  const recentSuccessHistory = require('../core/qzoneGenerationState').getRecentQzoneHistory();
  const recentFailureHistory = getRecentFailureLikeEntries();
  const signals = extractDiarySignals(groupId, {
    recentMessages: options.recentMessages,
    presence: options.presence,
    hint,
    botUserId: options.botUserId || memoryUserId,
    now: options.now
  });

  const plannedQuery = await planBotDiaryMemoryQuery({
    hint,
    signals
  }, options);

  const memoryPrefetch = await (
    typeof options.runBotDiaryMemoryPrefetch === 'function'
      ? options.runBotDiaryMemoryPrefetch({
        groupId,
        query: plannedQuery.query,
        memoryUserId
      }, options)
      : runBotDiaryMemoryPrefetch({
        groupId,
        query: plannedQuery.query,
        memoryUserId
      }, options)
  );

  const baseMeta = buildBotDiaryMeta(signals, {
    memoryOwner: memoryPrefetch.memoryOwner || memoryUserId,
    memoryQuery: memoryPrefetch.query || plannedQuery.query,
    memorySearchCount: memoryPrefetch.searchCount,
    memoryOpenUsed: memoryPrefetch.openUsed,
    memoryOpenedRef: memoryPrefetch.openedRef,
    memoryFailureStage: memoryPrefetch.memoryFailureStage
  });

  if (!memoryPrefetch.ok) {
    return {
      ok: false,
      reason: 'bot diary memory search failed',
      meta: {
        ...baseMeta,
        filterResult: 'blocked',
        memoryFailureStage: normalizeText(memoryPrefetch.failureStage || baseMeta.memoryFailureStage || 'search')
      }
    };
  }

  let finalFailure = '日记草稿未通过安全过滤';
  for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
    const plan = buildQzonePlan({
      source: 'bot_diary',
      type: 'bot_diary',
      windowKey: signals.timeBucket || '',
      groupId,
      today: `${signals.weekday || ''}:${signals.timeBucket || ''}`,
      planAttempt,
      now: Date.now(),
      recentHistory: recentSuccessHistory,
      recentFailures: recentFailureHistory,
      allowImage: true,
      targetLength: '80-180'
    });
    const candidates = [];
    for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
      const strict = candidateIndex > 0;
      const prompt = buildCandidatePrompt(
        buildBotDiaryPromptFromPlan({
          hint,
          signals,
          strict,
          memoryEvidence: memoryPrefetch,
          plan,
          recentHistory: recentFailureHistory
        }),
        plan,
        candidateIndex > 0 ? `这是第 ${candidateIndex + 1} 个候选，请显著拉开与前一个版本的开头、节奏和落点。` : ''
      );
      const modelConfig = getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : '');
      const content = await runDiaryDraftGeneration(prompt, {
        ...options,
        modelConfig
      });
      const issues = findDiarySafetyIssues(content, signals);
      candidates.push({
        plan,
        text: content,
        rejected: issues.length > 0,
        rejectionReason: issues.join(','),
        meta: {
          lens: plan.variationProfile?.lens || '',
          emotion: plan.variationProfile?.emotion || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          ending: plan.variationProfile?.ending || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || '',
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : ''
        }
      });
    }

    const picked = pickBestCandidate(candidates, {
      source: 'bot_diary',
      recentHistory: recentSuccessHistory,
      plan
    });
    const selected = picked.selected;
    if (selected) {
      const imageConsistency = evaluateImageConsistency({
        text: selected.text,
        plan
      });
      const meta = {
        ...baseMeta,
        charCount: Array.from(selected.text).length,
        filterResult: 'pass',
        topicKey: plan.theme?.key || '',
        topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
        lens: plan.variationProfile?.lens || '',
        emotion: plan.variationProfile?.emotion || '',
        anchor: plan.variationProfile?.anchor || '',
        structure: plan.variationProfile?.structure || '',
        ending: plan.variationProfile?.ending || '',
        arc: plan.variationProfile?.arc || '',
        tempo: plan.variationProfile?.tempo || '',
        distance: plan.variationProfile?.distance || '',
        imageIntent: plan.imageIntent || null,
        imagePromptHints: buildVisualPromptHints(plan),
        imageConsistencyScore: imageConsistency.score,
        imageShouldDegrade: !imageConsistency.consistent,
        imageDuplicateRisk: imageConsistency.duplicate,
        planFingerprint: plan.fingerprint
      };
      appendQzoneGenerationLog(normalizeTelemetryPayload({
        source: 'bot_diary',
        type: 'bot_diary',
        groupId,
        status: 'sent',
        selectedFingerprint: selected.fingerprint,
        selectedScore: selected.score,
        similarity: selected.similarity,
        imageConsistencyScore: imageConsistency.score,
        failureReasons: [],
        planSummary: {
          fingerprint: plan.fingerprint,
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
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
      console.log('[qzone-diary] generated', JSON.stringify(meta));
      return {
        ok: true,
        content: selected.text,
        meta
      };
    }

    finalFailure = picked.ranked[0]?.rejectionReason || 'plan-candidate-rejected';
    appendQzoneGenerationLog(normalizeTelemetryPayload({
      source: 'bot_diary',
      type: 'bot_diary',
      groupId,
      status: 'failed',
      selectedFingerprint: '',
      selectedScore: 0,
      similarity: 0,
      failureReasons: uniqueBy(
        picked.ranked.map((item) => item.rejectionReason).filter(Boolean),
        (item) => item
      ),
      planSummary: {
        fingerprint: plan.fingerprint,
        topicKey: plan.theme?.key || '',
        topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
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

  return {
    ok: false,
    reason: finalFailure || '日记草稿未通过安全过滤',
    meta: {
      ...baseMeta,
      filterResult: 'blocked'
    }
  };
}

function buildGenericAutodraftPrompt(requestText = '', options = {}) {
  const profile = options.variationProfile || {};
  const recentHistory = Array.isArray(options.recentHistory) ? options.recentHistory : [];
  const plan = options.plan || {
    type: 'generic_autodraft',
    variationProfile: profile,
    fingerprint: '',
    sceneAnchors: [],
    emotionalArc: '',
    targetLength: '80-180',
    theme: null,
    microTheme: null,
    bannedRepeats: { openings: [], planFingerprints: [] }
  };
  const randomness = describeGenericAutodraftRandomness(requestText);
  return [
    '你现在只负责代写一条可以直接发布到 QQ 空间的中文正文。',
    '必须使用第一人称，语气自然，像今天写的日记或状态。',
    '优先根据用户原话推断主题、心情、长度和风格。',
    '默认写成 80 到 180 字。',
    '不要解释，不要提问，不要使用标题、项目符号、引号、标签或前缀。',
    '不要提到自己是 AI。',
    randomness.useFullVariation
      ? '用户没有明确锁死主题/长度/口吻时，你要主动换写法，不要套固定句式。'
      : '如果用户已经明确指定主题、长度或口吻，只在未指定维度上保留变化。',
    buildPlanPrompt(plan, { type: 'generic_autodraft' }),
    `最近失败原因: ${recentHistory.map((item) => item.reason).filter(Boolean).slice(-3).join(' / ') || '无'}`,
    '只输出最终可发布正文。',
    `用户请求: ${String(requestText || '').trim()}`
  ].filter(Boolean).join('\n');
}

async function generateGenericQzoneDraft(input = {}, options = {}) {
  const requestText = normalizeText(input.requestText || input.hint || '');
  const recentHistory = require('../core/qzoneGenerationState').getRecentQzoneHistory();
  const recentFailures = getRecentFailureLikeEntries();
  let finalFailure = '';
  for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
    const plan = buildQzonePlan({
      source: 'generic_autodraft',
      type: 'generic_autodraft',
      windowKey: '',
      groupId: normalizeText(input.groupId),
      today: '',
      planAttempt,
      now: Date.now(),
      recentHistory,
      recentFailures,
      allowImage: false,
      targetLength: '80-180'
    });
    const candidates = [];
    for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
      const prompt = buildCandidatePrompt(
        buildGenericAutodraftPrompt(requestText, {
          variationProfile: plan.variationProfile || {},
          recentHistory: recentFailures,
          plan
        }),
        plan,
        candidateIndex > 0 ? `这是第 ${candidateIndex + 1} 个候选，请更换叙事节奏和切入角度。` : ''
      );
      const response = await runDiaryDraftGeneration(prompt, {
        ...options,
        modelConfig: getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : '')
      });
      const normalized = normalizeGeneratedQzoneContent(response);
      const firstPerson = /我/.test(normalized);
      candidates.push({
        plan,
        text: normalized,
        rejected: !normalized || !firstPerson,
        rejectionReason: !normalized ? 'empty-output' : (!firstPerson ? 'not_first_person' : ''),
        meta: {
          mode: 'generic_autodraft',
          lens: plan.variationProfile?.lens || '',
          emotion: plan.variationProfile?.emotion || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          ending: plan.variationProfile?.ending || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || ''
        }
      });
    }
    const picked = pickBestCandidate(candidates, {
      source: 'generic_autodraft',
      recentHistory,
      plan
    });
    const selected = picked.selected;
    if (selected) {
      appendQzoneGenerationLog(normalizeTelemetryPayload({
        source: 'generic_autodraft',
        type: 'generic_autodraft',
        groupId: normalizeText(input.groupId),
        status: 'sent',
        selectedFingerprint: selected.fingerprint,
        selectedScore: selected.score,
        similarity: selected.similarity,
        failureReasons: [],
        planSummary: {
          fingerprint: plan.fingerprint,
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
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
        ok: true,
        content: selected.text,
        meta: {
          mode: 'generic_autodraft',
          lens: plan.variationProfile?.lens || '',
          emotion: plan.variationProfile?.emotion || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          ending: plan.variationProfile?.ending || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || '',
          similarity: selected.similarity,
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
          planFingerprint: plan.fingerprint
        }
      };
    }
    finalFailure = picked.ranked[0]?.rejectionReason || 'generic_autodraft_rejected';
    appendQzoneGenerationLog(normalizeTelemetryPayload({
      source: 'generic_autodraft',
      type: 'generic_autodraft',
      groupId: normalizeText(input.groupId),
      status: 'failed',
      selectedFingerprint: '',
      selectedScore: 0,
      similarity: 0,
      failureReasons: uniqueBy(picked.ranked.map((item) => item.rejectionReason).filter(Boolean), (item) => item),
      planSummary: {
        fingerprint: plan.fingerprint,
        topicKey: plan.theme?.key || '',
        topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
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
  return {
    ok: false,
    reason: finalFailure || 'generic qzone draft generation failed',
    meta: {
      mode: 'generic_autodraft'
    }
  };
}

module.exports = {
  INTERNAL_LEAK_TERMS,
  buildBotDiaryPrompt,
  buildGenericAutodraftPrompt,
  buildFallbackBotDiaryMemoryQuery,
  detectQzonePostDraftMode,
  extractDiarySignals,
  findDiarySafetyIssues,
  generateBotDiaryDraft,
  generateGenericQzoneDraft,
  normalizeGeneratedQzoneContent,
  planBotDiaryMemoryQuery,
  recordQzoneGenerationHistory,
  runBotDiaryMemoryPrefetch
};
