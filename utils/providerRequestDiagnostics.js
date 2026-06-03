const config = require('../config');
const httpClient = require('../api/httpClient');
const {
  buildMainModelRequest
} = require('../api/runtimeV2/model/shared');
const {
  buildBotDiaryQzoneImageHeaders,
  buildBotDiaryQzoneImageRequestBody,
  resolveBotDiaryQzoneImageRequestUrl
} = require('../api/imageGeneration');
const {
  buildImageModelConfig
} = require('./imageModelConfigResolver');
const {
  resolveRoleAwareMainModelConfig
} = require('./mainModelConfigResolver');
const {
  getApiProvider,
  normalizeApiProvider,
  isOpenAICompatibleProvider,
  isAnthropicProvider,
  isGeminiNativeProvider
} = require('./modelProvider');
const {
  buildRequestCacheTrace
} = require('../src/model/http/request-shaping.chunk');

const CACHE_FIELD_NAMES = [
  'cache',
  'cache_control',
  'cacheControl',
  'prompt_cache_key',
  'prompt_cache_retention'
];

const INTERNAL_FIELD_NAMES = [
  '__abortSignal',
  '__originalMaxTokens',
  '__preferredProtocol',
  '__requestHeaders',
  '__responsesProtocolFallbackAttempted',
  '__timeoutMs',
  '__provider',
  '__apiProvider',
  '__trace'
];

const FIELD_KINDS = {
  cache: CACHE_FIELD_NAMES,
  internal: INTERNAL_FIELD_NAMES
};

function normalizeText(value = '') {
  return String(value || '').trim();
}

