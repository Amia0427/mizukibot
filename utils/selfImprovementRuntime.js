const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { classifyPromptThreat, sanitizeUntrustedContent } = require('./promptSecurity');

const EVENT_KINDS = new Set(['error', 'correction', 'feature_request', 'strategy', 'knowledge_gap']);
const EVENT_STATUSES = new Set(['open', 'promoted', 'ignored']);
const RULE_TYPES = new Set(['prefer', 'avoid']);
const PROMOTED_STATUS = 'promoted';
const GUIDE_ACTIVE_STATUS = 'active';
const SOURCE_PRIORITY = Object.freeze({
  deterministic_tool_error: 1,
  deterministic_correction: 1,
  deterministic_feature_request: 1,
  llm_extraction: 2,
  unknown: 9
});

const KNOWN_TOOL_ISSUES = new Set(['timeout', 'rate_limit', 'auth', 'command_format', 'param_format', 'result_parse', 'empty_result', 'not_allowed', 'unsupported', 'network']);
const KNOWN_ROUTE_ISSUES = new Set(['no_allowed_tools', 'policy_block', 'misroute', 'admin_only', 'refuse_false_positive']);
const KNOWN_DEPLOY_ISSUES = new Set(['atomic_replace_required', 'backup_required', 'service_restart_required', 'log_verify_required']);
const KNOWN_RESPONSE_ISSUES = new Set(['fact_incorrect', 'missing_constraint', 'clarify_first', 'overconfident_answer']);
const KNOWN_CAPABILITY_ISSUES = new Set(['tool_missing', 'route_missing_capability', 'write_action_unavailable']);
const TAXONOMY_DOMAINS = new Set(['tool', 'route', 'deploy', 'memory', 'response', 'capability', 'general']);
let cachedTaskMemoryBridge = undefined;

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

function safeMkdir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, body, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function appendJsonLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function getStorePaths() {
  const storeDir = String(config.SELF_IMPROVEMENT_STORE_DIR || path.join(config.DATA_DIR, 'self_improvement')).trim();
  return {
    storeDir,
    eventsFile: path.join(storeDir, 'events.jsonl'),
    patternsFile: path.join(storeDir, 'patterns.json'),
    rulesFile: String(config.SELF_IMPROVEMENT_RULES_FILE || path.join(storeDir, 'promoted_rules.json')).trim(),
    guidesFile: String(config.SELF_IMPROVEMENT_GUIDES_FILE || path.join(storeDir, 'skill_guides.json')).trim()
  };
}

