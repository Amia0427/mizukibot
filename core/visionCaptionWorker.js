const config = require('../config');
const { runStructuredSubagent } = require('./structuredSubagent');
const { buildVisionCaptionWorkerModelConfig } = require('../utils/imageModelConfigResolver');

const ALLOWED_IMAGE_SOURCES = new Set(['current', 'reply', 'forward']);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSource(value) {
  const source = normalizeText(value).toLowerCase();
  return ALLOWED_IMAGE_SOURCES.has(source) ? source : 'current';
}

function buildVisionCaptionSystemPrompt() {
  return [
    '你是图片视觉转述 worker。',
    '你只负责高精度视觉理解，并且只能输出 JSON。',
    '不要输出 markdown，不要输出解释，不要输出多余前后缀。',
    '必须综合全部输入图片，并保持 image_index 与输入顺序一致。',
    '如果存在不确定性，明确写入 uncertainties，不要伪造细节。',
    '如果图片里有文字，尽量提取到 visible_text 和 ocr_text。',
    'recommended_prompt_context 必须是适合后续主回复模型消费的中文文本摘要。',
    'short_persist_summary 必须比 recommended_prompt_context 更短，只保留后续连续对话最需要的视觉信息。',
    '输出 JSON shape:',
    '{',
    '  "summary": "string",',
    '  "images": [',
    '    {',
    '      "image_index": 0,',
    '      "source": "current|reply|forward",',
    '      "global_description": "string",',
    '      "subjects": ["string"],',
    '      "actions": ["string"],',
    '      "relationships": ["string"],',
    '      "visible_text": ["string"],',
    '      "layout": ["string"],',
    '      "style": "string",',
    '      "safety_signals": ["string"],',
    '      "uncertainties": ["string"]',
    '    }',
    '  ],',
    '  "cross_image_relations": ["string"],',
    '  "user_relevant_facts": ["string"],',
    '  "ocr_text": ["string"],',
    '  "recommended_prompt_context": "string",',
    '  "short_persist_summary": "string",',
    '  "confidence": 0.0,',
    '  "uncertainties": ["string"]',
    '}'
  ].join('\n');
}

