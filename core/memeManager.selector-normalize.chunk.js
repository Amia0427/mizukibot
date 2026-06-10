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

