let latestReasoning = ''; // Keep latest model reasoning for the web panel.

const { StringDecoder } = require('string_decoder');

const SSE_UTF8_DECODER = Symbol('sseUtf8Decoder');

function normalizeSSEState(state) {
  const nextState = state && typeof state === 'object' ? state : {};
  nextState.buffer = String(nextState.buffer || '');
  return nextState;
}

function decodeSSEChunk(state, chunk) {
  if (!Buffer.isBuffer(chunk)) return String(chunk || '');
  if (!state[SSE_UTF8_DECODER]) {
    Object.defineProperty(state, SSE_UTF8_DECODER, {
      value: new StringDecoder('utf8'),
      enumerable: false,
      configurable: true
    });
  }
  return state[SSE_UTF8_DECODER].write(chunk);
}

function flushSSEDecoder(state) {
  if (!state || typeof state !== 'object' || !state[SSE_UTF8_DECODER]) return '';
  const tail = state[SSE_UTF8_DECODER].end();
  delete state[SSE_UTF8_DECODER];
  return tail;
}

function textFromContentArray(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      if (typeof part?.output_text === 'string') return part.output_text;
      if (typeof part?.outputText === 'string') return part.outputText;
      if (Array.isArray(part?.content)) return textFromContentArray(part.content);
      if (part?.content && typeof part.content === 'object') return extractTextFromObject(part.content);
      if (part && typeof part === 'object') return extractTextFromObject(part);
      return '';
    })
    .join('');
}

function textFromAnthropicContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('');
}

function textFromOutputContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      if (typeof part.output_text === 'string') return part.output_text;
      if (Array.isArray(part.content)) return textFromOutputContent(part.content);
      return '';
    })
    .join('');
}

function textFromResponsesOutput(output) {
  if (!Array.isArray(output)) return '';
  return output
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (typeof item.output_text === 'string') return item.output_text;
      if (Array.isArray(item.content)) return textFromOutputContent(item.content);
      return '';
    })
    .join('');
}

function toolCallsFromResponsesOutput(output) {
  if (!Array.isArray(output)) return [];
  return output
    .filter((item) => item && typeof item === 'object' && item.type === 'function_call')
    .map((item) => ({
      id: String(item.call_id || item.id || `call_${Date.now()}`),
      type: 'function',
      function: {
        name: String(item.name || '').trim(),
        arguments: String(item.arguments || '{}')
      }
    }))
    .filter((item) => item.function.name);
}

function extractTextFromObject(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || depth > 3) return '';
  const direct = String(
    value.output_text
    || value.outputText
    || value.response_text
    || value.responseText
    || value.answer
    || value.reply
    || ''
  ).trim();
  if (direct) return direct;
  const contentText = textFromOutputContent(value.content).trim();
  if (contentText) return contentText;
  const outputText = textFromResponsesOutput(value.output).trim();
  if (outputText) return outputText;
  if (value.message && typeof value.message === 'object') {
    const messageText = extractTextFromObject(value.message, depth + 1).trim();
    if (messageText) return messageText;
  }
  if (value.response && typeof value.response === 'object') {
    const responseText = extractTextFromObject(value.response, depth + 1).trim();
    if (responseText) return responseText;
  }
  if (value.result && typeof value.result === 'object') {
    const resultText = extractTextFromObject(value.result, depth + 1).trim();
    if (resultText) return resultText;
  }
  if (typeof value.text === 'string') return value.text;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.response === 'string') return value.response;
  if (typeof value.result === 'string') return value.result;
  return '';
}

function toolCallsFromAnthropicContent(content) {
  if (!Array.isArray(content)) return [];

  const calls = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use') continue;

    const name = String(block.name || '').trim();
    if (!name) continue;

    calls.push({
      id: String(block.id || `tooluse_${Date.now()}`),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(
          (block.input && typeof block.input === 'object' && !Array.isArray(block.input))
            ? block.input
            : {}
        )
      }
    });
  }

  return calls;
}

function parseSSEToText(raw) {
  if (typeof raw !== 'string') return null;
  const lines = raw.split('\n');
  let text = '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      text += extractDeltaText(obj);
    } catch (_) {}
  }
  return text || null;
}

