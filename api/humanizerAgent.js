const config = require('../config');
const { postWithRetry, postStreamWithRetry } = require('./httpClient');
const { extractMessageContent, extractSSEEvents, flushSSEState } = require('./parser');
const { humanizeReply } = require('../utils/humanizer');
const {
  extractUserFacingDelta,
  hasVisibleUserFacingText,
  sanitizeUserFacingText
} = require('../utils/userFacingText');

const HUMANIZER_AGENT_SYSTEM_PROMPT = [
  '你是“风格保护型 Humanizer 子 Agent”。',
  '任务：去掉明显 AI 腔/模板腔，但必须保留原文说话风格。',
  '硬性约束：',
  '1. 不改变事实、结论、称呼、角色设定与核心语气方向。',
  '2. 必须保留原文的说话风格：语气词、节奏、口头习惯、角色味道。',
  '3. 只去除明显 AI 套话、客服腔、总结腔；不要把原文改成统一模板口吻。',
  '4. 不新增事实，不删减关键信息。',
  '5. 如果原文已经自然，只做最小改动。',
  '6. 默认保持原文篇幅，除非有明显重复；通常不应压缩超过 20%。',
  '7. 只输出最终回复正文，不要解释。'
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
    `1) decide chunk boundaries yourself, send at most ${maxSegments} chunks total.`,
    '2) separate chunks with ONE blank line (\\n\\n).',
    '3) no numbering and no labels like "part 1".'
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
      return '';
    }).join('');
  }
  return String(content || '');
}

function sanitizeAgentOutput(text) {
  return sanitizeUserFacingText(text).trim();
}

function fallbackHumanize(text) {
  return humanizeReply(text) || sanitizeAgentOutput(text);
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
        '请在保留原文说话风格的前提下，润色下面这段回复：',
        original
      ].filter(Boolean).join('\n\n')
    }
  ].filter(Boolean);
}

async function requestHumanizerStreaming(apiBaseUrl, payload, options = {}, retries = 0, apiKey = '') {
  const parserState = { buffer: '' };
  let collected = '';

  try {
    await postStreamWithRetry(
      apiBaseUrl,
      { ...payload, stream: true },
      {
        onData(chunk) {
          const parsed = extractSSEEvents(parserState, chunk);
          parserState.buffer = parsed.state.buffer;

          for (const event of parsed.events) {
            if (!event || event.done || !event.delta) continue;
            const previousVisible = sanitizeAgentOutput(collected);
            collected += event.delta;
            const visibleCollected = sanitizeAgentOutput(collected);
            const visibleDelta = extractUserFacingDelta(previousVisible, visibleCollected);
            if (visibleCollected !== previousVisible) {
              options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visibleCollected));
              options.onDelta(visibleDelta, visibleCollected);
            }
          }
        }
      },
      retries,
      apiKey
    );
  } catch (error) {
    if (sanitizeAgentOutput(collected)) {
      error.partialText = sanitizeAgentOutput(collected);
      error.streamHadOutput = true;
    }
    throw error;
  }

  const tailEvents = flushSSEState(parserState);
  for (const event of tailEvents) {
    if (!event || event.done || !event.delta) continue;
    const previousVisible = sanitizeAgentOutput(collected);
    collected += event.delta;
    const visibleCollected = sanitizeAgentOutput(collected);
    const visibleDelta = extractUserFacingDelta(previousVisible, visibleCollected);
    if (visibleCollected !== previousVisible) {
      options.streamHadOutput = Boolean(options.streamHadOutput || hasVisibleUserFacingText(visibleCollected));
      options.onDelta(visibleDelta, visibleCollected);
    }
  }

  return sanitizeAgentOutput(collected);
}

async function runHumanizerAgent(text, options = {}) {
  const original = sanitizeAgentOutput(normalizeTextContent(text));
  if (!original) return '';

  // 子 Agent 关闭时，退回本地规则清洗器。
  if (!isHumanizerAgentEnabled()) return fallbackHumanize(original);

  const model = String(config.HUMANIZER_AGENT_MODEL || options.model || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  const apiBaseUrl = ensureChatCompletionsUrl(options.apiBaseUrl || config.API_BASE_URL);
  const apiKey = String(options.apiKey || config.API_KEY || '').trim();
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

  try {
    if (shouldUseHumanizerStreaming(options)) {
      const rewritten = await requestHumanizerStreaming(apiBaseUrl, requestBody, options, retries, apiKey);
      if (!rewritten) return fallbackHumanize(original);
      if (isLikelyOverCompressed(original, rewritten)) return fallbackHumanize(original);
      return rewritten;
    }

    const resp = await postWithRetry(apiBaseUrl, { ...requestBody, stream: false }, retries, apiKey);

    const msg = extractMessageContent(resp);
    const rewritten = sanitizeAgentOutput(normalizeTextContent(msg?.content));
    if (!rewritten) return fallbackHumanize(original);

    // 防止子 Agent 过度压缩导致“回复字数异常偏少”。
    if (isLikelyOverCompressed(original, rewritten)) return fallbackHumanize(original);

    return rewritten;
  } catch (e) {
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
  isHumanizerAgentEnabled,
  runHumanizerAgent
};
