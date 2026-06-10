function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function trimLine(value, maxChars = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function isPositiveMemoryRecallText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^暂无与当前问题强相关的长期记忆$/u.test(text)) return false;
  if (/^目前没有特别记忆[。.]?$/u.test(text)) return false;
  if (/^\[NoStrongMatch\]\s*$/u.test(text)) return false;
  return true;
}

function normalizeStringList(values = [], limit = 4, itemMaxChars = 180) {
  const output = [];
  const seen = new Set();
  for (const raw of normalizeArray(values)) {
    const text = trimLine(raw, itemMaxChars);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return output;
}

function normalizeRecentTurns(messages = [], limit = 4) {
  return normalizeArray(messages)
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') return null;
      const content = trimLine(item?.content, 220);
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || 1));
}

module.exports = {
  isPositiveMemoryRecallText,
  normalizeArray,
  normalizeObject,
  normalizeRecentTurns,
  normalizeStringList,
  trimLine
};
