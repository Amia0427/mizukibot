const fs = require('fs');
const path = require('path');
const {
  normalizeText,
  parseCacheRef,
  readCachedImagePayload,
  stripCacheControlFieldsDeep
} = require('./runtime-core.chunk');
const {
  buildUnavailableImageText,
  fetchRemoteImage,
  inferImageMediaType,
  isQqImageUrl
} = require('./images.chunk');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_GEMINI_SYSTEM_PROMPT_PATH = path.join(PROJECT_ROOT, 'prompts', 'GEMINI.txt');
const DEFAULT_GEMINI_ROLEPLAY_GUIDELINES_PATH = path.join(PROJECT_ROOT, 'prompts', 'persona', 'AI角色扮演规范文件.md');
const geminiSystemPromptCache = new Map();
const geminiRoleplayGuidelinesCache = new Map();

function ensureGeminiStreamSseUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    parsed.searchParams.set('alt', 'sse');
    return parsed.toString();
  } catch (_) {
    const hashIndex = raw.indexOf('#');
    const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const hash = hashIndex >= 0 ? raw.slice(hashIndex) : '';
    if (/[?&]alt=/i.test(base)) {
      return `${base.replace(/([?&]alt=)[^&#]*/i, '$1sse')}${hash}`;
    }
    return `${base}${base.includes('?') ? '&' : '?'}alt=sse${hash}`;
  }
}

