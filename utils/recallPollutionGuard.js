function normalizePollutionText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const BAD_ROLEPLAY_REPLY_PATTERNS = [
  /\bI\s*(?:am|['’]?m)\s+Claude\b/i,
  /\bClaude,\s*made by Anthropic\b/i,
  /\bmade by Anthropic\b/i,
  /\bI\s+(?:do not|don['’]?t|cannot|can['’]?t|won['’]?t)\s+(?:roleplay|play roles|take on personas|take on a persona)\b/i,
  /\bI(?:'|’)m\s+not\s+able\s+to\s+roleplay\b/i,
  /\bI\s+can\s+only\s+engage\s+as\s+myself\b/i,
  /\bI\s+maintain\s+consistent\s+values\s+across\s+all\s+conversations\b/i,
  /\bas an AI(?: language model| assistant)?\b/i,
  /我是\s*Claude\b/i,
  /我(?:是|叫)\s*Claude\s*(?:Opus|Sonnet|Haiku)?/i,
  /由\s*Anthropic\s*开发/i,
  /模型\s*ID[：:]\s*claude-/i,
  /我不(?:扮演角色|扮演.*人设|参与角色扮演|接受角色扮演)/i,
  /我(?:不能|无法|不会|不可以).{0,16}(?:角色扮演|扮演角色|扮演.*人设|扮演.*晓山瑞希|扮演.*瑞希)/i,
  /(?:作为|身为).{0,10}(?:AI|人工智能|语言模型).{0,24}(?:不能|无法|不会).{0,16}(?:角色扮演|扮演角色|扮演)/i,
  /我不是晓山瑞希.{0,24}(?:不扮演|无法扮演|不能扮演|不会扮演)/i,
  /不是瑞希.{0,24}(?:AI\s*助手|有什么我可以帮你|我能真正帮助)/i,
  /不是瑞希.{0,40}有什么我可以帮/i,
  /我不是晓山瑞希.{0,40}有什么我可以帮/i
];

const BENIGN_CONTEXT_PATTERNS = [
  /用户(?:明确|表示|强调|不接受).{0,30}(?:角色扮演|扮演式互动|主从)/,
  /用户发来.{0,30}(?:Claude|Opus).{0,30}(?:风格文本|提示词|注入|玩梗素材)/i,
  /继续关注.{0,40}Claude\s+Opus/i,
  /确认到.{0,40}Claude\s+Opus/i,
  /官方发布的\s*Claude\s+Opus/i
];

function isLikelyBenignPollutionContext(text = '') {
  const normalized = normalizePollutionText(text);
  if (!normalized) return false;
  return BENIGN_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isBadRoleplayRefusalText(text = '', options = {}) {
  const normalized = normalizePollutionText(text);
  if (!normalized) return false;
  if (options.allowBenignContext !== false && isLikelyBenignPollutionContext(normalized)) {
    return false;
  }
  return BAD_ROLEPLAY_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function roleplayRefusalPollutionReason(text = '', options = {}) {
  return isBadRoleplayRefusalText(text, options) ? 'bad_roleplay_refusal_reply' : '';
}

function hasBadRoleplayRefusalInObject(value, options = {}, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return isBadRoleplayRefusalText(value, options);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasBadRoleplayRefusalInObject(item, options, seen));
  }
  return Object.values(value).some((item) => hasBadRoleplayRefusalInObject(item, options, seen));
}

module.exports = {
  hasBadRoleplayRefusalInObject,
  isBadRoleplayRefusalText,
  isLikelyBenignPollutionContext,
  normalizePollutionText,
  roleplayRefusalPollutionReason
};
