const crypto = require('crypto');

const EVENT_KINDS = new Set(['error', 'correction', 'feature_request', 'strategy', 'knowledge_gap']);
const EVENT_STATUSES = new Set(['open', 'promoted', 'ignored', 'archived']);
const RULE_TYPES = new Set(['prefer', 'avoid']);

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimText(value, maxChars = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeLowerText(value, maxChars = 240) {
  return trimText(value, maxChars).toLowerCase();
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeShortList(values = [], limit = 3, itemMaxChars = 180) {
  const output = [];
  const seen = new Set();
  for (const raw of normalizeArray(values)) {
    const text = trimText(raw, itemMaxChars);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function redactSensitiveText(value, maxChars = 240) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text
    .replace(/\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b/g, '[redacted-token]')
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|private[_-]?key)\b\s*[:=]\s*['"]?[^'"\s,;]+['"]?/ig, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+\b/ig, 'Bearer [redacted]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[redacted-key-block]');
  return trimText(text, maxChars);
}

function normalizeEvidenceItem(entry = {}) {
  if (typeof entry === 'string') {
    const excerpt = redactSensitiveText(entry, 180);
    return excerpt ? { excerpt } : null;
  }
  const item = normalizeObject(entry, {});
  const excerpt = redactSensitiveText(item.excerpt || item.text || item.summary || '', 180);
  const label = trimText(item.label || item.type || item.source || '', 60);
  const out = {};
  if (label) out.label = label;
  if (excerpt) out.excerpt = excerpt;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeEvidenceList(entries = []) {
  const output = [];
  const seen = new Set();
  for (const entry of normalizeArray(entries)) {
    const normalized = normalizeEvidenceItem(entry);
    if (!normalized) continue;
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= 3) break;
  }
  return output;
}

function hashId(input = {}) {
  return crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function hashShort(text = '') {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 6);
}

function parseTime(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function normalizeKind(kind = '') {
  const value = String(kind || '').trim().toLowerCase();
  return EVENT_KINDS.has(value) ? value : 'knowledge_gap';
}

function normalizeStatus(status = '') {
  const value = String(status || '').trim().toLowerCase();
  return EVENT_STATUSES.has(value) ? value : 'open';
}

function normalizeRuleType(value = '', fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (RULE_TYPES.has(normalized)) return normalized;
  return fallback || '';
}

function derivePriority(kind = '') {
  if (kind === 'error' || kind === 'correction') return 0.88;
  if (kind === 'feature_request') return 0.74;
  if (kind === 'strategy') return 0.72;
  return 0.68;
}

function normalizeKeyPart(value, fallback = 'general') {
  const text = String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[\/_]+/g, ' ')
    .replace(/[^a-z0-9.\- ]+/g, ' ');
  const compact = text.trim().replace(/\s+/g, '_').replace(/_+/g, '_');
  return compact || fallback;
}

function normalizePatternKey(value, fallback = 'general.unknown.other') {
  const raw = String(value || fallback || '').trim().toLowerCase();
  if (!raw) return fallback;
  const parts = raw
    .replace(/[\/]+/g, '.')
    .split('.')
    .map((part) => normalizeKeyPart(part, 'unknown'))
    .filter(Boolean);
  return trimText((parts.length > 0 ? parts : [fallback]).join('.'), 120) || fallback;
}

function splitKnownIssueSuffix(value = '', knownIssues = new Set()) {
  const normalized = normalizeKeyPart(value, '');
  if (!normalized) return null;
  const issues = Array.from(knownIssues).sort((a, b) => b.length - a.length);
  for (const issue of issues) {
    if (normalized === issue) {
      return {
        subject: 'unknown',
        issue
      };
    }
    const suffix = `_${issue}`;
    if (!normalized.endsWith(suffix)) continue;
    const subject = normalizeKeyPart(normalized.slice(0, -suffix.length), 'unknown');
    if (!subject) continue;
    return {
      subject,
      issue
    };
  }
  return null;
}

function stableOtherIssue(existingKey = '', summaryKey = '') {
  return `other_${hashShort(existingKey || summaryKey || 'pattern')}`;
}

function isStableOtherIssue(issue = '') {
  return /^other_[a-f0-9]{6}$/i.test(String(issue || '').trim());
}

function normalizeSummary(value) {
  return redactSensitiveText(value, 220);
}

function normalizeSummaryKey(value) {
  return normalizeLowerText(redactSensitiveText(value, 220), 220);
}

function normalizeRouteContext(context = {}) {
  const routeMeta = normalizeObject(context.routeMeta, {});
  return {
    routePolicyKey: trimText(context.routePolicyKey || routeMeta.routePolicyKey || '', 120),
    topRouteType: trimText(context.topRouteType || routeMeta.topRouteType || '', 80),
    toolName: trimText(context.toolName || routeMeta.toolName || routeMeta.tool_name || '', 80),
    taskType: trimText(context.taskType || routeMeta.taskType || routeMeta.task_type || '', 120),
    sessionId: trimText(context.sessionId || routeMeta.sessionId || routeMeta.session_id || '', 120),
    channelId: trimText(context.channelId || routeMeta.channelId || routeMeta.channel_id || '', 120),
    groupId: trimText(context.groupId || routeMeta.groupId || routeMeta.group_id || '', 120),
    userId: trimText(context.userId || routeMeta.userId || routeMeta.user_id || '', 120)
  };
}

module.exports = {
  clampNumber,
  derivePriority,
  hashId,
  hashShort,
  isStableOtherIssue,
  normalizeArray,
  normalizeEvidenceList,
  normalizeKeyPart,
  normalizeKind,
  normalizeLowerText,
  normalizeObject,
  normalizePatternKey,
  normalizeRouteContext,
  normalizeRuleType,
  normalizeShortList,
  normalizeStatus,
  normalizeSummary,
  normalizeSummaryKey,
  nowIso,
  nowMs,
  parseTime,
  redactSensitiveText,
  splitKnownIssueSuffix,
  stableOtherIssue,
  trimText
};
