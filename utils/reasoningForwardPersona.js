const FORWARD_MIN_CHARS = 20;
const FORWARD_MAX_CHARS = 300;

const UNSAFE_PATTERNS = [
  /\b(?:reasoning_content|chain[-\s]*of[-\s]*thought|internal_check)\b/i,
  /(?:系统提示词|开发者提示|隐藏推理|内部推理|完整推理链|思维链如下|推理过程如下)/i,
  /(?:我作为|作为)(?:一个)?(?:AI|模型|语言模型|assistant|助手)/i,
  /(?:用户意图|user intent|the user wants|the user asks|final answer|draft reply)/i
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
    .replace(/\n{2,}/g, '\n')
    .trim();
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
    .split(/(?<=[。！？!?…])|\n+/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function pickReadableCore(reasoningText = '', finalReply = '') {
  const cleaned = stripReasoningMarkup(reasoningText);
  if (!cleaned || looksUnsafeForForward(cleaned)) return '';
  const finalCompact = normalizeText(finalReply).replace(/\s+/g, '');
  const sentences = splitReadableSentences(cleaned)
    .filter((sentence) => {
      const compact = sentence.replace(/\s+/g, '');
      if (!compact) return false;
      if (looksUnsafeForForward(sentence)) return false;
      if (finalCompact && compact.length >= 12 && finalCompact.includes(compact.slice(0, 24))) return false;
      return true;
    });
  const source = sentences.length ? sentences.join(' ') : cleaned.replace(/\s+/g, ' ');
  return source.length > FORWARD_MAX_CHARS
    ? source.slice(0, FORWARD_MAX_CHARS).replace(/[，、：:；;,.!?！？]?\s*$/, '').trim()
    : source.trim();
}

function buildPersonaReasoningForwardText(input = {}) {
  const reasoningText = normalizeText(input.reasoningText);
  if (!reasoningText) return '';
  const core = pickReadableCore(reasoningText, input.finalReply || input.replyText || '');
  if (!core || core.length < FORWARD_MIN_CHARS || looksUnsafeForForward(core)) return '';

  const userText = normalizeText(input.userText || input.question || '');
  const isQuestionLike = /[?？]|怎么|为什么|咋|吗|呢/.test(userText);
  const prefix = isQuestionLike ? '嗯……我刚才脑子里其实绕了一下：' : '刚才那一下，我心里大概是这样转的：';
  const text = `${prefix}${core}`;
  if (looksUnsafeForForward(text)) return '';
  return text.length > FORWARD_MAX_CHARS
    ? `${text.slice(0, FORWARD_MAX_CHARS - 1).replace(/[，、：:；;,.!?！？]?\s*$/, '').trim()}…`
    : text;
}

module.exports = {
  buildPersonaReasoningForwardText,
  looksUnsafeForForward,
  stripReasoningMarkup
};
