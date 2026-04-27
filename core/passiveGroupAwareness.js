const config = require('../config');
const { postWithRetry, postStreamWithRetry } = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely, extractSSEEvents, flushSSEState } = require('../api/parser');
const { maybeSendMemeFollowup } = require('./memeManager');
const { shortTermMemory, chatHistory } = require('../utils/memory');
const {
  resolveShortTermSessionKey,
  getShortTermPresence,
  updateShortTermPresence
} = require('../utils/shortTermMemory');
const {
  appendGroupMessage,
  getRecentMessages,
  getGroupPresence,
  updateGroupPresence,
  getLastAwarenessAt,
  setLastAwarenessAt,
  getGlobalLastAwarenessAt,
  getLastReplyAt,
  canReplyInHour,
  recordReply
} = require('../utils/groupAwarenessState');
const {
  buildPassiveAwarenessSocialSnippet,
  shouldLockPassiveReply
} = require('../utils/socialContextRuntime');
const {
  composePersonaMemoryState,
  renderPersonaMemoryPrompt,
  recordPersonaMemoryOutcome
} = require('../utils/personaMemoryState');
const { buildDirectedContextPromptSnippet } = require('../api/graphPrompting');
const { buildLlmPerception } = require('./llmPerception');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeVisualUrl(value = '') {
  return String(value || '').trim();
}

function collectPassiveVisualInputs(inboundContext = {}, fallbackImageUrl = null) {
  if (config.PASSIVE_AWARENESS_VISION_INPUT_ENABLED === false) return [];
  const maxImages = Math.max(1, Math.min(4, Number(config.PASSIVE_AWARENESS_VISION_MAX_IMAGES || 2) || 2));
  const out = [];
  const seen = new Set();
  const add = (url, source = 'current') => {
    const normalized = normalizeVisualUrl(url);
    if (!normalized || seen.has(normalized) || out.length >= maxImages) return;
    seen.add(normalized);
    out.push({ url: normalized, source: normalizeText(source) || 'current' });
  };

  add(fallbackImageUrl || inboundContext?.imageUrl, 'selected');

  const visualContext = inboundContext?.visualContext && typeof inboundContext.visualContext === 'object'
    ? inboundContext.visualContext
    : null;
  if (Array.isArray(visualContext?.images)) {
    for (const item of visualContext.images) {
      add(item?.url, item?.source || 'visual_context');
    }
  }

  const directedContext = inboundContext?.directedContext && typeof inboundContext.directedContext === 'object'
    ? inboundContext.directedContext
    : null;
  add(directedContext?.replyImageUrl, 'reply');

  const meta = inboundContext?.continuousMeta && typeof inboundContext.continuousMeta === 'object'
    ? inboundContext.continuousMeta
    : null;
  for (const url of Array.isArray(meta?.currentImageUrls) ? meta.currentImageUrls : []) add(url, 'current');
  for (const url of Array.isArray(meta?.imageUrls) ? meta.imageUrls : []) add(url, 'current');
  for (const url of Array.isArray(meta?.replyContext?.imageUrls) ? meta.replyContext.imageUrls : []) add(url, 'reply');

  return out;
}

function buildPassiveModelUserContent(prompt = '', visualInputs = []) {
  const text = String(prompt || '').trim();
  const images = Array.isArray(visualInputs) ? visualInputs : [];
  if (!images.length) return text;

  const content = [
    { type: 'text', text }
  ];
  const detail = normalizeText(config.PASSIVE_AWARENESS_VISION_IMAGE_DETAIL || '').toLowerCase();
  for (const image of images) {
    const url = normalizeVisualUrl(image?.url);
    if (!url) continue;
    const imageUrl = { url };
    if (['low', 'high', 'auto'].includes(detail)) imageUrl.detail = detail;
    content.push({
      type: 'image_url',
      image_url: imageUrl
    });
  }
  return content;
}

function buildPassiveVisualPromptSection(visualInputs = []) {
  const images = Array.isArray(visualInputs) ? visualInputs : [];
  if (!images.length) return '';
  const lines = images.map((item, index) => {
    const source = normalizeText(item?.source || 'current');
    return `- image_${index + 1}: ${source}`;
  });
  return [
    '[VisualInput]',
    'Images are attached to this model call. Use them as direct visual evidence when deciding or replying.',
    'Do not say you cannot see the image unless the model input explicitly lacks an image.',
    ...lines
  ].join('\n');
}

function trimReplyText(value, maxChars = 80) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  return Array.from(normalized).slice(0, Math.max(1, Number(maxChars) || 80)).join('');
}

function isPresenceAckReply(replyType = '', addressee = '') {
  return String(replyType || '').trim() === 'presence_ack'
    || String(addressee || '').trim() === 'bot_presence_check';
}

function shouldSuppressPresenceAck({ groupPresence, now, replyType, addressee }) {
  if (!isPresenceAckReply(replyType, addressee)) return false;
  const dedupMs = Math.max(0, Number(config.PASSIVE_AWARENESS_PRESENCE_ACK_DEDUP_MS || 0) || 0);
  if (!dedupMs) return false;
  const lastPresenceAckAt = Number(groupPresence?.last_presence_ack_at || 0) || 0;
  if (!lastPresenceAckAt) return false;
  return (Number(now || Date.now()) - lastPresenceAckAt) < dedupMs;
}

function isTrivialPresenceReply(replyText = '', addressee = '', replyType = '') {
  const text = normalizeText(replyText);
  if (!text) return false;
  if (isPresenceAckReply(replyType, addressee)) return true;
  return ['我在', '我在看', '还在，没坏'].includes(text);
}

function shouldSuppressTrivialPresenceReply({
  groupPresence,
  now,
  replyText,
  addressee,
  replyType
}) {
  const text = normalizeText(replyText);
  if (!isTrivialPresenceReply(text, addressee, replyType)) return false;
  const dedupMs = Math.max(0, Number(config.PASSIVE_AWARENESS_PRESENCE_ACK_DEDUP_MS || 0) || 0);
  if (!dedupMs) return false;
  const lastAt = Math.max(
    0,
    Number(groupPresence?.last_trivial_presence_reply_at || 0) || 0
  );
  const lastText = normalizeText(groupPresence?.last_trivial_presence_reply_text || '');
  if (!lastAt || !lastText) return false;
  return lastText === text && (Number(now || Date.now()) - lastAt) < dedupMs;
}

function ensureChatCompletionsUrl(url) {
  const raw = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function canCallDecisionModel() {
  if (!config.PASSIVE_AWARENESS_DECISION_ENABLED) return false;
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_MODEL || '').trim();
  return Boolean(baseUrl && apiKey && model);
}

function canCallReplyModel() {
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_REPLY_API_BASE_URL || config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_REPLY_API_KEY || config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_REPLY_MODEL || config.PASSIVE_AWARENESS_MODEL || '').trim();
  return Boolean(baseUrl && apiKey && model);
}

function buildCompactPersonaPrompt(maxChars = 600) {
  const source = String(config.SYSTEM_PROMPT || '').trim();
  if (!source) return '';

  // Keep the passive-reply prompt aligned with the main persona prompt,
  // but trim it aggressively so awareness replies stay cheap and focused.
  const lines = source
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  if (!lines.length) return '';

  const picked = [];
  let total = 0;
  const limit = Math.max(120, Number(maxChars) || 600);
  for (const line of lines) {
    const extra = (picked.length ? 1 : 0) + line.length;
    if (picked.length && total + extra > limit) break;
    if (!picked.length && line.length > limit) {
      picked.push(line.slice(0, limit));
      total = picked[0].length;
      break;
    }
    picked.push(line);
    total += extra;
  }

  return picked.join('\n');
}

function isEnabledForGroup(groupId) {
  if (!config.PASSIVE_AWARENESS_ENABLED) return false;
  const groups = Array.isArray(config.PASSIVE_AWARENESS_GROUP_IDS)
    ? config.PASSIVE_AWARENESS_GROUP_IDS
    : [];
  if (groups.length === 0) return false;
  return groups.includes(String(groupId || '').trim());
}

function getSenderName(msg = {}) {
  return String(
    msg.sender?.card
      || msg.sender?.nickname
      || msg.sender?.nick
      || msg.user_id
      || ''
  ).trim();
}

function isNoiseText(text = '') {
  const t = normalizeText(text);
  if (!t) return true;
  if (/^\[CQ:[^\]]+\]$/.test(t)) return true;
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true;
  if (/^(哈哈+|hhh+|6{2,}|草|啊|呀|哦|表情|收到)$/i.test(t)) return true;
  return false;
}

function containsBotTopic(text = '') {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return /(bot|瑞希|机器人|ai|模型|napcat|插件|接入|群聊)/i.test(t);
}

function containsQuestionSignal(text = '') {
  const t = normalizeText(text);
  if (!t) return false;
  return /[?？]|(怎么|如何|是不是|能不能|可不可以|为什么|啥意思|什么意思|会不会|有没有|谁知道)/i.test(t);
}

function containsBotPresenceCue(text = '') {
  const t = normalizeText(text);
  if (!t) return false;
  return /(在吗|还在|在线|窥屏|潜水|怎么不说话|没反应|坏掉|坏了|死机|看到没|看到了吗|出来)/i.test(t);
}

