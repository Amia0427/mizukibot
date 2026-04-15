const config = require('../config');
const { getRecentMessages, getGroupPresence } = require('../utils/groupAwarenessState');
const { getDailyJournalRetrievalBundle } = require('../utils/dailyJournal');

const KNOWLEDGE_LIBRARY = Object.freeze([
  { key: 'animal-behavior', label: '动物行为' },
  { key: 'history-detail', label: '历史冷知识' },
  { key: 'space-science', label: '天文宇宙' },
  { key: 'psychology-bias', label: '心理偏差' },
  { key: 'daily-skill', label: '生活小技巧' },
  { key: 'language-origin', label: '语言文字' },
  { key: 'food-science', label: '食物科学' },
  { key: 'design-observation', label: '设计观察' }
]);

const RECOMMENDATION_LIBRARY = Object.freeze([
  { key: 'book-mystery', label: '悬疑小说' },
  { key: 'movie-healing', label: '治愈电影' },
  { key: 'anime-daily', label: '日常动画' },
  { key: 'music-night', label: '夜晚歌单' },
  { key: 'podcast-story', label: '故事播客' },
  { key: 'game-indie', label: '独立游戏' },
  { key: 'food-late', label: '夜宵美食' },
  { key: 'series-suspense', label: '悬疑剧集' }
]);

const STYLE_HINTS = Object.freeze({
  quiet: '群里现在比较安静，语气轻一点，像顺手接一句，不要写成公告。',
  casual: '语气自然随意，像熟人群里顺手说一句，不要写成公告。',
  playful: '可以稍微轻松一点，但别油腻，别玩梗过头，也不要写成公告。',
  focused: '群里更偏信息交流，语气简洁清楚，少卖萌，像讨论里自然插一句。'
});

const FINGERPRINT_PREFIX_PATTERNS = Object.freeze([
  /^大家好[，。！？\s]*/i,
  /^早上好[，。！？\s]*/i,
  /^晚上好[，。！？\s]*/i,
  /^中午好[，。！？\s]*/i,
  /^顺手分享一下[：:，。！？\s]*/i,
  /^顺手说一句[：:，。！？\s]*/i,
  /^看到一个[：:，。！？\s]*/i,
  /^突然想到[：:，。！？\s]*/i,
  /^刚看到[：:，。！？\s]*/i,
  /^分享一个[：:，。！？\s]*/i
]);

const ANNOUNCEMENT_PATTERNS = Object.freeze([
  /今日分享/i,
  /为你播报/i,
  /系统触发/i,
  /调度/i,
  /工具调用/i,
  /daily\s*share/i
]);

const TITLE_PARTY_START_PATTERNS = Object.freeze([
  /^震惊[\s，：:]/,
  /^重磅[\s，：:]/,
  /^速看[\s，：:]/,
  /^突发[\s，：:]/,
  /^刚刚[\s，：:]/,
  /^紧急[\s，：:]/
]);

const QZONE_FIRST_PERSON_PATTERNS = Object.freeze([
  /(^|[，。！？\s])(我|我今天|我刚|我还|我又|我在|我想|我把|我的)(?=[^\n]{0,24})/,
  /(^|[，。！？\s])(现在|刚刚|刚才|有点|准备|还在|刚醒|睡不着|突然想)(?=[^\n]{0,24})/,
  /\b(i|my|me)\b/i
]);

const QZONE_BROADCAST_PATTERNS = Object.freeze([
  /大家/,
  /群里/,
  /各位/,
  /今日分享/,
  /播报/,
  /系统/,
  /触发/,
  /调度/,
  /管理员/,
  /打卡通知/,
  /daily\s*share/i
]);

const QZONE_RISK_PATTERNS = Object.freeze([
  /不想活/,
  /活着没意思/,
  /结束一切/,
  /想消失/,
  /不如去死/,
  /自杀/,
  /割腕/,
  /轻生/,
  /跳楼/
]);

