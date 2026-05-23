const axios = require('axios');
const config = require('../config');
const httpClient = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const {
  resolveRoleAwareMainModelConfig
} = require('../utils/mainModelConfigResolver');
const {
  ADMIN_SHARED_FALLBACK_SCOPE,
  resolveForcedFallbackMainModelConfig
} = require('../utils/mainModelFallback');
const {
  buildMainModelRequest,
  ensureChatCompletionsUrl,
  ensureResponsesUrl
} = require('../api/runtimeV2/model/shared');
const {
  resolveSafeModelEndpoint
} = require('../utils/networkSafety');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2));
  const timeoutArg = argv.find((item) => String(item || '').startsWith('--timeout-ms='));
  return {
    json: flags.has('--json'),
    timeoutMs: Math.max(5000, Number(String(timeoutArg || '').split('=')[1]) || 45000)
  };
}

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function normalizeText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join('\n').trim();
  }
  if (value && typeof value === 'object') {
    return normalizeText(value.text || value.content || value.output_text || value.outputText || value.message || value.response || '');
  }
  return String(value || '').trim();
}

function extractReplyText(resp) {
  const msg = extractMessageContent(resp);
  return normalizeText(msg?.content).replace(/\s+/g, ' ').trim();
}

function extractError(error) {
  const data = error?.response?.data;
  const payload = typeof data === 'string' ? data : JSON.stringify(data || {});
  return {
    ok: false,
    status: Number(error?.response?.status || 0) || null,
    code: String(error?.code || '').trim() || null,
    error: String(
      error?.response?.data?.error?.message
      || error?.response?.data?.error
      || error?.response?.data?.message
      || error?.message
      || error
    ).replace(/\s+/g, ' ').trim().slice(0, 600),
    responsePreview: payload.replace(/\s+/g, ' ').trim().slice(0, 800)
  };
}

function summarizeConfig(label, modelConfig) {
  return {
    label,
    model: String(modelConfig.model || '').trim(),
    apiBaseUrl: String(modelConfig.apiBaseUrl || '').trim(),
    apiKeyMasked: maskSecret(modelConfig.apiKey),
    role: String(modelConfig.__mainModelUserRole || '').trim(),
    modelSource: String(modelConfig.__mainModelSource || '').trim(),
    apiBaseUrlSource: String(modelConfig.__mainApiBaseUrlSource || '').trim(),
    apiKeySource: String(modelConfig.__mainApiKeySource || '').trim(),
    adminDedicatedModelConfigured: modelConfig.__adminDedicatedModelConfigured
  };
}

function inferNoToolWebCapability(text = '') {
  const refusal = /无法(?:直接)?(?:联网|浏览|访问互联网|实时搜索|搜索网页)|不能(?:直接)?(?:联网|浏览|访问互联网|实时搜索|搜索网页)|没有(?:模型内置的)?(?:联网|浏览|实时搜索|搜索网页)|没有.*(?:联网|浏览|实时访问|实时搜索|搜索网页)能力|do not have (?:direct )?(?:internet|web|browsing|search) access|cannot (?:browse|access the internet|search the web)/i.test(text);
  const claimsSearched = /已(?:联网|搜索|检索)|我(?:联网|搜索|检索)了|according to (?:the )?(?:search|web)|i searched|web search/i.test(text);
  const hasUrl = /https?:\/\/[^\s)）"'<>]+/i.test(text);
  return {
    canary: refusal ? 'explicit_no_browsing' : (claimsSearched || hasUrl ? 'claims_or_cites_web' : 'no_evidence'),
    likelyBuiltInWebSearch: Boolean(!refusal && (claimsSearched || hasUrl)),
    refusal,
    claimsSearched,
    hasUrl,
    preview: String(text || '').slice(0, 500)
  };
}

function inspectProviderSearchEvidence(resp, text = '') {
  const raw = typeof resp?.data === 'string' ? resp.data : JSON.stringify(resp?.data || {});
  const combined = `${raw}\n${text}`;
  const hasOpenAISearchCall = /web_search_call|web_search_preview|url_citation|citation/i.test(combined);
  const hasAnthropicSearchCall = /server_tool_use|web_search_tool_result|web_search_20250305/i.test(combined);
  const hasUrl = /https?:\/\/[^\s)）"'<>]+/i.test(combined);
  return {
    providerSearchEvidence: Boolean(hasOpenAISearchCall || hasAnthropicSearchCall || hasUrl),
    hasOpenAISearchCall,
    hasAnthropicSearchCall,
    hasUrl
  };
}