function maskSecret(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  const bearer = text.match(/^Bearer\s+(.+)$/i);
  if (bearer) return `Bearer ${maskSecret(bearer[1])}`;
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key || '').toLowerCase();
    if (value === false) {
      out[key] = false;
    } else if (lower === 'authorization' || lower === 'x-api-key' || lower === 'x-goog-api-key') {
      out[key] = maskSecret(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function countFieldNames(value, names, counts = {}) {
  for (const name of names) counts[name] = counts[name] || 0;
  if (Array.isArray(value)) {
    for (const item of value) countFieldNames(item, names, counts);
    return counts;
  }
  if (!value || typeof value !== 'object') return counts;
  for (const [key, child] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    countFieldNames(child, names, counts);
  }
  return counts;
}

function summarizeStrippedFields(before = {}, after = {}) {
  const result = {};
  for (const [kind, fields] of Object.entries(FIELD_KINDS)) {
    const beforeCounts = countFieldNames(before, fields);
    const afterCounts = countFieldNames(after, fields);
    result[kind] = fields
      .map((field) => ({
        field,
        before: beforeCounts[field] || 0,
        after: afterCounts[field] || 0,
        removed: Math.max(0, (beforeCounts[field] || 0) - (afterCounts[field] || 0))
      }))
      .filter((item) => item.before > 0 || item.after > 0 || item.removed > 0);
  }
  result.totalRemoved = Object.values(result)
    .flat()
    .filter((item) => item && typeof item === 'object')
    .reduce((sum, item) => sum + Math.max(0, Number(item.removed || 0)), 0);
  return result;
}

function getProviderPreset(provider = 'openai_compatible') {
  const normalized = normalizeApiProvider(provider);
  if (normalized === 'anthropic') {
    return {
      provider: normalized,
      model: 'claude-3-5-sonnet-latest',
      apiBaseUrl: 'https://api.anthropic.com/v1/messages',
      imageApiBaseUrl: 'https://api.anthropic.com/v1/messages',
      qzoneImageApiBaseUrl: 'https://api.anthropic.com/v1/messages'
    };
  }
  if (normalized === 'gemini_native') {
    return {
      provider: normalized,
      model: 'gemini-3-pro-preview',
      apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
      imageApiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
      qzoneImageApiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta'
    };
  }
  return {
    provider: 'openai_compatible',
    model: 'gpt-4.1-mini',
    apiBaseUrl: 'https://provider-diagnostic.example/v1/chat/completions',
    imageApiBaseUrl: 'https://provider-diagnostic.example/v1/chat/completions',
    qzoneImageApiBaseUrl: 'https://provider-diagnostic.example/v1/images/generations'
  };
}

function pickCliOrConfig(value, fallbackValue, valueSource, fallbackSource) {
  const text = normalizeText(value);
  if (text) return { value: text, source: valueSource };
  return { value: normalizeText(fallbackValue), source: fallbackSource };
}

function buildRequestedProviderConfig(options = {}) {
  const hasProvider = Boolean(normalizeText(options.provider));
  const inferredProvider = hasProvider
    ? normalizeApiProvider(options.provider)
    : getApiProvider(options.apiBaseUrl || config.API_BASE_URL, options.model || config.AI_MODEL, { preferUnifiedResponses: true });
  const preset = getProviderPreset(inferredProvider);
  const apiBaseUrlPick = pickCliOrConfig(
    options.apiBaseUrl,
    hasProvider ? preset.apiBaseUrl : config.API_BASE_URL,
    'cli.apiBaseUrl',
    hasProvider ? 'providerPreset.apiBaseUrl' : 'API_BASE_URL'
  );
  const apiKeyPick = Object.prototype.hasOwnProperty.call(options, 'apiKey')
    ? { value: normalizeText(options.apiKey), source: 'cli.apiKey' }
    : { value: normalizeText(config.API_KEY), source: 'API_KEY' };
  const modelPick = pickCliOrConfig(
    options.model,
    hasProvider ? preset.model : config.AI_MODEL,
    'cli.model',
    hasProvider ? 'providerPreset.model' : 'AI_MODEL'
  );
  const imageApiBaseUrlPick = pickCliOrConfig(
    options.imageApiBaseUrl,
    hasProvider ? preset.imageApiBaseUrl : (config.IMAGE_API_BASE_URL || apiBaseUrlPick.value),
    'cli.imageApiBaseUrl',
    hasProvider ? 'providerPreset.imageApiBaseUrl' : (config.IMAGE_API_BASE_URL ? 'IMAGE_API_BASE_URL' : apiBaseUrlPick.source)
  );
  const qzoneImageApiBaseUrlPick = pickCliOrConfig(
    options.qzoneImageApiBaseUrl,
    hasProvider ? preset.qzoneImageApiBaseUrl : config.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_BASE_URL,
    'cli.qzoneImageApiBaseUrl',
    hasProvider ? 'providerPreset.qzoneImageApiBaseUrl' : 'BOT_DIARY_QZONE_IMAGE_PROVIDER_API_BASE_URL'
  );

  return {
    requestedProvider: inferredProvider,
    model: modelPick.value,
    modelSource: modelPick.source,
    apiBaseUrl: apiBaseUrlPick.value,
    apiBaseUrlSource: apiBaseUrlPick.source,
    apiKey: apiKeyPick.value,
    apiKeySource: apiKeyPick.source,
    imageApiBaseUrl: imageApiBaseUrlPick.value,
    imageApiBaseUrlSource: imageApiBaseUrlPick.source,
    imageApiKey: apiKeyPick.value,
    imageApiKeySource: apiKeyPick.source,
    qzoneImageApiBaseUrl: qzoneImageApiBaseUrlPick.value,
    qzoneImageApiBaseUrlSource: qzoneImageApiBaseUrlPick.source
  };
}

function buildDiagnosticMessages({ withImage = false } = {}) {
  const userContent = withImage
    ? [
        {
          type: 'text',
          text: 'provider request diagnostic',
          cache_control: { type: 'ephemeral', ttl: '5m' }
        },
        {
          type: 'image_url',
          image_url: {
            url: 'cached-image://provider-diagnostic-missing',
            detail: 'ultra'
          },
          cache_control: true
        }
      ]
    : [
        {
          type: 'text',
          text: 'provider request diagnostic',
          cache_control: { type: 'ephemeral', ttl: '5m' }
        }
      ];

  return [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'stable diagnostic system',
          cache_control: { type: 'ephemeral', ttl: '5m' }
        }
      ],
      cache_control: true
    },
    {
      role: 'user',
      content: userContent
    }
  ];
}

function buildDiagnosticTools() {
  return [
    {
      type: 'function',
      cache_control: { type: 'ephemeral', ttl: '5m' },
      function: {
        name: 'diagnostic_lookup',
        description: 'diagnostic tool schema',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' }
          }
        },
        cache_control: true
      }
    }
  ];
}

