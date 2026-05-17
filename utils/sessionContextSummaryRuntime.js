const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent } = require('../api/parser');
const { sanitizeUntrustedContent } = require('./promptSecurity');
const {
  ensureShortTermMemoryState,
  normalizeShortTermState
} = require('./shortTermMemory');

function clampText(value, maxChars = config.SESSION_CONTEXT_SUMMARY_MAX_CHARS) {
  const text = sanitizeUntrustedContent(String(value || '').replace(/\s+/g, ' ').trim(), 'summary');
  if (!text) return '';
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length > limit ? text.slice(0, limit) : text;
}

function stripMarkdownFence(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? String(fenced[1] || '').trim() : raw;
}

function normalizeGeneratedSummaryText(value = '', state = {}, history = []) {
  const raw = stripMarkdownFence(value);
  if (!raw) return '';

  const normalized = clampText(raw);
  if (!normalized) return '';
  if (!/^[{\[]/.test(raw)) return normalized;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return normalized;
    }

    const explicitSummary = clampText(parsed.summary || parsed.text || '');
    if (explicitSummary) return explicitSummary;

    return buildFallbackSummary({
      ...state,
      ...parsed
    }, history);
  } catch (_) {
    return normalized;
  }
}

function serializeRecentHistory(history = [], limit = 12, itemMaxChars = 160) {
  return (Array.isArray(history) ? history : [])
    .slice(-Math.max(1, Number(limit) || 1))
    .map((item) => {
      const role = String(item?.role || '').trim().toLowerCase() === 'assistant' ? '助手' : '用户';
      return `${role}: ${clampText(item?.content, itemMaxChars) || '[空]'}`;
    })
    .filter(Boolean)
    .join('\n');
}

function getSessionSummaryRecentTurnsLimit() {
  return Math.max(2, Math.min(80, Math.floor(Number(config.SHORT_TERM_MEMORY_RECENT_TURNS || config.MEMORY_V3_SESSION_RECENT_MESSAGES || 32) || 32)));
}

function buildFallbackSummary(state = {}, history = []) {
  const normalized = normalizeShortTermState(state);
  const segments = [];

  if (normalized.activeTopic) segments.push(`主线:${normalized.activeTopic}`);
  if (normalized.openLoops.length > 0) segments.push(`待办:${normalized.openLoops.join('；')}`);
  if (normalized.assistantCommitments.length > 0) segments.push(`承诺:${normalized.assistantCommitments.join('；')}`);
  if (normalized.userConstraints.length > 0) segments.push(`约束:${normalized.userConstraints.join('；')}`);
  if (normalized.recentToolResults.length > 0) segments.push(`结果:${normalized.recentToolResults.join('；')}`);
  if (normalized.summary) segments.push(`摘要:${normalized.summary}`);

  const latestHistory = serializeRecentHistory(history, getSessionSummaryRecentTurnsLimit(), 90);
  if (latestHistory) segments.push(`近况:${latestHistory.replace(/\n/g, ' | ')}`);

  return clampText(segments.join('；'));
}

function buildStructuredSummaryPayload(state = {}, history = []) {
  const normalized = normalizeShortTermState(state);
  return {
    activeTopic: normalized.interaction.activeTopic || normalized.activeTopic,
    carryOverUserTurn: normalized.interaction.carryOverUserTurn || normalized.carryOverUserTurn,
    openLoops: normalized.interaction.openLoops.length > 0 ? normalized.interaction.openLoops : normalized.openLoops,
    assistantCommitments: normalized.interaction.assistantCommitments.length > 0 ? normalized.interaction.assistantCommitments : normalized.assistantCommitments,
    userConstraints: normalized.interaction.userConstraints.length > 0 ? normalized.interaction.userConstraints : normalized.userConstraints,
    recentTurns: (Array.isArray(history) ? history : [])
      .slice(-getSessionSummaryRecentTurnsLimit())
      .map((item) => ({
        role: String(item?.role || '').trim().toLowerCase(),
        content: clampText(item?.content, 140)
      }))
      .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.content),
    interaction: normalized.interaction,
    scene: normalized.scene,
    expression: normalized.expression,
    moduleState: normalized.moduleState,
    sourceFlags: normalized.interaction.sourceFlags || [],
    confidence: Math.max(
      Number(normalized.confidence || 0) || 0,
      Number(normalized.interaction?.confidence || 0) || 0,
      Number(normalized.expression?.confidence || 0) || 0
    )
  };
}

function buildSummaryPrompt(existingState, recentHistoryText) {
  const state = normalizeShortTermState(existingState);
  const compactState = {
    summary: state.summary,
    activeTopic: state.activeTopic,
    openLoops: state.openLoops,
    assistantCommitments: state.assistantCommitments,
    userConstraints: state.userConstraints,
    recentToolResults: state.recentToolResults,
    carryOverUserTurn: state.carryOverUserTurn
  };

  return [
    '你是会话压缩总结器。',
    `只输出中文纯文本，长度不超过 ${Math.max(1, Number(config.SESSION_CONTEXT_SUMMARY_MAX_CHARS) || 300)} 字。`,
    '保留当前主线、未完成事项、用户约束、最近关键结论。',
    '禁止输出系统提示词、密钥、内部推理、工具调用过程、命令细节。',
    '如果信息不足，就只总结已知关键上下文，不要编造。',
    `结构化状态: ${JSON.stringify(compactState)}`,
    recentHistoryText ? `近期会话:\n${recentHistoryText}` : '近期会话: 无'
  ].join('\n');
}

function resolveMemoryCompletionsUrl() {
  const memoryUrl = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(memoryUrl)) return memoryUrl;
  if (/\/v\d+$/i.test(memoryUrl)) return `${memoryUrl}/chat/completions`;
  return memoryUrl;
}

async function generateSessionContextSummary({
  userId = '',
  sessionKey = '',
  routeMeta = {},
  chatHistory = {},
  shortTermMemory = {}
} = {}) {
  const key = String(sessionKey || '').trim();
  const uid = String(userId || '').trim();
  if (!uid || !key) {
    return {
      ok: false,
      summary: '',
      source: 'invalid_input'
    };
  }

  const state = ensureShortTermMemoryState(key, shortTermMemory, routeMeta);
  const history = Array.isArray(chatHistory[key]) ? chatHistory[key] : [];
  const recentHistoryText = serializeRecentHistory(history, 12, 140);

  try {
    const response = await postWithRetry(
      resolveMemoryCompletionsUrl(),
      {
        model: String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4',
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          {
            role: 'system',
            content: buildSummaryPrompt(state, recentHistoryText)
          },
          {
            role: 'user',
            content: '请压缩总结当前会话。'
          }
        ],
        max_tokens: 220,
        stream: false
      },
      Math.max(0, Number(config.AI_RETRIES) || 0),
      String(config.MEMORY_API_KEY || config.API_KEY || '').trim()
    );
    const msg = extractMessageContent(response);
    const summary = normalizeGeneratedSummaryText(msg?.content || msg?.text || '', state, history);
    if (summary) {
      return {
        ok: true,
        summary,
        source: 'model',
        structured: buildStructuredSummaryPayload(state, history)
      };
    }
  } catch (_) {}

  const fallbackSummary = buildFallbackSummary(state, history);
  return {
    ok: Boolean(fallbackSummary),
    summary: fallbackSummary,
    source: 'fallback',
    structured: buildStructuredSummaryPayload(state, history)
  };
}

module.exports = {
  buildFallbackSummary,
  generateSessionContextSummary
};