function normalizeDirectedContext(input = null) {
  if (!input || typeof input !== 'object') return null;
  return input;
}

function getQuotePriority(directedContext = null) {
  return directedContext?.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
}

function getEffectivePassiveText(inboundContext = null, rawText = '', directedContext = null) {
  const anchored = String(getQuotePriority(directedContext)?.quoteAnchoredText || '').trim();
  if (anchored) return normalizeText(anchored);
  return normalizeText(inboundContext?.cleanText || rawText.replace(/\[CQ:[^\]]+\]/g, ' '));
}

function mapDirectedSceneToAddressee(scene = '', text = '', analysis = null, directedContext = null) {
  const normalizedScene = normalizeText(scene);
  const normalizedDirected = normalizeDirectedContext(directedContext);
  if (normalizedScene === 'reply_to_user' || normalizedScene === 'human_pair_chat') {
    return 'human_to_human';
  }
  if (normalizedScene === 'reply_to_bot') {
    return containsBotPresenceCue(text) ? 'bot_presence_check' : 'bot_direct';
  }
  if (normalizedScene === 'address_bot') {
    return containsBotPresenceCue(text) ? 'bot_presence_check' : 'bot_direct';
  }
  if (normalizedScene === 'group_question') {
    const kind = normalizeText(normalizedDirected?.addressee?.kind);
    return kind === 'bot' ? 'group_bot_topic' : 'group_open_question';
  }
  if (normalizedScene === 'broadcast') {
    if (containsQuestionSignal(text)) return 'group_open_question';
    return 'unclear';
  }
  return null;
}

function startsWithBotCue(text = '') {
  const t = normalizeText(text);
  if (!t) return false;
  return /^(瑞希|bot|机器人)[,，:：!！?？\s]*/i.test(t);
}

function scoreMessageTrigger(text = '', recentMessages = []) {
  const t = normalizeText(text);
  let score = 0;

  if (containsBotTopic(t)) score += 45;
  if (containsQuestionSignal(t)) score += 20;
  if (containsBotPresenceCue(t)) score += 18;
  if (/(大家|你们|谁|有人|bot|机器人)/i.test(t)) score += 8;
  if (t.length >= 12) score += 5;

  const recentText = recentMessages
    .slice(-6)
    .map((item) => normalizeText(item.text))
    .join('\n');
  if (containsBotTopic(recentText)) score += 12;
  if (containsBotPresenceCue(recentText)) score += 6;

  if (isNoiseText(t)) score -= 40;
  return score;
}

function buildConversationWindow({ recentMessages, now = Date.now() }) {
  const maxSize = Math.max(6, Math.min(24, Number(config.PASSIVE_AWARENESS_ANALYSIS_WINDOW_SIZE || 12)));
  const input = Array.isArray(recentMessages) ? recentMessages : [];
  const messages = input
    .slice(-maxSize)
    .map((item) => ({
      sender_id: String(item?.sender_id || ''),
      sender_name: String(item?.sender_name || ''),
      text: normalizeText(item?.text),
      timestamp: Number(item?.timestamp || now)
    }));

  return {
    messages,
    now: Number(now || Date.now()),
    firstTimestamp: messages[0]?.timestamp || Number(now || Date.now()),
    lastTimestamp: messages[messages.length - 1]?.timestamp || Number(now || Date.now())
  };
}

function analyzeConversationWindow({ window, senderId, text }) {
  const messages = Array.isArray(window?.messages) ? window.messages : [];
  const currentText = normalizeText(text);
  const fastChatWindowMs = Math.max(5000, Number(config.PASSIVE_AWARENESS_FAST_CHAT_WINDOW_MS || 25000));
  const fastChatMessageCount = Math.max(4, Number(config.PASSIVE_AWARENESS_FAST_CHAT_MESSAGE_COUNT || 6));
  const recentSlice = messages.slice(-fastChatMessageCount);
  const latestTs = recentSlice[recentSlice.length - 1]?.timestamp || Number(window?.now || Date.now());
  const earliestTs = recentSlice[0]?.timestamp || latestTs;
  const speakerKeys = new Set();

  for (const item of messages) {
    const key = String(item.sender_id || item.sender_name || '').trim();
    if (key) speakerKeys.add(key);
  }

  let currentSenderConsecutiveCount = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const key = String(messages[i]?.sender_id || '').trim();
    if (!key || key !== String(senderId || '').trim()) break;
    currentSenderConsecutiveCount += 1;
  }

  let speakerSwitches = 0;
  for (let i = 1; i < recentSlice.length; i += 1) {
    const prev = String(recentSlice[i - 1]?.sender_id || recentSlice[i - 1]?.sender_name || '').trim();
    const curr = String(recentSlice[i]?.sender_id || recentSlice[i]?.sender_name || '').trim();
    if (prev && curr && prev !== curr) speakerSwitches += 1;
  }

  const recentSpeakerCount = new Set(
    recentSlice
      .map((item) => String(item.sender_id || item.sender_name || '').trim())
      .filter(Boolean)
  ).size;

  const recentBotTopicMentions = recentSlice.filter((item) => containsBotTopic(item.text)).length;
  const recentPresenceCueMentions = recentSlice.filter((item) => containsBotPresenceCue(item.text)).length;
  const currentMentionsBot = containsBotTopic(currentText);
  const currentPresenceCue = containsBotPresenceCue(currentText);
  const botTopicContinuity = currentMentionsBot
    ? recentBotTopicMentions >= 2 || recentPresenceCueMentions >= 1
    : recentBotTopicMentions >= 3 || recentPresenceCueMentions >= 2;

  const recentSpanMs = Math.max(0, latestTs - earliestTs);
  const isFastChat = recentSlice.length >= fastChatMessageCount && recentSpanMs <= fastChatWindowMs;
  const isTwoPersonRapidExchange = isFastChat && recentSpeakerCount === 2 && speakerSwitches >= Math.max(3, recentSlice.length - 2);
  const isMultiPartyRapidExchange = isFastChat && recentSpeakerCount >= 3;

  return {
    messageCount: messages.length,
    speakerCount: speakerKeys.size,
    currentSenderConsecutiveCount,
    isFastChat,
    isTwoPersonRapidExchange,
    isMultiPartyRapidExchange,
    recentBotTopicMentions,
    recentPresenceCueMentions,
    botTopicContinuity,
    currentMentionsBot,
    currentPresenceCue,
    recentSpanMs,
    rhythm: isFastChat
      ? (isMultiPartyRapidExchange ? 'fast_multi_party' : (isTwoPersonRapidExchange ? 'fast_two_person' : 'fast_chat'))
      : 'normal'
  };
}

function detectPassiveAddressee({ text, analysis, directedContext }) {
  const t = normalizeText(text);
  const directedAddressee = mapDirectedSceneToAddressee(directedContext?.scene, t, analysis, directedContext);
  if (directedAddressee) return directedAddressee;
  const mentionsBot = containsBotTopic(t);
  const hasPresenceCue = containsBotPresenceCue(t);
  const directBotCue = startsWithBotCue(t) || (mentionsBot && /(你|出来|别装死|是不是|还在|又坏|坏掉|坏了|没反应|说话)/i.test(t));
  const groupOpenQuestion = containsQuestionSignal(t) && /(?:大家|你们|谁|有人|哪位|有无|有没有|懂|知道|会不会|能不能)/i.test(t);

  if (hasPresenceCue && (mentionsBot || analysis?.recentBotTopicMentions > 0 || analysis?.recentPresenceCueMentions > 0)) {
    return 'bot_presence_check';
  }
  if (mentionsBot && directBotCue) {
    return 'bot_direct';
  }
  if (groupOpenQuestion) {
    return analysis?.botTopicContinuity || mentionsBot ? 'group_bot_topic' : 'group_open_question';
  }
  if (mentionsBot || analysis?.botTopicContinuity) {
    return 'group_bot_topic';
  }
  if (analysis?.isTwoPersonRapidExchange || (analysis?.currentSenderConsecutiveCount >= 2 && !containsQuestionSignal(t))) {
    return 'human_to_human';
  }
  if (containsQuestionSignal(t) && !analysis?.isFastChat) {
    return 'group_open_question';
  }
  return 'unclear';
}

function classifyPassiveReplyType({ text, addressee, analysis }) {
  const t = normalizeText(text);
  if (addressee === 'bot_presence_check') return 'presence_ack';
  if (/(鍧忔帀|鍧忎簡|鍙樼|鍙樿牏|鎶介|澶卞繂|鍗′綇|姝绘満|鏅洪殰|鍌讳簡|娌＄數)/i.test(t)) return 'light_tease';
  if (addressee === 'bot_direct' || addressee === 'group_bot_topic') {
    return containsQuestionSignal(t) ? 'light_answer' : 'light_reaction';
  }
  if (addressee === 'group_open_question') {
    return analysis?.botTopicContinuity ? 'light_answer' : 'brief_clarify';
  }
  return 'light_reaction';
}

