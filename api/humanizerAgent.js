const config = require('../config');
const { postWithRetry, postStreamWithRetry } = require('./httpClient');
const { extractMessageContent, extractSSEEvents, flushSSEState } = require('./parser');
const { humanizeReply } = require('../utils/humanizer');
const {
  extractUserFacingDelta,
  hasVisibleUserFacingText,
  sanitizeUserFacingText
} = require('../utils/userFacingText');
const {
  buildModelRouteDiagnostics,
  createModelRouteTracePatch
} = require('../utils/modelRouteDiagnostics');

const HUMANIZER_AGENT_SYSTEM_PROMPT = [
  '你是“风格保护型 Humanizer 子 Agent”。',
  '任务：只做人味化修饰、去掉明显 AI 腔/模板腔，并根据当前语境决定更自然的流式分段。',
  '硬性约束：',
  '1. 不改变事实、结论、称呼、角色设定与核心语气方向。',
  '2. 必须保留原文的说话风格：语气词、节奏、口头习惯、角色味道。',
  '3. 只去除明显 AI 套话、客服腔、总结腔；不要把原文改成统一模板口吻。',
  '4. 禁止扩写：不新增理由、例子、背景、建议、设定、情绪解释或总结句。',
  '5. 不新增事实，不删减关键信息，不把含糊处改成确定结论。',
  '6. 如果原文已经自然，只做标点、停顿、少量词序和语气的最小调整。',
  '7. 默认保持原文篇幅；通常不应比原文更长，绝对不要超过原文约 15%。',
  '8. 如果需要流式分段，只在语义完整的位置插入一个空行作为段落边界。',
  '9. 只输出最终回复正文，不要解释，不要编号，不要写“第一段/第二段”。'
].join('\n');

function getHumanizerStreamMaxSegments(options = {}) {
  const raw = Number(options.maxSegments || config.AI_STREAM_MAX_SEGMENTS);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(6, Math.floor(raw)));
}

function buildHumanizerStreamingPrompt(options = {}) {
  const maxSegments = getHumanizerStreamMaxSegments(options);
  return [
    'Streaming output rule:',
    `1) decide semantic chunk boundaries yourself, output at most ${maxSegments} chunks total.`,
    '2) separate chunks with exactly ONE blank line (\\n\\n); that blank line is the stream boundary.',
    '3) every chunk must be independently readable; never split a sentence, quote, code block, markdown structure, or emotional beat in the middle.',
    '4) no numbering and no labels like "part 1".'
  ].join('\n');
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
      if (typeof part?.content === 'string') return part.content;
      if (typeof part?.output_text === 'string') return part.output_text;
      if (Array.isArray(part?.content)) return normalizeTextContent(part.content);
      if (part?.content && typeof part.content === 'object') return normalizeTextContent(part.content);
      return '';
    }).join('');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (typeof content.output_text === 'string') return content.output_text;
    if (typeof content.outputText === 'string') return content.outputText;
    if (Array.isArray(content.content)) return normalizeTextContent(content.content);
    if (Array.isArray(content.output)) return normalizeTextContent(content.output);
    if (content.message && typeof content.message === 'object') return normalizeTextContent(content.message);
    if (content.response && typeof content.response === 'object') return normalizeTextContent(content.response);
    if (content.result && typeof content.result === 'object') return normalizeTextContent(content.result);
    return '';
  }
  return String(content || '');
}

function sanitizeAgentOutput(text) {
  return sanitizeUserFacingText(text).trim();
}

function sanitizeAgentStreamText(text) {
  return sanitizeUserFacingText(text).replace(/^\s+/, '');
}

function fallbackHumanize(text) {
  return humanizeReply(text) || sanitizeAgentOutput(text);
}

function getHumanizerFirstTokenTimeoutMs(options = {}) {
  const raw = Number(
    options.firstTokenTimeoutMs !== undefined
      ? options.firstTokenTimeoutMs
      : config.HUMANIZER_AGENT_FIRST_TOKEN_TIMEOUT_MS
  );
  if (!Number.isFinite(raw)) return 10000;
  return Math.max(0, Math.floor(raw));
}

function isHumanizerFirstTokenTimeoutError(error) {
  return Boolean(
    error?.humanizerFirstTokenTimeout
    || String(error?.code || '').trim() === 'HUMANIZER_FIRST_TOKEN_TIMEOUT'
    || String(error?.reason || '').trim() === 'humanizer_first_token_timeout'
  );
}

