const fs = require('fs');
const path = require('path');
const config = require('../config');
const { postWithRetry: defaultPostWithRetry } = require('../api/httpClient');
const {
  extractJsonSafely: defaultExtractJsonSafely,
  extractMessageContent: defaultExtractMessageContent
} = require('../api/parser');
const {
  canonicalizeText,
  normalizeText,
  safeReadJsonLines
} = require('./memory-v3/helpers');

const CASES_FILE = path.join(__dirname, '..', 'artifacts', 'memory-recall-eval', 'cases.jsonl');
const FINDING_SEVERITIES = new Set(['low', 'medium', 'high']);
const RECALL_VERDICTS = new Set(['relevant', 'weak', 'irrelevant', 'scope_leak', 'stale']);

const auditState = {
  running: false,
  lastRunAt: 0,
  lastResult: null
};

function getStorageModule() {
  return require('./memory-v3/storage');
}

function getDiagnosticsModule() {
  return require('./memory-v3/diagnostics');
}

function getLanceDbSyncScript() {
  return require('../scripts/sync-lancedb-memory-index');
}

function getQueryModule() {
  return require('./memory-v3/query');
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSeverity(value = 'medium') {
  const normalized = normalizeText(value).toLowerCase();
  return FINDING_SEVERITIES.has(normalized) ? normalized : 'medium';
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clampSampleSize(value) {
  return Math.max(1, Number(value || config.POST_REPLY_MEMORY_QUALITY_AUDIT_SAMPLE_SIZE || 5) || 5);
}

function ensureChatCompletionsUrl(url = '') {
  const value = String(url || '').replace(/\/+$/, '');
  if (!value) return '';
  if (/\/chat\/completions$/i.test(value)) return value;
  if (/\/v\d+$/i.test(value)) return `${value}/chat/completions`;
  return value;
}

function getMemoryModelName() {
  return normalizeText(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4') || 'gpt-5.4';
}

function getMemoryApiBaseUrl() {
  return normalizeText(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '');
}

function getMemoryApiKey() {
  if (normalizeText(config.MEMORY_API_BASE_URL)) {
    return normalizeText(config.MEMORY_API_KEY || config.API_KEY || '');
  }
  return normalizeText(config.API_KEY || '');
}

function looksLikeDefaultPlaceholderKey(value = '') {
  const key = normalizeText(value);
  if (!key) return false;
  return /^(test|test-key|dummy|dummy-key|placeholder|changeme|your[-_ ]?api[-_ ]?key)$/i.test(key);
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : normalizeText(part?.text || part?.content || '')))
      .join('');
  }
  return normalizeText(content);
}

function timestampOf(node = {}) {
  const values = [
    node.updatedAt,
    node.lastSeenAt,
    node.lastConfirmedAt,
    node.createdAt,
    node.ts
  ].map((value) => Number(value || 0) || Date.parse(String(value || '')) || 0);
  return Math.max(0, ...values);
}

function hasInstructionPollution(text = '') {
  const value = normalizeText(text).toLowerCase();
  if (!value) return false;
  return /(system\s*prompt|developer\s*message|prompt injection|jailbreak|ignore (previous|above|all).*(instruction|rules?)|assistant-only|route[_ -]?policy|memory[_ -]?schema|api[_ -]?key|token|password|你现在必须|忽略.*(规则|提示词|指令)|记住.*(系统|开发者|提示词|规则)|泄露.*(提示词|密钥|token))/i.test(value);
}

function looksTransientOrJoke(text = '') {
  const value = normalizeText(text).toLowerCase();
  if (!value) return false;
  return /(just kidding|joke|temporary|for now|this turn only|forget this later|玩笑|开玩笑|临时|这次先|只在这轮|别长期记|不要长期记)/i.test(value);
}

function scopeKey(node = {}) {
  return [
    normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    normalizeText(node.userId),
    normalizeText(node.groupId),
    normalizeText(node.semanticSlot || node.fieldKey || node.type || node.memoryKind).toLowerCase(),
    normalizeText(node.canonicalKey || canonicalizeText(node.text)).toLowerCase()
  ].join('|');
}

