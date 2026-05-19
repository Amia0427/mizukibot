const {
  extractUrlFromText,
  parseJsonTextSafe,
  summarizePayloadShape
} = require('./requestUtils');

function extractImageFromGenerationResponse(payload = {}) {
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!first || typeof first !== 'object') {
    throw new Error('generation response missing image data');
  }

  const b64Json = String(first.b64_json || '').trim();
  if (b64Json) {
    return {
      kind: 'b64_json',
      value: b64Json
    };
  }

  const url = String(first.url || '').trim();
  if (url) {
    return {
      kind: 'url',
      value: url
    };
  }

  throw new Error('generation response missing image data');
}

function extractImageResultFromChatContentPart(part = {}) {
  if (!part || typeof part !== 'object') return null;

  const b64Json = String(
    part.b64_json
    || part.base64
    || part.image_base64
    || part.output_b64
    || part.result_b64
    || ''
  ).trim();
  if (b64Json) {
    return {
      kind: 'b64_json',
      value: b64Json
    };
  }

  const imageUrl = String(
    part?.image_url?.url
    || part?.image_url
    || part?.url
    || part?.file_url
    || extractUrlFromText(part?.text || part?.content || '')
    || ''
  ).trim();
  if (imageUrl) {
    return {
      kind: 'url',
      value: imageUrl
    };
  }

  return null;
}

function extractImageResultFromTextBlob(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;

  const directDataUrl = extractUrlFromText(text);
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(directDataUrl)) {
    return {
      kind: 'url',
      value: directDataUrl
    };
  }

  const parsedJson = parseJsonTextSafe(text);
  if (parsedJson && typeof parsedJson === 'object') {
    const parsedDirect = extractImageResultFromChatContentPart(parsedJson);
    if (parsedDirect) return parsedDirect;
    try {
      return extractImageFromGenerationResponse(parsedJson);
    } catch (_) {}
  }

  const urlMatch = extractUrlFromText(text);
  if (urlMatch) {
    return {
      kind: 'url',
      value: urlMatch
    };
  }

  return null;
}

function collectChatCompletionsTextFragments(payload = {}) {
  const fragments = [];
  if (!payload || typeof payload !== 'object') return fragments;

  const collectFromValue = (value) => {
    if (typeof value === 'string') {
      fragments.push(value);
      return;
    }
    if (!Array.isArray(value)) return;
    for (const part of value) {
      if (typeof part === 'string') {
        fragments.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') fragments.push(part.text);
      else if (typeof part.content === 'string') fragments.push(part.content);
    }
  };

  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    collectFromValue(choice?.message?.content);
    collectFromValue(choice?.delta?.content);
  }

  collectFromValue(payload?.message?.content);
  collectFromValue(payload?.delta?.content);
  return fragments;
}

function extractImageFromChatCompletionsResponse(payload = {}) {
  const directCandidates = [
    Array.isArray(payload?.data) ? payload.data : [],
    Array.isArray(payload?.images) ? payload.images : [],
    Array.isArray(payload?.output) ? payload.output : []
  ];
  for (const candidateList of directCandidates) {
    for (const item of candidateList) {
      const directImage = extractImageResultFromChatContentPart(item);
      if (directImage) return directImage;

      const nestedParts = Array.isArray(item?.content) ? item.content : [];
      for (const part of nestedParts) {
        const partImage = extractImageResultFromChatContentPart(part);
        if (partImage) return partImage;
      }
    }
  }

  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const directImage = extractImageResultFromChatContentPart(choice);
    if (directImage) return directImage;

    const message = choice?.message && typeof choice.message === 'object' ? choice.message : {};
    const messageImage = extractImageResultFromChatContentPart(message);
    if (messageImage) return messageImage;
    const messageTextImage = extractImageResultFromTextBlob(message?.content);
    if (messageTextImage) return messageTextImage;

    const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const deltaImage = extractImageResultFromChatContentPart(delta);
    if (deltaImage) return deltaImage;
    const deltaTextImage = extractImageResultFromTextBlob(delta?.content);
    if (deltaTextImage) return deltaTextImage;

    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const partImage = extractImageResultFromChatContentPart(part);
        if (partImage) return partImage;
        const partTextImage = extractImageResultFromTextBlob(part?.text || part?.content || '');
        if (partTextImage) return partTextImage;
      }
    }

    const deltaContent = delta?.content;
    if (Array.isArray(deltaContent)) {
      for (const part of deltaContent) {
        const partImage = extractImageResultFromChatContentPart(part);
        if (partImage) return partImage;
        const partTextImage = extractImageResultFromTextBlob(part?.text || part?.content || '');
        if (partTextImage) return partTextImage;
      }
    }
  }

  const aggregatedText = collectChatCompletionsTextFragments(payload).join('').trim();
  if (aggregatedText) {
    const aggregatedImage = extractImageResultFromTextBlob(aggregatedText);
    if (aggregatedImage) return aggregatedImage;
  }

  throw new Error('chat completions response missing image data');
}

function extractImageFromStreamEventPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const b64Json = String(payload.b64_json || payload.partial_image_b64 || '').trim();
  if (b64Json) {
    return {
      kind: 'b64_json',
      value: b64Json,
      eventType: String(payload.type || '').trim()
    };
  }

  const url = String(payload.url || '').trim();
  if (url) {
    return {
      kind: 'url',
      value: url,
      eventType: String(payload.type || '').trim()
    };
  }

  try {
    const nestedImage = extractImageFromGenerationResponse(payload);
    return {
      ...nestedImage,
      eventType: String(payload.type || '').trim()
    };
  } catch (_) {
    try {
      const nestedChatImage = extractImageFromChatCompletionsResponse(payload);
      return {
        ...nestedChatImage,
        eventType: String(payload.type || '').trim()
      };
    } catch (_) {
      return null;
    }
  }
}

function extractStreamFailureMessage(payload = {}) {
  if (!payload || typeof payload !== 'object') return '';

  const type = String(payload.type || '').trim().toLowerCase();
  const errorMessage = String(
    payload?.error?.message
    || payload?.error?.detail
    || payload?.message
    || ''
  ).trim();

  if (type === 'error' || type.endsWith('.failed')) {
    return errorMessage || summarizePayloadShape(payload);
  }

  return '';
}

module.exports = {
  collectChatCompletionsTextFragments,
  extractImageFromChatCompletionsResponse,
  extractImageFromGenerationResponse,
  extractImageFromStreamEventPayload,
  extractImageResultFromChatContentPart,
  extractImageResultFromTextBlob,
  extractStreamFailureMessage
};