function shouldUseHumanizerStreaming(options = {}) {
  return Boolean(options.stream && typeof options.onDelta === 'function' && !options.disableStream);
}

function getRewriteMaxTokens(text) {
  const length = String(text || '').length;
  const estimate = Math.max(256, Math.ceil(length * 2.2));
  return Math.min(1200, estimate);
}

function isHumanizerAgentEnabled() {
  return Boolean(config.HUMANIZER_AGENT_ENABLED || config.LLM_HUMANIZER_ENABLED);
}

function resolveHumanizerModelConfig(options = {}) {
  const dedicatedModel = String(config.HUMANIZER_AGENT_MODEL || '').trim();
  const dedicatedApiBaseUrl = String(config.HUMANIZER_AGENT_API_BASE_URL || '').trim();
  const dedicatedApiKey = String(config.HUMANIZER_AGENT_API_KEY || '').trim();
  const optionModel = String(options.model || '').trim();
  const optionApiBaseUrl = String(options.apiBaseUrl || '').trim();
  const optionApiKey = String(options.apiKey || '').trim();
  const mainModel = String(config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  const mainApiBaseUrl = String(config.API_BASE_URL || '').trim();
  const mainApiKey = String(config.API_KEY || '').trim();

  const model = dedicatedModel || optionModel || mainModel;
  const apiBaseUrl = ensureChatCompletionsUrl(dedicatedApiBaseUrl || optionApiBaseUrl || mainApiBaseUrl);
  const apiKey = dedicatedApiKey || optionApiKey || mainApiKey;

  return {
    model,
    apiBaseUrl,
    apiKey,
    modelSource: dedicatedModel ? 'HUMANIZER_AGENT_MODEL' : (optionModel ? 'caller_model_compat' : 'AI_MODEL_FALLBACK'),
    apiBaseUrlSource: dedicatedApiBaseUrl ? 'HUMANIZER_AGENT_API_BASE_URL' : (optionApiBaseUrl ? 'caller_apiBaseUrl_compat' : 'API_BASE_URL_FALLBACK'),
    apiKeySource: dedicatedApiKey ? 'HUMANIZER_AGENT_API_KEY' : (optionApiKey ? 'caller_apiKey_compat' : 'API_KEY_FALLBACK'),
    usedDedicatedConfig: Boolean(dedicatedModel || dedicatedApiBaseUrl || dedicatedApiKey)
  };
}

function countSentenceLikeUnits(text) {
  const t = String(text || '');
  const punct = (t.match(/[。！？!?]/g) || []).length;
  const lines = t.split(/\n+/).filter(Boolean).length;
  return Math.max(punct, lines);
}

function isLikelyOverCompressed(original, rewritten) {
  const source = sanitizeAgentOutput(original);
  const target = sanitizeAgentOutput(rewritten);
  if (!source || !target) return false;

  // 短文本不做强约束，避免误杀自然短句。
  if (source.length < 40) return false;

  const ratio = target.length / source.length;
  if (ratio < 0.58) return true;

  const sourceUnits = countSentenceLikeUnits(source);
  const targetUnits = countSentenceLikeUnits(target);
  if (sourceUnits >= 3 && targetUnits <= 1 && target.length < 80) return true;

  return false;
}

function isLikelyOverExpanded(original, rewritten) {
  const source = sanitizeAgentOutput(original);
  const target = sanitizeAgentOutput(rewritten);
  if (!source || !target) return false;

  const ratio = target.length / Math.max(1, source.length);
  if (source.length < 20) return ratio > 1.8 && target.length - source.length > 18;
  if (source.length < 80) return ratio > 1.45 && target.length - source.length > 24;
  return ratio > 1.18 && target.length - source.length > 40;
}

function buildHumanizerMessages(original, options = {}) {
  const question = String(options.question || '').trim();
  const dynamicPrompt = String(options.dynamicPrompt || '').trim();
  const useStreaming = shouldUseHumanizerStreaming(options);

  return [
    { role: 'system', content: HUMANIZER_AGENT_SYSTEM_PROMPT },
    dynamicPrompt ? { role: 'system', content: `角色设定摘要：\n${dynamicPrompt.slice(0, 1200)}` } : null,
    useStreaming ? { role: 'system', content: buildHumanizerStreamingPrompt(options) } : null,
    {
      role: 'user',
      content: [
        question ? `用户原问题：${question}` : '',
        '请在保留原文说话风格的前提下，轻微润色下面这段回复。',
        '只做拟人化修饰、去 AI 味和必要的语义分段；不要扩写，不要新增信息：',
        original
      ].filter(Boolean).join('\n\n')
    }
  ].filter(Boolean);
}

async function requestHumanizerStreaming(apiBaseUrl, payload, options = {}, retries = 0, apiKey = '', original = '') {
  const parserState = { buffer: '' };
  let collected = '';
  let emitted = '';
  let pendingVisible = '';
  let firstVisibleTokenSeen = false;
  let settled = false;
  let timeout = null;
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  const firstTokenTimeoutMs = getHumanizerFirstTokenTimeoutMs(options);

  const createFirstTokenTimeoutError = () => {
    const error = new Error(`Humanizer first visible token timeout after ${firstTokenTimeoutMs}ms`);
    error.code = 'HUMANIZER_FIRST_TOKEN_TIMEOUT';
    error.reason = 'humanizer_first_token_timeout';
    error.humanizerFirstTokenTimeout = true;
    error.partialText = sanitizeAgentOutput(collected);
    error.streamHadOutput = false;
    return error;
  };

  const clearFirstTokenTimeout = () => {
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = null;
  };

  const emitVisibleText = (nextVisible) => {
    const visible = sanitizeAgentOutput(nextVisible);
    if (!visible || visible === emitted) return;
    const visibleDelta = extractUserFacingDelta(emitted, visible);
    if (!visibleDelta) return;
    emitted = visible;
    options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visible));
    options.onDelta(visibleDelta, visible);
  };

  const flushCompletedSegments = () => {
    const normalized = String(pendingVisible || '').replace(/\r\n/g, '\n');
    const parts = normalized.split(/\n{2,}/);
    if (parts.length < 2) {
      pendingVisible = normalized;
      return;
    }

    const completedSegments = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean);
    const rest = parts[parts.length - 1] || '';
    for (const segment of completedSegments) {
      const nextVisible = emitted ? `${emitted}\n\n${segment}` : segment;
      emitVisibleText(nextVisible);
    }
    pendingVisible = rest;
  };

  let rejectFirstTokenTimeout = null;
  const firstTokenTimeoutPromise = firstTokenTimeoutMs > 0
    ? new Promise((_, reject) => {
        rejectFirstTokenTimeout = reject;
      })
    : null;

  if (firstTokenTimeoutMs > 0) {
    timeout = setTimeout(() => {
      if (settled || firstVisibleTokenSeen) return;
      if (abortController) {
        try { abortController.abort(); } catch (_) {}
      }
      if (typeof rejectFirstTokenTimeout === 'function') {
        rejectFirstTokenTimeout(createFirstTokenTimeoutError());
      }
    }, firstTokenTimeoutMs);
  }

  try {
    const streamRequest = typeof options.postStreamWithRetryImpl === 'function'
      ? options.postStreamWithRetryImpl
      : postStreamWithRetry;
    const streamPromise = streamRequest(
      apiBaseUrl,
      {
        ...payload,
        stream: true,
        ...(abortController ? { __abortSignal: abortController.signal } : {})
      },
      {
        onData(chunk) {
          if (abortController?.signal?.aborted && !firstVisibleTokenSeen) return;
          const parsed = extractSSEEvents(parserState, chunk);
          parserState.buffer = parsed.state.buffer;

          for (const event of parsed.events) {
            if (!event || event.done || !event.delta) continue;
            collected += event.delta;
            const visibleCollected = sanitizeAgentStreamText(collected);
            if (!firstVisibleTokenSeen && hasVisibleUserFacingText(visibleCollected)) {
              firstVisibleTokenSeen = true;
              clearFirstTokenTimeout();
            }
            pendingVisible = sanitizeAgentStreamText(visibleCollected.slice(emitted.length));
            flushCompletedSegments();
          }
        }
      },
      retries,
      apiKey
    );
    if (firstTokenTimeoutPromise && !firstVisibleTokenSeen) {
      await Promise.race([streamPromise, firstTokenTimeoutPromise]);
    } else {
      await streamPromise;
    }
  } catch (error) {
    settled = true;
    clearFirstTokenTimeout();
    if (isHumanizerFirstTokenTimeoutError(error)) {
      throw error;
    }
    if (abortController?.signal?.aborted && !firstVisibleTokenSeen) {
      throw createFirstTokenTimeoutError();
    }
    if (sanitizeAgentOutput(collected)) {
      error.partialText = sanitizeAgentOutput(collected);
      error.streamHadOutput = true;
    }
    throw error;
  }

  const tailEvents = flushSSEState(parserState);
  for (const event of tailEvents) {
    if (!event || event.done || !event.delta) continue;
    collected += event.delta;
  }

  settled = true;
  clearFirstTokenTimeout();
  const finalVisible = sanitizeAgentOutput(collected);
  if (isLikelyOverExpanded(original, finalVisible)) {
    return fallbackHumanize(original);
  }
  if (finalVisible) emitVisibleText(finalVisible);
  return finalVisible;
}