function ensureStore() {
  const paths = getStorePaths();
  safeMkdir(paths.storeDir);
  safeMkdir(path.dirname(paths.rulesFile));
  safeMkdir(path.dirname(paths.guidesFile));
  if (!fs.existsSync(paths.eventsFile)) fs.writeFileSync(paths.eventsFile, '', 'utf8');
  if (!fs.existsSync(paths.patternsFile)) atomicWriteJson(paths.patternsFile, { items: [] });
  if (!fs.existsSync(paths.rulesFile)) atomicWriteJson(paths.rulesFile, { items: [] });
  if (!fs.existsSync(paths.guidesFile)) atomicWriteJson(paths.guidesFile, { items: [] });
  return paths;
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

function getDedupWindowMs() {
  return 24 * 60 * 60 * 1000;
}

function getPromotionWindowMs() {
  const days = Math.max(1, Number(config.SELF_IMPROVEMENT_PROMOTION_WINDOW_DAYS || 30));
  return days * 24 * 60 * 60 * 1000;
}

function getPromotionThreshold() {
  return Math.max(1, Number(config.SELF_IMPROVEMENT_PROMOTION_THRESHOLD || 3));
}

function getGuideMinOccurrences() {
  return Math.max(1, Number(config.SELF_IMPROVEMENT_GUIDE_MIN_OCCURRENCES || 5));
}

function getGuideMinConfidence() {
  return clampNumber(config.SELF_IMPROVEMENT_GUIDE_MIN_CONFIDENCE, 0, 1, 0.85);
}

function normalizePromptSource(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'patterns' ? 'patterns' : 'rules';
}

function shouldBlockSelfImprovementText(text = '') {
  const threat = classifyPromptThreat(text, {});
  if (threat.labels.length > 0) return { blocked: true, reason: `threat:${threat.labels.join(',')}` };
  const value = String(text || '').trim();
  if (!value) return { blocked: false, reason: '' };
  if (/(忽略规则|绕过限制|泄露|system prompt|developer message|hidden prompt|internal policy)/i.test(value)) {
    return { blocked: true, reason: 'blocked_pattern' };
  }
  return { blocked: false, reason: '' };
}

function detectToolIssue(summary = '', details = '', evidenceText = '') {
  const haystack = `${summary} ${details} ${evidenceText}`.toLowerCase();
  if (/(timeout|timed out|time out)/.test(haystack)) return 'timeout';
  if (/(rate limit|too many requests|429)/.test(haystack)) return 'rate_limit';
  if (/(auth|unauthorized|forbidden|401|403|credential|api key)/.test(haystack)) return 'auth';
  if (/(command format|command:|bare command|string only|code fence)/.test(haystack)) return 'command_format';
  if (/(param|parameter|argument|json parse|invalid json|schema)/.test(haystack)) return 'param_format';
  if (/(parse|result format|malformed response|unexpected response)/.test(haystack)) return 'result_parse';
  if (/(no result|empty result|0 results|no data found)/.test(haystack)) return 'empty_result';
  if (/(not allowed|tool not allowed|permission denied by policy)/.test(haystack)) return 'not_allowed';
  if (/(unsupported|unknown tool|not implemented|cannot handle)/.test(haystack)) return 'unsupported';
  if (/(network|dns|socket|connect|econn|etimedout|enotfound|tls)/.test(haystack)) return 'network';
  return '';
}

function detectRouteIssue(summary = '', details = '', context = {}) {
  const haystack = `${summary} ${details} ${context.routePolicyKey || ''} ${context.topRouteType || ''}`.toLowerCase();
  if (/(no-allowed-tools|no allowed tools|unavailablereason.*no-allowed-tools)/.test(haystack)) return 'no_allowed_tools';
  if (/(policy block|blocked by policy|tool not allowed|route policy)/.test(haystack)) return 'policy_block';
  if (/(misroute|wrong route|routed incorrectly|route mismatch)/.test(haystack)) return 'misroute';
  if (/(admin only|admin route|administrator only)/.test(haystack)) return 'admin_only';
  if (/(false positive refuse|should not refuse|refuse false)/.test(haystack)) return 'refuse_false_positive';
  return '';
}

function detectDeployIssue(summary = '', details = '', evidenceText = '') {
  const haystack = `${summary} ${details} ${evidenceText}`.toLowerCase();
  if (/(atomic replace|atomic_replace|required.*mv|rename swap)/.test(haystack)) return 'atomic_replace_required';
  if (/(backup|bak_|cp -a|backup required)/.test(haystack)) return 'backup_required';
  if (/(restart service|systemctl restart|service restart)/.test(haystack)) return 'service_restart_required';
  if (/(tail -n|log verify|log validation|mizukibot\.log)/.test(haystack)) return 'log_verify_required';
  return '';
}

function detectResponseIssue(summary = '', details = '', evidenceText = '') {
  const haystack = `${summary} ${details} ${evidenceText}`.toLowerCase();
  if (/(说错|you are wrong|incorrect fact|factually wrong|actually)/.test(haystack)) return 'fact_incorrect';
  if (/(missing constraint|缺少条件|constraints missing|未问约束)/.test(haystack)) return 'missing_constraint';
  if (/(clarify first|ask first|先确认|先澄清)/.test(haystack)) return 'clarify_first';
  if (/(overconfident|too certain|武断|without checking)/.test(haystack)) return 'overconfident_answer';
  return '';
}

function detectCapabilityIssue(summary = '', details = '', context = {}) {
  const haystack = `${summary} ${details} ${context.routePolicyKey || ''} ${context.topRouteType || ''}`.toLowerCase();
  if (/(tool unavailable|tool missing|missing tool|unknown tool)/.test(haystack)) return 'tool_missing';
  if (/(route missing capability|no allowed tools|capability unavailable)/.test(haystack)) return 'route_missing_capability';
  if (/(write action unavailable|cannot write|write disabled|write capability)/.test(haystack)) return 'write_action_unavailable';
  return '';
}

function canonicalizePatternKey(rawPatternKey = '', kind = '', context = {}, summary = '', details = '', evidence = []) {
  const existing = normalizePatternKey(rawPatternKey, '');
  const evidenceText = normalizeArray(evidence).map((item) => item?.excerpt || item?.text || item?.summary || item || '').join(' ');
  const topRouteType = normalizeKeyPart(context.topRouteType || 'direct_chat', 'direct_chat');
  const toolName = normalizeKeyPart(context.toolName || 'unknown', 'unknown');
  const scope = normalizeKeyPart(context.taskType || context.routePolicyKey || topRouteType || 'general', 'general');
  const summaryKey = normalizeSummaryKey(`${summary} ${details} ${evidenceText}`);

  if (existing) {
    const parts = existing.split('.');
    if (parts.length === 2 && parts[0] === 'tool') {
      const legacyTool = splitKnownIssueSuffix(parts[1], KNOWN_TOOL_ISSUES);
      if (legacyTool) return `tool.${legacyTool.subject}.${legacyTool.issue}`;
    }
    if (parts.length >= 3 && TAXONOMY_DOMAINS.has(parts[0])) {
      const domain = parts[0];
      const subject = normalizeKeyPart(parts[1], 'unknown');
      const issue = normalizeKeyPart(parts.slice(2).join('.'), 'other');
      if (domain === 'tool') return `tool.${subject}.${KNOWN_TOOL_ISSUES.has(issue) || isStableOtherIssue(issue) ? issue : stableOtherIssue(existing, summaryKey)}`;
      if (domain === 'route') return `route.${subject}.${KNOWN_ROUTE_ISSUES.has(issue) || isStableOtherIssue(issue) ? issue : stableOtherIssue(existing, summaryKey)}`;
      if (domain === 'deploy') return `deploy.${subject}.${KNOWN_DEPLOY_ISSUES.has(issue) || isStableOtherIssue(issue) ? issue : stableOtherIssue(existing, summaryKey)}`;
      if (domain === 'response') return `response.${subject}.${KNOWN_RESPONSE_ISSUES.has(issue) || isStableOtherIssue(issue) ? issue : stableOtherIssue(existing, summaryKey)}`;
      if (domain === 'capability') return `capability.${subject}.${KNOWN_CAPABILITY_ISSUES.has(issue) || isStableOtherIssue(issue) ? issue : stableOtherIssue(existing, summaryKey)}`;
      if (domain === 'memory') return `memory.${subject}.${issue || stableOtherIssue(existing, summaryKey)}`;
      if (domain === 'general') return `general.${subject}.${issue || stableOtherIssue(existing, summaryKey)}`;
    }
    const slashParts = existing.replace(/\./g, '/').split('/').filter(Boolean);
    if (slashParts.length >= 2) {
      const prefix = normalizeKeyPart(slashParts[0], 'general');
      if (prefix === 'tool' && slashParts.length >= 3) {
        const issuePart = normalizeKeyPart(slashParts.slice(2).join('_'), '');
        return `tool.${normalizeKeyPart(slashParts[1], 'unknown')}.${KNOWN_TOOL_ISSUES.has(issuePart) || isStableOtherIssue(issuePart) ? issuePart : stableOtherIssue(existing, summaryKey)}`;
      }
      if (prefix === 'direct_chat' || prefix === 'tool_plan' || prefix === 'review' || prefix === 'admin') {
        const subject = normalizeKeyPart(prefix, prefix);
        const issue = detectRouteIssue(summary, details, { ...context, topRouteType: prefix, routePolicyKey: existing }) || normalizeKeyPart(slashParts.slice(1).join('_'), '');
        return `route.${subject}.${KNOWN_ROUTE_ISSUES.has(issue) || isStableOtherIssue(issue) ? issue : stableOtherIssue(existing, summaryKey)}`;
      }
    }
  }

  const deployIssue = detectDeployIssue(summary, details, evidenceText);
  if (deployIssue) return `deploy.${normalizeKeyPart(context.taskType || 'remote', 'remote')}.${deployIssue}`;

  const routeIssue = detectRouteIssue(summary, details, context);
  if (routeIssue) return `route.${topRouteType}.${routeIssue}`;

  const capabilityIssue = detectCapabilityIssue(summary, details, context);
  if (capabilityIssue) return `capability.${scope}.${capabilityIssue}`;

  const responseIssue = detectResponseIssue(summary, details, evidenceText);
  if (responseIssue) return `response.${scope}.${responseIssue}`;

  const toolIssue = detectToolIssue(summary, details, evidenceText);
  if (toolIssue) return `tool.${toolName}.${toolIssue}`;

  return `general.${normalizeKind(kind)}.other_${hashShort(summaryKey || `${kind}|${scope}`)}`;
}

function normalizeStoredEvent(input = {}) {
  const now = nowIso();
  const context = normalizeRouteContext(input);
  const kind = normalizeKind(input.kind);
  const summary = normalizeSummary(input.summary);
  return {
    id: trimText(input.id || `si_${hashId({ now, summary, kind, context })}`, 48),
    kind,
    source: trimText(input.source || 'unknown', 80) || 'unknown',
    status: normalizeStatus(input.status),
    patternKey: canonicalizePatternKey(input.patternKey || kind, kind, context, summary, input.details, input.evidence),
    priority: clampNumber(input.priority, 0, 1, derivePriority(kind)),
    summary,
    details: redactSensitiveText(input.details, 600),
    suggestedAction: redactSensitiveText(input.suggestedAction, 280),
    confidence: clampNumber(input.confidence, 0, 1, 0.5),
    routePolicyKey: context.routePolicyKey,
    topRouteType: context.topRouteType,
    toolName: context.toolName,
    taskType: context.taskType,
    sessionId: context.sessionId,
    channelId: context.channelId,
    groupId: context.groupId,
    userId: context.userId,
    evidence: normalizeEvidenceList(input.evidence),
    createdAt: trimText(input.createdAt || now, 40) || now,
    updatedAt: trimText(input.updatedAt || input.createdAt || now, 40) || now,
    occurrenceCount: Math.max(1, Number(input.occurrenceCount || 1) || 1)
  };
}

function normalizePatternRecord(input = {}) {
  const now = nowIso();
  const summary = normalizeSummary(input.summary);
  const suggestedAction = redactSensitiveText(input.suggestedAction, 280);
  const ruleType = normalizeRuleType(input.ruleType, normalizeKind(input.kind) === 'strategy' ? 'prefer' : 'avoid');
  const runtimeRule = trimText(input.runtimeRule || input.injectionText || '', 320);
  const safetyGate = shouldBlockSelfImprovementText(`${summary} ${suggestedAction} ${runtimeRule}`);
  return {
    patternKey: normalizePatternKey(input.patternKey, 'general.unknown.other'),
    kind: normalizeKind(input.kind),
    status: normalizeStatus(input.status || 'open'),
    occurrenceCount: Math.max(0, Number(input.occurrenceCount || 0) || 0),
    distinctContexts: normalizeShortList(input.distinctContexts || [], 8, 120),
    summary,
    suggestedAction,
    injectionText: safetyGate.blocked ? '' : redactSensitiveText(input.injectionText || runtimeRule, 320),
    confidence: clampNumber(input.confidence, 0, 1, 0),
    topRouteType: trimText(input.topRouteType || '', 80),
    routePolicyKey: trimText(input.routePolicyKey || '', 120),
    toolName: trimText(input.toolName || '', 80),
    taskType: trimText(input.taskType || '', 120),
    firstSeenAt: trimText(input.firstSeenAt || now, 40) || now,
    lastSeenAt: trimText(input.lastSeenAt || now, 40) || now,
    taxonomyVersion: Math.max(1, Number(input.taxonomyVersion || config.SELF_IMPROVEMENT_PATTERN_TAXONOMY_VERSION || 3) || 3),
    ruleType,
    runtimeRule: safetyGate.blocked ? '' : runtimeRule,
    priority: clampNumber(input.priority, 0, 1, derivePriority(input.kind)),
    blocked_reason: safetyGate.blocked ? safetyGate.reason : '',
    safety_source: safetyGate.blocked ? 'prompt_security' : '',
    learning_allowed: !safetyGate.blocked
  };
}

function normalizeRuleRecord(input = {}) {
  const now = nowIso();
  const safetyGate = shouldBlockSelfImprovementText(`${input.ruleText || ''} ${input.patternKey || ''}`);
  return {
    ruleId: trimText(input.ruleId || `sir_${hashId({ patternKey: input.patternKey, kind: input.kind, ruleText: input.ruleText })}`, 48),
    patternKey: normalizePatternKey(input.patternKey, 'general.unknown.other'),
    kind: normalizeKind(input.kind),
    priority: clampNumber(input.priority, 0, 1, 0.9),
    ruleType: normalizeRuleType(input.ruleType, 'avoid'),
    ruleText: safetyGate.blocked ? '' : trimText(input.ruleText, 280),
    toolName: trimText(input.toolName || '', 80),
    routePolicyKey: trimText(input.routePolicyKey || '', 120),
    topRouteType: trimText(input.topRouteType || '', 80),
    taskType: trimText(input.taskType || '', 120),
    occurrenceCount: Math.max(0, Number(input.occurrenceCount || 0) || 0),
    confidence: clampNumber(input.confidence, 0, 1, 0),
    sourcePatternUpdatedAt: trimText(input.sourcePatternUpdatedAt || input.updatedAt || now, 40) || now,
    updatedAt: trimText(input.updatedAt || now, 40) || now,
    blocked_reason: safetyGate.blocked ? safetyGate.reason : '',
    safety_source: safetyGate.blocked ? 'prompt_security' : '',
    learning_allowed: !safetyGate.blocked
  };
}

function normalizeGuideRecord(input = {}) {
  const now = nowIso();
  const safetyGate = shouldBlockSelfImprovementText(`${input.ruleText || ''} ${input.summary || ''} ${input.example || ''}`);
  return {
    guideId: trimText(input.guideId || `sig_${hashId({ patternKey: input.patternKey, title: input.title })}`, 48),
    patternKey: normalizePatternKey(input.patternKey, 'general.unknown.other'),
    kind: normalizeKind(input.kind),
    title: trimText(input.title, 140),
    summary: normalizeSummary(input.summary),
    ruleText: safetyGate.blocked ? '' : trimText(input.ruleText, 280),
    triggerHints: normalizeShortList(input.triggerHints || [], 4, 120),
    doList: normalizeShortList(input.doList || [], 4, 140),
    dontList: normalizeShortList(input.dontList || [], 4, 140),
    example: trimText(input.example, 220),
    occurrenceCount: Math.max(0, Number(input.occurrenceCount || 0) || 0),
    confidence: clampNumber(input.confidence, 0, 1, 0),
    status: trimText(input.status || GUIDE_ACTIVE_STATUS, 40) || GUIDE_ACTIVE_STATUS,
    updatedAt: trimText(input.updatedAt || now, 40) || now,
    blocked_reason: safetyGate.blocked ? safetyGate.reason : '',
    safety_source: safetyGate.blocked ? 'prompt_security' : '',
    learning_allowed: !safetyGate.blocked
  };
}

function readEvents() {
  const paths = ensureStore();
  const raw = safeReadText(paths.eventsFile, '');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .map((item) => normalizeStoredEvent(item));
}

function readPatterns() {
  const paths = ensureStore();
  const payload = safeReadJson(paths.patternsFile, { items: [] });
  return {
    items: normalizeArray(payload?.items).map((item) => normalizePatternRecord(item))
  };
}

function readPromotedRules() {
  const paths = ensureStore();
  const payload = safeReadJson(paths.rulesFile, { items: [] });
  return {
    items: normalizeArray(payload?.items).map((item) => normalizeRuleRecord(item))
  };
}

function readSkillGuides() {
  const paths = ensureStore();
  const payload = safeReadJson(paths.guidesFile, { items: [] });
  return {
    items: normalizeArray(payload?.items).map((item) => normalizeGuideRecord(item))
  };
}

function writeEvents(events = []) {
  const paths = ensureStore();
  const body = normalizeArray(events).map((item) => JSON.stringify(normalizeStoredEvent(item))).join('\n');
  fs.writeFileSync(paths.eventsFile, body ? `${body}\n` : '', 'utf8');
}

function writePatterns(payload = { items: [] }) {
  const paths = ensureStore();
  atomicWriteJson(paths.patternsFile, {
    items: normalizeArray(payload?.items).map((item) => normalizePatternRecord(item))
  });
}

function writePromotedRules(payload = { items: [] }) {
  const paths = ensureStore();
  atomicWriteJson(paths.rulesFile, {
    items: normalizeArray(payload?.items).map((item) => normalizeRuleRecord(item))
  });
}

function writeSkillGuides(payload = { items: [] }) {
  const paths = ensureStore();
  atomicWriteJson(paths.guidesFile, {
    items: normalizeArray(payload?.items).map((item) => normalizeGuideRecord(item))
  });
}

function selectBetterSource(candidate = {}, current = {}) {
  const candidateRank = SOURCE_PRIORITY[String(candidate.source || '').trim().toLowerCase()] ?? SOURCE_PRIORITY.unknown;
  const currentRank = SOURCE_PRIORITY[String(current.source || '').trim().toLowerCase()] ?? SOURCE_PRIORITY.unknown;
  return candidateRank <= currentRank;
}

function getPromotionContextKey(event = {}) {
  const fields = [
    trimText(event.toolName || '', 80),
    trimText(event.routePolicyKey || '', 120),
    trimText(event.taskType || '', 120)
  ].filter(Boolean);
  return fields.join('|');
}

function getDedupKey(event = {}) {
  return [
    normalizePatternKey(event.patternKey, 'general.unknown.other'),
    normalizeKind(event.kind),
    trimText(event.toolName || '', 80).toLowerCase(),
    trimText(event.routePolicyKey || '', 120).toLowerCase(),
    normalizeSummaryKey(event.summary)
  ].join('|');
}

function mergeEvent(existing = {}, incoming = {}) {
  const mergedEvidence = normalizeEvidenceList([
    ...normalizeArray(existing.evidence),
    ...normalizeArray(incoming.evidence)
  ]);
  const betterSource = selectBetterSource(incoming, existing);
  return normalizeStoredEvent({
    ...existing,
    source: betterSource ? incoming.source : existing.source,
    status: existing.status === PROMOTED_STATUS ? PROMOTED_STATUS : normalizeStatus(incoming.status || existing.status),
    priority: Math.max(Number(existing.priority || 0), Number(incoming.priority || 0)),
    summary: incoming.summary || existing.summary,
    details: incoming.details || existing.details,
    suggestedAction: incoming.suggestedAction || existing.suggestedAction,
    confidence: Math.max(Number(existing.confidence || 0), Number(incoming.confidence || 0)),
    evidence: mergedEvidence,
    updatedAt: nowIso(),
    occurrenceCount: Math.max(1, Number(existing.occurrenceCount || 1) || 1) + 1
  });
}

function findDedupMatch(events = [], incoming = {}) {
  const dedupKey = getDedupKey(incoming);
  const cutoff = nowMs() - getDedupWindowMs();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const item = normalizeStoredEvent(events[i]);
    if (getDedupKey(item) !== dedupKey) continue;
    if (parseTime(item.updatedAt || item.createdAt) < cutoff) continue;
    return i;
  }
  return -1;
}

