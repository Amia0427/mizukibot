const {
  extractAnthropicCacheControl,
  normalizeText,
  stripCacheControlFields,
  stripOpenAIPromptCacheFields,
  stripOpenAIPromptCacheRetention,
  stripTopPField
} = require('./runtime-core.chunk');
const {
  normalizeOpenAIImageDetail,
  resolveOpenAICompatibleImagePart,
  sanitizeOpenAICompatibleContentPart,
  sanitizeOpenAICompatibleContentPartWithoutCache,
  sanitizeOpenAICompatibleMessageWithoutCache,
  sanitizeOpenAICompatibleToolWithoutCache
} = require('./images.chunk');

function getRequestShaping() {
  return require('./request-shaping.chunk');
}

const RESPONSES_PROTOCOL_FALLBACK_FLAG = '__responsesProtocolFallbackAttempted';

async function preprocessOpenAICompatibleMessages(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const out = [];

  for (const message of normalizedMessages) {
    if (!message || typeof message !== 'object') {
      out.push(message);
      continue;
    }

    if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
      out.push({
        ...message,
        content: sanitizeOpenAICompatibleContentPart(message.content)
      });
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : null;
    if (!content) {
      out.push(message);
      continue;
    }

    const nextContent = [];
    for (const part of content) {
      const sanitizedPart = sanitizeOpenAICompatibleContentPart(part);
      const partType = String(sanitizedPart?.type || '').toLowerCase();
      if (partType === 'image_url' || partType === 'input_image' || partType === 'image') {
        const resolvedPart = await resolveOpenAICompatibleImagePart(sanitizedPart);
        if (resolvedPart) nextContent.push(resolvedPart);
        continue;
      }
      nextContent.push(sanitizedPart);
    }

    out.push({
      ...message,
      content: nextContent
    });
  }

  return out;
}

async function preprocessOpenAICompatibleMessagesWithoutCache(messages = []) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const out = [];

  for (const message of normalizedMessages) {
    if (!message || typeof message !== 'object') {
      out.push(message);
      continue;
    }

    const strippedMessage = sanitizeOpenAICompatibleMessageWithoutCache(message);
    const content = Array.isArray(strippedMessage?.content) ? strippedMessage.content : null;
    if (!content) {
      out.push(strippedMessage);
      continue;
    }

    const nextContent = [];
    for (const part of content) {
      const partType = String(part?.type || '').toLowerCase();
      if (partType === 'image_url' || partType === 'input_image' || partType === 'image') {
        const resolvedPart = await resolveOpenAICompatibleImagePart(part);
        if (resolvedPart) nextContent.push(stripCacheControlFields(resolvedPart));
        continue;
      }
      nextContent.push(part);
    }

    out.push({
      ...strippedMessage,
      content: nextContent
    });
  }

  return out;
}

function requestUsesOpenAICompatiblePromptCaching(requestBody = {}) {
  const topLevel = Boolean(
    requestBody?.prompt_cache_key
    || requestBody?.prompt_cache_retention
    || extractAnthropicCacheControl(requestBody)
  );
  if (topLevel) return true;
  return (Array.isArray(requestBody.messages) ? requestBody.messages : []).some((message) => {
    const content = message?.content;
    if (Array.isArray(content)) {
      return content.some((part) => Boolean(extractAnthropicCacheControl(part)));
    }
    return Boolean(extractAnthropicCacheControl(content));
  });
}

function requestUsesOpenAIPromptCacheRetention(requestBody = {}) {
  return Boolean(requestBody && typeof requestBody === 'object' && requestBody.prompt_cache_retention);
}

function stripOpenAIPromptCacheRetentionFromRequest(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  return stripOpenAIPromptCacheRetention(requestBody);
}

function stripOpenAICompatiblePromptCaching(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;
  const nextBody = stripOpenAIPromptCacheFields(stripCacheControlFields(requestBody));
  const strippedBody = {
    ...nextBody,
    tools: Array.isArray(nextBody.tools)
      ? nextBody.tools.map((tool) => sanitizeOpenAICompatibleToolWithoutCache(tool))
      : nextBody.tools
  };
  if (!Array.isArray(nextBody.messages)) return strippedBody;
  return {
    ...strippedBody,
    messages: nextBody.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const nextMessage = stripCacheControlFields(message);
      if (Array.isArray(nextMessage.content)) {
        return {
          ...nextMessage,
          content: nextMessage.content.map((part) => sanitizeOpenAICompatibleContentPart(stripCacheControlFields(part)))
        };
      }
      if (nextMessage.content && typeof nextMessage.content === 'object' && !Array.isArray(nextMessage.content)) {
        return {
          ...nextMessage,
          content: sanitizeOpenAICompatibleContentPart(stripCacheControlFields(nextMessage.content))
        };
      }
      return nextMessage;
    })
  };
}

function isOpenAIPromptCacheRetentionSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /prompt[_-]?cache[_-]?retention/i.test(bodyText);
}

function isOpenAICompatiblePromptCacheSchemaError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 415, 422].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  return /cache[_-]?control|prompt[_-]?cache|prompt[_-]?cache[_-]?key|unknown field|extra inputs|additional properties/i.test(bodyText);
}

function isResponsesUrl(url = '') {
  return /\/responses(?:\/)?$/i.test(String(url || '').trim());
}

function buildResponsesUrl(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (!normalized) return normalized;
  if (/\/responses$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, '/responses');
  if (/\/messages$/i.test(normalized)) return normalized.replace(/\/messages$/i, '/responses');
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/responses`;
  return normalized;
}

function buildChatCompletionsFallbackUrl(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (!normalized) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, '/chat/completions');
  if (/\/messages$/i.test(normalized)) return normalized.replace(/\/messages$/i, '/chat/completions');
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function hasResponsesProtocolFallbackAttempted(requestBody = {}) {
  return Boolean(
    requestBody
    && typeof requestBody === 'object'
    && requestBody[RESPONSES_PROTOCOL_FALLBACK_FLAG] === true
  );
}

function markResponsesProtocolFallbackAttempted(requestBody = {}) {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return requestBody;
  return {
    ...requestBody,
    [RESPONSES_PROTOCOL_FALLBACK_FLAG]: true
  };
}

function isResponsesProtocolUnsupportedError(error) {
  const status = Number(error?.response?.status || 0);
  if (![400, 404, 405, 415, 422, 500, 501].includes(status)) return false;
  const responseData = error?.response?.data;
  const bodyText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  const normalized = bodyText.replace(/\s+/g, ' ').trim();

  if (status === 500) {
    return /\bnot implemented\b/i.test(normalized)
      || /responses?\s+(?:api|protocol).*?(?:not implemented|not supported|unsupported)/i.test(normalized);
  }

  if (status === 404 || status === 405 || status === 501) {
    if (/\bmodel\b/i.test(normalized) && !/responses?|endpoint|route|path|url|cannot\s+(?:post|get)/i.test(normalized)) {
      return false;
    }
    return true;
  }

  return /\/responses\b|responses?\s+api|responses?\s+protocol|endpoint.*(?:not found|not supported|unsupported)|route.*not found|cannot\s+post|no route|unknown (?:field|parameter).*?(?:input|max_output_tokens|instructions|previous_response_id|truncation)|(?:input|max_output_tokens|instructions|previous_response_id|truncation).*?(?:unknown|unsupported|not supported|extra inputs|additional properties)|missing.*messages|required.*messages/i.test(normalized);
}

function shouldFallbackResponsesProtocol(prepared = null, originalBody = {}, error = null) {
  if (!prepared || prepared.provider !== 'openai_compatible') return false;
  if (!isResponsesUrl(prepared.requestUrl)) return false;
  if (hasResponsesProtocolFallbackAttempted(originalBody)) return false;
  if (!requestBodyLooksLikeChatCompletion(originalBody)) return false;
  if (!isResponsesProtocolUnsupportedError(error)) return false;
  const fallbackUrl = buildChatCompletionsFallbackUrl(prepared.requestUrl);
  return fallbackUrl && fallbackUrl !== prepared.requestUrl;
}

function requestBodyLooksLikeChatCompletion(requestBody = {}) {
  return Boolean(
    requestBody
    && typeof requestBody === 'object'
    && !Array.isArray(requestBody)
    && (Array.isArray(requestBody.messages) || Array.isArray(requestBody.input) || typeof requestBody.input === 'string')
  );
}

function mapResponsesContentPartToChat(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  const type = String(part.type || '').trim().toLowerCase();
  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    return { type: 'text', text: String(part.text || part.content || '') };
  }
  if (type === 'input_image') {
    const url = String(part.image_url || part.url || '').trim();
    if (!url) return null;
    const mapped = { type: 'image_url', image_url: { url } };
    const detail = normalizeOpenAIImageDetail(part.detail);
    if (detail) mapped.image_url.detail = detail;
    return mapped;
  }
  const text = normalizeResponsesTextContent(part);
  return text ? { type: 'text', text } : null;
}

function mapResponsesInputItemToChatMessages(item) {
  if (typeof item === 'string') return [{ role: 'user', content: item }];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  const type = String(item.type || '').trim().toLowerCase();
  if (type === 'message') {
    const role = ['system', 'developer', 'assistant', 'user'].includes(String(item.role || '').trim().toLowerCase())
      ? String(item.role || '').trim().toLowerCase()
      : 'user';
    const content = Array.isArray(item.content)
      ? item.content.map(mapResponsesContentPartToChat).filter(Boolean)
      : normalizeResponsesTextContent(item.content);
    return [{ role, content }];
  }
  if (type === 'function_call') {
    return [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: String(item.call_id || item.id || '').trim(),
        type: 'function',
        function: {
          name: String(item.name || '').trim(),
          arguments: String(item.arguments || '{}')
        }
      }].filter((call) => call.id && call.function.name)
    }];
  }
  if (type === 'function_call_output') {
    const callId = String(item.call_id || '').trim();
    if (!callId) return [];
    return [{
      role: 'tool',
      tool_call_id: callId,
      content: String(item.output || '')
    }];
  }
  const contentPart = mapResponsesContentPartToChat(item);
  return contentPart ? [{ role: 'user', content: [contentPart] }] : [];
}

function mapResponsesInputToChatMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    out.push(...mapResponsesInputItemToChatMessages(item));
  }
  return out;
}

function buildChatCompletionsRequestBody(requestBody = {}) {
  const body = requestBody && typeof requestBody === 'object' ? { ...requestBody } : {};
  if (Array.isArray(body.messages)) return body;
  const out = {
    model: body.model,
    messages: mapResponsesInputToChatMessages(body.input),
    stream: Boolean(body.stream)
  };
  if (Number.isFinite(Number(body.temperature))) out.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) out.top_p = Number(body.top_p);
  if (Number.isFinite(Number(body.max_tokens))) out.max_tokens = Math.floor(Number(body.max_tokens));
  else if (Number.isFinite(Number(body.max_output_tokens))) out.max_tokens = Math.floor(Number(body.max_output_tokens));
  if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
      if (tool.type !== 'function' || !tool.name) return tool;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} },
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {})
        }
      };
    }).filter(Boolean);
  }
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  if (body.user) out.user = body.user;
  return out;
}

function normalizeResponsesTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return String(part.text || part.content || part.output_text || '');
    }).join('');
  }
  if (content && typeof content === 'object') return String(content.text || content.content || '');
  return String(content || '');
}

function mapContentPartToResponsesInput(part) {
  if (typeof part === 'string') return { type: 'input_text', text: part };
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  const type = String(part.type || '').trim().toLowerCase();
  if (type === 'image_url') {
    const url = String(part?.image_url?.url || part.url || '').trim();
    if (!url) return null;
    const mapped = { type: 'input_image', image_url: url };
    const detail = normalizeOpenAIImageDetail(part?.image_url?.detail || part.detail);
    if (detail) mapped.detail = detail;
    return mapped;
  }
  if (type === 'input_image') {
    const url = String(part.image_url || part.url || '').trim();
    if (!url) return null;
    const mapped = { type: 'input_image', image_url: url };
    const detail = normalizeOpenAIImageDetail(part.detail);
    if (detail) mapped.detail = detail;
    return mapped;
  }
  if (type === 'input_text' || type === 'text') {
    return { type: 'input_text', text: String(part.text || part.content || '') };
  }
  const text = normalizeResponsesTextContent(part);
  return text ? { type: 'input_text', text } : null;
}

function mapMessageContentToResponsesInput(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(mapContentPartToResponsesInput).filter(Boolean);
  }
  if (content && typeof content === 'object') {
    const mapped = mapContentPartToResponsesInput(content);
    return mapped ? [mapped] : '';
  }
  return String(content || '');
}

function mapChatMessageToResponsesInput(message = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const role = String(message.role || '').trim().toLowerCase();
  if (role === 'tool') {
    const callId = String(message.tool_call_id || message.call_id || '').trim();
    if (!callId) return null;
    return {
      type: 'function_call_output',
      call_id: callId,
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')
    };
  }
  if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((toolCall) => ({
      type: 'function_call',
      call_id: String(toolCall.id || toolCall.call_id || '').trim(),
      name: String(toolCall?.function?.name || toolCall.name || '').trim(),
      arguments: String(toolCall?.function?.arguments || toolCall.arguments || '{}')
    })).filter((item) => item.call_id && item.name);
  }
  const allowedRole = role === 'developer' || role === 'system' || role === 'assistant'
    ? role
    : 'user';
  return {
    type: 'message',
    role: allowedRole,
    content: mapMessageContentToResponsesInput(message.content)
  };
}

function mapChatMessagesToResponsesInput(messages = []) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const mapped = mapChatMessageToResponsesInput(message);
    if (Array.isArray(mapped)) input.push(...mapped);
    else if (mapped) input.push(mapped);
  }
  return input;
}

function mapChatToolsToResponsesTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
      if (String(tool.type || '').trim() !== 'function' || !tool.function) return tool;
      const fn = tool.function;
      const mapped = {
        type: 'function',
        name: String(fn.name || '').trim(),
        parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : null
      };
      if (typeof fn.description === 'string') mapped.description = fn.description;
      if (typeof fn.strict === 'boolean') mapped.strict = fn.strict;
      return mapped.name ? mapped : null;
    })
    .filter(Boolean);
}

function mapToolChoiceToResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice !== 'object') return toolChoice;
  if (toolChoice.type === 'function') {
    return {
      type: 'function',
      name: String(toolChoice?.function?.name || toolChoice.name || '').trim()
    };
  }
  return toolChoice;
}

function mapReasoningEffortToResponses(value) {
  const effort = getRequestShaping().normalizeReasoningEffort(value);
  return effort ? { effort } : null;
}

function buildResponsesRequestBody(openAICompatibleBody = {}) {
  const body = openAICompatibleBody && typeof openAICompatibleBody === 'object'
    ? stripTopPField({ ...openAICompatibleBody })
    : {};
  const requestBody = {
    model: body.model,
    input: Array.isArray(body.input) || typeof body.input === 'string'
      ? body.input
      : mapChatMessagesToResponsesInput(body.messages),
    stream: Boolean(body.stream)
  };

  if (Number.isFinite(Number(body.temperature))) requestBody.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) requestBody.top_p = Number(body.top_p);
  if (Number.isFinite(Number(body.top_k))) requestBody.top_k = Math.floor(Number(body.top_k));
  if (Number.isFinite(Number(body.top_a))) requestBody.top_a = Number(body.top_a);
  if (Number.isFinite(Number(body.repetition_penalty))) requestBody.repetition_penalty = Number(body.repetition_penalty);
  if (Number.isFinite(Number(body.max_output_tokens))) {
    requestBody.max_output_tokens = Math.floor(Number(body.max_output_tokens));
  } else if (Number.isFinite(Number(body.max_tokens))) {
    requestBody.max_output_tokens = Math.floor(Number(body.max_tokens));
  }
  const reasoning = body.reasoning && typeof body.reasoning === 'object'
    ? body.reasoning
    : mapReasoningEffortToResponses(body.reasoning_effort);
  if (reasoning) requestBody.reasoning = reasoning;
  if (Array.isArray(body.tools)) {
    const tools = mapChatToolsToResponsesTools(body.tools);
    if (tools.length > 0) requestBody.tools = tools;
  }
  const toolChoice = mapToolChoiceToResponses(body.tool_choice);
  if (toolChoice) requestBody.tool_choice = toolChoice;
  if (body.prompt_cache_key) requestBody.prompt_cache_key = body.prompt_cache_key;
  if (body.prompt_cache_retention) requestBody.prompt_cache_retention = body.prompt_cache_retention;
  if (body.user) requestBody.user = body.user;
  if (body.service_tier) requestBody.service_tier = body.service_tier;
  if (body.text) requestBody.text = body.text;
  if (body.truncation) requestBody.truncation = body.truncation;
  if (Array.isArray(body.include)) requestBody.include = body.include;
  if (body.previous_response_id) requestBody.previous_response_id = body.previous_response_id;
  return requestBody;
}

module.exports = {
  buildResponsesRequestBody,
  buildChatCompletionsRequestBody,
  buildResponsesUrl,
  buildChatCompletionsFallbackUrl,
  hasResponsesProtocolFallbackAttempted,
  isOpenAICompatiblePromptCacheSchemaError,
  isOpenAIPromptCacheRetentionSchemaError,
  isResponsesProtocolUnsupportedError,
  isResponsesUrl,
  markResponsesProtocolFallbackAttempted,
  mapChatMessageToResponsesInput,
  mapChatMessagesToResponsesInput,
  mapChatToolsToResponsesTools,
  mapContentPartToResponsesInput,
  mapMessageContentToResponsesInput,
  mapReasoningEffortToResponses,
  mapToolChoiceToResponses,
  normalizeResponsesTextContent,
  preprocessOpenAICompatibleMessages,
  preprocessOpenAICompatibleMessagesWithoutCache,
  requestUsesOpenAICompatiblePromptCaching,
  requestUsesOpenAIPromptCacheRetention,
  requestBodyLooksLikeChatCompletion,
  shouldFallbackResponsesProtocol,
  stripOpenAICompatiblePromptCaching,
  stripOpenAIPromptCacheRetentionFromRequest
};

