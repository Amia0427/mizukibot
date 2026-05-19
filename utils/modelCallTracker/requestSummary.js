const { normalizeText } = require('./common');

function flattenContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => flattenContentText(part)).join('\n');
  }
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) return flattenContentText(content.content);
  if (content.type === 'image_url') {
    return String(content?.image_url?.url || content?.url || '');
  }
  return '';
}

function containsMemoryMarker(text) {
  const input = String(text || '');
  if (!input) return false;
  return /\[Memory\]|\[Profile\]|\[Summary\]|长期记忆|记忆注入/i.test(input);
}

function summarizeRequest(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemText = flattenContentText(request.system);
  const combinedText = [
    systemText,
    ...messages.map((msg) => flattenContentText(msg?.content))
  ].join('\n');
  const explicitMessageCount = Number(request.message_count);
  const explicitToolCount = Number(request.tool_count);

  return {
    model: normalizeText(request.model),
    stream: Boolean(request.stream),
    max_tokens: Number.isFinite(Number(request.max_tokens))
      ? Math.floor(Number(request.max_tokens))
      : null,
    message_count: Number.isFinite(explicitMessageCount)
      ? Math.max(0, Math.floor(explicitMessageCount))
      : messages.length + (systemText ? 1 : 0),
    tool_count: Number.isFinite(explicitToolCount)
      ? Math.max(0, Math.floor(explicitToolCount))
      : (Array.isArray(request.tools) ? request.tools.length : 0),
    memory_injected: request.memory_injected !== undefined
      ? Boolean(request.memory_injected)
      : containsMemoryMarker(combinedText)
  };
}

module.exports = {
  containsMemoryMarker,
  flattenContentText,
  summarizeRequest
};
