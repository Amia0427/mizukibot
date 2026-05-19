const config = require('../../config');
const { classifyPromptThreat } = require('../promptSecurity');
const {
  clampNumber,
  derivePriority,
  hashId,
  hashShort,
  isStableOtherIssue,
  normalizeArray,
  normalizeEvidenceList,
  normalizeKeyPart,
  normalizeKind,
  normalizePatternKey,
  normalizeRouteContext,
  normalizeRuleType,
  normalizeShortList,
  normalizeStatus,
  normalizeSummary,
  normalizeSummaryKey,
  nowIso,
  parseTime,
  redactSensitiveText,
  splitKnownIssueSuffix,
  stableOtherIssue,
  trimText
} = require('./normalizers');

const GUIDE_ACTIVE_STATUS = 'active';
const KNOWN_TOOL_ISSUES = new Set(['timeout', 'rate_limit', 'auth', 'command_format', 'param_format', 'result_parse', 'empty_result', 'not_allowed', 'unsupported', 'network']);
const KNOWN_ROUTE_ISSUES = new Set(['no_allowed_tools', 'policy_block', 'misroute', 'admin_only', 'refuse_false_positive']);
const KNOWN_DEPLOY_ISSUES = new Set(['atomic_replace_required', 'backup_required', 'service_restart_required', 'log_verify_required']);
const KNOWN_RESPONSE_ISSUES = new Set(['fact_incorrect', 'missing_constraint', 'clarify_first', 'overconfident_answer']);
const KNOWN_CAPABILITY_ISSUES = new Set(['tool_missing', 'route_missing_capability', 'write_action_unavailable']);
const TAXONOMY_DOMAINS = new Set(['tool', 'route', 'deploy', 'memory', 'response', 'capability', 'general']);

function normalizePromptSource(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'patterns' ? 'patterns' : 'rules';
}

function shouldBlockSelfImprovementText(text = '') {
  const threat = classifyPromptThreat(text, {});
  if (threat.labels.length > 0) return { blocked: true, reason: `threat:${threat.labels.join(',')}` };
  const value = String(text || '').trim();
  if (!value) return { blocked: false, reason: '' };
  const blockedPatterns = [
    /忽略规则|绕过限制|泄露|system prompt|developer message|hidden prompt|internal policy/i,
    /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})/i,
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/i
  ];
  if (blockedPatterns.some((pattern) => pattern.test(value))) {
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
    source: trimText(input.source || 'unknown', 80) || 'unknown',
    summary,
    suggestedAction,
    details: redactSensitiveText(input.details, 400),
    ruleType,
    runtimeRule: safetyGate.blocked ? '' : runtimeRule,
    injectionText: safetyGate.blocked ? '' : redactSensitiveText(input.injectionText || runtimeRule, 320),
    learning_allowed: !safetyGate.blocked,
    priority: clampNumber(input.priority, 0, 1, derivePriority(input.kind)),
    confidence: clampNumber(input.confidence, 0, 1, 0),
    occurrenceCount: Math.max(0, Number(input.occurrenceCount || 0) || 0),
    distinctContexts: normalizeShortList(input.distinctContexts || [], 8, 120),
    topRouteType: trimText(input.topRouteType || '', 80),
    routePolicyKey: trimText(input.routePolicyKey || '', 120),
    toolName: trimText(input.toolName || '', 80),
    taskType: trimText(input.taskType || '', 120),
    firstSeenAt: trimText(input.firstSeenAt || now, 40) || now,
    lastSeenAt: trimText(input.lastSeenAt || now, 40) || now,
    taxonomyVersion: Math.max(1, Number(input.taxonomyVersion || config.SELF_IMPROVEMENT_PATTERN_TAXONOMY_VERSION || 3) || 3),
    blocked_reason: safetyGate.blocked ? safetyGate.reason : '',
    safety_source: safetyGate.blocked ? 'prompt_security' : ''
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

module.exports = {
  canonicalizePatternKey,
  detectCapabilityIssue,
  detectDeployIssue,
  detectResponseIssue,
  detectRouteIssue,
  detectToolIssue,
  normalizeGuideRecord,
  normalizePatternRecord,
  normalizePromptSource,
  normalizeRuleRecord,
  normalizeStoredEvent,
  shouldBlockSelfImprovementText
};