function normalizeUsageObject(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const promptTokens = Number(
    raw.prompt_tokens
    ?? raw.input_tokens
    ?? raw.promptTokens
    ?? raw.inputTokens
    ?? raw.input_token_count
  );
  const completionTokens = Number(
    raw.completion_tokens
    ?? raw.output_tokens
    ?? raw.completionTokens
    ?? raw.outputTokens
    ?? raw.output_token_count
  );
  const totalTokens = Number(
    raw.total_tokens
    ?? raw.totalTokens
  );
  const cacheReadInputTokens = Number(
    raw.cache_read_input_tokens
    ?? raw.cacheReadInputTokens
    ?? raw.prompt_cache_hit_tokens
    ?? raw.promptCacheHitTokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.promptTokensDetails?.cachedTokens
    ?? raw.input_tokens_details?.cached_tokens
    ?? raw.inputTokensDetails?.cachedTokens
  );
  const cacheCreationInputTokens = Number(
    raw.cache_creation_input_tokens
    ?? raw.cacheCreationInputTokens
    ?? raw.prompt_cache_miss_tokens
    ?? raw.promptCacheMissTokens
    ?? raw.prompt_tokens_details?.cache_write_tokens
    ?? raw.promptTokensDetails?.cacheWriteTokens
    ?? raw.input_tokens_details?.cache_write_tokens
    ?? raw.inputTokensDetails?.cacheWriteTokens
  );
  const cacheCreation = raw.cache_creation && typeof raw.cache_creation === 'object'
    ? JSON.parse(JSON.stringify(raw.cache_creation))
    : null;

  const hasPrompt = Number.isFinite(promptTokens);
  const hasCompletion = Number.isFinite(completionTokens);
  const hasTotal = Number.isFinite(totalTokens);
  const hasCacheRead = Number.isFinite(cacheReadInputTokens);
  const hasCacheCreation = Number.isFinite(cacheCreationInputTokens) || Boolean(cacheCreation);
  if (!hasPrompt && !hasCompletion && !hasTotal && !hasCacheRead && !hasCacheCreation) return null;

  return {
    prompt_tokens: hasPrompt ? Math.floor(promptTokens) : null,
    completion_tokens: hasCompletion ? Math.floor(completionTokens) : null,
    cache_read_input_tokens: hasCacheRead ? Math.floor(cacheReadInputTokens) : null,
    cache_creation_input_tokens: Number.isFinite(cacheCreationInputTokens) ? Math.floor(cacheCreationInputTokens) : null,
    cache_creation: cacheCreation,
    total_tokens: hasTotal
      ? Math.floor(totalTokens)
      : ((hasPrompt || hasCompletion)
        ? Math.floor((hasPrompt ? promptTokens : 0) + (hasCompletion ? completionTokens : 0))
        : null)
  };
}

function mergeUsageObjects(baseUsage, patchUsage) {
  if (!baseUsage) return patchUsage ? { ...patchUsage } : null;
  if (!patchUsage) return { ...baseUsage };

  const merged = {
    prompt_tokens: patchUsage.prompt_tokens ?? baseUsage.prompt_tokens ?? null,
    completion_tokens: patchUsage.completion_tokens ?? baseUsage.completion_tokens ?? null,
    cache_read_input_tokens: patchUsage.cache_read_input_tokens ?? baseUsage.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: patchUsage.cache_creation_input_tokens ?? baseUsage.cache_creation_input_tokens ?? null,
    cache_creation: patchUsage.cache_creation ?? baseUsage.cache_creation ?? null,
    total_tokens: patchUsage.total_tokens ?? baseUsage.total_tokens ?? null
  };

  const prompt = Number(merged.prompt_tokens);
  const completion = Number(merged.completion_tokens);
  if (Number.isFinite(prompt) || Number.isFinite(completion)) {
    merged.total_tokens = Math.floor((Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0));
  }

  return merged;
}

function extractUsageFromSSEObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    normalizeUsageObject(obj.usage)
    || normalizeUsageObject(obj?.message?.usage)
    || normalizeUsageObject(obj?.delta?.usage)
    || normalizeUsageObject(obj?.response?.usage)
    || null
  );
}

function extractSSEEvents(state, chunk) {
  const nextState = normalizeSSEState(state);

  nextState.buffer += decodeSSEChunk(nextState, chunk);
  const events = [];

  while (true) {
    let boundary = nextState.buffer.indexOf('\n\n');
    let boundaryLength = 2;

    if (boundary < 0) {
      boundary = nextState.buffer.indexOf('\r\n\r\n');
      boundaryLength = 4;
    }
    if (boundary < 0) break;

    const block = nextState.buffer.slice(0, boundary);
    nextState.buffer = nextState.buffer.slice(boundary + boundaryLength);

    const lines = block.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (!dataLines.length) continue;

    const payload = dataLines.join('\n');
    if (payload === '[DONE]') {
      events.push({ done: true, delta: '', raw: payload });
      continue;
    }

    try {
      const obj = JSON.parse(payload);
      const delta = extractDeltaText(obj);
      const reasoning = extractReasoningText(obj);
      const usage = extractUsageFromSSEObject(obj);
      if (reasoning) latestReasoning = reasoning;
      events.push({ done: false, delta, reasoning, usage, json: obj, raw: payload });
    } catch (_) {
      // Ignore non-JSON heartbeat or provider-specific control lines.
    }
  }

  return { state: nextState, events };
}

function flushSSEState(state) {
  const nextState = normalizeSSEState(state);
  nextState.buffer += flushSSEDecoder(nextState);
  const tail = String(nextState.buffer || '').trim();
  if (!tail) return [];

  const lines = tail.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (!dataLines.length) return [];

  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return [{ done: true, delta: '', raw: payload }];

  try {
    const obj = JSON.parse(payload);
    const delta = extractDeltaText(obj);
    const reasoning = extractReasoningText(obj);
    const usage = extractUsageFromSSEObject(obj);
    if (reasoning) latestReasoning = reasoning;
    return [{ done: false, delta, reasoning, usage, json: obj, raw: payload }];
  } catch (_) {
    return [];
  }
}