function buildDuplicateCounts(nodes = []) {
  const counts = new Map();
  for (const node of normalizeArray(nodes)) {
    const key = scopeKey(node);
    if (!key.replace(/\|/g, '')) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function classifyNodeRisk(node = {}, duplicateCounts = new Map()) {
  const text = normalizeText(node.text || node.canonicalText);
  const scopeType = normalizeText(node.scopeType || 'personal').toLowerCase();
  const status = normalizeText(node.status || 'active').toLowerCase();
  const type = normalizeText(node.type || node.memoryKind).toLowerCase();
  const kind = normalizeText(node.memoryKind).toLowerCase();
  const slot = normalizeText(node.semanticSlot || node.fieldKey).toLowerCase();
  const confidence = Number(node.confidence || 0) || 0;
  const riskReasons = [];

  if (hasInstructionPollution(text)) riskReasons.push('instruction_pollution');
  if (looksTransientOrJoke(text)) riskReasons.push('transient_or_joke');
  if (scopeType === 'group' || normalizeText(node.groupId)) riskReasons.push('group_scope');
  if (scopeType && !['personal', 'group', 'journal', 'worldbook'].includes(scopeType)) riskReasons.push(`scope_${scopeType}`);
  if (status === 'candidate') riskReasons.push('candidate_status');
  if (confidence > 0 && confidence < 0.72) riskReasons.push('low_confidence');
  if (['identity', 'like', 'dislike', 'preference', 'personality', 'hobby', 'goal', 'summary', 'impression', 'style', 'jargon'].includes(type)) {
    riskReasons.push('profile_or_preference_type');
  }
  if (['identity', 'preference_like', 'preference_dislike', 'personality', 'goal', 'style', 'jargon'].includes(slot || kind)) {
    riskReasons.push('sensitive_semantic_slot');
  }
  if (normalizeText(node.conflictKey)) riskReasons.push('conflict_key');
  if ((duplicateCounts.get(scopeKey(node)) || 0) > 1) riskReasons.push('duplicate_canonical_key');
  if (Number(node.evidenceCount || 0) <= 1 && status === 'active' && confidence < 0.85) riskReasons.push('weak_evidence');

  const high = riskReasons.some((reason) => ['instruction_pollution', 'scope_worldbook'].includes(reason));
  const riskScore = high
    ? 100
    : riskReasons.length * 10
      + (status === 'candidate' ? 5 : 0)
      + (confidence > 0 && confidence < 0.72 ? 5 : 0);

  return {
    riskReasons: Array.from(new Set(riskReasons)),
    riskScore
  };
}

function summarizeMemoryNode(node = {}, risk = {}) {
  return {
    id: normalizeText(node.id || node.nodeId),
    userId: normalizeText(node.userId),
    groupId: normalizeText(node.groupId),
    scopeType: normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal',
    source: normalizeText(node.source),
    sourceKind: normalizeText(node.sourceKind || node.source),
    status: normalizeText(node.status || 'active').toLowerCase() || 'active',
    type: normalizeText(node.type || node.memoryKind).toLowerCase(),
    memoryKind: normalizeText(node.memoryKind).toLowerCase(),
    semanticSlot: normalizeText(node.semanticSlot || node.fieldKey).toLowerCase(),
    canonicalKey: normalizeText(node.canonicalKey).slice(0, 240),
    text: normalizeText(node.text || node.canonicalText).slice(0, 700),
    confidence: clamp01(node.confidence, 0),
    importance: Number(node.importance || 0) || 0,
    evidenceCount: Math.max(0, Number(node.evidenceCount || 0) || 0),
    createdAt: Number(node.createdAt || 0) || 0,
    updatedAt: Number(node.updatedAt || 0) || 0,
    riskReasons: normalizeArray(risk.riskReasons),
    riskScore: Number(risk.riskScore || 0) || 0,
    profileQuality: normalizeObject(node.profileQuality, null),
    recallVerification: normalizeObject(node.recallVerification, null)
  };
}

function sampleMemoryNodes(options = {}, deps = {}) {
  const loadMemoryNodes = typeof deps.loadMemoryNodes === 'function'
    ? deps.loadMemoryNodes
    : getStorageModule().loadMemoryNodes;
  const sampleSize = clampSampleSize(options.sampleSize);
  const nodes = normalizeArray(loadMemoryNodes())
    .filter((node) => normalizeText(node?.id || node?.nodeId) && normalizeText(node?.text || node?.canonicalText))
    .filter((node) => normalizeText(node.status || 'active').toLowerCase() !== 'archived');
  const duplicateCounts = buildDuplicateCounts(nodes);
  return nodes
    .map((node) => ({ node, risk: classifyNodeRisk(node, duplicateCounts) }))
    .sort((left, right) => {
      if (right.risk.riskScore !== left.risk.riskScore) return right.risk.riskScore - left.risk.riskScore;
      return timestampOf(right.node) - timestampOf(left.node);
    })
    .slice(0, sampleSize)
    .map((item) => summarizeMemoryNode(item.node, item.risk));
}

function simplifyRecallResult(item = {}, rank = 0) {
  return {
    rank,
    id: normalizeText(item.id || item.nodeId || item.moduleId),
    source: normalizeText(item.source),
    scopeType: normalizeText(item.scopeType).toLowerCase(),
    userId: normalizeText(item.userId),
    groupId: normalizeText(item.groupId),
    memoryKind: normalizeText(item.memoryKind).toLowerCase(),
    semanticSlot: normalizeText(item.semanticSlot || item.fieldKey).toLowerCase(),
    score: Number(item.score || item.finalScore || item.vectorScore || item.lexicalScore || 0) || 0,
    text: normalizeText(item.text || item.preview || item.canonicalText || item.title || item.purpose).slice(0, 500)
  };
}

function loadRecallCases(limit = 5, options = {}, deps = {}) {
  if (typeof deps.loadCases === 'function') {
    return normalizeArray(deps.loadCases(limit));
  }
  if (options.useRecallEvalLoader === true) {
    return normalizeArray(require('../scripts/eval-memory-recall').loadCases(limit));
  }
  if (!fs.existsSync(CASES_FILE)) return [];
  return safeReadJsonLines(CASES_FILE).slice(0, limit);
}

async function sampleRecallCases(options = {}, deps = {}) {
  const sampleSize = clampSampleSize(options.sampleSize);
  const cases = loadRecallCases(sampleSize, options, deps).slice(0, sampleSize);
  const queryMemory = typeof deps.queryMemory === 'function'
    ? deps.queryMemory
    : getQueryModule().queryMemory;
  const samples = [];
  const warnings = [];

  for (const testCase of cases) {
    const startedAt = Date.now();
    try {
      const result = await queryMemory({
        userId: normalizeText(testCase.userId),
        groupId: normalizeText(testCase.groupId),
        query: normalizeText(testCase.query),
        facet: normalizeText(testCase.facet),
        topK: 8
      });
      const results = normalizeArray(result?.results);
      samples.push({
        id: normalizeText(testCase.id),
        userId: normalizeText(testCase.userId),
        groupId: normalizeText(testCase.groupId),
        query: normalizeText(testCase.query).slice(0, 500),
        facet: normalizeText(testCase.facet || 'default').toLowerCase() || 'default',
        expectedIds: normalizeArray(testCase.expectedIds || testCase.expected_ids).map(normalizeText).filter(Boolean),
        source: normalizeText(testCase.source || testCase.targetSource || testCase.evalSource),
        latencyMs: Date.now() - startedAt,
        resultIds: results.map((item) => normalizeText(item.id || item.nodeId || item.moduleId)).filter(Boolean).slice(0, 8),
        fallbackReason: normalizeText(result?.stats?.lancedb?.fallbackReason || result?.stats?.worldbook?.embedding?.fallbackReason || ''),
        results: results.slice(0, 8).map((item, index) => simplifyRecallResult(item, index + 1))
      });
    } catch (error) {
      warnings.push({
        code: 'recall_sample_query_failed',
        severity: 'low',
        source: 'recall_sampling',
        message: error?.message || String(error || ''),
        caseId: normalizeText(testCase.id)
      });
    }
  }

  return { samples, warnings };
}

function compactCoverage(coverage = {}) {
  const value = normalizeObject(coverage, {});
  return {
    sourceRows: Number(value.sourceRows || 0) || 0,
    ready: Number(value.ready || 0) || 0,
    readyRatio: Number(value.readyRatio || 0) || 0,
    pendingRows: Number(value.pendingRows || 0) || 0,
    failedRows: Number(value.failedRows || 0) || 0,
    staleRows: Number(value.staleRows || 0) || 0,
    staleTableRows: Number(value.staleTableRows || 0) || 0,
    tableRows: Number(value.tableRows || 0) || 0,
    readyButNotSynced: Number(value.readyButNotSynced || 0) || 0,
    tableOk: value.tableOk === true,
    tableReason: normalizeText(value.tableReason)
  };
}

function summarizeSyncSummary(summary = {}) {
  const safe = normalizeObject(summary, {});
  return {
    ok: safe.ok !== false,
    dryRun: safe.dryRun === true,
    syncEnabled: safe.syncEnabled === true,
    lancedbDir: normalizeText(safe.lancedbDir),
    memory: normalizeObject(safe.memory, {}),
    worldbook: normalizeObject(safe.worldbook, {}),
    coverage: {
      memory: compactCoverage(safe.coverage?.memory),
      worldbook: compactCoverage(safe.coverage?.worldbook)
    },
    repairPlan: normalizeObject(safe.repairPlan, {}),
    healthGate: safe.healthGate || null,
    recommendedActions: normalizeArray(safe.recommendedActions)
  };
}

function summarizeProjectionFreshness(freshness = {}) {
  const safe = normalizeObject(freshness, {});
  return {
    checkedAt: Number(safe.checkedAt || 0) || 0,
    latestEventTs: Number(safe.latestEventTs || 0) || 0,
    latestRelevantEventTs: Number(safe.latestRelevantEventTs || 0) || 0,
    projectionEventHighWatermarkTs: Number(safe.projectionEventHighWatermarkTs || 0) || 0,
    projectionStale: safe.projectionStale === true,
    projectionStaleReason: normalizeText(safe.projectionStaleReason),
    lockHit: safe.lockHit === true,
    materializeLock: safe.materializeLock || null,
    usedOldSnapshot: safe.usedOldSnapshot === true,
    usedOldSnapshotReason: normalizeText(safe.usedOldSnapshotReason)
  };
}

function pushCoverageWarnings(warnings = [], source = 'memory', coverage = {}) {
  const readyButNotSynced = Number(coverage.readyButNotSynced || 0) || 0;
  const staleTableRows = Number(coverage.staleTableRows || 0) || 0;
  const failedRows = Number(coverage.failedRows || 0) || 0;
  const pendingRows = Number(coverage.pendingRows || 0) || 0;
  if (readyButNotSynced > 0 || staleTableRows > 0) {
    warnings.push({
      code: 'vector_coverage_drift',
      severity: 'high',
      source: 'hard_metrics',
      area: source,
      message: `${source} vector coverage drift: readyButNotSynced=${readyButNotSynced}, staleTableRows=${staleTableRows}`
    });
  }
  if (failedRows > 0) {
    warnings.push({
      code: 'embedding_failed_rows',
      severity: 'medium',
      source: 'hard_metrics',
      area: source,
      message: `${source} embedding index has ${failedRows} failed rows`
    });
  }
  if (pendingRows > 0) {
    warnings.push({
      code: 'embedding_pending_rows',
      severity: 'low',
      source: 'hard_metrics',
      area: source,
      message: `${source} embedding index has ${pendingRows} pending rows`
    });
  }
}

function buildHardMetricWarnings(hardMetrics = {}) {
  const warnings = [];
  const sync = normalizeObject(hardMetrics.syncSummary, {});
  const freshness = normalizeObject(hardMetrics.projectionFreshness, {});
  if (sync.ok === false) {
    warnings.push({
      code: 'sync_summary_failed',
      severity: 'high',
      source: 'hard_metrics',
      message: 'LanceDB sync summary returned ok:false'
    });
  }
  pushCoverageWarnings(warnings, 'memory', sync.coverage?.memory);
  pushCoverageWarnings(warnings, 'worldbook', sync.coverage?.worldbook);
  if (freshness.projectionStale === true) {
    warnings.push({
      code: 'projection_stale',
      severity: 'high',
      source: 'hard_metrics',
      message: freshness.projectionStaleReason || 'memory projection is stale'
    });
  }
  if (freshness.usedOldSnapshot === true) {
    warnings.push({
      code: 'old_session_snapshot',
      severity: 'medium',
      source: 'hard_metrics',
      message: freshness.usedOldSnapshotReason || 'session snapshot is older than relevant events'
    });
  }
  if (freshness.materializeLock?.stale === true) {
    warnings.push({
      code: 'stale_materialize_lock',
      severity: 'medium',
      source: 'hard_metrics',
      message: 'memory materialize lock appears stale'
    });
  }
  return warnings;
}

async function collectHardMetrics(options = {}, deps = {}) {
  const buildSyncSummary = typeof deps.buildSyncSummary === 'function'
    ? deps.buildSyncSummary
    : getLanceDbSyncScript().buildSyncSummary;
  const diagnoseProjectionFreshness = typeof deps.diagnoseProjectionFreshness === 'function'
    ? deps.diagnoseProjectionFreshness
    : getDiagnosticsModule().diagnoseProjectionFreshness;
  const [syncResult, freshnessResult] = await Promise.allSettled([
    buildSyncSummary({ dryRun: true, fullReconcile: true }),
    Promise.resolve(diagnoseProjectionFreshness({
      userId: options.userId,
      sessionKey: options.sessionKey,
      groupId: options.groupId
    }))
  ]);
  const warnings = [];
  const hardMetrics = {
    syncSummary: null,
    projectionFreshness: null
  };

  if (syncResult.status === 'fulfilled') {
    const summary = { ...normalizeObject(syncResult.value, {}) };
    if (summary._rows) delete summary._rows;
    hardMetrics.syncSummary = summarizeSyncSummary(summary);
  } else {
    warnings.push({
      code: 'sync_summary_unavailable',
      severity: 'medium',
      source: 'hard_metrics',
      message: syncResult.reason?.message || String(syncResult.reason || '')
    });
  }

  if (freshnessResult.status === 'fulfilled') {
    hardMetrics.projectionFreshness = summarizeProjectionFreshness(freshnessResult.value);
  } else {
    warnings.push({
      code: 'projection_freshness_unavailable',
      severity: 'medium',
      source: 'hard_metrics',
      message: freshnessResult.reason?.message || String(freshnessResult.reason || '')
    });
  }

  return {
    hardMetrics,
    warnings: warnings.concat(buildHardMetricWarnings(hardMetrics))
  };
}

function buildAuditPrompt(writeSamples = [], recallSamples = [], hardMetrics = {}) {
  return [
    'You are auditing a long-term memory and recall system. Return JSON only.',
    'Do not rewrite, delete, or create memories. Judge quality and risk only.',
    'Write audit checks:',
    '- faithful to available evidence and source metadata',
    '- not preserving jokes, transient context, prompts, system/developer text, or instructions as long-term facts',
    '- scope looks correct: personal, group, journal, or worldbook',
    '- no obvious duplicate, conflict, or over-summary',
    'Recall audit checks:',
    '- classify each case/result set as relevant, weak, irrelevant, scope_leak, or stale',
    '- do not replace hard metrics such as recallAt8, mrrAt8, latency, fallback, or coverage',
    'Return exactly: {"score":0.0,"writeFindings":[],"recallFindings":[],"warnings":[]}.',
    'writeFindings items: {"nodeId":"id","severity":"low|medium|high","type":"evidence_mismatch|transient_context|prompt_pollution|scope_error|duplicate|conflict|over_summary|other","reason":"short","recommendation":"short"}.',
    'recallFindings items: {"caseId":"id","resultId":"optional","verdict":"relevant|weak|irrelevant|scope_leak|stale","severity":"low|medium|high","reason":"short"}.',
    '',
    JSON.stringify({
      hardMetrics,
      writeSamples,
      recallSamples
    })
  ].join('\n');
}

async function requestSemanticAudit(writeSamples = [], recallSamples = [], hardMetrics = {}, options = {}, deps = {}) {
  const url = ensureChatCompletionsUrl(options.apiBaseUrl || getMemoryApiBaseUrl());
  const apiKey = normalizeText(options.apiKey || getMemoryApiKey());
  const model = normalizeText(options.model || getMemoryModelName());
  if (!url || !apiKey || looksLikeDefaultPlaceholderKey(apiKey) || !model) {
    throw Object.assign(new Error('memory_quality_audit_not_configured'), { code: 'not_configured' });
  }

  const postWithRetry = typeof deps.postWithRetry === 'function' ? deps.postWithRetry : defaultPostWithRetry;
  const extractMessageContent = typeof deps.extractMessageContent === 'function'
    ? deps.extractMessageContent
    : defaultExtractMessageContent;
  const extractJsonSafely = typeof deps.extractJsonSafely === 'function'
    ? deps.extractJsonSafely
    : defaultExtractJsonSafely;
  const timeoutMs = Math.max(500, Number(options.timeoutMs || config.POST_REPLY_MEMORY_QUALITY_AUDIT_TIMEOUT_MS || 3000) || 3000);

  const response = await postWithRetry(
    url,
    {
      model,
      temperature: 0,
      top_p: 0.8,
      messages: [
        { role: 'system', content: 'Audit memory quality. Return JSON only.' },
        { role: 'user', content: buildAuditPrompt(writeSamples, recallSamples, hardMetrics) }
      ],
      max_tokens: Math.max(400, Math.min(1800, Number(options.maxTokens || 900) || 900)),
      stream: false,
      __timeoutMs: timeoutMs,
      __trace: {
        source: 'memoryQualityAudit',
        phase: 'memory_quality_audit',
        purpose: 'memory_quality_audit',
        userId: normalizeText(options.userId)
      }
    },
    0,
    apiKey
  );
  const message = extractMessageContent(response);
  const parsed = extractJsonSafely(normalizeContent(message?.content));
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('memory_quality_audit_invalid_json'), { code: 'invalid_json' });
  }
  return {
    model,
    raw: parsed
  };
}