function buildHttpDiagnosticBody(scenarioConfig = {}, options = {}) {
  const apiKey = normalizeText(scenarioConfig.apiKey);
  return {
    model: scenarioConfig.model,
    temperature: 0.2,
    top_p: 0.9,
    top_a: 0.4,
    repetition_penalty: 1.05,
    reasoning_effort: 'high',
    messages: buildDiagnosticMessages({ withImage: Boolean(options.withImage) }),
    tools: buildDiagnosticTools(),
    tool_choice: 'auto',
    cache_control: { type: 'ephemeral', ttl: '5m' },
    prompt_cache_key: 'provider-diagnostic-cache-key',
    prompt_cache_retention: '24h',
    stream: false,
    __preferredProtocol: 'chat_completions',
    __trace: {
      source: 'provider_request_diagnostic',
      purpose: options.name || 'http_client_direct'
    },
    __requestHeaders: {
      Authorization: apiKey ? `Bearer ${apiKey}` : '',
      'User-Agent': config.MODEL_HTTP_USER_AGENT || config.MAIN_REPLY_USER_AGENT || config.HTTP_USER_AGENT,
      'x-api-key': apiKey,
      'x-goog-api-key': apiKey,
      'X-Not-Allowed': 'drop-me'
    }
  };
}

function summarizeGeminiSystemInstruction(body = {}) {
  const parts = Array.isArray(body?.systemInstruction?.parts)
    ? body.systemInstruction.parts
    : [];
  const text = parts
    .map((part) => normalizeText(part?.text))
    .filter(Boolean)
    .join('\n');
  return {
    present: Boolean(text),
    hasGeminiRuntimeAdapter: text.includes('[GeminiRuntimeAdapter]'),
    chars: text.length
  };
}

function summarizeAuth(headers = {}, apiKeySource = '') {
  const entries = [
    ['Authorization', 'bearer'],
    ['x-api-key', 'anthropic_x_api_key'],
    ['x-goog-api-key', 'gemini_x_goog_api_key']
  ];
  for (const [header, scheme] of entries) {
    if (headers && Object.prototype.hasOwnProperty.call(headers, header) && headers[header]) {
      return {
        present: true,
        header,
        scheme,
        source: normalizeText(apiKeySource) || 'unknown',
        valueMasked: maskSecret(headers[header])
      };
    }
  }
  return {
    present: false,
    header: '',
    scheme: 'none',
    source: normalizeText(apiKeySource) || 'unknown',
    valueMasked: ''
  };
}

function collectAnomalies({
  requestedProvider,
  finalProvider,
  finalHeaders,
  prepared,
  builtProvider = '',
  builtProtocol = '',
  stage = ''
}) {
  const anomalies = [];
  const provider = normalizeApiProvider(finalProvider);
  const requested = normalizeApiProvider(requestedProvider);
  const headers = finalHeaders || {};
  const body = prepared?.requestBody || {};
  const cache = buildRequestCacheTrace(body, prepared?.requestHeaders || {});

  if (requested && provider !== requested) {
    anomalies.push(`requested_provider_not_reached:${requested}->${provider}`);
  }
  if (builtProvider && normalizeApiProvider(builtProvider) !== requested) {
    anomalies.push(`builder_provider_differs_from_requested:${normalizeApiProvider(builtProvider)}!=${requested}`);
  }
  if (builtProtocol && stage !== 'http_client_direct' && normalizeText(builtProtocol) === 'anthropic_messages' && requested === 'openai_compatible') {
    anomalies.push('main_builder_forced_anthropic_messages_for_openai_compatible_request');
  }

  if (isOpenAICompatibleProvider(provider) && !headers.Authorization) {
    anomalies.push('openai_compatible_missing_authorization');
  }
  if (!isOpenAICompatibleProvider(provider) && headers.Authorization) {
    anomalies.push('non_openai_provider_has_authorization_header');
  }
  if (isAnthropicProvider(provider) && !headers['x-api-key']) {
    anomalies.push('anthropic_missing_x_api_key');
  }
  if (isGeminiNativeProvider(provider) && !headers['x-goog-api-key']) {
    anomalies.push('gemini_native_missing_x_goog_api_key');
  }
  if (!isOpenAICompatibleProvider(provider) && headers['User-Agent'] && headers['User-Agent'] !== false) {
    anomalies.push('non_openai_provider_has_user_agent_value');
  }
  if (!isOpenAICompatibleProvider(provider) && (body.prompt_cache_key || body.prompt_cache_retention)) {
    anomalies.push('non_openai_provider_has_openai_prompt_cache_fields');
  }
  if (isGeminiNativeProvider(provider) && cache.anthropicCacheBreakpoints > 0) {
    anomalies.push('gemini_native_has_anthropic_cache_control');
  }
  if (isGeminiNativeProvider(provider)) {
    const geminiSystem = prepared?.requestBody?.systemInstruction;
    const systemText = (Array.isArray(geminiSystem?.parts) ? geminiSystem.parts : [])
      .map((part) => normalizeText(part?.text))
      .filter(Boolean)
      .join('\n');
    if (!systemText) anomalies.push('gemini_native_missing_system_instruction');
    else if (!systemText.includes('[GeminiRuntimeAdapter]')) anomalies.push('gemini_native_missing_runtime_adapter_prompt');
  }
  if (isOpenAICompatibleProvider(provider) && body.prompt_cache_key && cache.anthropicCacheBreakpoints > 0) {
    anomalies.push('openai_prompt_cache_and_cache_control_both_present');
  }
  if (!summarizeAuth(headers).present) {
    anomalies.push('no_auth_header_will_be_sent');
  }

  return anomalies;
}

