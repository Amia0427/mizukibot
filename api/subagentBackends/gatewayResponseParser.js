function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractTextFromContentArray(content = []) {
  return (Array.isArray(content) ? content : [])
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (item.type === 'output_text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractTextFromOutputItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return extractTextFromContentArray(item.content);
  return '';
}

function extractTextFromOutput(output = []) {
  return (Array.isArray(output) ? output : [])
    .map((item) => extractTextFromOutputItem(item))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseGatewayJsonResponse(data = {}) {
  if (!data || typeof data !== 'object') return '';

  if (Array.isArray(data.output)) {
    const outputText = extractTextFromOutput(data.output);
    if (outputText) return outputText;
  }

  const choiceContent = data?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string' && choiceContent.trim()) return choiceContent.trim();
  if (Array.isArray(choiceContent)) {
    const arrayText = extractTextFromContentArray(choiceContent).trim();
    if (arrayText) return arrayText;
  }

  if (typeof data.content === 'string' && data.content.trim()) return data.content.trim();
  return '';
}

function parseGatewaySSEEvent(data = {}) {
  const eventType = String(data?.type || '').trim();
  const result = {
    type: eventType,
    deltaText: '',
    completedText: '',
    isDone: false,
    isError: false,
    errorMessage: ''
  };

  if (eventType === 'response.output_text.delta') {
    result.deltaText = typeof data?.delta === 'string' ? data.delta : '';
    return result;
  }

  if (eventType === 'response.output_text.done') {
    result.completedText = normalizeString(data?.text);
    return result;
  }

  if (eventType === 'response.completed') {
    result.isDone = true;
    result.completedText = parseGatewayJsonResponse(data?.response || {});
    return result;
  }

  if (eventType === 'response.failed') {
    result.isDone = true;
    result.isError = true;
    result.errorMessage = normalizeString(data?.response?.error?.message || data?.error?.message || 'Unknown gateway error');
    return result;
  }

  return result;
}

function parseGatewaySSEStream(raw = '') {
  const lines = String(raw || '').split(/\r?\n/);
  let accumulated = '';
  let completed = '';

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let parsed = null;
    try {
      parsed = JSON.parse(payload);
    } catch (_) {
      continue;
    }

    const event = parseGatewaySSEEvent(parsed);
    if (event.isError) {
      throw new Error(`gateway failed: ${event.errorMessage || 'unknown error'}`);
    }
    if (event.deltaText) accumulated += event.deltaText;
    if (event.completedText) completed = event.completedText;
  }

  return (completed || accumulated).trim();
}

module.exports = {
  extractTextFromContentArray,
  extractTextFromOutput,
  parseGatewayJsonResponse,
  parseGatewaySSEEvent,
  parseGatewaySSEStream
};
