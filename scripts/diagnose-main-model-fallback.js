const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { listRecentModelCalls } = require('../utils/modelCallTracker');
const {
  getMainModelFallbackStatus,
  resolveMainModelConfig,
  resolveForcedFallbackMainModelConfig
} = require('../utils/mainModelFallback');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2));
  return {
    probeMain: flags.has('--probe-main') || flags.has('--probe-both'),
    probeFallback: flags.has('--probe-fallback') || flags.has('--probe-both'),
    json: flags.has('--json')
  };
}

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return String(content || '');
}

function buildProbeRequestSummary(name, modelConfig) {
  return {
    name,
    model: String(modelConfig?.model || '').trim(),
    apiBaseUrl: String(modelConfig?.apiBaseUrl || '').trim(),
    apiKeyMasked: maskSecret(modelConfig?.apiKey || ''),
    activeFlag: Boolean(modelConfig?.__mainFallbackActive)
  };
}

async function probeModel(name, modelConfig) {
  const url = ensureChatCompletionsUrl(modelConfig.apiBaseUrl);
  const startedAt = Date.now();

  try {
    const resp = await postWithRetry(
      url,
      {
        model: modelConfig.model,
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'system', content: '请只输出一句极短确认语，不要解释。' },
          { role: 'user', content: '请只回复“诊断成功”。' }
        ],
        max_tokens: 64,
        stream: false,
        __trace: {
          source: 'diagnose_script',
          phase: 'probe',
          purpose: `probe_${name}`,
          routeType: 'diagnose'
        }
      },
      0,
      modelConfig.apiKey
    );

    const msg = extractMessageContent(resp);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      model: String(resp?.data?.model || modelConfig.model || ''),
      replyPreview: normalizeTextContent(msg?.content).slice(0, 120),
      status: Number(resp?.status || 200)
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      status: Number(error?.response?.status || 0),
      code: String(error?.code || ''),
      error: String(
        error?.response?.data?.error?.message
        || error?.response?.data?.error
        || error?.response?.data?.message
        || error?.message
        || error
      ).slice(0, 240)
    };
  }
}

function summarizeRecentCalls() {
  return listRecentModelCalls(10).map((call) => ({
    started_at: call.started_at,
    status: call.status,
    model: call.model,
    provider: call.provider,
    source: call.source,
    phase: call.phase,
    purpose: call.purpose,
    duration_ms: call.duration_ms,
    error: call.error
  }));
}

function buildAdvice(status, probes = {}) {
  const advice = [];

  if (!status.enabled) advice.push('未开启 AI_FALLBACK_ENABLED，主模型失败不会自动切备用。');
  if (!status.configured) advice.push('备用模型未完整配置，当前降级机制不可用。');
  if (status.enabled && status.configured && !status.active) advice.push('当前未处于备用模型状态，说明最近失败次数还没达到阈值或已经被成功请求清零。');
  if (status.active && status.permanent) advice.push('当前已进入永久备用模式，除非手动调整配置或重置状态，否则不会自动回主模型。');
  if (status.active && !status.permanent) advice.push('当前处于临时备用模式，冷却结束后会自动回主模型。');
  if (probes.main && !probes.main.ok) advice.push('主模型探测失败，建议检查主模型渠道、WAF、模型名或供应商可用性。');
  if (probes.fallback && !probes.fallback.ok) advice.push('备用模型探测失败，当前降级链路不可靠，应优先修复备用模型配置。');
  if (probes.main && probes.main.ok && probes.fallback && probes.fallback.ok) advice.push('主模型和备用模型探测都成功，当前更应关注失败计数触发条件和业务链路中的实际报错点。');

  return advice;
}

async function main() {
  const args = parseArgs(process.argv);
  const primaryConfig = {
    model: String(config.AI_MODEL || '').trim(),
    apiBaseUrl: String(config.API_BASE_URL || '').trim(),
    apiKey: String(config.API_KEY || '').trim(),
    __mainFallbackActive: false
  };
  const effectiveConfig = resolveMainModelConfig(primaryConfig);
  const fallbackConfig = resolveForcedFallbackMainModelConfig(primaryConfig);
  const fallbackStatus = getMainModelFallbackStatus();

  const result = {
    now: new Date().toISOString(),
    config: {
      primary: buildProbeRequestSummary('primary', primaryConfig),
      effective: buildProbeRequestSummary('effective', effectiveConfig),
      fallback: buildProbeRequestSummary('fallback', fallbackConfig),
      failureThreshold: fallbackStatus.failureThreshold,
      cooldownMs: fallbackStatus.cooldownMs
    },
    fallbackStatus,
    recentCalls: summarizeRecentCalls(),
    probes: {}
  };

  if (args.probeMain) {
    result.probes.main = await probeModel('main', primaryConfig);
  }
  if (args.probeFallback) {
    result.probes.fallback = await probeModel('fallback', fallbackConfig);
  }

  result.advice = buildAdvice(fallbackStatus, result.probes);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('=== Main Model Fallback Diagnose ===');
  console.log('[config]');
  console.log(JSON.stringify(result.config, null, 2));
  console.log('[fallbackStatus]');
  console.log(JSON.stringify(result.fallbackStatus, null, 2));
  console.log('[recentCalls]');
  console.log(JSON.stringify(result.recentCalls, null, 2));
  if (args.probeMain || args.probeFallback) {
    console.log('[probes]');
    console.log(JSON.stringify(result.probes, null, 2));
  }
  console.log('[advice]');
  for (const line of result.advice) {
    console.log(`- ${line}`);
  }
}

main().catch((error) => {
  console.error('[FAIL]', error?.stack || error?.message || error);
  process.exit(1);
});