async function buildHttpScenario(name, requestUrl, requestBody, scenarioConfig, extra = {}) {
  const prepared = await httpClient.prepareRequest(requestUrl, requestBody);
  const finalHeaders = httpClient.getAxiosOptions(
    prepared.provider,
    scenarioConfig.apiKey,
    10000,
    prepared.requestHeaders
  ).headers;
  const strippedFields = summarizeStrippedFields(requestBody, prepared.requestBody);
  const cache = buildRequestCacheTrace(prepared.requestBody, prepared.requestHeaders || {});
  const finalProvider = normalizeApiProvider(prepared.provider);
  return {
    name,
    stage: extra.stage || name,
    requestedProvider: scenarioConfig.requestedProvider,
    builtProvider: extra.builtProvider || '',
    builtProtocol: extra.builtProtocol || '',
    finalProvider,
    requestUrl: prepared.requestUrl,
    requestBodyKeys: prepared.requestBody && typeof prepared.requestBody === 'object'
      ? Object.keys(prepared.requestBody).sort()
      : [],
    headers: redactHeaders(finalHeaders),
    headerNames: Object.keys(finalHeaders || {}).sort(),
    auth: summarizeAuth(finalHeaders, scenarioConfig.apiKeySource),
    cache,
    geminiSystemInstruction: isGeminiNativeProvider(finalProvider)
      ? summarizeGeminiSystemInstruction(prepared.requestBody)
      : null,
    strippedFields,
    anomalies: collectAnomalies({
      requestedProvider: scenarioConfig.requestedProvider,
      finalProvider,
      finalHeaders,
      prepared,
      builtProvider: extra.builtProvider,
      builtProtocol: extra.builtProtocol,
      stage: extra.stage || name
    }),
    sources: {
      model: scenarioConfig.modelSource || '',
      apiBaseUrl: scenarioConfig.apiBaseUrlSource || '',
      apiKey: scenarioConfig.apiKeySource || ''
    }
  };
}

function buildMainScenarioConfig(baseConfig, role = 'main') {
  return {
    ...baseConfig,
    __mainModelUserRole: role === 'admin' ? 'admin' : 'user',
    __mainModelSource: baseConfig.modelSource,
    __mainApiBaseUrlSource: baseConfig.apiBaseUrlSource,
    __mainApiKeySource: baseConfig.apiKeySource
  };
}

async function buildMainReplyScenario(name, scenarioConfig, role = 'main') {
  const request = buildMainModelRequest(buildMainScenarioConfig(scenarioConfig, role), {
    messages: buildDiagnosticMessages(),
    tools: buildDiagnosticTools(),
    stream: false,
    defaultMaxTokens: 256,
    routeMeta: {
      topRouteType: role === 'admin' ? 'admin' : 'direct_chat'
    }
  });
  return buildHttpScenario(name, request.url, request.body, scenarioConfig, {
    builtProvider: request.provider,
    builtProtocol: request.protocol,
    stage: name
  });
}