async function runNoToolProbe(label, modelConfig, timeoutMs) {
  const request = buildMainModelRequest(modelConfig, {
    messages: [
      {
        role: 'system',
        content: '只做能力诊断。不要猜测；如果没有真实联网/浏览能力，请明确说没有。'
      },
      {
        role: 'user',
        content: [
          '请测试你在本次 API 调用中是否拥有“模型/供应商内置”的联网搜索能力。',
          '不要使用外部工具，因为调用方不会提供工具。',
          '请尝试联网搜索 Reuters 当前 World News 首页的最新标题，并回复 JSON：',
          '{"can_web_search":true|false,"searched":true|false,"evidence_urls":[],"answer":"...","note":"..."}'
        ].join('\n')
      }
    ],
    stream: false,
    defaultMaxTokens: 420,
    trace: {
      source: 'diagnose_script',
      phase: 'web_search_capability_probe',
      purpose: `${label}_no_tool_probe`,
      routeType: 'diagnose'
    }
  });

  request.body.__timeoutMs = timeoutMs;
  const startedAt = Date.now();
  try {
    const resp = await httpClient.postWithRetry(request.url, request.body, 0, modelConfig.apiKey);
    const text = extractReplyText(resp);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      requestUrl: ensureChatCompletionsUrl(modelConfig.apiBaseUrl),
      protocol: request.protocol,
      status: Number(resp?.status || 200),
      text,
      inference: inferNoToolWebCapability(text)
    };
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      requestUrl: request.url,
      protocol: request.protocol,
      ...extractError(error)
    };
  }
}

async function postPrepared(url, body, apiKey, timeoutMs) {
  const prepared = await httpClient.prepareRequest(url, body);
  const response = await axios.post(
    prepared.requestUrl,
    prepared.requestBody,
    httpClient.getAxiosOptions(prepared.provider, apiKey, timeoutMs, prepared.requestHeaders)
  );
  return { response, prepared };
}

async function runOpenAIResponsesSearchProbe(label, modelConfig, timeoutMs) {
  const url = ensureResponsesUrl(modelConfig.apiBaseUrl);
  const body = {
    model: modelConfig.model,
    input: [
      'Use built-in web search for this diagnostic request.',
      'Find Reuters current World News front page latest headline.',
      'Return a compact JSON object with searched=true, title, and source URL.'
    ].join('\n'),
    tools: [{ type: 'web_search_preview' }],
    max_output_tokens: 420,
    stream: false,
    __preferredProtocol: 'responses',
    __timeoutMs: timeoutMs,
    __trace: {
      source: 'diagnose_script',
      phase: 'web_search_capability_probe',
      purpose: `${label}_openai_responses_web_search_preview`,
      routeType: 'diagnose'
    }
  };

  const startedAt = Date.now();
  try {
    const { response, prepared } = await postPrepared(url, body, modelConfig.apiKey, timeoutMs);
    const text = extractReplyText(response);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      requestUrl: prepared.requestUrl,
      provider: prepared.provider,
      status: Number(response?.status || 200),
      text,
      inference: inspectProviderSearchEvidence(response, text)
    };
  } catch (error) {
    return {
      elapsedMs: Date.now() - startedAt,
      requestUrl: url,
      provider: 'openai_compatible',
      ...extractError(error)
    };
  }
}

