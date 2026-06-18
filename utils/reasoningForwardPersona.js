const FORWARD_MIN_CHARS = 20;
const FORWARD_MAX_CHARS = 520;
const FORWARD_MAX_PARAGRAPHS = 3;

const UNSAFE_PATTERNS = [
  /\b(?:reasoning_content|chain[-\s]*of[-\s]*thought|internal_check)\b/i,
  /(?:系统提示词|开发者提示|隐藏推理|内部推理|完整推理链|思维链如下|推理过程如下)/i,
  /(?:我作为|作为)(?:一个)?(?:AI|模型|语言模型|assistant|助手)/i,
  /(?:用户意图|user intent|the user wants|the user asks|final answer|draft reply)/i,
  /\b(?:respond|reply|answer|write|speak|act|sound)\s+(?:naturally|like|as|in character)\b/i,
  /\b(?:as|like)\s+a?\s*(?:sleepy|drowsy|assistant|model|character|riki)\b/i,
  /\bthe says\b/i
];

function normalizeText(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function stripReasoningMarkup(text = '') {
  return normalizeText(text)
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*["']?(?:reasoning_content|internal_check|chain[-\s]*of[-\s]*thought)["']?\s*[:：=].*$/gmi, ' ')
    .replace(/^\s*(?:[-*]|\d+[.)、]|[一二三四五六七八九十]+[、.．])\s*/gm, '')
    .replace(/\b(?:maybe|wait|what if|let(?:'|’)s see|i need to|i should)\b/gi, ' ')
    .replace(/\b(?:user|assistant|model|AI|final answer|draft reply)\b/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeForwardParagraphs(text = '') {
  return normalizeText(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, FORWARD_MAX_PARAGRAPHS)
    .join('\n\n');
}

function trimForwardCore(text = '', maxChars = FORWARD_MAX_CHARS) {
  const normalized = normalizeForwardParagraphs(text);
  const limit = Math.max(FORWARD_MIN_CHARS, Math.floor(Number(maxChars) || FORWARD_MAX_CHARS));
  if (!normalized || normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).replace(/[，、：:；;,.!?！？。]?\s*$/, '').trim()}…`;
}

function looksUnsafeForForward(text = '') {
  const compact = normalizeText(text);
  if (!compact) return true;
  if (UNSAFE_PATTERNS.some((pattern) => pattern.test(compact))) return true;
  if (/[{}[\]]/.test(compact) && /"(?:choices|message|usage|delta|content)"/i.test(compact)) return true;
  return false;
}

function splitReadableSentences(text = '') {
  return normalizeText(text)
    .split(/(?<=[。！？!?])|\n+/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function pickReadableCore(reasoningText = '', finalReply = '') {
  const cleaned = normalizeForwardParagraphs(stripReasoningMarkup(reasoningText));
  if (!cleaned || looksUnsafeForForward(cleaned)) return '';
  const finalCompact = normalizeText(finalReply).replace(/\s+/g, '');
  const allSentences = splitReadableSentences(cleaned);
  const sentences = allSentences
    .filter((sentence) => {
      const compact = sentence.replace(/\s+/g, '');
      if (!compact) return false;
      if (looksUnsafeForForward(sentence)) return false;
      if (finalCompact && compact.length >= 12 && finalCompact.includes(compact.slice(0, 24))) return false;
      return true;
    });
  const source = sentences.length === allSentences.length
    ? cleaned
    : sentences.join(' ');
  return trimForwardCore(source);
}

function buildPersonaReasoningForwardText(input = {}) {
  const reasoningText = normalizeText(input.reasoningText);
  if (!reasoningText) return '';
  const core = pickReadableCore(reasoningText, input.finalReply || input.replyText || '');
  if (!core || core.length < FORWARD_MIN_CHARS || looksUnsafeForForward(core)) return '';

  return trimForwardCore(core);
}

module.exports = {
  buildPersonaReasoningForwardText,
  looksUnsafeForForward,
  stripReasoningMarkup
};