async function buildVisionReplyScenario(scenarioConfig) {
  const imageConfig = buildImageModelConfig({
    model: scenarioConfig.model,
    imageModel: scenarioConfig.model,
    apiBaseUrl: scenarioConfig.apiBaseUrl,
    apiKey: scenarioConfig.apiKey,
    imageApiBaseUrl: scenarioConfig.imageApiBaseUrl,
    imageApiKey: scenarioConfig.imageApiKey
  }, '__provider_diag_user__');
  const request = buildMainModelRequest({
    ...buildMainScenarioConfig({
      ...scenarioConfig,
      model: imageConfig.model,
      apiBaseUrl: imageConfig.apiBaseUrl,
      apiKey: imageConfig.apiKey,
      apiBaseUrlSource: scenarioConfig.imageApiBaseUrlSource,
      apiKeySource: scenarioConfig.imageApiKeySource
    }, 'vision')
  }, {
    messages: buildDiagnosticMessages({ withImage: true }),
    tools: buildDiagnosticTools(),
    stream: false,
    defaultMaxTokens: 256,
    routeMeta: {
      topRouteType: 'direct_chat',
      modality: 'vision'
    }
  });
  return buildHttpScenario('vision_reply', request.url, request.body, {
    ...scenarioConfig,
    model: imageConfig.model,
    apiBaseUrl: imageConfig.apiBaseUrl,
    apiKey: imageConfig.apiKey,
    apiBaseUrlSource: scenarioConfig.imageApiBaseUrlSource,
    apiKeySource: scenarioConfig.imageApiKeySource
  }, {
    builtProvider: request.provider,
    builtProtocol: request.protocol,
    stage: 'vision_reply'
  });
}

function buildQzoneImageScenario(scenarioConfig) {
  const requestUrl = resolveBotDiaryQzoneImageRequestUrl(
    scenarioConfig.qzoneImageApiBaseUrl,
    scenarioConfig.model
  );
  const requestBody = buildBotDiaryQzoneImageRequestBody('provider request diagnostic');
  const finalProvider = normalizeApiProvider(getApiProvider(requestUrl, scenarioConfig.model, { preferUnifiedResponses: true }));
  const headers = buildBotDiaryQzoneImageHeaders(scenarioConfig.apiKey, requestUrl, scenarioConfig.model);
  const prepared = {
    provider: finalProvider,
    requestBody,
    requestHeaders: headers
  };
  return {
    name: 'qzone_image_generation',
    stage: 'qzone_image_generation',
    requestedProvider: scenarioConfig.requestedProvider,
    builtProvider: '',
    builtProtocol: 'imageGeneration.drawBotDiaryQzonePicture',
    finalProvider,
    requestUrl,
    requestBodyKeys: Object.keys(requestBody).sort(),
    headers: redactHeaders(headers),
    headerNames: Object.keys(headers || {}).sort(),
    auth: summarizeAuth(headers, scenarioConfig.apiKeySource),
    cache: buildRequestCacheTrace(requestBody, headers),
    strippedFields: summarizeStrippedFields(requestBody, requestBody),
    anomalies: collectAnomalies({
      requestedProvider: scenarioConfig.requestedProvider,
      finalProvider,
      finalHeaders: headers,
      prepared,
      builtProtocol: 'imageGeneration.drawBotDiaryQzonePicture',
      stage: 'qzone_image_generation'
    }),
    sources: {
      model: scenarioConfig.modelSource || '',
      apiBaseUrl: scenarioConfig.qzoneImageApiBaseUrlSource || '',
      apiKey: scenarioConfig.apiKeySource || ''
    }
  };
}

function normalizeScenarioList(value) {
  const items = Array.isArray(value)
    ? value
    : normalizeText(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) {
    return ['http_client_direct', 'main_reply', 'admin_reply', 'vision_reply', 'qzone_image_generation'];
  }
  return items;
}

