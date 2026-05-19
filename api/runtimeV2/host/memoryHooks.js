const config = require('../../../config');
const { postWithRetry } = require('../../httpClient');
const { extractMessageContent } = require('../../parser');
const { buildStructuredCompressionPrompt } = require('../../../utils/shortTermMemory');

function appendMemoryEvent(...args) {
  return require('../../../utils/memory-v3').appendMemoryEvent(...args);
}

function materializeMemoryViews(...args) {
  return require('../../../utils/memory-v3').materializeMemoryViews(...args);
}

function recordPersonaMemoryOutcome(...args) {
  return require('../../../utils/personaMemoryState').recordPersonaMemoryOutcome(...args);
}

function warmMcpRegistry(...args) {
  return require('../../toolRegistry').warmMcpRegistry(...args);
}

function resolveMemoryCompletionsUrl() {
  const memoryUrl = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(memoryUrl)) return memoryUrl;
  if (/\/v\d+$/i.test(memoryUrl)) return `${memoryUrl}/chat/completions`;
  return memoryUrl;
}

function resolveMemoryModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function resolveMemoryApiKey() {
  return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
}

async function summarizeShortTermChunk(payload = {}) {
  const summaryTokens = Math.max(96, Math.min(400, Number(payload.summaryTokens || 0) || 400));
  const response = await postWithRetry(
    resolveMemoryCompletionsUrl(),
    {
      model: resolveMemoryModelName(),
      temperature: 0.2,
      top_p: 0.9,
      messages: [
        {
          role: 'system',
          content: [
            buildStructuredCompressionPrompt(
              payload.existingState || { summary: payload.existingSummary },
              summaryTokens
            ),
            '如果无法稳定输出 JSON，退回输出纯文本短期摘要。'
          ].join('\n')
        },
        {
          role: 'user',
          content: String(payload.chunkText || '').trim()
        }
      ],
      max_tokens: summaryTokens,
      stream: false
    },
    Math.max(0, Number(config.AI_RETRIES) || 0),
    resolveMemoryApiKey()
  );
  const message = extractMessageContent(response);
  return String(message?.content || message?.text || '').trim();
}

module.exports = {
  appendMemoryEvent,
  materializeMemoryViews,
  recordPersonaMemoryOutcome,
  warmMcpRegistry,
  resolveMemoryCompletionsUrl,
  resolveMemoryModelName,
  resolveMemoryApiKey,
  summarizeShortTermChunk
};