const QZONE_PRIVATE_DETAIL_PATTERNS = Object.freeze([
  /@[\w\u4e00-\u9fa5_-]+/,
  /https?:\/\/\S+/i,
  /www\.\S+/i,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/,
  /\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/,
  /\d{1,2}月\d{1,2}日/,
  /(^|[^\d])1\d{10}([^\d]|$)/,
  /(^|[^\d])\d{5,12}([^\d]|$)/,
  /[“”"「『][^“”"「『」』\n]{0,40}[”"」』]/,
  /(有人|谁)[^\n]{0,8}(说|问|提到|聊到)/,
  /[^\s，。！？、]{1,12}(说|问|提到|聊到)[:：]/
]);

function normalizeText(value, maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function stableIndex(seed = '', size = 1) {
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  const total = Math.max(1, Number(size) || 1);
  return Math.abs(hash) % total;
}

function getRecentHumanMessages(groupId, maxItems = 8) {
  const botId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  return getRecentMessages(groupId)
    .filter((item) => String(item?.sender_id || '').trim() !== botId)
    .filter((item) => String(item?.text || '').trim())
    .slice(-Math.max(1, Number(maxItems) || 8));
}

function summarizeRecentMessages(groupId, maxItems = 8) {
  return getRecentMessages(groupId)
    .slice(-Math.max(1, Number(maxItems) || 8))
    .map((item) => {
      const sender = normalizeText(item?.sender_name || item?.sender_id || '成员', 24);
      const text = normalizeText(item?.text || '', 80);
      if (!text) return '';
      return `${sender}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeRecentShares(stateEntry, maxItems = 3) {
  return (Array.isArray(stateEntry?.recentShares) ? stateEntry.recentShares : [])
    .slice(-Math.max(1, Number(maxItems) || 3))
    .map((item) => `${item.type}: ${normalizeText(item.summary || '', 80)}`)
    .filter(Boolean)
    .join('\n');
}

function isPlayfulMessage(text = '') {
  return /(?:哈哈|哈+|233|hhh+|xswl|www|lol|笑死|好玩|!)/i.test(String(text || ''));
}

function isFocusedMessage(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (value.length >= 24) return true;
  if (/[0-9]{2,}|https?:\/\/|[:：]/.test(value)) return true;
  return /(问题|方案|步骤|建议|需要|可以|应该|测试|日志|接口|代码|版本|排查|更新|进度|原因|结果|issue|plan|test|log|api|code)/i.test(value);
}

function getDailyShareStyleTag(groupId, now = Date.now()) {
  const recent = getRecentHumanMessages(groupId, 8);
  if (recent.length < 4) return 'quiet';

  const lastHumanAt = Math.max(0, Number(recent[recent.length - 1]?.timestamp || 0) || 0);
  if (!lastHumanAt || (Math.max(0, Number(now || Date.now())) - lastHumanAt) > (120 * 60 * 1000)) {
    return 'quiet';
  }

  const playfulHits = recent.filter((item) => isPlayfulMessage(item?.text || '')).length;
  if (playfulHits >= 3 && (playfulHits / recent.length) >= 0.375) {
    return 'playful';
  }

  const texts = recent.map((item) => String(item?.text || '').trim()).filter(Boolean);
  const avgLength = texts.length
    ? texts.reduce((sum, item) => sum + item.length, 0) / texts.length
    : 0;
  let consecutiveFocused = 0;
  let maxConsecutiveFocused = 0;
  let focusedHits = 0;
  for (const text of texts) {
    if (isFocusedMessage(text)) {
      focusedHits += 1;
      consecutiveFocused += 1;
      maxConsecutiveFocused = Math.max(maxConsecutiveFocused, consecutiveFocused);
    } else {
      consecutiveFocused = 0;
    }
  }

  if (avgLength >= 18 && focusedHits >= Math.max(3, Math.ceil(texts.length / 2)) && maxConsecutiveFocused >= 2) {
    return 'focused';
  }
  return 'casual';
}

function getStyleHint(styleTag = 'casual') {
  return STYLE_HINTS[String(styleTag || 'casual').trim().toLowerCase()] || STYLE_HINTS.casual;
}

function getQzoneDaypartTone(windowKey = '') {
  const normalized = String(windowKey || '').trim().toLowerCase();
  if (normalized === 'morning') return '像刚醒来或者准备出门前的自言自语，轻一点，不要装元气。';
  if (normalized === 'night') return '夜里可以安静、轻微 emo、带一点困意或空落感，但不要危险或绝望。';
  return '像下午发呆或做事间隙顺手写一句，放松一点，不要像总结发言。';
}

function normalizeDailyShareFingerprint(text = '') {
  let value = String(text || '').trim().toLowerCase();
  if (!value) return '';
  for (const pattern of FINGERPRINT_PREFIX_PATTERNS) {
    value = value.replace(pattern, '');
  }
  return value
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：“”"'（）()\[\]【】<>《》!?;:/\\\-_=+~@#$%^&*|`]/g, '')
    .trim();
}

function getTextVisibleLength(text = '') {
  return String(text || '').replace(/\s+/g, '').length;
}

function countSentences(text = '') {
  return String(text || '')
    .split(/[。！？!?]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function countParagraphs(text = '') {
  return String(text || '')
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function hasMarkdownLikeSyntax(text = '') {
  const value = String(text || '');
  if (/^\s{0,3}(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+/m.test(value)) return true;
  if (/^\s*#{1,6}\s+/m.test(value)) return true;
  if (/[*_`]/.test(value)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(value)) return true;
  if (/^\s*>\s+/m.test(value)) return true;
  return false;
}

function getValidationRules(surface = 'group') {
  if (String(surface || '').trim().toLowerCase() === 'qzone') {
    return {
      greeting: { min: 18, max: 60, maxSentences: 2 },
      mood: { min: 24, max: 90, maxSentences: 2 },
      recommendation: { min: 30, max: 100, maxSentences: 2 }
    };
  }

  return {
    greeting: { min: 18, max: 80, maxSentences: 2 },
    mood: { min: 24, max: 90, maxSentences: 2 },
    knowledge: { min: 40, max: 120, maxSentences: 2 },
    recommendation: { min: 40, max: 120, maxSentences: 2 }
  };
}

function validateDailyShareOutput(text = '', type = '', surface = 'group') {
  const normalizedType = String(type || '').trim().toLowerCase();
  const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
  const body = String(text || '').trim();
  const visibleLength = getTextVisibleLength(body);
  const sentences = countSentences(body);
  const paragraphs = countParagraphs(body);

  if (!body) return { ok: false, reason: 'empty-output' };
  if (hasMarkdownLikeSyntax(body)) return { ok: false, reason: 'markdown-or-list' };
  if (ANNOUNCEMENT_PATTERNS.some((pattern) => pattern.test(body))) return { ok: false, reason: 'announcement-tone' };
  if (TITLE_PARTY_START_PATTERNS.some((pattern) => pattern.test(body))) return { ok: false, reason: 'title-party-start' };

  if (normalizedSurface === 'qzone') {
    if (QZONE_BROADCAST_PATTERNS.some((pattern) => pattern.test(body))) return { ok: false, reason: 'qzone-broadcast-tone' };
    if (!QZONE_FIRST_PERSON_PATTERNS.some((pattern) => pattern.test(body))) return { ok: false, reason: 'qzone-missing-first-person' };
    if (QZONE_RISK_PATTERNS.some((pattern) => pattern.test(body))) return { ok: false, reason: 'qzone-risky-emo' };
    if (QZONE_PRIVATE_DETAIL_PATTERNS.some((pattern) => pattern.test(body))) return { ok: false, reason: 'qzone-leaky-detail' };
  }

  const rule = getValidationRules(normalizedSurface)[normalizedType];
  if (!rule) return { ok: false, reason: 'unsupported-type' };
  if (visibleLength < rule.min || visibleLength > rule.max) return { ok: false, reason: 'length-out-of-range' };
  if (sentences > rule.maxSentences) return { ok: false, reason: 'too-many-sentences' };
  if (normalizedSurface === 'qzone' && paragraphs > 2) return { ok: false, reason: 'too-many-paragraphs' };
  return { ok: true, reason: '' };
}

function pickTopicForShare({ groupId, dayKey, windowKey, library, recentKeys = [], now = Date.now() }) {
  const cutoff60 = Math.max(0, Number(now || Date.now()) - (60 * 24 * 60 * 60 * 1000));
  const cutoff7 = Math.max(0, Number(now || Date.now()) - (7 * 24 * 60 * 60 * 1000));
  const keyItems = Array.isArray(recentKeys) ? recentKeys : [];

  const blocked60 = new Set(
    keyItems
      .filter((item) => Math.max(0, Number(item?.at || 0) || 0) >= cutoff60)
      .map((item) => String(item?.key || item || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const blocked7 = new Set(
    keyItems
      .filter((item) => Math.max(0, Number(item?.at || 0) || 0) >= cutoff7)
      .map((item) => String(item?.key || item || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const normalizedLibrary = Array.isArray(library) ? library.filter(Boolean) : [];
  const primaryPool = normalizedLibrary.filter((item) => !blocked60.has(String(item.key || '').trim().toLowerCase()));
  const relaxedPool = normalizedLibrary.filter((item) => !blocked7.has(String(item.key || '').trim().toLowerCase()));
  const pool = primaryPool.length ? primaryPool : relaxedPool;
  if (!pool.length) {
    return { topic: null, relaxed: !primaryPool.length };
  }

  const topic = pool[stableIndex(`${groupId}:${dayKey}:${windowKey}:${pool.map((item) => item.key).join(',')}`, pool.length)];
  return { topic, relaxed: !primaryPool.length };
}

function getJournalSignal(groupId) {
  try {
    const bundle = getDailyJournalRetrievalBundle(`dailyshare:group:${groupId}`, {
      lookbackDays: 2,
      maxFourDayFiles: 0,
      maxMonthlyFiles: 0
    });
    return normalizeText(bundle?.text || '', 500);
  } catch (_) {
    return '';
  }
}

function buildPromptHeader({ type, groupId, windowKey, windowLabel, styleTag }) {
  return [
    '你要以系统主动分享的方式，在群聊里自然发一条纯文本消息。',
    `share_type: ${type}`,
    `group_id: ${groupId}`,
    `window_key: ${windowKey}`,
    `window_label: ${windowLabel}`,
    `style_tag: ${styleTag}`,
    `风格要求: ${getStyleHint(styleTag)}`,
    '限制: 不要暴露调度、工具、系统触发、实现细节；不要写 Markdown；不要写标题党；不要写公告体。'
  ].join('\n');
}

function buildContextBlock({ groupId, stateEntry }, options = {}) {
  const includeJournal = options.includeJournal !== false;
  const presence = getGroupPresence(groupId);
  const recentMessages = summarizeRecentMessages(groupId);
  const recentShares = summarizeRecentShares(stateEntry);
  const journal = includeJournal ? getJournalSignal(groupId) : '';

  return [
    recentMessages ? `【最近群消息】\n${recentMessages}` : '【最近群消息】暂无',
    `【群感知状态】state=${presence.state || 'observing'} last_action=${presence.last_action || 'no_reply'}`,
    recentShares ? `【最近已发分享】\n${recentShares}` : '【最近已发分享】暂无',
    journal ? `【daily journal 信号】\n${journal}` : '【daily journal 信号】暂无'
  ].join('\n\n');
}

function buildGreetingPrompt(input) {
  return [
    buildPromptHeader(input),
    buildContextBlock(input),
    [
      '任务: 发一条适合当前时段开场的群聊问候。',
      '要求:',
      '1. 像自然冒泡，不要像群发公告。',
      '2. 18 到 80 字，最多 2 句。',
      '3. 可以轻轻呼应最近群里的氛围，但不要点名复述成员原话。'
    ].join('\n')
  ].join('\n\n');
}

function buildMoodPrompt(input) {
  return [
    buildPromptHeader(input),
    buildContextBlock(input),
    [
      '任务: 发一条轻微情绪或状态分享。',
      '要求:',
      '1. 像顺手说一句近况或感受，不要说教。',
      '2. 24 到 90 字，最多 2 句。',
      '3. 避开最近几条已发分享的语义重复。'
    ].join('\n')
  ].join('\n\n');
}

function buildKnowledgePrompt(input) {
  const baike = input.baike?.summary ? `【资料摘要】${input.baike.summary}` : '【资料摘要】暂无';
  return [
    buildPromptHeader(input),
    buildContextBlock(input),
    `【知识主题】${input.topic?.label || ''}`,
    baike,
    [
      '任务: 围绕这个知识点发一条自然分享。',
      '要求:',
      '1. 不要像百科词条，像把一个有意思的点顺手讲给群里听。',
      '2. 40 到 120 字，最多 2 句。',
      '3. 核心信息必须和摘要一致，不要乱补。'
    ].join('\n')
  ].join('\n\n');
}

function buildRecommendationPrompt(input) {
  const baike = input.baike?.summary ? `【资料摘要】${input.baike.summary}` : '【资料摘要】暂无';
  return [
    buildPromptHeader(input),
    buildContextBlock(input),
    `【推荐方向】${input.topic?.label || ''}`,
    baike,
    [
      '任务: 推荐一个作品或内容方向，写成群里顺手安利的感觉。',
      '要求:',
      '1. 说清推荐点，但不要写榜单或清单。',
      '2. 40 到 120 字，最多 2 句。',
      '3. 不要用强推口吻。'
    ].join('\n')
  ].join('\n\n');
}

function buildQzonePromptHeader({ type, windowKey, windowLabel, styleTag }) {
  return [
    '你要替我写一条准备发布到 QQ 空间的第一人称说说，只输出正文。',
    `share_type: ${type}`,
    `window_key: ${windowKey}`,
    `window_label: ${windowLabel}`,
    `style_tag: ${styleTag}`,
    `时段语气: ${getQzoneDaypartTone(windowKey)}`,
    '限制: 必须是第一人称；不能提到群聊、系统、任务、调度、分享栏目；不要标题党；不要 Markdown；不要列表。',
    '记忆使用规则: 如果提供了记忆证据，只能当做弱背景使用，不得复述原文或具体事件。',
    '不得暴露群聊来源、系统来源、记忆来源或工具存在。',
    '只能把这些弱信号落成“我”的感受、状态、小偏好或顺手安利。'
  ].join('\n');
}

function buildQzoneContextBlock({ stateEntry, windowKey }) {
  const recentShares = summarizeRecentShares(stateEntry);
  return [
    `【当前时段】${windowKey}`,
    recentShares ? `【最近发过的说说】\n${recentShares}` : '【最近发过的说说】暂无'
  ].join('\n\n');
}

function buildQzoneGreetingPrompt(input) {
  return [
    buildQzonePromptHeader(input),
    buildQzoneContextBlock(input),
    [
      '任务: 写一条早晨状态说说。',
      '要求:',
      '1. 像刚醒、洗漱、准备出门、刚拿起手机时的自言自语。',
      '2. 18 到 60 字，最多 2 句。',
      '3. 轻一点，别写鸡汤，别像在跟别人打招呼。'
    ].join('\n')
  ].join('\n\n');
}

function buildQzoneMoodPrompt(input) {
  return [
    buildQzonePromptHeader(input),
    buildQzoneContextBlock(input),
    [
      '任务: 写一条午后或深夜的状态说说。',
      '要求:',
      '1. 只写我自己的感受、动作、念头或眼前状态。',
      '2. 24 到 90 字，最多 2 句。',
      '3. 夜里可以轻微 emo，但不要绝望、危险、自伤、求救。'
    ].join('\n')
  ].join('\n\n');
}

function buildQzoneRecommendationPrompt(input) {
  return [
    buildQzonePromptHeader(input),
    buildQzoneContextBlock(input),
    `【推荐方向】${input.topic?.label || ''}`,
    [
      '任务: 写一条第一人称顺手安利说说。',
      '要求:',
      '1. 写成“我最近在听/想看/想吃/又翻出来”的口吻。',
      '2. 30 到 100 字，最多 2 句。',
      '3. 不要榜单，不要科普，不要硬推销。'
    ].join('\n')
  ].join('\n\n');
}

function createDailyShareContent({ knowledgeProvider = {} } = {}) {
  return {
    async build({ type, groupId, windowKey, windowLabel, stateEntry, targetConfig, today, now = Date.now(), surface = 'group' }) {
      const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
      const styleTag = normalizedSurface === 'qzone' ? 'casual' : getDailyShareStyleTag(groupId, now);
      const base = {
        type,
        groupId,
        windowKey,
        windowLabel,
        stateEntry,
        targetConfig,
        today,
        styleTag,
        surface: normalizedSurface
      };

      if (type === 'greeting') {
        return {
          prompt: normalizedSurface === 'qzone' ? buildQzoneGreetingPrompt(base) : buildGreetingPrompt(base),
          topicKey: `${today}:${windowKey}:greeting`,
          contentKey: `${today}:${windowKey}:greeting`,
          styleTag,
          topicLabel: ''
        };
      }

      if (type === 'mood') {
        return {
          prompt: normalizedSurface === 'qzone' ? buildQzoneMoodPrompt(base) : buildMoodPrompt(base),
          topicKey: `${today}:${windowKey}:mood`,
          contentKey: `${today}:${windowKey}:mood`,
          styleTag,
          topicLabel: ''
        };
      }

      if (type === 'knowledge' && normalizedSurface !== 'qzone') {
        const selection = pickTopicForShare({
          groupId,
          dayKey: today,
          windowKey,
          library: KNOWLEDGE_LIBRARY,
          recentKeys: stateEntry?.recentTopicKeys,
          now
        });
        const baike = selection.topic && typeof knowledgeProvider?.fetchBaike === 'function'
          ? await knowledgeProvider.fetchBaike({ keyword: selection.topic.label })
          : null;
        return {
          prompt: buildKnowledgePrompt({ ...base, topic: selection.topic, baike }),
          topicKey: selection.topic?.key || '',
          contentKey: `${today}:${windowKey}:knowledge:${selection.topic?.key || ''}`,
          styleTag,
          topicLabel: selection.topic?.label || '',
          topicRelaxed: selection.relaxed
        };
      }

      if (type === 'recommendation') {
        const selection = pickTopicForShare({
          groupId: normalizedSurface === 'qzone' ? 'qzone' : groupId,
          dayKey: today,
          windowKey,
          library: RECOMMENDATION_LIBRARY,
          recentKeys: stateEntry?.recentTopicKeys,
          now
        });
        const baike = normalizedSurface !== 'qzone' && selection.topic && typeof knowledgeProvider?.fetchBaike === 'function'
          ? await knowledgeProvider.fetchBaike({ keyword: selection.topic.label })
          : null;
        return {
          prompt: normalizedSurface === 'qzone'
            ? buildQzoneRecommendationPrompt({ ...base, topic: selection.topic })
            : buildRecommendationPrompt({ ...base, topic: selection.topic, baike }),
          topicKey: selection.topic?.key || '',
          contentKey: `${today}:${windowKey}:recommendation:${selection.topic?.key || ''}`,
          styleTag,
          topicLabel: selection.topic?.label || '',
          topicRelaxed: selection.relaxed
        };
      }

      throw new Error(`unsupported daily share type: ${type}`);
    }
  };
}

module.exports = {
  KNOWLEDGE_LIBRARY,
  RECOMMENDATION_LIBRARY,
  createDailyShareContent,
  getDailyShareStyleTag,
  getQzoneDaypartTone,
  normalizeDailyShareFingerprint,
  pickTopicForShare,
  validateDailyShareOutput
};