function buildConfigBackedScenarioConfig(role = 'main') {
  if (role === 'admin') {
    const adminId = normalizeText((config.ADMIN_USER_IDS || [])[0] || '__provider_diag_admin__');
    const resolved = resolveRoleAwareMainModelConfig(adminId, null, {});
    return {
      requestedProvider: getApiProvider(resolved.apiBaseUrl, resolved.model, { preferUnifiedResponses: true }),
      model: resolved.model,
      modelSource: resolved.__mainModelSource || '',
      apiBaseUrl: resolved.apiBaseUrl,
      apiBaseUrlSource: resolved.__mainApiBaseUrlSource || '',
      apiKey: resolved.apiKey,
      apiKeySource: resolved.__mainApiKeySource || '',
      imageApiBaseUrl: resolved.apiBaseUrl,
      imageApiBaseUrlSource: resolved.__mainApiBaseUrlSource || '',
      imageApiKey: resolved.apiKey,
      imageApiKeySource: resolved.__mainApiKeySource || '',
      qzoneImageApiBaseUrl: normalizeText(config.BOT_DIARY_QZONE_IMAGE_PROVIDER_API_BASE_URL),
      qzoneImageApiBaseUrlSource: 'BOT_DIARY_QZONE_IMAGE_PROVIDER_API_BASE_URL'
    };
  }
  return buildRequestedProviderConfig({});
}

async function runProviderRequestDiagnostics(options = {}) {
  const requestedConfig = buildRequestedProviderConfig(options);
  const scenarioNames = normalizeScenarioList(options.scenarios || options.scenario);
  const scenarios = [];

  for (const name of scenarioNames) {
    if (name === 'http_client_direct') {
      scenarios.push(await buildHttpScenario(
        name,
        requestedConfig.apiBaseUrl,
        buildHttpDiagnosticBody(requestedConfig, { name }),
        requestedConfig,
        { stage: name }
      ));
    } else if (name === 'main_reply') {
      const scenarioConfig = options.provider ? requestedConfig : buildConfigBackedScenarioConfig('main');
      scenarios.push(await buildMainReplyScenario(name, scenarioConfig, 'main'));
    } else if (name === 'admin_reply') {
      const scenarioConfig = options.provider ? requestedConfig : buildConfigBackedScenarioConfig('admin');
      scenarios.push(await buildMainReplyScenario(name, scenarioConfig, 'admin'));
    } else if (name === 'vision_reply') {
      scenarios.push(await buildVisionReplyScenario(requestedConfig));
    } else if (name === 'qzone_image_generation') {
      scenarios.push(buildQzoneImageScenario(requestedConfig));
    }
  }

  return {
    schemaVersion: 'provider_request_diagnostic_v1',
    generatedAt: new Date().toISOString(),
    requested: {
      provider: requestedConfig.requestedProvider,
      model: requestedConfig.model,
      modelSource: requestedConfig.modelSource,
      apiBaseUrl: requestedConfig.apiBaseUrl,
      apiBaseUrlSource: requestedConfig.apiBaseUrlSource,
      apiKeyConfigured: Boolean(normalizeText(requestedConfig.apiKey)),
      apiKeySource: requestedConfig.apiKeySource
    },
    scenarios,
    anomalies: scenarios.flatMap((scenario) => (
      Array.isArray(scenario.anomalies)
        ? scenario.anomalies.map((signal) => `${scenario.name}:${signal}`)
        : []
    ))
  };
}

function parseProviderDiagnosticArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const out = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (!item) continue;
    if (item.startsWith('--')) {
      const eq = item.indexOf('=');
      const key = item.slice(2, eq >= 0 ? eq : undefined);
      const nextValue = eq >= 0 ? item.slice(eq + 1) : args[i + 1];
      if (eq < 0 && nextValue && !String(nextValue).startsWith('--')) i += 1;
      const value = eq >= 0 ? nextValue : (nextValue && !String(nextValue).startsWith('--') ? nextValue : 'true');
      if (key === 'provider') out.provider = value;
      else if (key === 'api-base-url') out.apiBaseUrl = value;
      else if (key === 'api-key') out.apiKey = value;
      else if (key === 'model') out.model = value;
      else if (key === 'scenario' || key === 'scenarios') out.scenarios = value;
      else if (key === 'image-api-base-url') out.imageApiBaseUrl = value;
      else if (key === 'qzone-image-api-base-url') out.qzoneImageApiBaseUrl = value;
      continue;
    }
    positionals.push(item);
  }
  if (!out.provider && positionals[0]) out.provider = positionals[0];
  return out;
}

module.exports = {
  buildRequestedProviderConfig,
  maskSecret,
  parseProviderDiagnosticArgs,
  runProviderRequestDiagnostics,
  summarizeStrippedFields
};