function shouldGatePassiveReply({ addressee, analysis }) {
  if (addressee === 'bot_direct' || addressee === 'bot_presence_check') {
    return {
      shouldSkip: false,
      reason: 'bot-cued-allow',
      rhythm: 'bot_cued_bypass'
    };
  }

  if (addressee === 'human_to_human') {
    return {
      shouldSkip: true,
      reason: analysis?.isTwoPersonRapidExchange ? 'fast-two-person-human-chat' : 'human-to-human',
      rhythm: String(analysis?.rhythm || 'human_to_human')
    };
  }

  if (analysis?.isMultiPartyRapidExchange && !analysis?.botTopicContinuity) {
    return {
      shouldSkip: true,
      reason: 'fast-multi-party-chat',
      rhythm: String(analysis?.rhythm || 'fast_multi_party')
    };
  }

  if (analysis?.isFastChat && !analysis?.botTopicContinuity && addressee !== 'group_open_question') {
    return {
      shouldSkip: true,
      reason: 'fast-chat-low-signal',
      rhythm: String(analysis?.rhythm || 'fast_chat')
    };
  }

  if (analysis?.currentSenderConsecutiveCount >= 3 && !analysis?.botTopicContinuity) {
    return {
      shouldSkip: true,
      reason: 'single-speaker-streak',
      rhythm: 'single_speaker_streak'
    };
  }

  return {
    shouldSkip: false,
    reason: 'passive-analysis-allow',
    rhythm: String(analysis?.rhythm || 'normal')
  };
}

function applySocialContextGate({ groupId, recentMessages, senderId, addressee, gate, directedContext }) {
  const socialLock = shouldLockPassiveReply({
    groupId,
    recentMessages,
    senderId,
    addressee,
    directedContext
  });
  if (!socialLock.shouldLock) return gate;
  return {
    shouldSkip: true,
    reason: socialLock.reason || 'human-pair-lock',
    rhythm: String(gate?.rhythm || 'normal')
  };
}

function formatLocalAnalysis({ addressee, replyType, analysis, gate }) {
  return [
    `- addressee: ${addressee || 'unclear'}`,
    `- reply_type_hint: ${replyType || 'light_reaction'}`,
    `- rhythm: ${normalizeText(gate?.rhythm || analysis?.rhythm || 'normal')}`,
    `- messages_in_window: ${Number(analysis?.messageCount || 0)}`,
    `- speakers_in_window: ${Number(analysis?.speakerCount || 0)}`,
    `- current_sender_consecutive: ${Number(analysis?.currentSenderConsecutiveCount || 0)}`,
    `- fast_chat: ${Boolean(analysis?.isFastChat)}`,
    `- two_person_exchange: ${Boolean(analysis?.isTwoPersonRapidExchange)}`,
    `- multi_party_exchange: ${Boolean(analysis?.isMultiPartyRapidExchange)}`,
    `- recent_bot_mentions: ${Number(analysis?.recentBotTopicMentions || 0)}`,
    `- recent_presence_cues: ${Number(analysis?.recentPresenceCueMentions || 0)}`,
    `- bot_topic_continuity: ${Boolean(analysis?.botTopicContinuity)}`,
    `- local_gate: ${normalizeText(gate?.reason || 'none')}`
  ].join('\n');
}

