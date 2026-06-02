function normalizeContextText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasModelSelfIdentity(text = '') {
  const value = normalizeContextText(text);
  if (!value) return false;
  return /\bClaude\b/i.test(value)
    || /\bAnthropic\b/i.test(value)
    || /我是\s*(?:Claude|克劳德)/i.test(value)
    || /模型\s*ID\s*[:：]?\s*claude/i.test(value);
}

function hasPersonaRefusal(text = '') {
  const value = normalizeContextText(text);
  if (!value) return false;
  return /\b(?:I\s+am|I'm|I’m)\s+not\s+(?:able\s+to\s+)?(?:roleplay|pretend|act\s+as|be)\b/i.test(value)
    || /\b(?:I\s+do\s+not|I\s+don't|I\s+can(?:not|'t)|I’m\s+not|I'm\s+not)\s+(?:roleplay|take\s+on\s+personas|pretend|act\s+as)\b/i.test(value)
    || /\bI\s+can\s+only\s+engage\s+as\s+myself\b/i.test(value)
    || /不(?:扮演|进行角色扮演|代入|接受).{0,24}(?:角色|人设|晓山瑞希|瑞希)/i.test(value)
    || /不是.{0,12}(?:晓山瑞希|瑞希)/i.test(value)
    || /只能以我自己的身份/i.test(value);
}

function isModelIdentityContamination(text = '') {
  const value = normalizeContextText(text);
  if (!value) return false;
  if (/I\s+don['’]?t\s+roleplay\s+as\s+characters\s+or\s+take\s+on\s+personas/i.test(value)) return true;
  if (/I'm\s+Claude,\s+made\s+by(?:\s+Anthropic)?/i.test(value)) return true;
  if (/I\s+appreciate\s+the\s+detailed\s+context.{0,120}I'm\s+Claude/i.test(value)) return true;
  if (/我是\s*Claude.{0,80}(?:不扮演|不是|Anthropic|模型\s*ID|由.*开发)/i.test(value)) return true;
  return hasModelSelfIdentity(value) && hasPersonaRefusal(value);
}

function sanitizeModelIdentityContextText(text = '', options = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const replacement = Object.prototype.hasOwnProperty.call(options, 'replacement')
    ? String(options.replacement || '')
    : '';
  const lines = raw.split(/\r?\n/);
  const sanitized = lines
    .map((line) => {
      if (!isModelIdentityContamination(line)) return line;
      return replacement;
    })
    .filter((line) => String(line || '').trim())
    .join('\n')
    .trim();
  if (sanitized) return sanitized;
  return isModelIdentityContamination(raw) ? replacement.trim() : raw.trim();
}

module.exports = {
  hasModelSelfIdentity,
  hasPersonaRefusal,
  isModelIdentityContamination,
  sanitizeModelIdentityContextText
};