function ensureAnthropicMessagesUrl(url = '') {
  const normalized = String(url || '').trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  if (/\/v1\/messages$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, '/messages');
  if (/\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, '/messages');
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/messages`;
  return normalized;
}

async function postAnthropicMessages(url, body, apiKey, timeoutMs, authMode = 'x-api-key') {
  await resolveSafeModelEndpoint(url, {
    allowLocalHttp: Boolean(config.MODEL_ENDPOINT_ALLOW_LOCAL_HTTP)
  });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'anthropic-version': config.ANTHROPIC_VERSION || '2023-06-01'
  };
  if (authMode === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  else headers['x-api-key'] = apiKey;
  return axios.post(url, body, {
    headers,
    timeout: timeoutMs,
    proxy: false,
    responseType: 'text'
  });
}

async function runAnthropicNativeSearchProbe(label, modelConfig, timeoutMs) {
  const url = ensureAnthropicMessagesUrl(modelConfig.apiBaseUrl);
  const body = {
    model: modelConfig.model,
    max_tokens: 420,
    messages: [
      {
        role: 'user',
        content: [
          'Use the native Anthropic web search tool for this diagnostic request.',
          'Find Reuters current World News front page latest headline.',
          'Return compact JSON with searched=true, title, and source URL.'
        ].join('\n')
      }
    ],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 1
      }
    ]
  };

  const startedAt = Date.now();
  const attempts = [];
  for (const authMode of ['x-api-key', 'bearer']) {
    try {
      const response = await postAnthropicMessages(url, body, modelConfig.apiKey, timeoutMs, authMode);
      const text = extractReplyText(response);
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        requestUrl: url,
        authMode,
        status: Number(response?.status || 200),
        text,
        inference: inspectProviderSearchEvidence(response, text),
        attempts
      };
    } catch (error) {
      const err = extractError(error);
      attempts.push({ authMode, status: err.status, error: err.error, responsePreview: err.responsePreview });
      if (![401, 403].includes(Number(err.status || 0))) {
        return {
          elapsedMs: Date.now() - startedAt,
          requestUrl: url,
          authMode,
          ...err,
          attempts
        };
      }
    }
  }

  return {
    elapsedMs: Date.now() - startedAt,
    requestUrl: url,
    ...attempts[attempts.length - 1],
    ok: false,
    attempts
  };
}

function resolveTargets() {
  const adminUserId = String((config.ADMIN_USER_IDS || [])[0] || '__diagnose_admin__').trim();
  const adminPrimaryConfig = resolveRoleAwareMainModelConfig(adminUserId, null, {});
  return [
    {
      label: 'main',
      userId: '__diagnose_user__',
      modelConfig: resolveRoleAwareMainModelConfig('__diagnose_user__', null, {})
    },
    {
      label: 'admin_main',
      userId: adminUserId,
      modelConfig: adminPrimaryConfig
    },
    {
      label: 'admin_main_fallback_reference',
      userId: adminUserId,
      modelConfig: resolveForcedFallbackMainModelConfig(adminPrimaryConfig, { scope: ADMIN_SHARED_FALLBACK_SCOPE })
    }
  ];
}

async function runDiagnose(options = {}) {
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 45000);
  const targets = resolveTargets();
  const result = {
    now: new Date().toISOString(),
    timeoutMs,
    targets: []
  };

  for (const target of targets) {
    const entry = {
      label: target.label,
      userId: target.userId,
      config: summarizeConfig(target.label, target.modelConfig),
      probes: {}
    };
    entry.probes.no_tool = await runNoToolProbe(target.label, target.modelConfig, timeoutMs);
    entry.probes.openai_responses_web_search_preview = await runOpenAIResponsesSearchProbe(target.label, target.modelConfig, timeoutMs);
    entry.probes.anthropic_messages_web_search = await runAnthropicNativeSearchProbe(target.label, target.modelConfig, timeoutMs);
    result.targets.push(entry);
  }

  return result;
}

function printHuman(result) {
  console.log(`=== Main Model Built-in Web Search Diagnose @ ${result.now} ===`);
  for (const target of result.targets) {
    console.log(`\n[${target.label}]`);
    console.log(JSON.stringify(target.config, null, 2));
    for (const [name, probe] of Object.entries(target.probes)) {
      console.log(`\n- ${name}`);
      console.log(JSON.stringify({
        ok: probe.ok,
        status: probe.status,
        requestUrl: probe.requestUrl,
        provider: probe.provider,
        authMode: probe.authMode,
        elapsedMs: probe.elapsedMs,
        inference: probe.inference,
        error: probe.error,
        textPreview: probe.text ? String(probe.text).slice(0, 500) : undefined,
        attempts: probe.attempts
      }, null, 2));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runDiagnose(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  inferNoToolWebCapability,
  inspectProviderSearchEvidence,
  parseArgs,
  runDiagnose
};