function finalizeGeminiNativeEndpoint(url = '', stream = false) {
  if (!stream) return url;
  const streamUrl = String(url || '').replace(/:generateContent(?=([?#]|$))/i, ':streamGenerateContent');
  return ensureGeminiStreamSseUrl(streamUrl);
}

function normalizeGeminiNativeApiBaseUrl(url = '', model = '', options = {}) {
  const stream = options === true || Boolean(options?.stream);
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw) return raw;
  if (/\/models\/[^/?#]+:(?:stream)?generatecontent(?:[?#].*)?$/i.test(raw)) {
    return finalizeGeminiNativeEndpoint(raw, stream);
  }
  const modelName = normalizeText(model || process.env.AI_MODEL || 'gemini-3-pro-preview') || 'gemini-3-pro-preview';
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  if (/\/(?:chat\/completions|responses|messages)(?:\/)?$/i.test(raw)) {
    const versionRoot = raw.replace(/\/(?:chat\/completions|responses|messages)(?:\/)?$/i, '');
    return finalizeGeminiNativeEndpoint(`${versionRoot}/models/${encodeURIComponent(modelName)}:${action}`, stream);
  }
  if (/\/v(?:1|1beta)(?:\/)?$/i.test(raw)) {
    return finalizeGeminiNativeEndpoint(`${raw}/models/${encodeURIComponent(modelName)}:${action}`, stream);
  }
  return raw;
}

function isGeminiNativeSystemPromptEnabled() {
  const raw = normalizeText(
    process.env.GEMINI_NATIVE_SYSTEM_PROMPT_ENABLED
    || ''
  ).toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function getGeminiSystemPromptPath() {
  return normalizeText(
    process.env.GEMINI_SYSTEM_PROMPT_PATH
    || ''
  ) || DEFAULT_GEMINI_SYSTEM_PROMPT_PATH;
}

function getGeminiRoleplayGuidelinesPath() {
  return normalizeText(
    process.env.GEMINI_ROLEPLAY_GUIDELINES_PATH
    || ''
  ) || DEFAULT_GEMINI_ROLEPLAY_GUIDELINES_PATH;
}

function isGeminiRoleplayGuidelinesEnabled() {
  const raw = normalizeText(
    process.env.GEMINI_ROLEPLAY_GUIDELINES_ENABLED
    || ''
  ).toLowerCase();
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function loadGeminiSystemPrompt() {
  if (!isGeminiNativeSystemPromptEnabled()) return '';
  const filePath = getGeminiSystemPromptPath();
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return '';
  }
  if (!stat || !stat.isFile()) return '';

  const cacheKey = `${path.resolve(filePath)}::${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}`;
  if (geminiSystemPromptCache.has(cacheKey)) return geminiSystemPromptCache.get(cacheKey);
  const text = fs.readFileSync(filePath, 'utf8').trim();
  geminiSystemPromptCache.clear();
  geminiSystemPromptCache.set(cacheKey, text);
  return text;
}

function loadGeminiRoleplayGuidelines() {
  if (!isGeminiRoleplayGuidelinesEnabled()) return '';
  const filePath = getGeminiRoleplayGuidelinesPath();
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return '';
  }
  if (!stat || !stat.isFile()) return '';

  const cacheKey = `${path.resolve(filePath)}::${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}`;
  if (geminiRoleplayGuidelinesCache.has(cacheKey)) return geminiRoleplayGuidelinesCache.get(cacheKey);
  const text = fs.readFileSync(filePath, 'utf8').trim();
  geminiRoleplayGuidelinesCache.clear();
  geminiRoleplayGuidelinesCache.set(cacheKey, text);
  return text;
}

function normalizePartText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  return String(part.text || part.content || part.output_text || part.outputText || '');
}

function normalizePromptForCompare(value = '') {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function systemTextsContainPrompt(systemTexts = [], prompt = '') {
  const needle = normalizePromptForCompare(prompt);
  if (!needle) return false;
  return (Array.isArray(systemTexts) ? systemTexts : [])
    .some((item) => normalizePromptForCompare(item).includes(needle));
}

function extractDataUrlPayload(url = '') {
  const match = String(url || '').trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: String(match[2] || '').replace(/\s+/g, '')
  };
}

function buildGeminiInlineDataPart(mediaType = 'image/jpeg', data = '') {
  const cleanData = String(data || '').replace(/\s+/g, '');
  if (!cleanData) return null;
  return {
    inlineData: {
      mimeType: normalizeText(mediaType) || 'image/jpeg',
      data: cleanData
    }
  };
}

async function resolveGeminiImagePart(part = {}) {
  const inlineData = normalizeText(
    part?.data
    || part?.image?.data
    || part?.source?.data
    || ''
  );
  const inlineMediaType = normalizeText(
    part?.media_type
    || part?.mime
    || part?.image?.media_type
    || part?.source?.media_type
    || ''
  ).toLowerCase();
  const sourceType = normalizeText(part?.source?.type || '').toLowerCase();
  if (inlineData && (sourceType === 'base64' || part?.type === 'input_image' || part?.type === 'image')) {
    return buildGeminiInlineDataPart(inlineMediaType || 'image/jpeg', inlineData);
  }

  const imageUrl = normalizeText(part?.image_url?.url || part?.url || '');
  if (!imageUrl) return null;
  const dataUrlPayload = extractDataUrlPayload(imageUrl);
  if (dataUrlPayload) return buildGeminiInlineDataPart(dataUrlPayload.mimeType, dataUrlPayload.data);

  const cacheRef = parseCacheRef(imageUrl);
  const cachedImage = cacheRef ? readCachedImagePayload(imageUrl) : null;
  if (cachedImage?.data) {
    return buildGeminiInlineDataPart(cachedImage.mediaType || 'image/jpeg', cachedImage.data);
  }
  if (cacheRef) {
    return { text: buildUnavailableImageText(imageUrl) };
  }

  if (isQqImageUrl(imageUrl)) {
    return { text: buildUnavailableImageText(imageUrl) };
  }

  try {
    const fetched = await fetchRemoteImage(imageUrl);
    return buildGeminiInlineDataPart(
      inferImageMediaType(imageUrl, fetched.headers),
      Buffer.from(fetched.buffer).toString('base64')
    );
  } catch (error) {
    const details = error?.response?.status ? `status=${error.response.status}` : (error?.message || 'unknown-error');
    console.warn('[vision] failed to fetch image url for gemini-native part: ' + details);
    return { text: buildUnavailableImageText(imageUrl) };
  }
}

async function mapContentToGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const rawPart of content) {
      if (typeof rawPart === 'string') {
        parts.push({ text: rawPart });
        continue;
      }
      if (!rawPart || typeof rawPart !== 'object') continue;
      const part = stripCacheControlFieldsDeep(rawPart);
      const type = normalizeText(part.type).toLowerCase();
      if (type === 'image_url' || type === 'input_image' || type === 'image') {
        const imagePart = await resolveGeminiImagePart(part);
        if (imagePart) parts.push(imagePart);
        continue;
      }
      const text = normalizePartText(part);
      if (text) parts.push({ text });
    }
    return parts;
  }
  if (content && typeof content === 'object') {
    const type = normalizeText(content.type).toLowerCase();
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      const imagePart = await resolveGeminiImagePart(stripCacheControlFieldsDeep(content));
      return imagePart ? [imagePart] : [];
    }
    const text = normalizePartText(content);
    return text ? [{ text }] : [];
  }
  const fallback = String(content || '');
  return fallback ? [{ text: fallback }] : [];
}