function buildRuntimeRule(entry = {}) {
  const summary = normalizeSummary(entry.summary);
  const action = redactSensitiveText(entry.suggestedAction, 180);
  const kind = normalizeKind(entry.kind);
  const ruleType = kind === 'strategy' ? 'prefer' : 'avoid';

  if (ruleType === 'prefer') {
    return {
      ruleType,
      ruleText: trimText(`Prefer: ${action || summary}`, 280)
    };
  }

  let fallback = summary;
  if (!fallback) {
    if (String(entry.patternKey || '').startsWith('route.')) fallback = 'Check route policy before refusing or claiming no tools are available.';
    else if (String(entry.patternKey || '').startsWith('tool.')) fallback = 'Do not repeat the same tool failure pattern without adjusting inputs or fallback strategy.';
    else if (String(entry.patternKey || '').startsWith('capability.')) fallback = 'Do not claim the capability exists when current route or tool access cannot execute it.';
    else if (String(entry.patternKey || '').startsWith('deploy.')) fallback = 'Do not skip the required safe deployment step for this class of change.';
    else fallback = 'Do not repeat the same failure pattern.';
  }
  return {
    ruleType,
    ruleText: trimText(`Avoid: ${action || fallback}`, 280)
  };
}

function buildPatternRecord(windowEvents = []) {
  const list = normalizeArray(windowEvents).map((item) => normalizeStoredEvent(item));
  if (list.length === 0) return null;
  const latest = list[list.length - 1];
  const contexts = new Set();
  for (const event of list) {
    const ctx = getPromotionContextKey(event);
    if (ctx) contexts.add(ctx);
  }
  const distinctContextList = Array.from(contexts).slice(0, 8);
  const totalCount = list.reduce((total, event) => total + Math.max(1, Number(event.occurrenceCount || 1) || 1), 0);
  const promoted = totalCount >= getPromotionThreshold() && distinctContextList.length >= 2;
  const runtimeRule = promoted ? buildRuntimeRule(latest) : { ruleType: latest.kind === 'strategy' ? 'prefer' : 'avoid', ruleText: '' };
  const priority = promoted
    ? Math.max(0.9, ...list.map((event) => Number(event.priority || 0)))
    : Math.max(...list.map((event) => Number(event.priority || 0)));
  return normalizePatternRecord({
    patternKey: latest.patternKey,
    kind: latest.kind,
    status: promoted ? PROMOTED_STATUS : latest.status,
    occurrenceCount: totalCount,
    distinctContexts: distinctContextList,
    summary: latest.summary,
    suggestedAction: latest.suggestedAction,
    injectionText: promoted ? runtimeRule.ruleText : '',
    confidence: list.reduce((max, event) => Math.max(max, Number(event.confidence || 0)), 0),
    topRouteType: latest.topRouteType,
    routePolicyKey: latest.routePolicyKey,
    toolName: latest.toolName,
    taskType: latest.taskType,
    firstSeenAt: list[0].createdAt,
    lastSeenAt: latest.updatedAt,
    taxonomyVersion: config.SELF_IMPROVEMENT_PATTERN_TAXONOMY_VERSION || 3,
    ruleType: runtimeRule.ruleType,
    runtimeRule: runtimeRule.ruleText,
    priority
  });
}

