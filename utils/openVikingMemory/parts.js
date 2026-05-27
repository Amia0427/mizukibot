const {
  clampText,
  estimateTokens,
  normalizeText
} = require('./text');

function userTextPart(text = '', options = {}) {
  let body = normalizeText(text);
  if (options.isGroup && normalizeText(options.senderName)) {
    const senderId = normalizeText(options.senderId);
    body = senderId
      ? `[${normalizeText(options.senderName)}(${senderId})] ${body}`
      : `[${normalizeText(options.senderName)}] ${body}`;
  }
  return { type: 'text', text: body };
}

function assistantTextPart(text = '') {
  return { type: 'text', text: normalizeText(text) };
}

function toolCallPart(toolName = '', toolInput = '') {
  return {
    type: 'tool',
    tool_name: normalizeText(toolName),
    tool_input: typeof toolInput === 'string' ? clampText(toolInput, 500) : clampText(JSON.stringify(toolInput || {}), 500)
  };
}

function toolResultPart(toolName = '', toolOutput = '') {
  return {
    type: 'tool',
    tool_name: normalizeText(toolName),
    tool_output: typeof toolOutput === 'string' ? clampText(toolOutput, 500) : clampText(JSON.stringify(toolOutput || {}), 500)
  };
}

function buildMessage(role = 'user', parts = []) {
  const normalizedRole = normalizeText(role, 'user');
  const cleanParts = Array.isArray(parts) ? parts.filter((item) => item && typeof item === 'object') : [];
  if (cleanParts.length === 1 && cleanParts[0].type === 'text') {
    return { role: normalizedRole, content: cleanParts[0].text || '' };
  }
  return { role: normalizedRole, parts: cleanParts };
}

module.exports = {
  assistantTextPart,
  buildMessage,
  estimateTokens,
  toolCallPart,
  toolResultPart,
  userTextPart
};