function mapRoleToGemini(role = '') {
  const normalized = normalizeText(role).toLowerCase();
  if (normalized === 'assistant' || normalized === 'model') return 'model';
  return 'user';
}

function normalizeGeminiToolName(name = '') {
  return normalizeText(name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

function mapToolToGeminiFunctionDeclaration(tool = {}) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  if (normalizeText(tool.type) !== 'function') return null;
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : {};
  const name = normalizeGeminiToolName(fn.name);
  if (!name) return null;
  const declaration = {
    name,
    parameters: fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} }
  };
  const description = normalizeText(fn.description);
  if (description) declaration.description = description;
  return declaration;
}

function mapToolChoiceToGemini(toolChoice) {
  if (!toolChoice) return null;
  if (typeof toolChoice === 'string') {
    const normalized = normalizeText(toolChoice).toLowerCase();
    if (normalized === 'auto') return { mode: 'AUTO' };
    if (normalized === 'none') return { mode: 'NONE' };
    if (normalized === 'required') return { mode: 'ANY' };
    return null;
  }
  if (toolChoice && typeof toolChoice === 'object' && normalizeText(toolChoice.type).toLowerCase() === 'function') {
    const name = normalizeGeminiToolName(toolChoice?.function?.name || toolChoice.name || '');
    return name ? { mode: 'ANY', allowedFunctionNames: [name] } : { mode: 'ANY' };
  }
  return null;
}

async function mapMessagesToGemini(messages = []) {
  const systemTexts = [];
  const contents = [];
  const items = Array.isArray(messages) ? messages : [];

  for (const message of items) {
    if (!message || typeof message !== 'object') continue;
    const role = normalizeText(message.role).toLowerCase();
    if (role === 'system' || role === 'developer') {
      const parts = await mapContentToGeminiParts(message.content);
      const text = parts.map((part) => normalizeText(part.text)).filter(Boolean).join('\n');
      if (text) systemTexts.push(text);
      continue;
    }
    if (role === 'tool') {
      const toolName = normalizeGeminiToolName(message.name || message.tool_name || message.tool_call_id || 'tool_result');
      const responseText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || {});
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: toolName || 'tool_result',
            response: {
              result: responseText || '(empty tool result)'
            }
          }
        }]
      });
      continue;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const functionCallParts = message.tool_calls
        .map((call) => {
          const name = normalizeGeminiToolName(call?.function?.name || call?.name || '');
          if (!name) return null;
          let args = {};
          try {
            args = JSON.parse(String(call?.function?.arguments || call?.args || '{}'));
          } catch (_) {
            args = {};
          }
          return { functionCall: { name, args } };
        })
        .filter(Boolean);
      if (functionCallParts.length > 0) {
        contents.push({ role: 'model', parts: functionCallParts });
        continue;
      }
    }
    const parts = await mapContentToGeminiParts(message.content);
    contents.push({
      role: mapRoleToGemini(role),
      parts: parts.length ? parts : [{ text: '' }]
    });
  }

  return {
    systemTexts,
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: '(empty input)' }] }]
  };
}