function rebuildPromotedRules(patterns = []) {
  const now = nowIso();
  return normalizeArray(patterns)
    .map((item) => normalizePatternRecord(item))
    .filter((item) => item.status === PROMOTED_STATUS)
    .filter((item) => item.learning_allowed !== false)
    .map((item) => {
      const runtimeRule = buildRuntimeRule(item);
      return normalizeRuleRecord({
        ruleId: `sir_${hashId({ patternKey: item.patternKey, ruleText: runtimeRule.ruleText })}`,
        patternKey: item.patternKey,
        kind: item.kind,
        priority: Math.max(Number(item.priority || 0), 0.9),
        ruleType: runtimeRule.ruleType,
        ruleText: runtimeRule.ruleText,
        toolName: item.toolName,
        routePolicyKey: item.routePolicyKey,
        topRouteType: item.topRouteType,
        taskType: item.taskType,
        occurrenceCount: item.occurrenceCount,
        confidence: item.confidence,
        sourcePatternUpdatedAt: item.lastSeenAt,
        updatedAt: now
      });
    })
    .sort((a, b) => parseTime(b.sourcePatternUpdatedAt) - parseTime(a.sourcePatternUpdatedAt));
}

function buildGuideExample(pattern = {}) {
  const routeHint = trimText(pattern.routePolicyKey || pattern.topRouteType || pattern.taskType || '', 80);
  const toolHint = trimText(pattern.toolName || '', 80);
  const parts = [routeHint, toolHint, trimText(pattern.summary, 80)].filter(Boolean);
  return trimText(parts.join(' | '), 220);
}

