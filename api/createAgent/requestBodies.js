const CREATE_AGENT_STREAM_PARTIAL_IMAGES = 1;

function buildImageGenerationRequestBody(prompt = '', runtimeConfig = {}, options = {}) {
  const body = {
    model: runtimeConfig.model,
    prompt,
    size: runtimeConfig.imageSize,
    quality: runtimeConfig.imageQuality,
    style: runtimeConfig.imageStyle,
    background: runtimeConfig.imageBackground,
    output_format: runtimeConfig.outputFormat,
    output_compression: runtimeConfig.imageOutputCompression,
    response_format: runtimeConfig.responseFormat
  };

  if (options.stream) {
    body.stream = true;
    body.partial_images = Math.max(
      0,
      Math.min(3, Number(options.partialImages ?? CREATE_AGENT_STREAM_PARTIAL_IMAGES) || 0)
    );
  }
  return body;
}

function buildChatCompletionsImagePrompt(prompt = '', runtimeConfig = {}) {
  const responseFormat = String(runtimeConfig.responseFormat || 'b64_json').trim().toLowerCase();
  const lines = [
    'Generate exactly one high-quality image that follows the prompt below.',
    `Prompt: ${String(prompt || '').trim()}`,
    `Image size: ${String(runtimeConfig.imageSize || '1024x1024').trim()}`,
    `Quality: ${String(runtimeConfig.imageQuality || 'high').trim()}`,
    `Style: ${String(runtimeConfig.imageStyle || 'vivid').trim()}`,
    `Background: ${String(runtimeConfig.imageBackground || 'auto').trim()}`,
    `Output format: ${String(runtimeConfig.outputFormat || 'png').trim()}`,
    `Response format preference: ${responseFormat}`,
    responseFormat === 'url'
      ? 'Return only a direct image URL or a data:image/... URL when possible. Do not return prose.'
      : 'If returning JSON, return one complete final image payload such as {"b64_json":"..."} without truncation or splitting across content blocks.',
    'Return image output only.'
  ];
  return lines.join('\n');
}

function buildChatCompletionsImageRequestBody(prompt = '', runtimeConfig = {}, options = {}) {
  return {
    model: runtimeConfig.model,
    messages: [
      {
        role: 'user',
        content: buildChatCompletionsImagePrompt(prompt, runtimeConfig)
      }
    ],
    stream: Boolean(options.stream)
  };
}

function omitObjectKeys(source = {}, keys = []) {
  const next = { ...(source && typeof source === 'object' ? source : {}) };
  for (const key of (Array.isArray(keys) ? keys : [])) {
    delete next[String(key || '').trim()];
  }
  return next;
}

function pickObjectKeys(source = {}, keys = []) {
  const next = {};
  const rawSource = source && typeof source === 'object' ? source : {};
  for (const key of (Array.isArray(keys) ? keys : [])) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    if (!Object.prototype.hasOwnProperty.call(rawSource, normalizedKey)) continue;
    next[normalizedKey] = rawSource[normalizedKey];
  }
  return next;
}

function buildImageGenerationRequestBodyVariants(prompt = '', runtimeConfig = {}, options = {}) {
  const fullBody = buildImageGenerationRequestBody(prompt, runtimeConfig, options);
  const variants = [
    fullBody,
    omitObjectKeys(fullBody, ['style']),
    omitObjectKeys(fullBody, ['style', 'background']),
    omitObjectKeys(fullBody, ['style', 'background', 'output_format', 'output_compression']),
    omitObjectKeys(fullBody, ['style', 'background', 'output_format', 'output_compression', 'quality']),
    omitObjectKeys(fullBody, ['style', 'background', 'output_format', 'output_compression', 'quality', 'response_format'])
  ];

  if (options.stream) {
    variants.push(
      omitObjectKeys(fullBody, [
        'style',
        'background',
        'output_format',
        'output_compression',
        'quality',
        'response_format',
        'partial_images'
      ])
    );
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt', 'size', 'stream']));
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt', 'stream']));
  } else {
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt', 'size']));
    variants.push(pickObjectKeys(fullBody, ['model', 'prompt']));
  }

  const seen = new Set();
  return variants.filter((variant) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  CREATE_AGENT_STREAM_PARTIAL_IMAGES,
  buildImageGenerationRequestBody,
  buildChatCompletionsImagePrompt,
  buildChatCompletionsImageRequestBody,
  omitObjectKeys,
  pickObjectKeys,
  buildImageGenerationRequestBodyVariants
};
