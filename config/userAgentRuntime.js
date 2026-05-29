const CODEX_USER_AGENT = 'codex-cli/0.121.0 (external, cli)';

function normalizeUserAgent(value, fallback = CODEX_USER_AGENT) {
  const text = String(value || '').trim();
  if (/codex/i.test(text)) return text;
  const fallbackText = String(fallback || '').trim();
  return /codex/i.test(fallbackText) ? fallbackText : CODEX_USER_AGENT;
}

module.exports = {
  CODEX_USER_AGENT,
  normalizeUserAgent
};