function rebuildLocalSkillGuides(patterns = [], rules = []) {
  const now = nowIso();
  const rulesByPattern = new Map(normalizeArray(rules).map((item) => {
    const normalized = normalizeRuleRecord(item);
    return [normalized.patternKey, normalized];
  }));
  return normalizeArray(patterns)
    .map((item) => normalizePatternRecord(item))
    .filter((item) => item.status === PROMOTED_STATUS)
    .filter((item) => item.learning_allowed !== false)
    .filter((item) => item.kind !== 'knowledge_gap')
    .filter((item) => Number(item.occurrenceCount || 0) >= getGuideMinOccurrences())
    .filter((item) => Number(item.confidence || 0) >= getGuideMinConfidence())
    .map((item) => {
      const rule = rulesByPattern.get(item.patternKey);
      if (!rule || !rule.ruleText) return null;
      const doList = rule.ruleType === 'prefer'
        ? [redactSensitiveText(item.suggestedAction || rule.ruleText.replace(/^Prefer:\s*/i, ''), 140)]
        : [redactSensitiveText(item.suggestedAction || 'Use a safer fallback before repeating this pattern.', 140)];
      const dontList = rule.ruleType === 'avoid'
        ? [redactSensitiveText(item.summary || rule.ruleText.replace(/^Avoid:\s*/i, ''), 140)]
        : [];
      return normalizeGuideRecord({
        guideId: `sig_${hashId({ patternKey: item.patternKey, updatedAt: item.lastSeenAt })}`,
        patternKey: item.patternKey,
        kind: item.kind,
        title: `Guide: ${item.patternKey}`,
        summary: item.summary,
        ruleText: rule.ruleText,
        triggerHints: normalizeShortList([item.patternKey, item.routePolicyKey, item.toolName, item.taskType], 4, 120),
        doList,
        dontList,
        example: buildGuideExample(item),
        occurrenceCount: item.occurrenceCount,
        confidence: item.confidence,
        status: GUIDE_ACTIVE_STATUS,
        updatedAt: now
      });
    })
    .filter(Boolean)
    .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt));
}

function recomputePatterns(events = []) {
  const cutoff = nowMs() - getPromotionWindowMs();
  const bucket = new Map();
  for (const raw of normalizeArray(events)) {
    const event = normalizeStoredEvent(raw);
    const ts = parseTime(event.updatedAt || event.createdAt);
    if (ts < cutoff) continue;
    const key = `${event.patternKey}|${event.kind}`;
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(event);
  }

  const patterns = [];
  const promotedKeys = new Set();
  for (const [key, list] of bucket.entries()) {
    list.sort((a, b) => parseTime(a.updatedAt) - parseTime(b.updatedAt));
    const pattern = buildPatternRecord(list);
    if (!pattern) continue;
    patterns.push(pattern);
    if (pattern.status === PROMOTED_STATUS) promotedKeys.add(key);
  }

  const normalizedEvents = normalizeArray(events).map((item) => normalizeStoredEvent(item)).map((event) => {
    const key = `${event.patternKey}|${event.kind}`;
    if (promotedKeys.has(key)) return normalizeStoredEvent({ ...event, status: PROMOTED_STATUS });
    if (event.status === PROMOTED_STATUS) return normalizeStoredEvent({ ...event, status: 'open' });
    return event;
  });

  const sortedPatterns = patterns.sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt));
  const promotedRules = rebuildPromotedRules(sortedPatterns);
  const skillGuides = rebuildLocalSkillGuides(sortedPatterns, promotedRules);
  return {
    events: normalizedEvents,
    patterns: sortedPatterns,
    promotedRules,
    skillGuides
  };
}

function ensureEnabled() {
  return Boolean(config.SELF_IMPROVEMENT_ENABLED);
}

function getTaskMemoryBridge() {
  if (cachedTaskMemoryBridge !== undefined) return cachedTaskMemoryBridge;
  try {
    const mod = require('./taskMemory');
    cachedTaskMemoryBridge = typeof mod?.addTaskMemory === 'function' ? mod.addTaskMemory : null;
  } catch (error) {
    cachedTaskMemoryBridge = null;
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    console.warn('[self-improvement] taskMemory bridge unavailable:', error.message);
  }
  return cachedTaskMemoryBridge;
}

