const config = require('../../config');
const { getDatePartsInTz } = require('../../utils/time');

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
  const getRecentMessages = typeof options.getRecentMessages === 'function' ? options.getRecentMessages : () => [];
  const getGroupPresence = typeof options.getGroupPresence === 'function' ? options.getGroupPresence : () => ({});
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

function buildQzoneVariantNote(variantType = '') {
  const normalized = normalizeText(variantType).toLowerCase();
  if (normalized === 'edge_variant') {
    return '这个候选要允许一点坏劲和嘴硬感，可以有轻微冷转、轻阴阳怪气或小反差，但不能攻击人。';
  }
  if (normalized === 'image_variant') {
    return '这个候选优先增强画面、动作和可截图感，让图文 vibe 更一致。';
  }
  return '这个候选优先写得像真人会随手发圈的碎碎念，自然、不装、能被截图。';
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

module.exports = {
  INTERNAL_LEAK_TERMS,
  BOT_DIARY_MEMORY_OPEN_PRIORITY,
  normalizeText,
  uniqueBy,
  safeJsonParse,
  stripCodeFences,
  normalizeGeneratedQzoneContent,
  detectQzonePostDraftMode,
  getTimeBucket,
  formatWeekday,
  classifyGroupMood,
  classifyBotStyle,
  buildSimilarityWindows,
  extractDiarySignals,
  sanitizeMemoryQuery,
  buildFallbackBotDiaryMemoryQuery,
  extractAssistantText,
  parsePlannerQueryFromResponse,
  redactMemoryEvidenceText,
  isExpectedMemorySearchPayload,
  isExpectedMemoryOpenPayload,
  buildSearchDigestLines,
  pickBotDiaryOpenCandidate,
  summarizeOpenedMemory,
  buildMemoryEvidenceLines,
  buildQzoneVariantNote,
  splitSentenceLike,
  findDiarySafetyIssues
};
