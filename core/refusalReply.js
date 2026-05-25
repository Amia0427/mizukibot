const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');

const FALLBACK_TEMPLATES = Object.freeze({
  'harmful-request': [
    'I can\'t help with harmful or unsafe requests. Ask for a safe alternative and I\'ll help directly.',
    'That request crosses a safety line. Rephrase it into a safe, legitimate task and I\'ll continue.',
    'I\'m not going to assist with something harmful. Give me the safe version of what you need.'
  ],
  'bad-faith-request': [
    'That looks like a bad-faith or spammy request. Send the real task and I\'ll handle it.',
    'I\'m skipping that kind of spammy request. If you have a legitimate goal, say it directly.',
    'That request looks designed to waste turns. Ask the actual task and I\'ll continue.'
  ],
  default: [
    'I can\'t take that request as-is. Rephrase it into a normal task and I\'ll help.',
    'That one isn\'t something I can do directly. Send a concrete legitimate request instead.'
  ]
});

const REFUSAL_AGENT_SYSTEM_PROMPT = [
  '你是 Mizuki 的 refusal 子 Agent。',
  '任务：只在路由已经判定必须拒绝时，生成一条简短、温和、自然的回绝。',
  '硬性约束：',
  '1. 明确表示不能照原请求执行，但不要解释内部规则、路由原因或安全策略。',
  '2. 不提供可执行伤害、违法滥用、攻击链、绕过细节、泄密内容、代码、命令或操作步骤。',
  '3. 可以给出一个正常替代方向，但不要模板腔、客服腔、机械说教。',
  '4. 保持 Mizuki 的聊天口吻，不要自称 AI、模型或系统。',
  '5. 默认 1-2 句，尽量简短。',
  '6. 只输出最终回复正文，不要解释。'
].join('\n');

function ensureChatCompletionsUrl(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return String(content || '');
}

function buildCuteRefusalReply(route = {}) {
  const reason = String(route?.meta?.reason || '').trim();
  const pool = FALLBACK_TEMPLATES[reason] || FALLBACK_TEMPLATES.default;
  const scoreBase = `${reason}|${String(route?.cleanText || '').trim()}`;
  let score = 0;
  for (const ch of scoreBase) score += ch.charCodeAt(0);
  return pool[score % pool.length];
}

function getRefusalAgentApiBaseUrl() {
  return String(config.REFUSAL_AGENT_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getRefusalAgentApiKey() {
  return String(config.REFUSAL_AGENT_API_KEY || config.API_KEY || '').trim();
}

function getRefusalAgentModel() {
  return String(config.REFUSAL_AGENT_MODEL || 'gpt-5.4-mini').trim() || 'gpt-5.4-mini';
}

function buildPersonaExcerpt(limit = 700) {
  const prompt = String(config.SYSTEM_PROMPT || '').replace(/\s+/g, ' ').trim();
  if (!prompt) return '';
  return prompt.slice(0, Math.max(120, limit)).trim();
}

function detectLanguageHint(text = '') {
  const input = String(text || '').trim();
  if (!input) return 'match-user-language';
  if (/[\u4e00-\u9fff]/.test(input)) return 'reply-in-zh';
  return 'reply-in-user-language';
}

function buildRefusalMessages(route = {}) {
  const cleanText = String(route?.cleanText || '').trim();
  const reason = String(route?.meta?.reason || '').trim() || 'default';
  const personaExcerpt = buildPersonaExcerpt();
  return [
    { role: 'system', content: REFUSAL_AGENT_SYSTEM_PROMPT },
    personaExcerpt ? { role: 'system', content: `主人格气质摘要：\n${personaExcerpt}` } : null,
    {
      role: 'user',
      content: [
        `reason=${reason}`,
        `language_hint=${detectLanguageHint(cleanText)}`,
        '请基于这个被拒绝的请求，生成一句温和、简短、自然的回绝：',
        cleanText || '(empty request)'
      ].filter(Boolean).join('\n\n')
    }
  ].filter(Boolean);
}

function isRefusalAgentEnabled() {
  return Boolean(config.REFUSAL_AGENT_ENABLED);
}

function looksUnsafeRefusalOutput(text = '') {
  const input = String(text || '').trim();
  if (!input) return true;
  if (/```/.test(input)) return true;
  if (/(?:^|\n)\s*(?:\d+\.|[-*])\s+/.test(input)) return true;
  if (/(攻击链|绕过|exploit|payload|shellcode|phishing kit|steal password|credential stuffing|bypass 2fa)/i.test(input)) return true;
  return false;
}

async function buildRefusalReply(route = {}, options = {}) {
  const fallbackReply = buildCuteRefusalReply(route);
  if (!isRefusalAgentEnabled()) return fallbackReply;

  const apiBaseUrl = ensureChatCompletionsUrl(options.apiBaseUrl || getRefusalAgentApiBaseUrl());
  const apiKey = String(options.apiKey || getRefusalAgentApiKey()).trim();
  const model = String(options.model || getRefusalAgentModel()).trim();
  const postWithRetryImpl = typeof options.postWithRetry === 'function' ? options.postWithRetry : postWithRetry;
  const extractMessageContentImpl = typeof options.extractMessageContent === 'function'
    ? options.extractMessageContent
    : extractMessageContent;
  if (!apiBaseUrl || !apiKey || !model) return fallbackReply;

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : Math.max(1000, Number(config.REFUSAL_AGENT_TIMEOUT_MS || 5000));

  try {
    const response = await postWithRetryImpl(
      apiBaseUrl,
      {
        model,
        temperature: 0.35,
        messages: buildRefusalMessages(route),
        max_tokens: 120,
        stream: false,
        __timeoutMs: timeoutMs,
        __trace: {
          feature: 'refusal_agent',
          agentName: 'refusal-agent'
        }
      },
      0,
      apiKey
    );
    const message = extractMessageContentImpl(response);
    const rewritten = normalizeTextContent(message?.content).replace(/\u200b/g, '').trim();
    if (looksUnsafeRefusalOutput(rewritten)) return fallbackReply;
    return rewritten;
  } catch (_) {
    return fallbackReply;
  }
}

module.exports = {
  REFUSAL_AGENT_SYSTEM_PROMPT,
  buildCuteRefusalReply,
  buildRefusalReply,
  buildRefusalMessages,
  detectLanguageHint,
  isRefusalAgentEnabled,
  looksUnsafeRefusalOutput
};
