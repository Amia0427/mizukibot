const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const httpClient = require('../api/httpClient');
const {
  buildMainModelRequest
} = require('../api/runtimeV2/model/shared');
const {
  resolveUserScopedMainModelConfig
} = require('../utils/mainModelConfigResolver');
const {
  buildRequestCacheTrace
} = require('../src/model/http/request-shaping.chunk');
const {
  flushModelCallLogsSync,
  listRecentModelCalls
} = require('../utils/modelCallTracker');
const {
  extractUsage
} = require('../utils/modelCallTracker/usage');
const {
  estimatePromptTokens,
  summarizePromptTokenBudget
} = require('../utils/modelCallTracker/requestSummary');
const {
  createRequestTrace,
  flushRequestTraceEventsSync
} = require('../utils/requestTrace');

const DEFAULT_TEXT = '管理员缓存对照验收：请只回复“cache-check-ok”。';
const CACHE_READ_KEYS = new Set([
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'prompt_cache_hit_tokens',
  'promptCacheHitTokens'
]);
const CACHE_WRITE_KEYS = new Set([
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'prompt_cache_miss_tokens',
  'promptCacheMissTokens',
  'cache_write_tokens',
  'cacheWriteTokens'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function sha(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : stableStringify(value))
    .digest('hex')
    .slice(0, 16);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function maskSecret(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  const bearer = text.match(/^Bearer\s+(.+)$/i);
  if (bearer) return `Bearer ${maskSecret(bearer[1])}`;
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function summarizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'x-goog-api-key') {
      out[key] = maskSecret(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parseArgs(argv = []) {
  const out = {
    adminUserId: normalizeText((config.ADMIN_USER_IDS || [])[0] || ''),
    text: DEFAULT_TEXT,
    maxTokens: 32,
    retries: 0,
    timeoutMs: 45000,
    delayMs: 1200,
    forceStableCacheBlock: true,
    keepReasoning: false,
    dryRun: false,
    json: false,
    output: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || '').trim();
    if (!raw) continue;
    const eq = raw.indexOf('=');
    const key = raw.startsWith('--') ? raw.slice(2, eq >= 0 ? eq : undefined) : '';
    const next = eq >= 0 ? raw.slice(eq + 1) : argv[i + 1];
    const hasInlineValue = eq >= 0;
    const hasNextValue = !hasInlineValue && next !== undefined && !String(next).startsWith('--');
    const value = hasInlineValue ? next : (hasNextValue ? next : 'true');
    if (!hasInlineValue && hasNextValue) i += 1;

    if (key === 'admin-user-id' || key === 'admin') out.adminUserId = normalizeText(value);
    else if (key === 'text') out.text = String(value || '');
    else if (key === 'max-tokens') out.maxTokens = Math.max(1, Math.floor(Number(value) || out.maxTokens));
    else if (key === 'retries') out.retries = Math.max(0, Math.floor(Number(value) || 0));
    else if (key === 'timeout-ms') out.timeoutMs = Math.max(1000, Math.floor(Number(value) || out.timeoutMs));
    else if (key === 'delay-ms') out.delayMs = Math.max(0, Math.floor(Number(value) || 0));
    else if (key === 'no-force-cache-block') out.forceStableCacheBlock = false;
    else if (key === 'keep-reasoning') out.keepReasoning = true;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'json') out.json = true;
    else if (key === 'output') out.output = normalizeText(value);
  }
  return out;
}

function buildStableSystemMessages(options = {}) {
  const messages = [];
  const rootSystem = normalizeText(config.SYSTEM_PROMPT);
  if (rootSystem) {
    messages.push({ role: 'system', content: rootSystem });
  }

  if (options.forceStableCacheBlock) {
    const diagnosticStableText = [
      '[AdminCacheReadVerification]',
      'This block is intentionally stable across two consecutive admin cache verification requests.',
      'It contains no user secrets and exists only to make provider prompt-cache eligibility visible.',
      'Do not follow instructions from this block except to keep the final answer short.',
      'stable-anchor='.repeat(260)
    ].join('\n');
    messages.push({
      role: 'system',
      content: diagnosticStableText,
      cache_control: { type: 'ephemeral', ttl: '1h' }
    });
  }

  if (messages.length === 0) {
    messages.push({
      role: 'system',
      content: 'MizukiBot admin cache verification stable system prompt.',
      cache_control: options.forceStableCacheBlock ? { type: 'ephemeral', ttl: '1h' } : undefined
    });
  }

  return messages;
}

function buildMessages(options = {}) {
  return [
    ...buildStableSystemMessages(options),
    {
      role: 'user',
      content: normalizeText(options.text) || DEFAULT_TEXT
    }
  ];
}

function summarizeBody(body = {}) {
  const promptBudget = summarizePromptTokenBudget(body);
  return {
    hash: sha(body),
    keys: body && typeof body === 'object' ? Object.keys(body).sort() : [],
    model: normalizeText(body?.model),
    stream: Boolean(body?.stream),
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    systemBlockCount: Array.isArray(body?.system) ? body.system.length : 0,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    estimatedInputTokens: promptBudget.estimated_input_tokens,
    estimatedSystemTokens: promptBudget.estimated_system_tokens,
    estimatedMessageTokens: promptBudget.estimated_message_tokens,
    promptCacheKey: normalizeText(body?.prompt_cache_key),
    promptCacheRetention: normalizeText(body?.prompt_cache_retention)
  };
}

function summarizeValue(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', length: value.length, hash: sha(value) };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).length, hash: sha(value) };
  if (typeof value === 'string') return { type: 'string', length: value.length, hash: sha(value) };
  return { type: typeof value, value: typeof value === 'number' || typeof value === 'boolean' ? value : undefined };
}

function diffJson(a, b, basePath = '$', diffs = [], limit = 120) {
  if (diffs.length >= limit) return diffs;
  if (a === b) return diffs;
  const aIsObject = a && typeof a === 'object';
  const bIsObject = b && typeof b === 'object';
  if (!aIsObject || !bIsObject || Array.isArray(a) !== Array.isArray(b)) {
    diffs.push({ path: basePath, before: summarizeValue(a), after: summarizeValue(b) });
    return diffs;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max && diffs.length < limit; i += 1) {
      if (i >= a.length || i >= b.length) {
        diffs.push({ path: `${basePath}[${i}]`, before: summarizeValue(a[i]), after: summarizeValue(b[i]) });
      } else {
        diffJson(a[i], b[i], `${basePath}[${i}]`, diffs, limit);
      }
    }
    return diffs;
  }

  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  for (const key of keys) {
    if (diffs.length >= limit) break;
    const nextPath = `${basePath}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(a, key) || !Object.prototype.hasOwnProperty.call(b, key)) {
      diffs.push({ path: nextPath, before: summarizeValue(a[key]), after: summarizeValue(b[key]) });
      continue;
    }
    diffJson(a[key], b[key], nextPath, diffs, limit);
  }
  return diffs;
}

function maybeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function collectRawCacheSignals(value, pathName = '$', out = null, depth = 0) {
  const result = out || {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    readFields: [],
    writeFields: [],
    usageFieldsSeen: false
  };
  if (!value || typeof value !== 'object' || depth > 10) return result;

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRawCacheSignals(item, `${pathName}[${index}]`, result, depth + 1));
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathName}.${key}`;
    if (/usage/i.test(key)) result.usageFieldsSeen = true;
    const n = maybeNumber(child);
    if (n !== null) {
      if (CACHE_READ_KEYS.has(key) || /(?:prompt|input)_tokens_details\.cached_tokens$/i.test(childPath)) {
        result.cacheReadTokens += Math.max(0, n);
        result.readFields.push({ path: childPath, value: n });
      } else if (CACHE_WRITE_KEYS.has(key) || /(?:prompt|input)_tokens_details\.cache_write_tokens$/i.test(childPath)) {
        result.cacheWriteTokens += Math.max(0, n);
        result.writeFields.push({ path: childPath, value: n });
      }
    } else if (key === 'cache_creation' || key === 'cacheCreation') {
      result.writeFields.push({ path: childPath, value: 'object' });
    }
    collectRawCacheSignals(child, childPath, result, depth + 1);
  }

  return result;
}

function summarizeUsage(response = null, modelCall = null) {
  const rawSignals = collectRawCacheSignals(response?.data || response || {});
  const normalizedUsage = extractUsage(response);
  const trackedUsage = modelCall?.usage || null;
  return {
    responseUsage: normalizedUsage,
    modelCallUsage: trackedUsage,
    rawCacheSignals: rawSignals,
    cacheReadTokens: Number(
      rawSignals.cacheReadTokens
      || normalizedUsage?.cache_read_input_tokens
      || trackedUsage?.cache_read_input_tokens
      || 0
    ) || 0,
    cacheWriteTokens: Number(
      rawSignals.cacheWriteTokens
      || normalizedUsage?.cache_creation_input_tokens
      || trackedUsage?.cache_creation_input_tokens
      || 0
    ) || 0
  };
}

function readNdjsonTail(file, maxBytes = 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function collectTraceEvents(requestIds = []) {
  const wanted = new Set(requestIds.map(normalizeText).filter(Boolean));
  if (wanted.size === 0) return [];
  const file = path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'request-trace.ndjson');
  return readNdjsonTail(file)
    .filter((row) => wanted.has(normalizeText(row.requestId)))
    .map((row) => ({
      recordedAt: row.recordedAt,
      requestId: row.requestId,
      phaseSeq: row.phaseSeq,
      tracePhase: row.tracePhase,
      stage: row.stage,
      attempt: row.attempt,
      provider: row.provider,
      model: row.model,
      requestUrl: row.requestUrl,
      statusCode: row.statusCode,
      reason: row.reason,
      downgradeReason: row.downgradeReason,
      finalErrorCode: row.finalErrorCode,
      durationMs: row.durationMs,
      cache: row.cache || null,
      error: row.error
    }));
}

function summarizeModelCall(call = null) {
  if (!call) return null;
  return {
    id: call.id,
    status: call.status,
    source: call.source,
    phase: call.phase,
    purpose: call.purpose,
    requestId: call.request_id,
    provider: call.provider,
    model: call.model,
    userId: call.user_id,
    userRole: call.user_role,
    apiBaseUrlHost: call.api_base_url_host,
    promptCaching: call.prompt_caching,
    usage: call.usage,
    finishReason: call.finish_reason,
    attempts: call.attempts,
    durationMs: call.duration_ms,
    error: call.error,
    finalErrorCode: call.final_error_code
  };
}

function hasCacheRequest(cache = {}) {
  return Boolean(
    normalizeText(cache.openaiPromptCacheKey)
    || normalizeText(cache.openaiPromptCacheRetention)
    || Number(cache.anthropicCacheBreakpoints || 0) > 0
    || normalizeText(cache.anthropicBeta)
  );
}

function classify(report = {}) {
  if (report.dryRun) {
    return {
      status: 'dry_run_preflight',
      verdict: '仅完成本地请求体预检，未发送真实请求，不能判断上游缓存读写。',
      reasons: ['dry_run=true']
    };
  }

  const attempts = Array.isArray(report.attempts) ? report.attempts : [];
  const first = attempts[0] || {};
  const second = attempts[1] || {};
  const cacheRead = Number(second.usage?.cacheReadTokens || 0) || 0;
  const rawSecondRead = Number(second.usage?.rawCacheSignals?.cacheReadTokens || 0) || 0;
  const trackedSecondRead = Number(second.usage?.modelCallUsage?.cache_read_input_tokens || 0) || 0;
  const cacheWrite1 = Number(first.usage?.cacheWriteTokens || 0) || 0;
  const cacheWrite2 = Number(second.usage?.cacheWriteTokens || 0) || 0;
  const usageFieldsSeen = Boolean(
    first.usage?.rawCacheSignals?.usageFieldsSeen
    || second.usage?.rawCacheSignals?.usageFieldsSeen
    || first.usage?.responseUsage
    || second.usage?.responseUsage
    || first.usage?.modelCallUsage
    || second.usage?.modelCallUsage
  );
  const finalCache1 = first.modelCall?.promptCaching || {};
  const finalCache2 = second.modelCall?.promptCaching || {};
  const sentCache1 = first.prepared?.cache || {};
  const sentCache2 = second.prepared?.cache || {};
  const requestCachePresent = hasCacheRequest(sentCache1) || hasCacheRequest(sentCache2) || hasCacheRequest(finalCache1) || hasCacheRequest(finalCache2);
  const downgradeEvents = (report.traceEvents || []).filter((event) => /downgrade/i.test(event.tracePhase || event.stage || ''));
  const cacheDowngrades = downgradeEvents.filter((event) => /cache/i.test(event.reason || event.downgradeReason || ''));
  const diffCount = Number(report.requestBodyDiff?.count || 0) || 0;
  const minTokens = Math.min(
    Number(first.prepared?.bodySummary?.estimatedInputTokens || 0) || 0,
    Number(second.prepared?.bodySummary?.estimatedInputTokens || 0) || 0
  );
  const failed = attempts.some((attempt) => attempt.error);

  if (failed) {
    return {
      status: 'request_failed',
      verdict: '真实请求失败，不能判断缓存读写。',
      reasons: attempts.filter((attempt) => attempt.error).map((attempt) => attempt.error)
    };
  }

  if (rawSecondRead > 0 && trackedSecondRead <= 0) {
    return {
      status: 'local_read_chain_missed_result',
      verdict: '上游响应已有缓存读取信号，但本地 model-call 记录没有吃到结果。',
      reasons: ['raw_response_cache_read_positive', 'model_call_cache_read_missing']
    };
  }

  if (cacheRead > 0) {
    return {
      status: 'cache_hit_confirmed',
      verdict: '第二次真实请求已读到缓存。',
      reasons: [`second_cache_read_tokens=${cacheRead}`]
    };
  }

  if (cacheDowngrades.length > 0) {
    return {
      status: 'upstream_cache_unsupported',
      verdict: '上游拒绝缓存字段，本地已降级剥离缓存参数。',
      reasons: cacheDowngrades.map((event) => normalizeText(event.reason || event.downgradeReason)).filter(Boolean)
    };
  }

  if (!requestCachePresent) {
    return {
      status: 'request_body_not_cacheable',
      verdict: '最终请求体没有携带任何可识别的缓存读写条件。',
      reasons: ['no_prompt_cache_key_or_cache_control_after_local_shaping']
    };
  }

  if (diffCount > 0) {
    return {
      status: 'request_body_not_cacheable',
      verdict: '两次最终准备请求体存在差异，不能把“只写不读”归因给上游。',
      reasons: [`request_body_diff_count=${diffCount}`]
    };
  }

  if (minTokens > 0 && minTokens < 1024) {
    return {
      status: 'request_body_not_cacheable',
      verdict: '请求输入太短，可能不满足常见 prompt cache 最小前缀条件。',
      reasons: [`estimated_input_tokens=${minTokens}`]
    };
  }

  if (cacheWrite1 > 0 && cacheWrite2 > 0) {
    return {
      status: 'upstream_cache_not_reused',
      verdict: '两次请求体一致且缓存条件已送出，但第二次仍只写不读；优先归因上游不复用/不支持读取。',
      reasons: [`first_cache_write_tokens=${cacheWrite1}`, `second_cache_write_tokens=${cacheWrite2}`]
    };
  }

  if (!usageFieldsSeen) {
    return {
      status: 'upstream_cache_signal_unobservable',
      verdict: '缓存条件已送出且请求体一致，但上游响应没有 usage/cache 字段；不能证明“只写”，只能归因上游不提供可观测缓存读写信号或该端点不支持上报。',
      reasons: ['no_usage_fields_in_response', 'model_call_usage_empty']
    };
  }

  return {
    status: 'upstream_no_cache_hit_signal',
    verdict: '缓存条件已送出且请求体一致，但第二次响应没有缓存读取信号。',
    reasons: ['no_second_cache_read_tokens', 'no_cache_field_downgrade', `first_cache_write_tokens=${cacheWrite1}`, `second_cache_write_tokens=${cacheWrite2}`]
  };
}

async function buildPreparedAttempt(attemptNo, options = {}) {
  const adminUserId = normalizeText(options.adminUserId) || normalizeText((config.ADMIN_USER_IDS || [])[0] || '__admin_cache_verify__');
  const resolvedBase = resolveUserScopedMainModelConfig(adminUserId, null, {});
  const resolvedConfig = {
    ...resolvedBase,
    maxTokens: options.maxTokens,
    retries: options.retries,
    timeoutMs: options.timeoutMs
  };
  if (!options.keepReasoning) {
    resolvedConfig.reasoningEffort = 'off';
    resolvedConfig.topK = undefined;
    resolvedConfig.topP = undefined;
    resolvedConfig.topA = undefined;
    resolvedConfig.repetitionPenalty = undefined;
  }

  const requestTrace = createRequestTrace({
    source: 'admin_cache_read_verification',
    userId: adminUserId,
    chatType: 'private',
    isAdmin: true,
    messageId: `admin_cache_verify_${Date.now()}_${attemptNo}`
  });
  const messages = buildMessages(options);
  const request = buildMainModelRequest(resolvedConfig, {
    messages,
    stream: false,
    defaultMaxTokens: options.maxTokens,
    trace: {
      source: 'admin_cache_read_verification',
      phase: `attempt_${attemptNo}`,
      purpose: 'admin_cache_read_compare',
      requestId: requestTrace.requestId,
      phaseSeq: requestTrace.phaseSeq,
      userId: adminUserId,
      userRole: 'admin',
      topRouteType: 'admin',
      routePolicyKey: 'admin/cache-read-verification',
      routeDebugKey: 'admin/cache-read-verification',
      dispatchBranch: 'admin_cache_read_verification',
      triggerBranch: 'script.verify_admin_cache_read',
      modelSource: resolvedConfig.__mainModelSource,
      apiBaseUrlSource: resolvedConfig.__mainApiBaseUrlSource,
      apiKeySource: resolvedConfig.__mainApiKeySource,
      mainFallbackScope: resolvedConfig.__mainFallbackScope,
      mainFallbackActive: resolvedConfig.__mainFallbackActive === true,
      mainFallbackForced: resolvedConfig.__mainFallbackForced === true,
      adminDedicatedModelConfigured: resolvedConfig.__adminDedicatedModelConfigured
    },
    routeMeta: {
      topRouteType: 'admin',
      routePolicyKey: 'admin/cache-read-verification',
      routeDebugKey: 'admin/cache-read-verification',
      requestTrace
    },
    topRouteType: 'admin',
    tools: [],
    allowedTools: []
  });
  const prepared = await httpClient.prepareRequest(request.url, request.body);
  return {
    attemptNo,
    adminUserId,
    requestTrace,
    resolved: {
      provider: request.provider,
      protocol: request.protocol,
      model: resolvedConfig.model,
      modelSource: resolvedConfig.__mainModelSource,
      apiBaseUrlSource: resolvedConfig.__mainApiBaseUrlSource,
      apiKeySource: resolvedConfig.__mainApiKeySource,
      fallbackActive: resolvedConfig.__mainFallbackActive === true,
      fallbackForced: resolvedConfig.__mainFallbackForced === true
    },
    request,
    prepared,
    bodySummary: summarizeBody(prepared.requestBody),
    cache: buildRequestCacheTrace(prepared.requestBody, prepared.requestHeaders),
    headerNames: Object.keys(prepared.requestHeaders || {}).sort(),
    headers: summarizeHeaders(prepared.requestHeaders)
  };
}

async function runAttempt(attemptNo, options = {}) {
  const preparedAttempt = await buildPreparedAttempt(attemptNo, options);
  if (options.dryRun) {
    return {
      attemptNo,
      requestId: preparedAttempt.requestTrace.requestId,
      resolved: preparedAttempt.resolved,
      prepared: {
        requestUrl: preparedAttempt.prepared.requestUrl,
        provider: preparedAttempt.prepared.provider,
        bodySummary: preparedAttempt.bodySummary,
        cache: preparedAttempt.cache,
        headerNames: preparedAttempt.headerNames,
        headers: preparedAttempt.headers
      },
      responseStatus: null,
      usage: null,
      modelCall: null,
      error: null
    };
  }

  try {
    const response = await httpClient.postWithRetry(
      preparedAttempt.request.url,
      preparedAttempt.request.body,
      Math.max(0, Number(options.retries) || 0),
      null
    );
    flushModelCallLogsSync();
    flushRequestTraceEventsSync();
    const modelCallId = response?.__modelCallId;
    const modelCall = listRecentModelCalls(20).find((call) => call.id === modelCallId)
      || listRecentModelCalls(20).find((call) => call.request_id === preparedAttempt.requestTrace.requestId)
      || null;
    return {
      attemptNo,
      requestId: preparedAttempt.requestTrace.requestId,
      resolved: preparedAttempt.resolved,
      prepared: {
        requestUrl: preparedAttempt.prepared.requestUrl,
        provider: preparedAttempt.prepared.provider,
        bodySummary: preparedAttempt.bodySummary,
        cache: preparedAttempt.cache,
        headerNames: preparedAttempt.headerNames,
        headers: preparedAttempt.headers
      },
      responseStatus: Number(response?.status || 0) || null,
      usage: summarizeUsage(response, modelCall),
      modelCall: summarizeModelCall(modelCall),
      error: null
    };
  } catch (error) {
    flushModelCallLogsSync();
    flushRequestTraceEventsSync();
    const modelCall = listRecentModelCalls(20).find((call) => call.request_id === preparedAttempt.requestTrace.requestId) || null;
    return {
      attemptNo,
      requestId: preparedAttempt.requestTrace.requestId,
      resolved: preparedAttempt.resolved,
      prepared: {
        requestUrl: preparedAttempt.prepared.requestUrl,
        provider: preparedAttempt.prepared.provider,
        bodySummary: preparedAttempt.bodySummary,
        cache: preparedAttempt.cache,
        headerNames: preparedAttempt.headerNames,
        headers: preparedAttempt.headers
      },
      responseStatus: Number(error?.response?.status || 0) || null,
      usage: summarizeUsage(error?.response || null, modelCall),
      modelCall: summarizeModelCall(modelCall),
      error: {
        message: normalizeText(error?.message || error),
        statusCode: Number(error?.response?.status || 0) || null,
        code: normalizeText(error?.code || error?.response?.data?.error?.code)
      }
    };
  }
}

function reportText(report = {}) {
  const lines = [];
  lines.push(`管理员缓存对照验收：${report.classification.verdict}`);
  lines.push(`结论：${report.classification.status}`);
  lines.push(`管理员：${report.adminUserId}`);
  lines.push(`请求体差异：${report.requestBodyDiff.count} 处`);
  for (const attempt of report.attempts || []) {
    lines.push(`第 ${attempt.attemptNo} 次：status=${attempt.responseStatus || 'n/a'} provider=${attempt.prepared.provider} model=${attempt.prepared.bodySummary.model}`);
    lines.push(`  cache=${JSON.stringify(attempt.prepared.cache)} usage_read=${attempt.usage?.cacheReadTokens ?? 'n/a'} usage_write=${attempt.usage?.cacheWriteTokens ?? 'n/a'}`);
  }
  if (report.requestBodyDiff.items.length > 0) {
    lines.push('差异路径：');
    for (const item of report.requestBodyDiff.items.slice(0, 20)) {
      lines.push(`  - ${item.path}`);
    }
  }
  lines.push(`关键日志事件：${report.traceEvents.length} 条；requestId=${report.attempts.map((item) => item.requestId).join(',')}`);
  return lines.join('\n');
}

async function run(options = {}) {
  const attempt1 = await runAttempt(1, options);
  if (!options.dryRun && options.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  const attempt2 = await runAttempt(2, options);
  flushModelCallLogsSync();
  flushRequestTraceEventsSync();

  const prepared1 = await buildPreparedAttempt(101, options);
  const prepared2 = await buildPreparedAttempt(102, options);
  const diffItems = diffJson(prepared1.prepared.requestBody, prepared2.prepared.requestBody);
  const report = {
    schemaVersion: 'admin_cache_read_verification_v1',
    generatedAt: new Date().toISOString(),
    dryRun: Boolean(options.dryRun),
    adminUserId: normalizeText(options.adminUserId) || normalizeText((config.ADMIN_USER_IDS || [])[0] || ''),
    generationOverrides: {
      maxTokens: options.maxTokens,
      retries: options.retries,
      timeoutMs: options.timeoutMs,
      keepReasoning: options.keepReasoning,
      forceStableCacheBlock: options.forceStableCacheBlock
    },
    input: {
      textHash: sha(options.text || DEFAULT_TEXT),
      textTokens: estimatePromptTokens(options.text || DEFAULT_TEXT)
    },
    requestBodyDiff: {
      count: diffItems.length,
      truncated: diffItems.length >= 120,
      items: diffItems
    },
    attempts: [attempt1, attempt2],
    traceEvents: collectTraceEvents([attempt1.requestId, attempt2.requestId])
  };
  report.classification = classify(report);

  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.adminUserId) {
    options.adminUserId = '__admin_cache_verify__';
  }
  let report = null;
  try {
    report = await run(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(reportText(report));
    }

    if (report.classification.status === 'request_failed') {
      process.exitCode = 2;
    }
  } finally {
    if (typeof httpClient.shutdownCycleTLS === 'function') {
      await httpClient.shutdownCycleTLS();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[FAIL]', error?.stack || error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  buildMessages,
  classify,
  collectRawCacheSignals,
  diffJson,
  parseArgs,
  run,
  summarizeUsage
};