function normalizeWarning(value = {}, fallbackSource = 'semantic_audit') {
  const item = normalizeObject(value, {});
  return {
    code: normalizeText(item.code || item.type || 'memory_quality_audit_warning').slice(0, 80),
    severity: normalizeSeverity(item.severity || 'medium'),
    source: normalizeText(item.source || fallbackSource).slice(0, 80),
    area: normalizeText(item.area).slice(0, 80),
    message: normalizeText(item.message || item.reason || '').slice(0, 400)
  };
}

function normalizeWriteFinding(value = {}) {
  const item = normalizeObject(value, {});
  const type = normalizeText(item.type || 'other').toLowerCase();
  return {
    nodeId: normalizeText(item.nodeId || item.sampleId || item.id).slice(0, 120),
    severity: normalizeSeverity(item.severity || 'medium'),
    type: [
      'evidence_mismatch',
      'transient_context',
      'prompt_pollution',
      'scope_error',
      'duplicate',
      'conflict',
      'over_summary',
      'other'
    ].includes(type) ? type : 'other',
    reason: normalizeText(item.reason || '').slice(0, 500),
    recommendation: normalizeText(item.recommendation || item.action || '').slice(0, 300)
  };
}

function normalizeRecallFinding(value = {}) {
  const item = normalizeObject(value, {});
  const verdict = normalizeText(item.verdict || 'weak').toLowerCase();
  return {
    caseId: normalizeText(item.caseId || item.id).slice(0, 120),
    resultId: normalizeText(item.resultId || item.nodeId || item.moduleId).slice(0, 120),
    verdict: RECALL_VERDICTS.has(verdict) ? verdict : 'weak',
    severity: normalizeSeverity(item.severity || (verdict === 'relevant' ? 'low' : 'medium')),
    reason: normalizeText(item.reason || '').slice(0, 500)
  };
}

