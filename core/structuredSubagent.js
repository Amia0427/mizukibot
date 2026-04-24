const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../api/parser');

function ensureChatCompletionsUrl(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function normalizeContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String(part?.text || '')))
      .join('');
  }
  return String(content || '');
}

function resolveModelConfig(modelResolver = null) {
  const resolved = typeof modelResolver === 'function'
    ? modelResolver()
    : modelResolver;
  return resolved && typeof resolved === 'object' ? resolved : {};
}

function isTimeoutError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}

async function runStructuredSubagent({
  agentName = 'structured-subagent',
  systemPrompt = '',
  userPayload = {},
  userMessageContent = null,
  modelResolver = null,
  validateOutput = null
} = {}) {
  const modelConfig = resolveModelConfig(modelResolver);
  const baseUrl = String(modelConfig.baseUrl || '').trim();
  const apiKey = String(modelConfig.apiKey || '').trim();
  const model = String(modelConfig.model || '').trim();
  const maxTokens = Number.isFinite(Number(modelConfig.maxTokens))
    ? Math.max(64, Math.floor(Number(modelConfig.maxTokens)))
    : 700;
  const temperature = Number.isFinite(Number(modelConfig.temperature))
    ? Number(modelConfig.temperature)
    : 0.1;
  const retries = Number.isFinite(Number(modelConfig.retries))
    ? Math.max(0, Math.floor(Number(modelConfig.retries)))
    : 0;
  const timeoutMs = Number.isFinite(Number(modelConfig.timeoutMs))
    ? Math.max(1000, Math.floor(Number(modelConfig.timeoutMs)))
    : undefined;

  if (!baseUrl || !apiKey || !model) {
    return {
      ok: false,
      output: null,
      rawText: '',
      failureReason: 'fallback'
    };
  }

  try {
    const startedAt = Date.now();
    const response = await postWithRetry(
      ensureChatCompletionsUrl(baseUrl),
      {
        model,
        temperature,
        messages: [
          { role: 'system', content: String(systemPrompt || '').trim() },
          {
            role: 'user',
            content: Array.isArray(userMessageContent) && userMessageContent.length > 0
              ? userMessageContent
              : JSON.stringify(userPayload || {})
          }
        ],
        max_tokens: maxTokens,
        stream: false,
        ...(timeoutMs ? { __timeoutMs: timeoutMs } : {}),
        __trace: {
          feature: 'structured_subagent',
          agentName: String(agentName || 'structured-subagent').trim() || 'structured-subagent'
        }
      },
      retries,
      apiKey
    );

    const message = extractMessageContent(response);
    const rawText = normalizeContentText(message?.content).trim();
    const parsed = extractJsonSafely(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        output: null,
        rawText,
        failureReason: 'parse'
      };
    }

    if (typeof validateOutput === 'function') {
      const validation = validateOutput(parsed);
      if (validation !== true) {
        return {
          ok: false,
          output: null,
          rawText,
          failureReason: 'policy-violation'
        };
      }
    }

    return {
      ok: true,
      output: parsed,
      rawText,
      durationMs: Math.max(0, Date.now() - startedAt),
      failureReason: ''
    };
  } catch (error) {
    const failureReason = isTimeoutError(error) ? 'timeout' : 'fallback';
    console.error('[structured-subagent] failed', {
      agentName: String(agentName || 'structured-subagent').trim() || 'structured-subagent',
      failureReason,
      timeoutMs: timeoutMs || null,
      retries,
      error: String(error?.message || error || '').slice(0, 300)
    });
    return {
      ok: false,
      output: null,
      rawText: '',
      failureReason
    };
  }
}

module.exports = {
  runStructuredSubagent
};
