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
const { buildChatLivenessDisciplinePrompt } = require('../utils/chatLivenessContext');
const { buildDirectedContextPromptSnippet } = require('../api/graphPrompting');
const { buildLlmPerception } = require('./llmPerception');
const { appendUtf8Chunk } = require('../utils/utf8Stream');
const { sanitizeUserFacingText } = require('../utils/userFacingText');
const { StringDecoder } = require('string_decoder');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const PASSIVE_PROMPT_TEXT_MAX_CHARS = 800;
const PASSIVE_CONTEXT_MESSAGE_MAX_CHARS = 240;

function limitPassivePromptText(value, maxChars = PASSIVE_PROMPT_TEXT_MAX_CHARS) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const limit = Math.max(1, Number(maxChars) || PASSIVE_PROMPT_TEXT_MAX_CHARS);
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return chars.slice(0, limit).join('');
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

function hasPassiveVisualInput(visualInputs = []) {
  return (Array.isArray(visualInputs) ? visualInputs : [])
    .some((item) => Boolean(normalizeVisualUrl(item?.url)));
}

function shouldProbePassiveVisualCue({ hasVisualInput, addressee, gate } = {}) {
  if (!hasVisualInput || gate?.shouldSkip) return false;
  return ['group_open_question', 'group_bot_topic', 'unclear'].includes(String(addressee || '').trim());
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

function normalizePassiveReplyText(value, maxChars = 80) {
  const sanitized = sanitizeUserFacingText(trimReplyText(value, maxChars), { returnMeta: true });
  return {
    replyText: trimReplyText(sanitized.text, maxChars),
    hasSafetyRestriction: sanitized.hasSafetyRestriction === true
  };
}

async function markPassiveSafetyRestrictionEmoji({
  messageId,
  sendWithRetry
} = {}) {
  const normalizedMessageId = String(messageId || '').trim();
  const send = typeof sendWithRetry === 'function' ? sendWithRetry : null;
  const emojiIds = Array.isArray(config.QQ_SAFETY_RESTRICTION_EMOJI_IDS)
    ? config.QQ_SAFETY_RESTRICTION_EMOJI_IDS
    : [];
  if (!normalizedMessageId || !send || !emojiIds.length) return false;

  let sentAny = false;
  for (const emojiId of emojiIds) {
    const id = Number(emojiId);
    if (!Number.isInteger(id)) continue;
    const ok = await send({
      action: 'set_msg_emoji_like',
      params: {
        message_id: /^\d+$/.test(normalizedMessageId) ? Number(normalizedMessageId) : normalizedMessageId,
        emoji_id: id,
        set: true
      }
    }, 1, 300);
    sentAny = sentAny || Boolean(ok);
  }
  return sentAny;
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
  const useMainReplyModel = config.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL === true;
  const baseUrl = ensureChatCompletionsUrl(useMainReplyModel
    ? config.API_BASE_URL
    : (config.PASSIVE_AWARENESS_REPLY_API_BASE_URL || config.PASSIVE_AWARENESS_API_BASE_URL));
  const apiKey = String(useMainReplyModel
    ? config.API_KEY
    : (config.PASSIVE_AWARENESS_REPLY_API_KEY || config.PASSIVE_AWARENESS_API_KEY || '')).trim();
  const model = String(useMainReplyModel
    ? config.AI_MODEL
    : (config.PASSIVE_AWARENESS_REPLY_MODEL || config.PASSIVE_AWARENESS_MODEL || '')).trim();
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
  const context = { ...input };
  if (context.quote && typeof context.quote === 'object') {
    context.quote = {
      ...context.quote,
      text: limitPassivePromptText(context.quote.text, PASSIVE_CONTEXT_MESSAGE_MAX_CHARS)
    };
  }
  if (context.forwardContext && typeof context.forwardContext === 'object') {
    context.forwardContext = {
      ...context.forwardContext,
      summaryText: limitPassivePromptText(context.forwardContext.summaryText, PASSIVE_PROMPT_TEXT_MAX_CHARS)
    };
  }
  if (context.quotePriority && typeof context.quotePriority === 'object') {
    context.quotePriority = {
      ...context.quotePriority,
      reason: limitPassivePromptText(context.quotePriority.reason, 160),
      quoteAnchoredText: limitPassivePromptText(context.quotePriority.quoteAnchoredText)
    };
  }
  return context;
}

function getQuotePriority(directedContext = null) {
  return directedContext?.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
}

function stripPassiveCqControls(value = '') {
  return normalizeText(String(value || '').replace(/\[CQ:[^\]]+\]/g, ' '));
}

function getEffectivePassiveText(inboundContext = null, rawText = '', directedContext = null, visualInputs = []) {
  const anchored = String(getQuotePriority(directedContext)?.quoteAnchoredText || '').trim();
  if (anchored) return limitPassivePromptText(anchored);
  const cleanText = stripPassiveCqControls(inboundContext?.cleanText || '');
  if (cleanText) return limitPassivePromptText(cleanText);
  const fallbackText = stripPassiveCqControls(rawText);
  if (fallbackText) return limitPassivePromptText(fallbackText);
  return hasPassiveVisualInput(visualInputs) ? '[图片]' : '';
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
      text: limitPassivePromptText(item?.text, PASSIVE_CONTEXT_MESSAGE_MAX_CHARS),
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

