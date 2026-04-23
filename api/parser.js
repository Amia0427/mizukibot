let latestReasoning = ''; // Keep latest model reasoning for the web panel.

function textFromContentArray(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
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
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.promptTokensDetails?.cachedTokens
  );
  const cacheCreationInputTokens = Number(
    raw.cache_creation_input_tokens
    ?? raw.cacheCreationInputTokens
    ?? raw.prompt_tokens_details?.cache_write_tokens
    ?? raw.promptTokensDetails?.cacheWriteTokens
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
    || null
  );
}

function extractSSEEvents(state, chunk) {
  const nextState = state && typeof state === 'object'
    ? { buffer: String(state.buffer || '') }
    : { buffer: '' };

  nextState.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
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
  const tail = String(state?.buffer || '').trim();
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

  if (Array.isArray(obj.content)) {
    return textFromContentArray(obj.content);
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
    try { data = JSON.parse(data); } catch (_) {}
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
    return msg;
  }

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