function extractDeltaText(obj) {
  if (!obj || typeof obj !== 'object') return '';

  // Anthropic stream events.
  if (obj.type === 'content_block_delta') {
    if (typeof obj?.delta?.text === 'string') return obj.delta.text;
    if (obj?.delta?.type === 'text_delta' && typeof obj?.delta?.text === 'string') return obj.delta.text;
    return '';
  }
  if (obj.type === 'content_block_start') {
    if (obj?.content_block?.type === 'text' && typeof obj?.content_block?.text === 'string') {
      return obj.content_block.text;
    }
  }

  if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') return obj.delta;
  if (obj.type === 'response.output_text.done' && typeof obj.text === 'string') return obj.text;
  if (obj.type === 'response.completed') {
    return extractTextFromObject(obj.response).trim();
  }
  if (obj.type === 'response.incomplete') {
    return extractTextFromObject(obj.response).trim();
  }

  if (typeof obj.delta === 'string') return obj.delta;
  if (typeof obj.output_text === 'string') return obj.output_text;
  if (typeof obj.text === 'string') return obj.text;

  const choice = obj.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta === 'string') return delta;
  if (typeof delta?.content === 'string') return delta.content;
  if (Array.isArray(delta?.content)) {
    return textFromContentArray(delta.content);
  }

  if (typeof choice?.text === 'string') return choice.text;
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (Array.isArray(choice?.message?.content)) {
    return textFromContentArray(choice.message.content);
  }
  if (choice?.message?.content && typeof choice.message.content === 'object') {
    return extractTextFromObject(choice.message.content);
  }

  if (Array.isArray(obj.content)) {
    return textFromContentArray(obj.content);
  }
  if (obj.content && typeof obj.content === 'object') {
    return extractTextFromObject(obj.content);
  }

  return '';
}

function extractReasoningText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const choice = obj.choices?.[0];
  return String(
    obj.reasoning ||
    obj.reasoning_content ||
    obj?.delta?.thinking ||
    obj?.content_block?.thinking ||
    choice?.delta?.reasoning ||
    choice?.delta?.reasoning_content ||
    choice?.message?.reasoning ||
    choice?.message?.reasoning_content ||
    ''
  );
}

function extractJsonSafely(text) {
  let raw = String(text || '').trim();
  if (!raw) return null;

  raw = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try { return JSON.parse(raw); } catch (_) {}

  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) {
    const sub = raw.slice(s, e + 1);
    try { return JSON.parse(sub); } catch (_) {}
  }

  return null;
}

function extractMessageContent(resp) {
  let data = resp?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) {
      const sseText = parseSSEToText(data);
      if (sseText) return { role: 'assistant', content: sseText };
      const text = String(data || '').trim();
      return text ? { role: 'assistant', content: text } : null;
    }
  }

  // Anthropic non-stream response format.
  if (data && data.type === 'message' && data.role === 'assistant') {
    const toolCalls = toolCallsFromAnthropicContent(data.content);
    const msg = {
      role: 'assistant',
      content: textFromAnthropicContent(data.content)
    };
    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    return msg;
  }

  const msg = data?.choices?.[0]?.message;
  if (msg) {
    latestReasoning = msg.reasoning_content || msg.reasoning || '';
    const normalized = { ...msg };
    if (Array.isArray(normalized.content)) {
      normalized.content = textFromContentArray(normalized.content);
    } else if (normalized.content && typeof normalized.content === 'object') {
      normalized.content = extractTextFromObject(normalized.content);
    }
    return normalized;
  }

  const choice = data?.choices?.[0];
  const choiceText = extractDeltaText({ choices: [choice] }).trim();
  if (choiceText) return { role: 'assistant', content: choiceText };

  // OpenAI Responses API / common proxy response formats.
  if (data && Array.isArray(data.output)) {
    const msg = {
      role: 'assistant',
      content: textFromResponsesOutput(data.output)
    };
    const toolCalls = toolCallsFromResponsesOutput(data.output);
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    if (msg.content || toolCalls.length > 0) return msg;
  }

  const fallbackText = extractTextFromObject(data).trim();
  if (fallbackText) return { role: 'assistant', content: fallbackText };

  const sseText = parseSSEToText(resp?.data);
  if (sseText) return { content: sseText };
  return null;
}

function safeParseArgs(argsStr) {
  try { return JSON.parse(argsStr || '{}'); } catch (_) { return {}; }
}

module.exports = {
  extractMessageContent,
  safeParseArgs,
  extractJsonSafely,
  parseSSEToText,
  extractSSEEvents,
  flushSSEState,
  extractUsageFromSSEObject,
  mergeUsageObjects,
  getLatestReasoning: () => latestReasoning
};