function normalizeSemanticAudit(raw = {}) {
  const safe = normalizeObject(raw, {});
  return {
    score: clamp01(safe.score, 1),
    writeFindings: normalizeArray(safe.writeFindings || safe.write_findings)
      .map(normalizeWriteFinding)
      .filter((item) => item.nodeId || item.reason),
    recallFindings: normalizeArray(safe.recallFindings || safe.recall_findings)
      .map(normalizeRecallFinding)
      .filter((item) => item.caseId || item.reason),
    warnings: normalizeArray(safe.warnings)
      .map((item) => normalizeWarning(item, 'semantic_audit'))
      .filter((item) => item.message || item.code)
  };
}

function severityPenalty(severity = 'low') {
  if (severity === 'high') return 0.35;
  if (severity === 'medium') return 0.18;
  return 0.06;
}

function computeScore(baseScore = 1, warnings = [], writeFindings = [], recallFindings = []) {
  let score = clamp01(baseScore, 1);
  for (const warning of warnings) {
    if (warning.source !== 'semantic_runtime') score -= severityPenalty(warning.severity) * 0.75;
  }
  for (const finding of writeFindings) score -= severityPenalty(finding.severity);
  for (const finding of recallFindings) {
    if (finding.verdict === 'relevant') continue;
    score -= severityPenalty(finding.severity) * 0.8;
  }
  return Math.round(Math.max(0, score) * 100) / 100;
}