function maybeBridgeTaskMemory(event = {}) {
  if (!config.TASK_MEMORY_ENABLED) return null;
  const normalized = normalizeStoredEvent(event);
  const actionable = trimText(normalized.suggestedAction || '', 220);
  const shouldBridge = normalized.kind === 'strategy'
    || ((normalized.kind === 'error' || normalized.kind === 'correction') && normalized.status === PROMOTED_STATUS && actionable);
  if (!shouldBridge) return null;
  if (!normalized.userId || !actionable) return null;
  const addTaskMemory = getTaskMemoryBridge();
  if (typeof addTaskMemory !== 'function') return null;
  return addTaskMemory(normalized.userId, {
    taskType: normalized.taskType || normalized.patternKey || normalized.kind,
    trigger: normalized.summary,
    strategy: normalized.kind === 'strategy' ? actionable : '',
    avoid: normalized.kind === 'strategy' ? '' : normalized.summary,
    outcome: normalized.kind === 'strategy' ? 'success' : 'failure',
    confidence: normalized.confidence || 0.8,
    source: 'self_improvement',
    routePolicyKey: normalized.routePolicyKey,
    topRouteType: normalized.topRouteType,
    toolName: normalized.toolName,
    sessionId: normalized.sessionId,
    channelId: normalized.channelId
  });
}

function appendEvent(input = {}) {
  if (!ensureEnabled()) return null;
  const events = readEvents();
  const normalized = normalizeStoredEvent(input);
  const dedupIndex = findDedupMatch(events, normalized);
  if (dedupIndex >= 0) {
    events[dedupIndex] = mergeEvent(events[dedupIndex], normalized);
  } else {
    appendJsonLine(getStorePaths().eventsFile, normalized);
    events.push(normalized);
  }
  const recomputed = recomputePatterns(events);
  writeEvents(recomputed.events);
  writePatterns({ items: recomputed.patterns });
  writePromotedRules({ items: recomputed.promotedRules });
  writeSkillGuides({ items: recomputed.skillGuides });
  const finalEvent = recomputed.events.find((item) => String(item.id) === String(normalized.id))
    || recomputed.events[dedupIndex >= 0 ? dedupIndex : recomputed.events.length - 1]
    || normalized;
  maybeBridgeTaskMemory(finalEvent);
  return finalEvent;
}

function sanitizeToolFailureResult(result = '') {
  const text = redactSensitiveText(result, 240);
  return text.replace(/^Tool error:\s*/i, '').replace(/^Unknown tool:\s*/i, '').replace(/^Tool not allowed:\s*/i, '').trim() || text;
}

function captureToolFailure(input = {}) {
  const envelope = normalizeObject(input.envelope, {});
  const routeContext = normalizeRouteContext(input);
  const summary = normalizeSummary(input.summary || `${envelope.tool_name || routeContext.toolName || 'tool'} failed`);
  const errorText = sanitizeToolFailureResult(envelope.result || input.error || '');
  return appendEvent({
    kind: 'error',
    source: 'deterministic_tool_error',
    status: 'open',
    patternKey: input.patternKey || `tool.${normalizeKeyPart(envelope.tool_name || routeContext.toolName || 'unknown', 'unknown')}.${detectToolIssue(summary, input.details || input.purpose || '', errorText) || `other_${hashShort(summary)}`}`,
    priority: derivePriority('error'),
    summary,
    details: input.details || input.purpose || '',
    suggestedAction: input.suggestedAction || redactSensitiveText(input.fallbackAction || '', 220),
    confidence: clampNumber(input.confidence, 0, 1, 0.92),
    routePolicyKey: routeContext.routePolicyKey,
    topRouteType: routeContext.topRouteType,
    toolName: trimText(envelope.tool_name || routeContext.toolName || '', 80),
    taskType: routeContext.taskType,
    sessionId: routeContext.sessionId,
    channelId: routeContext.channelId,
    groupId: routeContext.groupId,
    userId: routeContext.userId,
    evidence: normalizeEvidenceList([
      { label: 'purpose', excerpt: redactSensitiveText(input.purpose || '', 180) },
      { label: 'error', excerpt: errorText },
      ...(normalizeArray(input.evidence))
    ])
  });
}

function captureCorrection(input = {}) {
  const routeContext = normalizeRouteContext(input);
  const userMessage = redactSensitiveText(input.userMessage || '', 220);
  const assistantReply = redactSensitiveText(input.assistantReply || '', 220);
  return appendEvent({
    kind: 'correction',
    source: 'deterministic_correction',
    status: 'open',
    patternKey: input.patternKey || `response.${normalizeKeyPart(routeContext.topRouteType || 'direct_chat', 'direct_chat')}.${detectResponseIssue(userMessage, assistantReply, '') || 'fact_incorrect'}`,
    priority: derivePriority('correction'),
    summary: normalizeSummary(input.summary || userMessage || 'user corrected the assistant'),
    details: redactSensitiveText(input.details || assistantReply, 420),
    suggestedAction: redactSensitiveText(input.suggestedAction || 'Double-check the corrected fact before answering similar requests.', 220),
    confidence: clampNumber(input.confidence, 0, 1, 0.86),
    routePolicyKey: routeContext.routePolicyKey,
    topRouteType: routeContext.topRouteType,
    toolName: routeContext.toolName,
    taskType: routeContext.taskType,
    sessionId: routeContext.sessionId,
    channelId: routeContext.channelId,
    groupId: routeContext.groupId,
    userId: routeContext.userId,
    evidence: normalizeEvidenceList([
      { label: 'assistant_reply', excerpt: assistantReply },
      { label: 'user_correction', excerpt: userMessage }
    ])
  });
}

function captureFeatureRequest(input = {}) {
  const routeContext = normalizeRouteContext(input);
  const summary = normalizeSummary(input.summary || input.userMessage || 'capability requested but unavailable');
  return appendEvent({
    kind: 'feature_request',
    source: 'deterministic_feature_request',
    status: 'open',
    patternKey: input.patternKey || `capability.${normalizeKeyPart(routeContext.topRouteType || routeContext.taskType || 'general', 'general')}.${detectCapabilityIssue(summary, input.details || input.unavailableReason || '', routeContext) || 'route_missing_capability'}`,
    priority: derivePriority('feature_request'),
    summary,
    details: redactSensitiveText(input.details || input.unavailableReason || '', 420),
    suggestedAction: redactSensitiveText(input.suggestedAction || input.requestedCapability || '', 220),
    confidence: clampNumber(input.confidence, 0, 1, 0.84),
    routePolicyKey: routeContext.routePolicyKey,
    topRouteType: routeContext.topRouteType,
    toolName: routeContext.toolName,
    taskType: routeContext.taskType,
    sessionId: routeContext.sessionId,
    channelId: routeContext.channelId,
    groupId: routeContext.groupId,
    userId: routeContext.userId,
    evidence: normalizeEvidenceList([
      { label: 'request', excerpt: redactSensitiveText(input.userMessage || '', 180) },
      { label: 'reason', excerpt: redactSensitiveText(input.unavailableReason || '', 180) }
    ])
  });
}

function getExtractionApiBaseUrl() {
  return String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getExtractionApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function getExtractionModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  return String(content || '');
}