function normalizeGeminiGenerationConfig(body = {}) {
  const generationConfig = {};
  const temperature = Number(body.temperature);
  if (Number.isFinite(temperature)) generationConfig.temperature = Math.max(0, Math.min(2, temperature));
  const topP = Number(body.top_p);
  if (Number.isFinite(topP)) generationConfig.topP = Math.max(0, Math.min(1, topP));
  const topK = Number(body.top_k);
  if (Number.isFinite(topK) && topK > 0) generationConfig.topK = Math.floor(topK);
  const maxTokens = Number(body.max_output_tokens ?? body.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.floor(maxTokens);
  if (Array.isArray(body.stop) && body.stop.length > 0) {
    generationConfig.stopSequences = body.stop.map((item) => normalizeText(item)).filter(Boolean);
  }
  return Object.keys(generationConfig).length > 0 ? generationConfig : null;
}

async function buildGeminiNativeRequestBody(inputBody = {}) {
  const body = stripCacheControlFieldsDeep(inputBody && typeof inputBody === 'object' ? { ...inputBody } : {});
  const mapped = Array.isArray(body.contents)
    ? { systemTexts: [], contents: body.contents }
    : await mapMessagesToGemini(body.messages);
  const sourceSystemTexts = [];
  if (body.systemInstruction?.parts || body.system_instruction?.parts) {
    const existing = body.systemInstruction || body.system_instruction;
    const text = (Array.isArray(existing.parts) ? existing.parts : [])
      .map((part) => normalizeText(part?.text))
      .filter(Boolean)
      .join('\n');
    if (text) sourceSystemTexts.push(text);
  } else {
    sourceSystemTexts.push(...mapped.systemTexts);
  }
  const systemTexts = [];
  const geminiPrompt = loadGeminiSystemPrompt();
  if (geminiPrompt) {
    systemTexts.push(systemTextsContainPrompt(sourceSystemTexts, geminiPrompt)
      ? '[GeminiRuntimeAdapter]'
      : `[GeminiRuntimeAdapter]\n${geminiPrompt}`);
  }
  const geminiRoleplayGuidelines = loadGeminiRoleplayGuidelines();
  if (geminiRoleplayGuidelines) systemTexts.push(`[GeminiRoleplayGuidelines]\n${geminiRoleplayGuidelines}`);
  systemTexts.push(...sourceSystemTexts);

  const requestBody = {
    contents: mapped.contents
  };
  const systemInstructionText = systemTexts.map((item) => normalizeText(item)).filter(Boolean).join('\n\n');
  if (systemInstructionText) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstructionText }]
    };
  }
  const generationConfig = normalizeGeminiGenerationConfig(body);
  if (generationConfig) requestBody.generationConfig = generationConfig;

  if (Array.isArray(body.tools)) {
    const declarations = body.tools.map(mapToolToGeminiFunctionDeclaration).filter(Boolean);
    if (declarations.length > 0) {
      requestBody.tools = [{ functionDeclarations: declarations }];
      const functionCallingConfig = mapToolChoiceToGemini(body.tool_choice);
      if (functionCallingConfig) {
        requestBody.toolConfig = { functionCallingConfig };
      }
    }
  }
  if (Array.isArray(body.safetySettings)) requestBody.safetySettings = body.safetySettings;
  else if (Array.isArray(body.safety_settings)) requestBody.safetySettings = body.safety_settings;

  return requestBody;
}

function clearGeminiNativePromptCache() {
  geminiSystemPromptCache.clear();
  geminiRoleplayGuidelinesCache.clear();
}

module.exports = {
  DEFAULT_GEMINI_SYSTEM_PROMPT_PATH,
  DEFAULT_GEMINI_ROLEPLAY_GUIDELINES_PATH,
  buildGeminiNativeRequestBody,
  clearGeminiNativePromptCache,
  getGeminiSystemPromptPath,
  getGeminiRoleplayGuidelinesPath,
  isGeminiNativeSystemPromptEnabled,
  isGeminiRoleplayGuidelinesEnabled,
  loadGeminiSystemPrompt,
  loadGeminiRoleplayGuidelines,
  mapMessagesToGemini,
  normalizeGeminiNativeApiBaseUrl
};