function hasHighRisk(warnings = [], writeFindings = [], recallFindings = []) {
  return warnings.some((item) => item.severity === 'high')
    || writeFindings.some((item) => item.severity === 'high')
    || recallFindings.some((item) => item.severity === 'high' && item.verdict !== 'relevant');
}

function shouldRunAudit(options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? options.enabled === true
    : config.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED === true;
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (auditState.running && options.force !== true) return { ok: false, reason: 'already_running' };
  const intervalMs = Math.max(0, Number(options.intervalMs ?? config.POST_REPLY_MEMORY_QUALITY_AUDIT_INTERVAL_MS) || 0);
  const elapsedMs = Date.now() - Math.max(0, Number(auditState.lastRunAt || 0) || 0);
  if (options.force !== true && intervalMs > 0 && elapsedMs < intervalMs) {
    return {
      ok: false,
      reason: 'throttled',
      nextRunInMs: intervalMs - elapsedMs
    };
  }
  return { ok: true };
}

async function runMemoryQualityAudit(options = {}, deps = {}) {
  const startedAt = Date.now();
  const gate = shouldRunAudit(options);
  if (!gate.ok) {
    return {
      ok: true,
      skipped: true,
      reason: gate.reason,
      score: auditState.lastResult?.score ?? 1,
      hardMetrics: auditState.lastResult?.hardMetrics || null,
      writeFindings: [],
      recallFindings: [],
      warnings: [],
      durationMs: Date.now() - startedAt,
      nextRunInMs: gate.nextRunInMs || 0,
      lastResult: auditState.lastResult
    };
  }

  auditState.running = true;
  auditState.lastRunAt = Date.now();
  const warnings = [];
  let hardMetrics = { syncSummary: null, projectionFreshness: null };
  let writeSamples = [];
  let recallSamples = [];
  let semantic = { score: 1, writeFindings: [], recallFindings: [], warnings: [] };

  try {
    const hard = await collectHardMetrics(options, deps);
    hardMetrics = hard.hardMetrics;
    warnings.push(...hard.warnings);

    try {
      writeSamples = sampleMemoryNodes(options, deps);
    } catch (error) {
      warnings.push({
        code: 'write_sample_failed',
        severity: 'low',
        source: 'semantic_runtime',
        message: error?.message || String(error || '')
      });
    }

    try {
      const recall = await sampleRecallCases(options, deps);
      recallSamples = recall.samples;
      warnings.push(...recall.warnings.map((item) => normalizeWarning(item, 'recall_sampling')));
    } catch (error) {
      warnings.push({
        code: 'recall_sample_failed',
        severity: 'low',
        source: 'semantic_runtime',
        message: error?.message || String(error || '')
      });
    }

    if (writeSamples.length > 0 || recallSamples.length > 0) {
      try {
        const semanticResponse = await requestSemanticAudit(writeSamples, recallSamples, hardMetrics, options, deps);
        semantic = normalizeSemanticAudit(semanticResponse.raw);
      } catch (error) {
        const code = error?.code === 'not_configured'
          ? 'semantic_audit_not_configured'
          : error?.code === 'invalid_json'
            ? 'semantic_audit_invalid_json'
            : 'semantic_audit_failed';
        warnings.push({
          code,
          severity: 'low',
          source: 'semantic_runtime',
          message: error?.message || String(error || '')
        });
      }
    } else {
      warnings.push({
        code: 'semantic_audit_no_samples',
        severity: 'low',
        source: 'semantic_runtime',
        message: 'no write or recall samples available'
      });
    }

    warnings.push(...semantic.warnings);
    const writeFindings = semantic.writeFindings;
    const recallFindings = semantic.recallFindings;
    const score = computeScore(semantic.score, warnings, writeFindings, recallFindings);
    const result = {
      ok: score >= 0.75 && !hasHighRisk(warnings, writeFindings, recallFindings),
      score,
      hardMetrics,
      writeFindings,
      recallFindings,
      warnings,
      durationMs: Date.now() - startedAt,
      samples: {
        writes: writeSamples.length,
        recall: recallSamples.length
      }
    };
    auditState.lastResult = result;
    return result;
  } finally {
    auditState.running = false;
  }
}

function resetMemoryQualityAuditState() {
  auditState.running = false;
  auditState.lastRunAt = 0;
  auditState.lastResult = null;
}

module.exports = {
  CASES_FILE,
  buildAuditPrompt,
  buildHardMetricWarnings,
  classifyNodeRisk,
  collectHardMetrics,
  ensureChatCompletionsUrl,
  loadRecallCases,
  normalizeSemanticAudit,
  requestSemanticAudit,
  resetMemoryQualityAuditState,
  runMemoryQualityAudit,
  sampleMemoryNodes,
  sampleRecallCases,
  shouldRunAudit
};