function validateVisionCaptionOutput(output = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  if (!normalizeText(output.summary)) return false;
  if (!normalizeText(output.recommended_prompt_context)) return false;
  if (!normalizeText(output.short_persist_summary)) return false;
  if (!Array.isArray(output.images)) return false;
  const confidence = Number(output.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
  return output.images.every((item, index) => (
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && Number(item.image_index) === index
    && ALLOWED_IMAGE_SOURCES.has(normalizeSource(item.source))
    && typeof item.global_description === 'string'
    && Array.isArray(item.subjects)
    && Array.isArray(item.actions)
    && Array.isArray(item.relationships)
    && Array.isArray(item.visible_text)
    && Array.isArray(item.layout)
    && typeof item.style === 'string'
    && Array.isArray(item.safety_signals)
    && Array.isArray(item.uncertainties)
  ));
}

function buildVisionCaptionUserMessageContent(payload = {}) {
  const normalizedImages = normalizeArray(payload.images);
  const contextLines = [
    `original_user_text: ${normalizeText(payload.originalUserText) || '(empty)'}`,
    `image_count: ${normalizedImages.length}`,
    `quote_priority_mode: ${normalizeText(payload.quotePriorityMode) || 'none'}`,
    `quote_priority_reason: ${normalizeText(payload.quotePriorityReason) || ''}`,
    `instruction: prioritize user-relevant visual evidence and cross-image relationships.`,
    `instruction: do not assume facts not visible in the images.`,
    'Return JSON only.'
  ].filter(Boolean);

  const content = [{
    type: 'text',
    text: contextLines.join('\n')
  }];

  normalizedImages.forEach((item, index) => {
    const source = normalizeSource(item.source);
    const url = normalizeText(item.url);
    if (!url) return;
    content.push({
      type: 'text',
      text: `image_index=${index}\nsource=${source}\nsource_label=${normalizeText(item.label) || source}`
    });
    content.push({
      type: 'image_url',
      image_url: {
        url
      }
    });
  });

  return content;
}

function sanitizeStringList(value) {
  return normalizeArray(value).map((item) => normalizeText(item)).filter(Boolean);
}

function sanitizeVisionCaptionOutput(output = {}) {
  const confidence = Math.max(0, Math.min(1, Number(output.confidence) || 0));
  return {
    summary: normalizeText(output.summary),
    images: normalizeArray(output.images).map((item, index) => ({
      image_index: index,
      source: normalizeSource(item?.source),
      global_description: normalizeText(item?.global_description),
      subjects: sanitizeStringList(item?.subjects),
      actions: sanitizeStringList(item?.actions),
      relationships: sanitizeStringList(item?.relationships),
      visible_text: sanitizeStringList(item?.visible_text),
      layout: sanitizeStringList(item?.layout),
      style: normalizeText(item?.style),
      safety_signals: sanitizeStringList(item?.safety_signals),
      uncertainties: sanitizeStringList(item?.uncertainties)
    })),
    cross_image_relations: sanitizeStringList(output.cross_image_relations),
    user_relevant_facts: sanitizeStringList(output.user_relevant_facts),
    ocr_text: sanitizeStringList(output.ocr_text),
    recommended_prompt_context: normalizeText(output.recommended_prompt_context),
    short_persist_summary: normalizeText(output.short_persist_summary),
    confidence,
    uncertainties: sanitizeStringList(output.uncertainties)
  };
}

function buildRuntimeQuestionText(originalUserText = '', visionJson = {}) {
  const original = normalizeText(originalUserText);
  const serialized = JSON.stringify(visionJson);
  return [
    original ? `用户原始文本：${original}` : '用户原始文本：（用户只发送了图片）',
    'VisionCaptionJSON:',
    serialized,
    '约束：后续主链只能把上面的 VisionCaptionJSON 作为视觉证据，不要假设自己直接看到了图片。'
  ].join('\n');
}

function buildPersistUserText(originalUserText = '', shortPersistSummary = '') {
  const original = normalizeText(originalUserText);
  const summary = normalizeText(shortPersistSummary);
  return [
    original ? `用户原始文本：${original}` : '用户原始文本：（用户只发送了图片）',
    summary ? `视觉摘要：${summary}` : ''
  ].filter(Boolean).join('\n');
}

async function runVisionCaptionWorker(input = {}) {
  const enabled = config.VISION_CAPTION_WORKER_ENABLED === true;
  const modelConfig = buildVisionCaptionWorkerModelConfig();
  const baseUrl = normalizeText(modelConfig.baseUrl);
  const apiKey = normalizeText(modelConfig.apiKey);
  const images = normalizeArray(input.images)
    .filter((item) => item && typeof item === 'object' && normalizeText(item.url))
    .slice(0, Math.max(1, Number(config.VISION_CAPTION_WORKER_MAX_IMAGES || 8) || 8))
    .map((item, index) => ({
      imageIndex: index,
      url: normalizeText(item.url),
      source: normalizeSource(item.source),
      label: normalizeText(item.label)
    }));

  if (!enabled || !baseUrl || !apiKey || !images.length) {
    return {
      ok: false,
      fallbackReason: !enabled ? 'disabled' : (!baseUrl || !apiKey ? 'missing_config' : 'no_images'),
      modelConfig,
      images,
      visualContext: null
    };
  }

  const result = await runStructuredSubagent({
    agentName: 'vision-caption-worker',
    systemPrompt: buildVisionCaptionSystemPrompt(),
    userPayload: {
      originalUserText: normalizeText(input.originalUserText),
      images
    },
    userMessageContent: buildVisionCaptionUserMessageContent({
      originalUserText: input.originalUserText,
      images,
      quotePriorityMode: input.quotePriorityMode,
      quotePriorityReason: input.quotePriorityReason
    }),
    modelResolver: () => modelConfig,
    validateOutput: validateVisionCaptionOutput
  });

  if (!result.ok) {
    return {
      ok: false,
      fallbackReason: normalizeText(result.failureReason) || 'worker_failed',
      modelConfig,
      images,
      visualContext: null
    };
  }

  const sanitized = sanitizeVisionCaptionOutput(result.output);
  const runtimeQuestionText = buildRuntimeQuestionText(input.originalUserText, sanitized);
  const persistUserText = buildPersistUserText(input.originalUserText, sanitized.short_persist_summary);
  const visualContext = {
    hasVisualInput: true,
    worker: {
      name: 'vision-caption-worker',
      succeeded: true,
      fallbackUsed: false,
      fallbackReason: '',
      model: normalizeText(modelConfig.model),
      imageCount: images.length
    },
    images: images.map((item, index) => ({
      imageIndex: index,
      source: item.source,
      url: item.url,
      label: item.label
    })),
    captionJson: sanitized,
    summary: sanitized.summary,
    recommendedPromptContext: sanitized.recommended_prompt_context,
    shortPersistSummary: sanitized.short_persist_summary,
    runtimeQuestionText,
    persistUserText,
    originalUserText: normalizeText(input.originalUserText)
  };

  return {
    ok: true,
    fallbackReason: '',
    modelConfig,
    images,
    visualContext
  };
}

module.exports = {
  buildPersistUserText,
  buildRuntimeQuestionText,
  buildVisionCaptionSystemPrompt,
  runVisionCaptionWorker
};