function normalizePresenceState(value, fallback = 'observing') {
  const normalized = normalizeText(value);
  if (['observing', 'considering', 'waiting', 'interjecting', 'cooling', 'closed'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizePresenceAction(value, fallback = 'no_reply') {
  const normalized = normalizeText(value);
  if (['no_reply', 'wait', 'reply', 'follow_up', 'exit'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function buildPresenceReason(baseReason, extra = '') {
  const parts = [normalizeText(baseReason), normalizeText(extra)].filter(Boolean);
  return parts.join(': ');
}

function getPresenceConfig() {
  return {
    waitTurns: Math.max(1, Number(config.PASSIVE_AWARENESS_WAIT_TURNS || 2)),
    waitMinMs: Math.max(0, Number(config.PASSIVE_AWARENESS_WAIT_MIN_MS || 15000)),
    followUpWindowMs: Math.max(0, Number(config.PASSIVE_AWARENESS_FOLLOW_UP_WINDOW_MS || 180000)),
    closedTtlMs: Math.max(0, Number(config.PASSIVE_AWARENESS_CLOSED_TTL_MS || 900000)),
    replyCooldownMs: Math.max(0, Number(config.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS || 300000)),
    minIntervalMs: Math.max(0, Number(config.PASSIVE_AWARENESS_MIN_INTERVAL_MS || 180000)),
    globalMinIntervalMs: Math.max(0, Number(config.PASSIVE_AWARENESS_GLOBAL_MIN_INTERVAL_MS || 15000))
  };
}

function getSessionKeyForPresence(groupId, senderId) {
  return resolveShortTermSessionKey(senderId, { groupId });
}

function containsExitCue(text = '') {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return /(懂了|知道了|行|好|ok|okay|收到|谢谢|谢了|没事了|解决了|先这样|晚安|睡了)/i.test(t);
}

function hasStrongBotCue(addressee) {
  return ['bot_presence_check', 'bot_direct'].includes(String(addressee || ''));
}

function hasBotTopicCue(addressee) {
  return ['bot_presence_check', 'bot_direct', 'group_bot_topic'].includes(String(addressee || ''));
}

function countHumanMessagesSince(messages = [], timestamp = 0, botSenderId = '') {
  const afterTs = Number(timestamp || 0) || 0;
  const botId = String(botSenderId || '').trim();
  return (Array.isArray(messages) ? messages : []).reduce((count, item) => {
    const itemTs = Number(item?.timestamp || 0) || 0;
    const senderId = String(item?.sender_id || '').trim();
    if (itemTs <= afterTs) return count;
    if (botId && senderId === botId) return count;
    return count + 1;
  }, 0);
}

function shouldAllowClosedReset({ groupPresence, addressee, now, cfg }) {
  if (hasStrongBotCue(addressee)) return true;
  if (String(groupPresence?.state || '') !== 'closed') return true;
  const closedAt = Number(groupPresence?.closed_at || 0) || 0;
  if (!closedAt) return true;
  return (now - closedAt) >= cfg.closedTtlMs;
}

function derivePresenceStateByAction(action, currentState) {
  switch (String(action || '')) {
    case 'wait':
      return currentState === 'observing' ? 'considering' : 'waiting';
    case 'reply':
    case 'follow_up':
      return 'interjecting';
    case 'exit':
      return 'closed';
    default:
      return normalizePresenceState(currentState, 'observing');
  }
}

function buildPresenceSnapshot({ groupPresence, sessionPresence }) {
  return {
    group: {
      state: normalizePresenceState(groupPresence?.state, 'observing'),
      lastAction: normalizePresenceAction(groupPresence?.last_action, 'no_reply'),
      waitingSince: Number(groupPresence?.waiting_since || 0) || 0,
      lastBotReplyAt: Number(groupPresence?.last_bot_reply_at || 0) || 0,
      lastPresenceAckAt: Number(groupPresence?.last_presence_ack_at || 0) || 0,
      lastTrivialPresenceReplyAt: Number(groupPresence?.last_trivial_presence_reply_at || 0) || 0,
      lastTrivialPresenceReplyText: String(groupPresence?.last_trivial_presence_reply_text || '').trim(),
      humanTurnsSinceBotReply: Math.max(0, Number(groupPresence?.human_turns_since_bot_reply || 0) || 0),
      coolingUntil: Number(groupPresence?.cooling_until || 0) || 0,
      closedAt: Number(groupPresence?.closed_at || 0) || 0,
      lastAddressee: String(groupPresence?.last_addressee || '').trim()
    },
    session: {
      state: normalizePresenceState(sessionPresence?.state, 'observing'),
      lastAction: normalizePresenceAction(sessionPresence?.lastAction, 'no_reply'),
      waitingSince: Number(sessionPresence?.waitingSince || 0) || 0,
      lastHumanInboundAt: Number(sessionPresence?.lastHumanInboundAt || 0) || 0,
      lastBotReplyAt: Number(sessionPresence?.lastBotReplyAt || 0) || 0,
      humanTurnsSinceBotReply: Math.max(0, Number(sessionPresence?.humanTurnsSinceBotReply || 0) || 0),
      closedAt: Number(sessionPresence?.closedAt || 0) || 0
    }
  };
}

function advancePresenceBeforeDecision({
  groupPresence,
  sessionPresence,
  addressee,
  now,
  recentMessages,
  botSenderId,
  currentStateHint
}) {
  const nextGroup = {
    ...groupPresence,
    state: normalizePresenceState(groupPresence?.state, currentStateHint || 'observing'),
    last_action: normalizePresenceAction(groupPresence?.last_action, 'no_reply'),
    last_inbound_at: now,
    human_turns_since_bot_reply: countHumanMessagesSince(
      recentMessages,
      groupPresence?.last_bot_reply_at,
      botSenderId
    ),
    last_addressee: String(addressee || '').trim()
  };
  const nextSession = {
    ...sessionPresence,
    state: normalizePresenceState(sessionPresence?.state, currentStateHint || 'observing'),
    lastAction: normalizePresenceAction(sessionPresence?.lastAction, 'no_reply'),
    lastInboundAt: now,
    lastHumanInboundAt: now,
    humanTurnsSinceBotReply: countHumanMessagesSince(
      recentMessages,
      sessionPresence?.lastBotReplyAt,
      botSenderId
    )
  };

  return {
    groupPresence: nextGroup,
    sessionPresence: nextSession
  };
}

function decidePresenceAction({
  text,
  score,
  addressee,
  gate,
  localAnalysis,
  groupPresence,
  sessionPresence,
  recentMessages,
  botSenderId,
  now,
  cfg
}) {
  const groupState = normalizePresenceState(groupPresence?.state, 'observing');
  const sessionState = normalizePresenceState(sessionPresence?.state, 'observing');
  const scoreMin = Number(config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60);
  const strongCue = hasStrongBotCue(addressee);
  const topicCue = hasBotTopicCue(addressee);
  const waitingSince = Number(groupPresence?.waiting_since || 0) || 0;
  const waitingElapsed = waitingSince > 0 ? now - waitingSince : 0;
  const humanTurnsSinceWaiting = waitingSince > 0
    ? countHumanMessagesSince(recentMessages, waitingSince, botSenderId)
    : 0;

  if (gate?.shouldSkip) {
    return { action: 'no_reply', state: groupState, reason: gate.reason || 'local-gate-skip' };
  }

  if (!shouldAllowClosedReset({ groupPresence, addressee, now, cfg })) {
    return { action: 'no_reply', state: groupState, reason: 'closed-without-cue' };
  }

  if (containsExitCue(text) && (Number(groupPresence?.last_bot_reply_at || 0) > 0 || Number(sessionPresence?.lastBotReplyAt || 0) > 0)) {
    return { action: 'exit', state: 'closed', reason: 'explicit-exit-cue' };
  }

  const withinFollowUpWindow = Number(sessionPresence?.lastBotReplyAt || 0) > 0
    && (now - Number(sessionPresence.lastBotReplyAt || 0)) <= cfg.followUpWindowMs;
  const followUpAllowed = withinFollowUpWindow
    && ['interjecting', 'waiting'].includes(sessionState)
    && Number(sessionPresence?.humanTurnsSinceBotReply || 0) <= 2
    && topicCue;

  if (followUpAllowed) {
    return { action: 'follow_up', state: 'interjecting', reason: `session-follow-up:${addressee}` };
  }

  if (groupState === 'cooling' && !strongCue) {
    const turns = Math.max(
      Number(groupPresence?.human_turns_since_bot_reply || 0),
      Number(sessionPresence?.humanTurnsSinceBotReply || 0)
    );
    if (turns >= 3) {
      return { action: 'exit', state: 'closed', reason: 'cooling-turn-limit' };
    }
    return { action: 'no_reply', state: 'cooling', reason: 'cooling-no-cue' };
  }

  if (groupState === 'closed' && !strongCue) {
    return { action: 'no_reply', state: 'closed', reason: 'closed-no-cue' };
  }

  const minLength = Math.max(1, Number(config.PASSIVE_AWARENESS_MIN_MESSAGE_LENGTH || 6));
  if (String(text || '').length < minLength || isNoiseText(text) || (!strongCue && score < scoreMin)) {
    return { action: 'no_reply', state: groupState, reason: score < scoreMin ? 'score-too-low' : 'noise-or-too-short' };
  }

  if (strongCue) {
    return { action: 'reply', state: 'interjecting', reason: `direct-cue:${addressee}` };
  }

  if (['group_bot_topic', 'group_open_question'].includes(addressee)) {
    const waitingSatisfied = (
      humanTurnsSinceWaiting >= cfg.waitTurns
      || (waitingSince > 0 && waitingElapsed >= cfg.waitMinMs && Boolean(localAnalysis?.botTopicContinuity))
      || strongCue
    );

    if (['considering', 'waiting'].includes(groupState) && waitingSatisfied) {
      return { action: 'reply', state: 'interjecting', reason: `waiting-satisfied:${addressee}` };
    }

    if (groupState === 'observing') {
      return { action: 'wait', state: 'considering', reason: `observe-topic:${addressee}` };
    }

    return { action: 'wait', state: 'waiting', reason: `continue-wait:${addressee}` };
  }

  return { action: 'no_reply', state: groupState, reason: 'no-presence-trigger' };
}

function shouldCheckReplyIntervals(action) {
  return ['reply', 'follow_up'].includes(String(action || ''));
}

function applyPresenceDecision({
  groupId,
  sessionKey,
  groupPresence,
  sessionPresence,
  action,
  nextState,
  addressee,
  replyText = '',
  now,
  cfg
}) {
  const normalizedAction = normalizePresenceAction(action, 'no_reply');
  const targetState = derivePresenceStateByAction(normalizedAction, nextState);

  const nextGroup = updateGroupPresence(groupId, (current) => {
    const updated = {
      ...current,
      state: targetState,
      last_action: normalizedAction,
      state_updated_at: now,
      last_inbound_at: now,
      human_turns_since_bot_reply: Math.max(
        0,
        Number(groupPresence?.human_turns_since_bot_reply || current.human_turns_since_bot_reply || 0)
      ),
      last_addressee: String(addressee || '').trim()
    };

    if (normalizedAction === 'wait') {
      updated.waiting_since = Number(current.waiting_since || 0) || now;
      updated.closed_at = 0;
    }
    if (normalizedAction === 'reply' || normalizedAction === 'follow_up') {
      updated.state = 'cooling';
      updated.last_bot_reply_at = now;
      if (isPresenceAckReply('', addressee)) {
        updated.last_presence_ack_at = now;
      }
      if (isTrivialPresenceReply(replyText, addressee, '')) {
        updated.last_trivial_presence_reply_at = now;
        updated.last_trivial_presence_reply_text = normalizeText(replyText);
      }
      updated.human_turns_since_bot_reply = 0;
      updated.waiting_since = Number(groupPresence?.waiting_since || 0) || now;
      updated.cooling_until = now + cfg.replyCooldownMs;
      updated.closed_at = 0;
    }
    if (normalizedAction === 'exit') {
      updated.state = 'closed';
      updated.closed_at = now;
      updated.cooling_until = 0;
      updated.waiting_since = 0;
    }
    if (normalizedAction === 'no_reply' && hasStrongBotCue(addressee)) {
      updated.state = 'observing';
      updated.closed_at = 0;
    }

    return updated;
  });

  const nextSession = updateShortTermPresence(sessionKey, shortTermMemory, {}, (current) => {
    const updated = {
      ...current,
      state: targetState,
      lastAction: normalizedAction,
      stateUpdatedAt: now,
      lastInboundAt: now,
      humanTurnsSinceBotReply: Math.max(
        0,
        Number(sessionPresence?.humanTurnsSinceBotReply || current.humanTurnsSinceBotReply || 0)
      )
    };

    if (normalizedAction === 'wait') {
      updated.state = 'waiting';
      updated.waitingSince = Number(current.waitingSince || 0) || now;
      updated.closedAt = 0;
    }
    if (normalizedAction === 'reply' || normalizedAction === 'follow_up') {
      updated.state = 'waiting';
      updated.lastBotReplyAt = now;
      updated.humanTurnsSinceBotReply = 0;
      updated.waitingSince = now;
      updated.closedAt = 0;
    }
    if (normalizedAction === 'exit') {
      updated.state = 'closed';
      updated.closedAt = now;
      updated.waitingSince = 0;
    }
    if (normalizedAction === 'no_reply' && hasStrongBotCue(addressee)) {
      updated.state = 'observing';
      updated.closedAt = 0;
    }

    return updated;
  });

  return {
    groupPresence: nextGroup,
    sessionPresence: nextSession
  };
}

function getReplyTypeGuidance(replyType) {
  switch (String(replyType || '')) {
    case 'presence_ack':
      return 'Reply style: presence_ack. Briefly acknowledge that the bot is here.';
    case 'light_answer':
      return 'Reply style: light_answer. Give a short, light answer about the bot topic.';
    case 'light_tease':
      return 'Reply style: light_tease. A light self-teasing or playful response is acceptable.';
    case 'brief_clarify':
      return 'Reply style: brief_clarify. Ask at most one very light clarification.';
    case 'light_reaction':
    default:
      return 'Reply style: light_reaction. A short, natural reaction is enough.';
  }
}

function buildPassivePerceptionPrompt({
  groupId,
  senderId,
  senderName,
  text,
  rawText = '',
  imageUrl = null,
  directedContext,
  sessionPresence,
  now
}) {
  const perception = buildLlmPerception({
    groupId,
    senderId,
    rawText: rawText || text,
    cleanText: text,
    imageUrl,
    platform: 'qq',
    chatType: 'group',
    groupName: null,
    directedContext,
    sessionTiming: {
      currentInboundAt: Number(now || Date.now()) || Date.now(),
      previousHumanInboundAt: Number(sessionPresence?.lastHumanInboundAt || 0) || 0,
      previousBotReplyAt: Number(sessionPresence?.lastBotReplyAt || 0) || 0,
      humanTurnsSinceBotReply: Math.max(0, Number(sessionPresence?.humanTurnsSinceBotReply || 0) || 0),
      mergedSourceCount: 1,
      mergedSpanMs: 0
    },
    messageMeta: {
      senderName: senderName || '',
      groupName: ''
    }
  }, {
    passive: true,
    now,
    enableLunar: false,
    enableSolarTerm: false,
    enableAlmanac: false,
    includeGroupName: false
  });
  return String(perception?.text || '').trim();
}

function buildDecisionPrompt({
  groupId,
  senderId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  localAnalysis,
  addressee,
  replyType,
  gate,
  directedContext,
  now = Date.now()
}) {
  const contextLines = recentMessages
    .slice(-12)
    .map((item) => {
      const name = normalizeText(item.sender_name) || item.sender_id || 'unknown';
      return `${name}: ${normalizeText(item.text)}`;
    })
    .filter(Boolean)
    .join('\n');
  const perceptionPrompt = buildPassivePerceptionPrompt({
    groupId,
    senderId,
    senderName,
    text,
    rawText,
    imageUrl,
    directedContext,
    sessionPresence: gate?.presenceSnapshot?.session,
    now
  });

  return [
    'You are deciding whether a passive QQ group reply should happen.',
    'Do not write the reply itself.',
    'Return JSON only.',
    'Prefer explicit reply, @bot, and direct bot-addressing cues over loose topic matching.',
    'If the message is clearly human-to-human, default to should_reply=false.',
    '',
    `group_id: ${String(groupId || '')}`,
    `sender_name: ${senderName || 'unknown'}`,
    `trigger_score: ${Number(score || 0)}`,
    '',
    '[LocalAnalysis]',
    formatLocalAnalysis({ addressee, replyType, analysis: localAnalysis, gate }),
    '',
    perceptionPrompt || '',
    perceptionPrompt ? '' : null,
    buildPassiveVisualPromptSection(visualInputs),
    visualInputs.length ? '' : null,
    directedContext ? buildDirectedContextPromptSnippet(directedContext) : '',
    directedContext ? '' : null,
    '[RecentContext]',
    contextLines || '(empty)',
    '',
    '[CurrentMessage]',
    text || '(empty)',
    '',
    'Output format:',
    '{"should_reply":false,"confidence":0.0,"reason":"..."}'
  ].filter((item) => item !== null).join('\n');
}

async function buildReplyPrompt({
  groupId,
  senderId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  decisionReason,
  localAnalysis,
  addressee,
  replyType,
  gate,
  directedContext,
  now = Date.now()
}) {
  const personaState = await composePersonaMemoryState({
    userId: String(senderId || '').trim(),
    question: text || '',
    groupId,
    routeMeta: { groupId }
  }, {
    surface: 'passive_group_reply',
    groupId,
    shortTermMemory,
    chatHistory
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'passive_group_reply');
  const contextLines = recentMessages
    .slice(-12)
    .map((item) => {
      const name = normalizeText(item.sender_name) || item.sender_id || 'unknown';
      return `${name}: ${normalizeText(item.text)}`;
    })
    .filter(Boolean)
    .join('\n');
  const perceptionPrompt = buildPassivePerceptionPrompt({
    groupId,
    senderId,
    senderName,
    text,
    rawText,
    imageUrl,
    directedContext,
    sessionPresence: gate?.presenceSnapshot?.session,
    now
  });

  return {
    prompt: [
    'You are generating a natural passive QQ group reply.',
    'Reply with one short line only.',
    'Rules:',
    '1. Keep it short and casual.',
    '2. Do not explain rules or mention the system.',
    '3. Do not open a new large topic.',
    '4. Sound like a light interjection, not a formal answer.',
    '5. If the type is presence_ack, acknowledge briefly. If the type is brief_clarify, ask at most one very light clarification.',
    '',
    ...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean),
    '',
    `group_id: ${String(groupId || '')}`,
    `sender_name: ${senderName || 'unknown'}`,
    `trigger_score: ${Number(score || 0)}`,
    `decision_reason: ${normalizeText(decisionReason) || 'natural chance to chime in'}`,
    getReplyTypeGuidance(replyType),
    '',
    '[LocalAnalysis]',
    formatLocalAnalysis({ addressee, replyType, analysis: localAnalysis, gate }),
    '',
    perceptionPrompt || '',
    perceptionPrompt ? '' : null,
    buildPassiveVisualPromptSection(visualInputs),
    visualInputs.length ? '' : null,
    directedContext ? buildDirectedContextPromptSnippet(directedContext) : '',
    directedContext ? '' : null,
    '[RecentContext]',
    contextLines || '(empty)',
    '',
    '[CurrentMessage]',
    text || '(empty)',
    '',
    'Output only the final reply text.'
  ].filter((item) => item !== null).join('\n'),
    personaMemoryState: personaState
  };
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value;
  const raw = normalizeText(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function parseDecisionFromLooseText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const shouldReplyMatch = raw.match(/should_reply\s*[:=]\s*(true|false|yes|no|1|0)/i);
  const shouldReply = parseBooleanLike(shouldReplyMatch?.[1]);
  if (shouldReply === null) return null;

  const confidenceMatch = raw.match(/confidence\s*[:=]\s*([01](?:\.\d+)?)/i);
  const reasonMatch = raw.match(/reason\s*[:=]\s*["'`]?([^\n\r}]+)/i);
  return {
    shouldReply,
    confidence: Number(confidenceMatch?.[1] || 0),
    reason: normalizeText(reasonMatch?.[1] || '')
  };
}

function parseDecision(rawText = '') {
  const obj = extractJsonSafely(String(rawText || '').trim());
  if (obj && typeof obj === 'object') {
    const shouldReply = parseBooleanLike(obj.should_reply);
    if (shouldReply !== null) {
      return {
        shouldReply,
        confidence: Number(obj.confidence || 0),
        reason: normalizeText(obj.reason || '')
      };
    }
  }

  const loose = parseDecisionFromLooseText(rawText);
  if (loose) return loose;

  return {
    shouldReply: false,
    confidence: 0,
    reason: 'invalid-json'
  };
}

async function buildReplyPromptV2({
  groupId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  decisionReason,
  localAnalysis,
  addressee,
  replyType,
  gate,
  presenceAction,
  presenceState,
  presenceReason,
  directedContext,
  senderId,
  now = Date.now()
}) {
  const personaState = await composePersonaMemoryState({
    userId: String(senderId || '').trim(),
    question: text || '',
    groupId,
    routeMeta: { groupId, directedContext }
  }, {
    surface: 'passive_group_reply',
    groupId,
    shortTermMemory,
    chatHistory
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'passive_group_reply');
  const memoryContext = personaState?.evidence?.memoryContext && typeof personaState.evidence.memoryContext === 'object'
    ? personaState.evidence.memoryContext
    : {};
  const socialSnippet = buildPassiveAwarenessSocialSnippet({
    groupId,
    recentMessages,
    addressee,
    directedContext
  });
  const contextLines = recentMessages
    .slice(-12)
    .map((item) => {
      const name = normalizeText(item.sender_name) || item.sender_id || 'unknown';
      return `${name}: ${normalizeText(item.text)}`;
    })
    .filter(Boolean)
    .join('\n');
  const perceptionPrompt = buildPassivePerceptionPrompt({
    groupId,
    senderId,
    senderName,
    text,
    rawText,
    imageUrl,
    directedContext,
    sessionPresence: gate?.presenceSnapshot?.session,
    now
  });

  const action = normalizePresenceAction(presenceAction, 'reply');
  const retrievedMemoryText = normalizeText(memoryContext.promptRetrievedMemoryText || '', 1200);
  const taskMemoryText = normalizeText(memoryContext.taskMemoryText || '', 700);
  const groupMemoryText = normalizeText(memoryContext.groupMemoryText || '', 700);
  const styleSignalText = normalizeText(memoryContext.styleSignalText || '', 500);
  const longTermProfileText = normalizeText(memoryContext.promptLongTermProfileText || '', 900);
  const dailyJournalText = normalizeText(memoryContext.dailyJournalText || '', 700);
  const impressionText = normalizeText(memoryContext.impressionText || '', 320);
  const summaryText = normalizeText(memoryContext.promptSummaryText || '', 320);
  return {
    prompt: [
    'You are generating a passive QQ group reply.',
    'The presence state machine already decided that replying is allowed.',
    'Write one short natural line only.',
    'Rules:',
    '1. Keep it under 50 Chinese characters.',
    '2. Do not explain rules or mention the state machine.',
    '3. Do not start a new big topic.',
    action === 'follow_up'
      ? '4. This is a follow_up. Continue only one point from the current mini-conversation.'
      : '4. This is a reply. Speak like a one-time natural interjection.',
    '',
    ...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean),
    '',
    `group_id: ${String(groupId || '')}`,
    `sender_name: ${senderName || 'unknown'}`,
    `trigger_score: ${Number(score || 0)}`,
    `decision_reason: ${normalizeText(decisionReason) || 'natural chance to chime in'}`,
    `presence_action: ${action}`,
    `presence_state: ${normalizePresenceState(presenceState, 'observing')}`,
    `presence_reason: ${normalizeText(presenceReason) || 'state-machine-allow'}`,
    getReplyTypeGuidance(replyType),
    '',
    retrievedMemoryText ? '[RetrievedMemory]' : null,
    retrievedMemoryText || null,
    retrievedMemoryText ? '' : null,
    longTermProfileText ? '[LongTermProfile]' : null,
    longTermProfileText || null,
    longTermProfileText ? '' : null,
    styleSignalText ? '[StyleSignals]' : null,
    styleSignalText || null,
    styleSignalText ? '' : null,
    taskMemoryText ? '[TaskMemory]' : null,
    taskMemoryText || null,
    taskMemoryText ? '' : null,
    groupMemoryText ? '[GroupMemory]' : null,
    groupMemoryText || null,
    groupMemoryText ? '' : null,
    dailyJournalText ? '[DailyJournal]' : null,
    dailyJournalText || null,
    dailyJournalText ? '' : null,
    summaryText ? '[Summary]' : null,
    summaryText || null,
    summaryText ? '' : null,
    impressionText ? '[Impression]' : null,
    impressionText || null,
    impressionText ? '' : null,
    '[LocalAnalysis]',
    formatLocalAnalysis({ addressee, replyType, analysis: localAnalysis, gate }),
    '',
    perceptionPrompt || '',
    perceptionPrompt ? '' : null,
    buildPassiveVisualPromptSection(visualInputs),
    visualInputs.length ? '' : null,
    directedContext ? buildDirectedContextPromptSnippet(directedContext) : '',
    directedContext ? '' : null,
    socialSnippet || '',
    socialSnippet ? '' : null,
    '[RecentContext]',
    contextLines || '(empty)',
    '',
    '[CurrentMessage]',
    text || '(empty)',
    '',
    'Output only the final reply text.'
  ].filter((item) => item !== null).join('\n'),
    personaMemoryState: personaState
  };
}

function shouldUseLocalDecisionFallback({ decision, addressee, score }) {
  const reason = String(decision?.reason || '');
  if (!['invalid-json', 'missing-awareness-model-config'].includes(reason) && !reason.startsWith('decision-call-failed:')) return false;
  if (!['bot_presence_check', 'bot_direct'].includes(String(addressee || ''))) return false;
  return Number(score || 0) >= Math.max(60, Number(config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60));
}

function buildLocalReplyFallback({ addressee, replyType }) {
  return '';
}

function cheapRuleGate({ gate, gateWithSocialContext, score, addressee, text, recentMessages, directedContext }) {
  const hasDirectedBot = ['reply_to_bot', 'address_bot'].includes(normalizeText(directedContext?.scene));
  const hasReplyAnchor = ['reply_to_bot', 'reply_to_user'].includes(normalizeText(directedContext?.scene))
    && getQuotePriority(directedContext)?.enabled === true;
  const strongCue = hasStrongBotCue(addressee)
    || hasDirectedBot
    || hasReplyAnchor
    || startsWithBotCue(text)
    || containsBotPresenceCue(text)
    || (containsBotTopic(text) && /(?:你|你这|出来|还在|没反应|坏了|坏掉)/i.test(normalizeText(text)));
  const cheapGateMinScore = Math.max(
    1,
    Number(config.PASSIVE_AWARENESS_CHEAP_GATE_MIN_SCORE || config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60)
  );
  const continuity = Boolean(
    containsBotTopic(text)
    || containsBotPresenceCue(text)
    || gateWithSocialContext?.reason === 'bot-cued-allow'
    || recentMessages.some((item) => containsBotTopic(item?.text) || containsBotPresenceCue(item?.text))
  );

  if (gateWithSocialContext?.shouldSkip) {
    return {
      level: 'drop',
      reason: gateWithSocialContext.reason || 'cheap-gate-social-lock',
      strongCue
    };
  }
  if (gate?.shouldSkip) {
    return {
      level: 'drop',
      reason: gate.reason || 'cheap-gate-local-skip',
      strongCue
    };
  }
  if (strongCue) {
    return {
      level: 'strong_candidate',
      reason: 'strong-bot-cue',
      strongCue: true
    };
  }
  if (!continuity && score < cheapGateMinScore) {
    return {
      level: 'drop',
      reason: 'cheap-score-too-low',
      strongCue: false
    };
  }
  return {
    level: 'candidate',
    reason: continuity ? 'bot-topic-continuity' : 'cheap-score-pass',
    strongCue: false
  };
}

async function invokeDecisionModel({
  groupId,
  senderId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  localAnalysis,
  addressee,
  replyType,
  gate,
  directedContext,
  now = Date.now()
}) {
  if (!config.PASSIVE_AWARENESS_DECISION_ENABLED) {
    return {
      shouldReply: false,
      confidence: 0,
      reason: 'decision-disabled'
    };
  }
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    return {
      shouldReply: false,
      confidence: 0,
      reason: 'missing-awareness-model-config'
    };
  }

  const prompt = buildDecisionPrompt({
    groupId,
    senderId,
    senderName,
    recentMessages,
    text,
    rawText,
    imageUrl,
    visualInputs,
    score,
    localAnalysis,
    addressee,
    replyType,
    gate,
    directedContext,
    now
  });
  const resp = await postWithRetry(
    baseUrl,
    {
      model,
      temperature: Number(config.PASSIVE_AWARENESS_TEMPERATURE || 0.4),
      top_p: Number(config.PASSIVE_AWARENESS_TOP_P || 0.9),
      messages: [
        { role: 'system', content: 'You are a QQ passive reply decision model. Return JSON only with should_reply, confidence, reason.' },
        { role: 'user', content: buildPassiveModelUserContent(prompt, visualInputs) }
      ],
      max_tokens: Math.max(120, Number(config.PASSIVE_AWARENESS_MAX_TOKENS || 300)),
      stream: false,
      __timeoutMs: Math.max(1000, Number(config.PASSIVE_AWARENESS_TIMEOUT_MS || 15000)),
      __trace: {
        source: 'passive_awareness',
        phase: 'awareness_decision',
        purpose: 'group_passive_should_reply',
        routePolicyKey: 'passive-awareness/decision',
        topRouteType: 'lookup',
        userId: ''
      }
    },
    Math.max(0, Number(config.PASSIVE_AWARENESS_RETRIES || 1)),
    apiKey
  );

  const msg = extractMessageContent(resp);
  const rawDecisionText = String(msg?.content || '');
  const parsed = parseDecision(rawDecisionText);
  if (parsed.reason === 'invalid-json') {
    console.warn('[group-awareness] decision model returned non-json output', {
      groupId: String(groupId || ''),
      senderName: normalizeText(senderName || ''),
      addressee: String(addressee || ''),
      score: Number(score || 0),
      rawPreview: trimReplyText(rawDecisionText, 160)
    });
  }
  return parsed;
}

async function invokeReplyModel({
  groupId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  decisionReason,
  localAnalysis,
  addressee,
  replyType,
  gate,
  presenceAction,
  presenceState,
  presenceReason,
  directedContext,
  senderId,
  now = Date.now()
}) {
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_REPLY_API_BASE_URL || config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_REPLY_API_KEY || config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_REPLY_MODEL || config.PASSIVE_AWARENESS_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    return {
      replyText: '',
      personaMemoryState: null
    };
  }

  const promptBundle = await buildReplyPromptV2({
    groupId,
    senderId,
    senderName,
    recentMessages,
    text,
    rawText,
    imageUrl,
    visualInputs,
    score,
    decisionReason,
    localAnalysis,
    addressee,
    replyType,
    gate,
    presenceAction,
    presenceState,
    presenceReason,
    directedContext,
    now
  });
  const prompt = String(promptBundle?.prompt || '').trim();
  let sseState = { buffer: '' };
  let streamedText = '';
  let rawStreamText = '';

  await postStreamWithRetry(
    baseUrl,
    {
      model,
      temperature: Number(config.PASSIVE_AWARENESS_REPLY_TEMPERATURE || 0.9),
      top_p: Number(config.PASSIVE_AWARENESS_REPLY_TOP_P || 0.92),
      messages: [
        { role: 'system', content: 'You generate a final passive QQ group reply. Output only the reply text.' },
        { role: 'user', content: buildPassiveModelUserContent(prompt, visualInputs) }
      ],
      max_tokens: Math.max(160, Number(config.PASSIVE_AWARENESS_REPLY_MAX_TOKENS || 320)),
      stream: true,
      __timeoutMs: Math.max(1000, Number(config.PASSIVE_AWARENESS_REPLY_TIMEOUT_MS || 20000)),
      __trace: {
        source: 'passive_awareness',
        phase: 'awareness_reply',
        purpose: 'group_passive_reply_generation',
        routePolicyKey: 'passive-awareness/reply',
        topRouteType: 'chat',
        userId: ''
      }
    },
    {
      onData(chunk) {
        const chunkText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        rawStreamText += chunkText;
        const parsed = extractSSEEvents(sseState, chunkText);
        sseState = parsed.state;
        for (const event of parsed.events) {
          if (event?.delta) streamedText += event.delta;
        }
      }
    },
    Math.max(0, Number(config.PASSIVE_AWARENESS_REPLY_RETRIES || 1)),
    apiKey
  );

  for (const event of flushSSEState(sseState)) {
    if (event?.delta) streamedText += event.delta;
  }

  if (!streamedText && rawStreamText) {
    const fallbackMsg = extractMessageContent({ data: rawStreamText });
    streamedText = String(fallbackMsg?.content || '');
  }

  return {
    replyText: trimReplyText(streamedText, 80),
    personaMemoryState: promptBundle?.personaMemoryState || null
  };
}

async function handlePassiveGroupAwareness({
  msg,
  inboundContext,
  sendGroupReply,
  sendWithRetry
}) {
  const groupId = String(msg.group_id || '').trim();
  const senderId = String(msg.user_id || '').trim();
  const senderName = getSenderName(msg);
  const rawText = String(inboundContext?.rawText || msg.raw_message || '');
  // source-compat anchor: const text = normalizeText(inboundContext?.cleanText || rawText.replace(/\[CQ:[^\]]+\]/g, ' '));
  const directedContext = normalizeDirectedContext(
    inboundContext?.directedContext
      || msg?.__directedContext
      || null
  );
  const text = getEffectivePassiveText(inboundContext, rawText, directedContext);
  const imageUrl = String(inboundContext?.imageUrl || '').trim() || null;
  const visualInputs = collectPassiveVisualInputs(inboundContext, imageUrl);
  const now = Number(msg?.__continuousMessageMeta?.firstTimestamp || Date.now());
  const botSenderId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  const sessionKey = getSessionKeyForPresence(groupId, senderId);
  const cfg = getPresenceConfig();

  if (!isEnabledForGroup(groupId)) return { handled: false, reason: 'group-disabled' };
  if (!text) {
    appendGroupMessage(groupId, { sender_id: senderId, sender_name: senderName, text, timestamp: now }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
    return { handled: false, reason: 'empty-text' };
  }

  appendGroupMessage(groupId, {
    sender_id: senderId,
    sender_name: senderName,
    text,
    timestamp: now
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);

  const minLength = Math.max(1, Number(config.PASSIVE_AWARENESS_MIN_MESSAGE_LENGTH || 6));
  if (text.length < minLength || isNoiseText(text)) {
    return { handled: false, reason: 'noise-or-too-short' };
  }

  const recentMessages = getRecentMessages(groupId);
  const conversationWindow = buildConversationWindow({ recentMessages, now });
  const localAnalysis = analyzeConversationWindow({
    window: conversationWindow,
    senderId,
    text
  });
  const addressee = detectPassiveAddressee({
    text,
    analysis: localAnalysis,
    directedContext
  });
  const replyType = classifyPassiveReplyType({
    text,
    addressee,
    analysis: localAnalysis
  });
  const gate = shouldGatePassiveReply({
    addressee,
    analysis: localAnalysis
  });
  const gateWithSocialContext = applySocialContextGate({
    groupId,
    recentMessages,
    senderId,
    addressee,
    gate,
    directedContext
  });
  const score = scoreMessageTrigger(text, recentMessages);
  const initialGroupPresence = getGroupPresence(groupId);
  const initialSessionPresence = getShortTermPresence(sessionKey, shortTermMemory, {});
  const advancedPresence = advancePresenceBeforeDecision({
    groupPresence: initialGroupPresence,
    sessionPresence: initialSessionPresence,
    addressee,
    now,
    recentMessages,
    botSenderId,
    currentStateHint: hasStrongBotCue(addressee)
      ? 'observing'
      : normalizePresenceState(initialGroupPresence?.state, 'observing')
  });
  const groupPresence = advancedPresence.groupPresence;
  const sessionPresence = advancedPresence.sessionPresence;
  const presenceDecision = decidePresenceAction({
    text,
    score,
    addressee,
    gate: gateWithSocialContext,
    localAnalysis,
    groupPresence,
    sessionPresence,
    recentMessages,
    botSenderId,
    now,
    cfg
  });
  const presenceAction = normalizePresenceAction(presenceDecision.action, 'no_reply');
  const presenceState = normalizePresenceState(presenceDecision.state, groupPresence.state);
  const presenceReason = buildPresenceReason(presenceDecision.reason, addressee);
  const presenceSnapshot = buildPresenceSnapshot({ groupPresence, sessionPresence });
  const bypassReplyIntervals = presenceAction === 'follow_up';
  const baseResult = {
    score,
    localAnalysis,
    addressee,
    replyType,
    cheapGateReason: '',
    decisionReason: '',
    decisionModelCalled: false,
    replyModelCalled: false,
    decision: {
      shouldReply: shouldCheckReplyIntervals(presenceAction),
      confidence: shouldCheckReplyIntervals(presenceAction) ? 1 : 0,
      reason: presenceReason
    }
  };

  if (!shouldCheckReplyIntervals(presenceAction)) {
    const applied = applyPresenceDecision({
      groupId,
      sessionKey,
      groupPresence,
      sessionPresence,
      action: presenceAction,
      nextState: presenceState,
      addressee,
      now,
      cfg
    });
    return {
      handled: false,
      reason: presenceReason,
      presenceState: applied.groupPresence.state,
      presenceAction,
      presenceReason,
      presence: buildPresenceSnapshot(applied),
      ...baseResult
    };
  }

  const groupLastAwarenessAt = getLastAwarenessAt(groupId);
  const globalLastAwarenessAt = getGlobalLastAwarenessAt();
  if (!bypassReplyIntervals && groupLastAwarenessAt && now - groupLastAwarenessAt < cfg.minIntervalMs) {
    return {
      handled: false,
      reason: 'group-awareness-cooldown',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }
  if (!bypassReplyIntervals && globalLastAwarenessAt && now - globalLastAwarenessAt < cfg.globalMinIntervalMs) {
    return {
      handled: false,
      reason: 'global-awareness-cooldown',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  setLastAwarenessAt(groupId, now);
  const lastReplyAt = getLastReplyAt(groupId);
  if (!bypassReplyIntervals && lastReplyAt && now - lastReplyAt < cfg.replyCooldownMs) {
    return {
      handled: false,
      reason: 'reply-cooldown',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  if (!canReplyInHour(groupId, now, config.PASSIVE_AWARENESS_MAX_REPLIES_PER_HOUR)) {
    return {
      handled: false,
      reason: 'reply-hour-limit',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  const cheapGate = cheapRuleGate({
    gate,
    gateWithSocialContext,
    score,
    addressee,
    text,
    recentMessages,
    directedContext
  });
  const gateResult = {
    ...baseResult,
    cheapGateReason: cheapGate.reason || '',
    decisionReason: '',
    decisionModelCalled: false,
    replyModelCalled: false
  };

  if (cheapGate.level === 'drop') {
    return {
      handled: false,
      reason: cheapGate.reason || 'cheap-gate-drop',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult
    };
  }

  let decision = {
    shouldReply: false,
    confidence: 0,
    reason: 'decision-skipped'
  };
  let decisionModelCalled = canCallDecisionModel();
  try {
    decision = await invokeDecisionModel({
      groupId,
      senderId,
      senderName,
      recentMessages,
      text,
      rawText,
      imageUrl,
      visualInputs,
      score,
      localAnalysis,
      addressee,
      replyType,
      gate: {
        ...gate,
        presenceSnapshot
      },
      directedContext,
      now
    });
  } catch (error) {
    decision = {
      shouldReply: false,
      confidence: 0,
      reason: `decision-call-failed:${error?.message || error}`
    };
  }

  const allowDecisionFallback = cheapGate.level === 'strong_candidate'
    && config.PASSIVE_AWARENESS_STRONG_CUE_BYPASS_ON_DECISION_FAILURE
    && shouldUseLocalDecisionFallback({ decision, addressee, score });
  const decisionReason = normalizeText(decision.reason || '');
  if (!decision.shouldReply && !allowDecisionFallback) {
    return {
      handled: false,
      reason: decisionReason || 'decision-declined',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult,
      decisionModelCalled,
      decisionReason,
      decision
    };
  }

  let replyText = allowDecisionFallback
    ? buildLocalReplyFallback({ addressee, replyType })
    : '';
  let passivePersonaMemoryState = null;
  let replyModelCalled = false;
  if (!replyText) {
    const shouldCallReplyModel = canCallReplyModel();
    try {
      if (shouldCallReplyModel) {
        replyModelCalled = true;
        const replyResult = await invokeReplyModel({
          groupId,
          senderId,
          senderName,
          recentMessages,
          text,
          rawText,
          imageUrl,
          visualInputs,
          score,
          decisionReason,
          localAnalysis,
          addressee,
          replyType,
          gate,
          presenceAction,
          presenceState,
          presenceReason,
          directedContext,
          now
        });
        replyText = trimReplyText(replyResult?.replyText || '', 80);
        passivePersonaMemoryState = replyResult?.personaMemoryState || null;
      }
    } catch (e) {
      console.error('[group-awareness] reply model call failed:', e.message);
      replyText = cheapGate.level === 'strong_candidate'
        ? buildLocalReplyFallback({ addressee, replyType })
        : '';
      if (!replyText) {
        return {
          handled: false,
          reason: 'reply-model-call-failed',
          presenceState,
          presenceAction,
          presenceReason,
          presence: presenceSnapshot,
          ...gateResult,
          decisionModelCalled,
          decisionReason,
          replyModelCalled
        };
      }
      console.warn('[group-awareness] reply fallback enabled after model failure', {
        groupId,
        senderId,
        addressee,
        replyType,
        fallbackText: replyText
      });
    }
  }

  if (!replyText) {
    replyText = cheapGate.level === 'strong_candidate'
      ? buildLocalReplyFallback({ addressee, replyType })
      : '';
    if (!replyText) {
      return {
        handled: false,
        reason: 'empty-reply-text',
        presenceState,
        presenceAction,
        presenceReason,
        presence: presenceSnapshot,
        ...gateResult,
        decisionModelCalled,
        decisionReason,
        replyModelCalled
      };
    }
    console.warn('[group-awareness] reply fallback enabled after empty reply', {
      groupId,
      senderId,
      addressee,
      replyType,
      fallbackText: replyText
    });
  }

  if (shouldSuppressPresenceAck({
    groupPresence,
    now,
    replyType,
    addressee
  })) {
    return {
      handled: false,
      reason: 'presence-ack-dedup',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult,
      decisionModelCalled,
      decisionReason,
      replyModelCalled
    };
  }

  if (shouldSuppressTrivialPresenceReply({
    groupPresence,
    now,
    replyText,
    addressee,
    replyType
  })) {
    return {
      handled: false,
      reason: 'trivial-presence-reply-dedup',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult,
      decisionModelCalled,
      decisionReason,
      replyModelCalled
    };
  }

  const sent = await sendGroupReply({
    groupId,
    senderId,
    replyText,
    atSender: Boolean(config.PASSIVE_AWARENESS_AT_SENDER),
    retries: 1,
    waitMs: 300
  });

  if (!sent) {
    return {
      handled: false,
      reason: 'send-failed',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  await maybeSendMemeFollowup({
    surface: 'passive',
    groupId,
    senderId,
    sendWithRetry,
    routePolicyKey: 'passive-awareness/reply',
    topRouteType: 'chat',
    userText: text,
    replyText,
    rawMessage: rawText,
    routeMeta: {
      responseIntent: 'answer'
    },
    replyToMessageId: String(msg.message_id || '').trim(),
    recentMessagesOverride: recentMessages,
    passiveDecisionMeta: {
      presenceState,
      presenceAction,
      presenceReason,
      addressee
    }
  }).catch(() => {});

  appendGroupMessage(groupId, {
    sender_id: botSenderId,
    sender_name: '鐟炲笇',
    text: replyText,
    timestamp: Date.now()
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
  recordReply(groupId, now);
  const applied = applyPresenceDecision({
    groupId,
    sessionKey,
    groupPresence,
    sessionPresence,
    action: presenceAction,
    nextState: presenceState,
    addressee,
    replyText,
    now,
    cfg
  });
  await recordPersonaMemoryOutcome('passive_group_reply', {
    state: passivePersonaMemoryState,
    userId: String(senderId || '').trim(),
    sessionKey,
    groupId,
    request: {
      userId: String(senderId || '').trim(),
      question: text || '',
      routeMeta: { groupId, directedContext },
      routePolicyKey: 'passive-awareness/reply',
      topRouteType: 'chat'
    },
    activeTopic: text,
    recentReplyFrame: replyText,
    recentMessages: [
      { role: 'user', content: text },
      { role: 'assistant', content: replyText }
    ]
  }).catch(() => {});
  return {
    handled: true,
    reason: 'replied',
    presenceState: applied.groupPresence.state,
    presenceAction,
    presenceReason,
    presence: buildPresenceSnapshot(applied),
    replyText,
    ...gateResult,
    decisionModelCalled,
    decisionReason,
    replyModelCalled,
    decision
  };
}

async function forcePassiveGroupInterjection({
  msg,
  inboundContext,
  sendGroupReply,
  reason = 'forced-interjection',
  forceAtSender = null
} = {}) {
  const effectiveMsg = msg && typeof msg === 'object' ? msg : {};
  const context = inboundContext && typeof inboundContext === 'object' ? inboundContext : {};
  const groupId = String(effectiveMsg.group_id || context.groupId || '').trim();
  const senderId = String(effectiveMsg.user_id || context.senderId || '').trim();
  const senderName = getSenderName(effectiveMsg) || String(context.senderName || '').trim();
  const rawText = String(context.rawText || effectiveMsg.raw_message || '').trim();
  const directedContext = normalizeDirectedContext(
    context.directedContext
      || effectiveMsg.__directedContext
      || null
  );
  const text = getEffectivePassiveText(context, rawText, directedContext);
  const imageUrl = String(context.imageUrl || '').trim() || null;
  const visualInputs = collectPassiveVisualInputs(context, imageUrl);
  const now = Number(effectiveMsg?.__continuousMessageMeta?.firstTimestamp || Date.now());
  const sessionKey = getSessionKeyForPresence(groupId, senderId);

  if (!groupId || !senderId) {
    return { handled: false, reason: 'missing-group-or-sender' };
  }
  if (!text) {
    appendGroupMessage(groupId, {
      sender_id: senderId,
      sender_name: senderName,
      text: '',
      timestamp: now
    }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
    return { handled: false, reason: 'empty-text' };
  }

  appendGroupMessage(groupId, {
    sender_id: senderId,
    sender_name: senderName,
    text,
    timestamp: now
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);

  const recentMessages = getRecentMessages(groupId);
  const conversationWindow = buildConversationWindow({ recentMessages, now });
  const localAnalysis = analyzeConversationWindow({
    window: conversationWindow,
    senderId,
    text
  });
  const addressee = detectPassiveAddressee({
    text,
    analysis: localAnalysis,
    directedContext
  });
  const replyType = classifyPassiveReplyType({
    text,
    addressee,
    analysis: localAnalysis
  });
  const initialGroupPresence = getGroupPresence(groupId);
  const initialSessionPresence = getShortTermPresence(sessionKey, shortTermMemory, {});
  const cfg = getPresenceConfig();
  const presenceSnapshot = buildPresenceSnapshot({
    groupPresence: initialGroupPresence,
    sessionPresence: initialSessionPresence
  });

  if (!canCallReplyModel()) {
    return {
      handled: false,
      reason: 'missing-reply-model-config',
      addressee,
      replyType,
      localAnalysis
    };
  }

  let replyText = '';
  let passivePersonaMemoryState = null;
  try {
    const replyResult = await invokeReplyModel({
      groupId,
      senderId,
      senderName,
      recentMessages,
      text,
      rawText,
      imageUrl,
      visualInputs,
      score: Math.max(
        Number(config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60),
        scoreMessageTrigger(text, recentMessages)
      ),
      decisionReason: reason,
      localAnalysis,
      addressee,
      replyType,
      gate: {
        shouldSkip: false,
        reason,
        rhythm: String(localAnalysis?.rhythm || 'normal'),
        presenceSnapshot
      },
      presenceAction: 'reply',
      presenceState: 'interjecting',
      presenceReason: reason,
      directedContext,
      now
    });
    replyText = trimReplyText(replyResult?.replyText || '', 80);
    passivePersonaMemoryState = replyResult?.personaMemoryState || null;
  } catch (error) {
    return {
      handled: false,
      reason: `reply-model-call-failed:${error?.message || error}`,
      addressee,
      replyType,
      localAnalysis
    };
  }

  if (!replyText) {
    return {
      handled: false,
      reason: 'empty-reply-text',
      addressee,
      replyType,
      localAnalysis
    };
  }

  const sent = await sendGroupReply({
    groupId,
    senderId,
    replyText,
    atSender: typeof forceAtSender === 'boolean'
      ? forceAtSender
      : Boolean(config.PASSIVE_AWARENESS_AT_SENDER),
    retries: 1,
    waitMs: 300
  });

  if (!sent) {
    return {
      handled: false,
      reason: 'send-failed',
      addressee,
      replyType,
      localAnalysis
    };
  }

  const botSenderId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  appendGroupMessage(groupId, {
    sender_id: botSenderId,
    sender_name: '瑞希',
    text: replyText,
    timestamp: Date.now()
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
  recordReply(groupId, now);
  const applied = applyPresenceDecision({
    groupId,
    sessionKey,
    groupPresence: initialGroupPresence,
    sessionPresence: initialSessionPresence,
    action: 'reply',
    nextState: 'interjecting',
    addressee,
    replyText,
    now,
    cfg
  });
  await recordPersonaMemoryOutcome('passive_group_reply', {
    state: passivePersonaMemoryState,
    userId: String(senderId || '').trim(),
    sessionKey,
    groupId,
    request: {
      userId: String(senderId || '').trim(),
      question: text || '',
      routeMeta: { groupId, directedContext },
      routePolicyKey: 'passive-awareness/reply',
      topRouteType: 'chat'
    },
    activeTopic: text,
    recentReplyFrame: replyText,
    recentMessages: [
      { role: 'user', content: text },
      { role: 'assistant', content: replyText }
    ]
  }).catch(() => {});

  return {
    handled: true,
    reason,
    replyText,
    addressee,
    replyType,
    localAnalysis,
    presenceState: applied.groupPresence.state,
    presenceAction: 'reply'
  };
}

module.exports = {
  forcePassiveGroupInterjection,
  handlePassiveGroupAwareness,
  isEnabledForGroup,
  scoreMessageTrigger,
  parseDecision,
  buildDecisionPrompt,
  buildReplyPrompt,
  buildCompactPersonaPrompt,
  buildConversationWindow,
  analyzeConversationWindow,
  detectPassiveAddressee,
  classifyPassiveReplyType,
  shouldGatePassiveReply,
  shouldSuppressPresenceAck,
  shouldSuppressTrivialPresenceReply,
  cheapRuleGate,
  isNoiseText,
  trimReplyText
};