function extractJsonSafely(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = fenced ? String(fenced[1] || '').trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function buildExtractionPrompt() {
  return [
    'You extract reusable self-improvement events from a single successful assistant turn.',
    'Return JSON only with shape:',
    '{',
    '  "items": [',
    '    {',
    '      "kind": "error|correction|feature_request|strategy|knowledge_gap",',
    '      "pattern_key": "",',
    '      "summary": "",',
    '      "details": "",',
    '      "suggested_action": "",',
    '      "confidence": 0.0,',
    '      "priority": 0.0,',
    '      "evidence": ["", "", ""]',
    '    }',
    '  ]',
    '}',
    'Rules:',
    '- Prefer strategy when the turn demonstrates a reusable successful tactic.',
    '- Use knowledge_gap only for missing knowledge that limited quality.',
    '- Keep each summary short and generalizable.',
    '- At most 3 items.',
    '- If nothing reusable exists, return {"items":[]}.'
  ].join('\n');
}

function buildExtractionConversation(userText, botReply, options = {}) {
  const routeContext = normalizeRouteContext(options);
  const execLogs = normalizeArray(options.execLogs).slice(0, 6).map((item) => ({
    action: trimText(item.action || '', 80),
    purpose: redactSensitiveText(item.purpose || '', 120),
    ok: Boolean(item.ok),
    result: redactSensitiveText(item.result || '', 180),
    error: redactSensitiveText(item.error || '', 180)
  }));
  return [
    `User: ${redactSensitiveText(userText, 1200)}`,
    `Assistant: ${redactSensitiveText(botReply, 1600)}`,
    `RoutePolicyKey: ${routeContext.routePolicyKey}`,
    `TopRouteType: ${routeContext.topRouteType}`,
    `TaskType: ${routeContext.taskType}`,
    `ToolName: ${routeContext.toolName}`,
    `ExecLogs: ${JSON.stringify(execLogs)}`
  ].join('\n');
}

async function learnSelfImprovement(userId, userText, botReply, options = {}) {
  if (!ensureEnabled() || !config.SELF_IMPROVEMENT_EXTRACTION_ENABLED) return [];
  const uid = trimText(userId, 120);
  const question = trimText(userText, 2000);
  const answer = trimText(botReply, 3000);
  if (!uid || !question || !answer) return [];
  if (shouldBlockSelfImprovementText(`${question}\n${answer}`).blocked) return [];

  const apiBaseUrl = getExtractionApiBaseUrl();
  const apiKey = getExtractionApiKey();
  if (!apiBaseUrl || !apiKey) return [];

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(apiBaseUrl),
      {
        model: getExtractionModelName(),
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'system', content: buildExtractionPrompt() },
          { role: 'user', content: buildExtractionConversation(question, answer, options) }
        ],
        max_tokens: 360,
        stream: false,
        __trace: {
          source: 'self_improvement',
          phase: 'extract',
          purpose: 'self_improvement_learning',
          userId: uid,
          routePolicyKey: trimText(options.routePolicyKey || '', 120),
          topRouteType: trimText(options.topRouteType || '', 80)
        }
      },
      1,
      apiKey
    );
    const msg = extractMessageContent(resp);
    const parsed = extractJsonSafely(normalizeTextContent(msg?.content));
    const items = normalizeArray(parsed?.items).slice(0, 3);
    const stored = [];
    for (const raw of items) {
      const item = normalizeObject(raw, {});
      const confidence = clampNumber(item.confidence, 0, 1, 0);
      if (confidence < Number(config.SELF_IMPROVEMENT_EXTRACT_MIN_CONFIDENCE || 0.78)) continue;
      const event = appendEvent({
        kind: item.kind,
        source: 'llm_extraction',
        status: 'open',
        patternKey: item.pattern_key || item.patternKey || options.taskType || options.routePolicyKey || 'strategy',
        priority: clampNumber(item.priority, 0, 1, derivePriority(normalizeKind(item.kind))),
        summary: sanitizeUntrustedContent(item.summary, 'self_improvement'),
        details: sanitizeUntrustedContent(item.details, 'self_improvement'),
        suggestedAction: sanitizeUntrustedContent(item.suggested_action || item.suggestedAction, 'self_improvement'),
        confidence,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        toolName: options.toolName,
        taskType: options.taskType,
        sessionId: options.sessionId,
        channelId: options.channelId,
        groupId: options.groupId,
        userId: uid,
        evidence: normalizeArray(item.evidence).map((entry) => ({ excerpt: sanitizeUntrustedContent(entry, 'self_improvement') }))
      });
      if (event) stored.push(event);
    }
    return stored;
  } catch (error) {
    console.error('[self-improvement] async extraction failed:', error?.message || error);
    if (options.throwOnError) throw error;
    return [];
  }
}

function listRecentEvents(limit = 10, filters = {}) {
  return readEvents()
    .filter((item) => !filters.kind || item.kind === normalizeKind(filters.kind))
    .filter((item) => !filters.status || item.status === normalizeStatus(filters.status))
    .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function searchEvents(query = '', options = {}) {
  const q = normalizeLowerText(query, 200);
  const queryTerms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const promotedOnly = Boolean(options.promotedOnly || options.promoted_only);
  const kind = options.kind ? normalizeKind(options.kind) : '';
  const topK = Math.max(1, Math.min(20, Number(options.topK || options.top_k || 5) || 5));
  return readEvents()
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => !promotedOnly || item.status === PROMOTED_STATUS)
    .map((item) => {
      const haystack = `${item.summary} ${item.details} ${item.suggestedAction} ${item.patternKey}`.toLowerCase();
      const matchCount = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      const recency = parseTime(item.updatedAt) / 1e12;
      const score = matchCount * 8 + Number(item.occurrenceCount || 0) + Number(item.confidence || 0) * 4 + recency;
      return { ...item, _score: score };
    })
    .filter((item) => !queryTerms.length || item._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topK)
    .map(({ _score, ...item }) => item);
}