async function runHumanizerAgent(text, options = {}) {
  const original = sanitizeAgentOutput(normalizeTextContent(text));
  if (!original) return '';

  // 子 Agent 关闭时，退回本地规则清洗器。
  if (!isHumanizerAgentEnabled()) return fallbackHumanize(original);

  const resolvedHumanizerConfig = resolveHumanizerModelConfig(options);
  const { model, apiBaseUrl, apiKey } = resolvedHumanizerConfig;
  const retries = Math.max(0, Number.isFinite(Number(options.retries))
    ? Number(options.retries)
    : (Number(config.AI_RETRIES) || 0));
  const messages = buildHumanizerMessages(original, options);
  const requestBody = {
    model,
    temperature: 0.35,
    messages,
    max_tokens: getRewriteMaxTokens(original)
  };
  const trace = createModelRouteTracePatch(buildModelRouteDiagnostics({
    routeMeta: options.routeMeta,
    routePolicyKey: options.routePolicyKey,
    routeDebugKey: options.routeDebugKey,
    topRouteType: options.topRouteType,
    branch: options.dispatchBranch || 'humanizer',
    triggerBranch: options.triggerBranch || 'humanizer.rewrite',
    apiBaseUrl,
    model,
    modelSource: resolvedHumanizerConfig.modelSource,
    apiBaseUrlSource: resolvedHumanizerConfig.apiBaseUrlSource,
    apiKeySource: resolvedHumanizerConfig.apiKeySource
  }));
  if (options.requestTrace) {
    requestBody.__trace = {
      ...trace,
      requestId: String(options.requestTrace?.requestId || options.requestTrace?.request_id || '').trim(),
      phaseSeq: Number(options.requestTrace?.phaseSeq || options.requestTrace?.phase_seq || 0) || undefined,
      source: 'humanizer_agent',
      phase: 'humanizer',
      purpose: 'rewrite_reply',
      userId: String(options.userId || options.routeMeta?.userId || options.routeMeta?.user_id || '').trim()
    };
  }

  try {
    if (shouldUseHumanizerStreaming(options)) {
      const rewritten = await requestHumanizerStreaming(apiBaseUrl, requestBody, options, retries, apiKey, original);
      if (!rewritten) return fallbackHumanize(original);
      if (isLikelyOverCompressed(original, rewritten)) return fallbackHumanize(original);
      if (isLikelyOverExpanded(original, rewritten)) return fallbackHumanize(original);
      return rewritten;
    }

    const postRequest = typeof options.postWithRetryImpl === 'function'
      ? options.postWithRetryImpl
      : postWithRetry;
    const resp = await postRequest(apiBaseUrl, { ...requestBody, stream: false }, retries, apiKey);

    const msg = extractMessageContent(resp);
    const rewritten = sanitizeAgentOutput(normalizeTextContent(msg?.content));
    if (!rewritten) return fallbackHumanize(original);

    // 防止子 Agent 过度压缩导致“回复字数异常偏少”。
    if (isLikelyOverCompressed(original, rewritten)) return fallbackHumanize(original);
    // 防止子 Agent 自行扩写，改变原意或引入额外表达。
    if (isLikelyOverExpanded(original, rewritten)) return fallbackHumanize(original);

    return rewritten;
  } catch (e) {
    if (e?.humanizerFirstTokenTimeout) {
      throw e;
    }

    if (shouldUseHumanizerStreaming(options) && sanitizeAgentOutput(e.partialText)) {
      return sanitizeAgentOutput(e.partialText);
    }

    // 子 Agent 失败时降级本地清洗，保证可用性。
    console.error('[humanizer-agent] rewrite failed:', e.message || e);
    return fallbackHumanize(original);
  }
}

module.exports = {
  HUMANIZER_AGENT_SYSTEM_PROMPT,
  getHumanizerFirstTokenTimeoutMs,
  isHumanizerAgentEnabled,
  resolveHumanizerModelConfig,
  runHumanizerAgent
};
