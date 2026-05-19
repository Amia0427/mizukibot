const DEFAULTS = {
  mode: 'balanced',
  action: 'archive',
  minConfidence: 0.72,
  topicTtlDays: 21,
  dedupeThreshold: 0.9
};

function nowTs() {
  return Date.now();
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeStringArray(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return Array.from(new Set(list.map((item) => normalizeText(item)).filter(Boolean)));
}

module.exports = {
  DEFAULTS,
  normalizeStringArray,
  normalizeText,
  nowTs
};