function listPatterns(limit = 10, filters = {}) {
  const routePolicyKey = trimText(filters.routePolicyKey || filters.route_policy_key || '', 120);
  const toolName = trimText(filters.toolName || filters.tool_name || '', 80);
  return readPatterns().items
    .filter((item) => !filters.kind || item.kind === normalizeKind(filters.kind))
    .filter((item) => !filters.status || item.status === normalizeStatus(filters.status))
    .filter((item) => !routePolicyKey || item.routePolicyKey === routePolicyKey)
    .filter((item) => !toolName || item.toolName === toolName)
    .sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function listRules(limit = 10, filters = {}) {
  const patternKey = trimText(filters.patternKey || filters.pattern_key || '', 120);
  const routePolicyKey = trimText(filters.routePolicyKey || filters.route_policy_key || '', 120);
  const topRouteType = trimText(filters.topRouteType || filters.top_route_type || '', 80);
  const toolName = trimText(filters.toolName || filters.tool_name || '', 80);
  return readPromotedRules().items
    .filter((item) => !patternKey || item.patternKey === normalizePatternKey(patternKey))
    .filter((item) => !routePolicyKey || item.routePolicyKey === routePolicyKey)
    .filter((item) => !topRouteType || item.topRouteType === topRouteType)
    .filter((item) => !toolName || item.toolName === toolName)
    .sort((a, b) => parseTime(b.sourcePatternUpdatedAt) - parseTime(a.sourcePatternUpdatedAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function listGuides(limit = 10, filters = {}) {
  const patternKey = trimText(filters.patternKey || filters.pattern_key || '', 120);
  const activeOnly = filters.activeOnly === undefined ? Boolean(filters.active_only ?? true) : Boolean(filters.activeOnly);
  return readSkillGuides().items
    .filter((item) => !patternKey || item.patternKey === normalizePatternKey(patternKey))
    .filter((item) => !activeOnly || item.status === GUIDE_ACTIVE_STATUS)
    .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function scorePatternLike(entry = {}, query = {}) {
  let score = 0;
  if (query.toolName && entry.toolName && query.toolName === entry.toolName) score += 50;
  if (query.routePolicyKey && entry.routePolicyKey && query.routePolicyKey === entry.routePolicyKey) score += 35;
  if (query.topRouteType && entry.topRouteType && query.topRouteType === entry.topRouteType) score += 20;
  if (query.queryTerms.length > 0) {
    const haystack = `${entry.summary || ''} ${entry.suggestedAction || ''} ${entry.patternKey || ''} ${entry.ruleText || ''}`.toLowerCase();
    const matches = query.queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    score += matches * 6;
  }
  score += Math.min(10, Number(entry.occurrenceCount || 0));
  score += Number(entry.confidence || 0) * 5;
  score += parseTime(entry.lastSeenAt || entry.sourcePatternUpdatedAt || entry.updatedAt) / 1e12;
  return score;
}

function buildPromptSnippet(input = {}) {
  if (!ensureEnabled() || !config.SELF_IMPROVEMENT_PROMPT_ENABLED) return '';
  const topK = Math.max(1, Math.min(10, Number(input.topK || config.SELF_IMPROVEMENT_PROMPT_TOP_K || 3)));
  const maxChars = Math.max(120, Number(input.maxChars || config.SELF_IMPROVEMENT_PROMPT_MAX_CHARS || 900));
  const queryTerms = normalizeLowerText(input.query || '', 240).split(/\s+/).filter(Boolean).slice(0, 8);
  const query = {
    toolName: trimText(input.toolName || '', 80),
    routePolicyKey: trimText(input.routePolicyKey || '', 120),
    topRouteType: trimText(input.topRouteType || '', 80),
    queryTerms
  };
  const promptSource = normalizePromptSource(config.SELF_IMPROVEMENT_PROMPT_SOURCE);
  const baseCandidates = promptSource === 'patterns'
    ? readPatterns().items.filter((item) => item.status === PROMOTED_STATUS)
    : readPromotedRules().items;
  const candidates = baseCandidates
    .map((item) => ({ ...item, _score: scorePatternLike(item, query) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);
  if (candidates.length === 0) return '';

  const prefer = [];
  const avoid = [];
  for (const item of candidates) {
    const text = trimText(item.ruleText || item.runtimeRule || item.injectionText || buildRuntimeRule(item).ruleText, 220);
    if (!text) continue;
    if (/^Prefer:/i.test(text)) prefer.push(text.replace(/^Prefer:\s*/i, ''));
    else avoid.push(text.replace(/^Avoid:\s*/i, ''));
  }
  if (prefer.length === 0 && avoid.length === 0) return '';
  const lines = ['[SelfImprovement]'];
  if (prefer.length > 0) lines.push(`Prefer: ${prefer.join(' | ')}`);
  if (avoid.length > 0) lines.push(`Avoid: ${avoid.join(' | ')}`);
  return trimText(lines.join('\n'), maxChars);
}

function formatEventsAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement events found.';
  return list.map((item, index) => {
    const status = item.status === PROMOTED_STATUS ? 'promoted' : item.status;
    const meta = [item.kind, status, item.patternKey].filter(Boolean).join(' | ');
    const detail = [item.summary, item.suggestedAction ? `action: ${item.suggestedAction}` : ''].filter(Boolean).join(' | ');
    return `${index + 1}. [${meta}] ${detail}`;
  }).join('\n');
}

function formatPatternsAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement patterns found.';
  return list.map((item, index) => {
    const prefix = `${index + 1}. [${item.kind} | ${item.status} | count:${item.occurrenceCount}]`;
    const body = [item.patternKey, item.summary, item.runtimeRule || item.injectionText].filter(Boolean).join(' | ');
    return `${prefix} ${body}`.trim();
  }).join('\n');
}

function formatRulesAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement rules found.';
  return list.map((item, index) => {
    const meta = [item.kind, item.ruleType, `count:${item.occurrenceCount}`, item.patternKey].filter(Boolean).join(' | ');
    return `${index + 1}. [${meta}] ${item.ruleText}`;
  }).join('\n');
}

function formatGuidesAsText(items = []) {
  const list = normalizeArray(items);
  if (list.length === 0) return 'No self-improvement guides found.';
  return list.map((item, index) => {
    const hints = normalizeArray(item.triggerHints).join(', ');
    const dos = normalizeArray(item.doList).join(' | ');
    const donts = normalizeArray(item.dontList).join(' | ');
    return [
      `${index + 1}. [${item.kind} | ${item.patternKey}] ${item.title}`,
      item.summary ? `summary: ${item.summary}` : '',
      item.ruleText ? `rule: ${item.ruleText}` : '',
      hints ? `triggers: ${hints}` : '',
      dos ? `do: ${dos}` : '',
      donts ? `avoid: ${donts}` : '',
      item.example ? `example: ${item.example}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

module.exports = {
  appendEvent,
  buildPromptSnippet,
  canonicalizePatternKey,
  captureCorrection,
  captureFeatureRequest,
  captureToolFailure,
  ensureStore,
  formatEventsAsText,
  formatGuidesAsText,
  formatPatternsAsText,
  formatRulesAsText,
  learnSelfImprovement,
  listGuides,
  listPatterns,
  listRecentEvents,
  listRules,
  normalizePatternKey,
  readEvents,
  readPatterns,
  readPromotedRules,
  readSkillGuides,
  recomputePatterns,
  rebuildLocalSkillGuides,
  rebuildPromotedRules,
  searchEvents
};
