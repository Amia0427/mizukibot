const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { todayStrInTz } = require('../utils/time');
const { extractSSEEvents, flushSSEState } = require('./parser');
const { sendGroupImageMessage } = require('./qqActionService');

const CREATE_AGENT_DIR = path.join(config.DATA_DIR, 'create-agent');
const CREATE_AGENT_QUOTA_FILE = path.join(CREATE_AGENT_DIR, 'quota.json');
const CREATE_AGENT_RUNTIME_FILE = path.join(CREATE_AGENT_DIR, 'runtime.json');
const CREATE_AGENT_ERROR_LOG_FILE = path.join(CREATE_AGENT_DIR, 'errors.log');
const DEFAULT_IMAGE_EXTENSION = '.png';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const CREATE_AGENT_STREAM_PARTIAL_IMAGES = 1;
const CREATE_AGENT_ADMIN_USER_IDS = new Set((config.ADMIN_USER_IDS || []).map((item) => String(item || '').trim()).filter(Boolean));

function ensureDirSync(dirPath = '') {
  const fullPath = path.resolve(String(dirPath || '').trim());
  if (!fullPath) return '';
  fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

function readJsonFileSafe(filePath = '', fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed;
  } catch (_) {
    return fallback;
  }
}

function writeJsonFileSafe(filePath = '', value = {}) {
  const target = path.resolve(String(filePath || '').trim());
  if (!target) return;
  ensureDirSync(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

function appendTextFileSafe(filePath = '', text = '') {
  const target = path.resolve(String(filePath || '').trim());
  const content = String(text || '');
  if (!target || !content) return;
  ensureDirSync(path.dirname(target));
  fs.appendFileSync(target, content, 'utf8');
}

function normalizePromptText(prompt = '') {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIdList(list = []) {
  return Array.from(new Set(
    (Array.isArray(list) ? list : [list])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));
}

function buildCreateAgentAllowedUserIds(overrides = {}) {
  const configAllowUserIds = normalizeIdList(overrides.allowUserIds ?? config.CREATE_AGENT_ALLOW_USER_IDS ?? []);
  return new Set([
    ...CREATE_AGENT_ADMIN_USER_IDS,
    ...configAllowUserIds
  ]);
}

function isCreateAgentUserAllowed(userId = '', overrides = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return false;
  return buildCreateAgentAllowedUserIds(overrides).has(normalizedUserId);
}

function normalizeRequestedImageSize(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';

  const sizeMatch = raw.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!sizeMatch) return '1024x1024';

  const width = Number(sizeMatch[1] || 0);
  const height = Number(sizeMatch[2] || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1024x1024';
  }
  return `${width}x${height}`;
}

function buildResolutionQualityClause(imageSize = '') {
  const normalizedSize = normalizeRequestedImageSize(imageSize);
  const sizeMatch = normalizedSize.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!sizeMatch) {
    return 'Target native high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }

  const width = Number(sizeMatch[1] || 0);
  const height = Number(sizeMatch[2] || 0);
  const longestEdge = Math.max(width, height);
  if (longestEdge >= 3840) {
    return 'Target true 4K-class clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  if (longestEdge >= 2048) {
    return 'Target true 2K-class clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  if (longestEdge >= 1536) {
    return 'Target high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  return 'Target clean high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
}

function buildCreateAgentPrompt(rawPrompt = '', options = {}) {
  const prompt = normalizePromptText(rawPrompt);
  if (!prompt) return '';

  const effectiveSize = normalizeRequestedImageSize(options.imageSize || '');
  const hasSizeHint = /(1024|1536|2048|4096|1k|2k|4k|1080p|high[- ]?res|high resolution|ultra)/i.test(prompt);
  const hasPhotoHint = /(照片|摄影|真实|写实|photoreal|photo[- ]?real|iphone photo|realistic)/i.test(prompt);
  const hasNoTextHint = /(不要文字|无文字|no text|without text|不要水印|no watermark)/i.test(prompt);
  const hasCompositionHint = /(竖图|横图|方图|portrait|landscape|square|9:16|16:9|手机截图|海报|poster|screenshot)/i.test(prompt);
  const hasSharpnessHint = /(清晰|锐利|锐度|sharp|crisp|high detail|fine detail|ultra detailed|detailed skin|clean lineart|clean linework)/i.test(prompt);
  const hasAntiBlurHint = /(不要模糊|避免模糊|no blur|avoid blur|sharp focus|in focus|clear edges|anti[- ]blur)/i.test(prompt);

  const clauses = [prompt];
  if (!hasPhotoHint) {
    clauses.push('Use clean composition and natural lighting with coherent details.');
  }
  if (!hasSharpnessHint) {
    clauses.push('Prioritize crisp focus, sharp edges, clean linework, high local contrast, and dense fine details.');
  }
  if (!hasAntiBlurHint) {
    clauses.push('Avoid blur, softness, haze, washed-out textures, smeared details, and low-detail backgrounds.');
  }
  clauses.push(buildResolutionQualityClause(effectiveSize));
  clauses.push('Preserve facial features, eyes, hands, hair strands, clothing textures, object edges, and small foreground details without mushiness.');
  if (!hasNoTextHint) {
    clauses.push('No text, watermark, UI, screenshot, or logo.');
  }
  if (!hasCompositionHint) {
    clauses.push('Render it as a polished single-image composition.');
  }
  if (!hasSizeHint) {
    clauses.push(`Prefer a polished single-image composition suitable for a ${effectiveSize === 'auto' ? 'native high-quality image output' : effectiveSize + ' output'}.`);
  }
  return clauses.join(' ');
}

function detectImageExtension(buffer = Buffer.alloc(0), fallback = DEFAULT_IMAGE_EXTENSION, mimeType = '') {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';

  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return fallback;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (
    buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) return '.webp';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif';
  return fallback;
}

function buildOutputBasename(prompt = '') {
  const datePart = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const normalized = normalizePromptText(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${datePart}-${normalized || 'create'}-${suffix}`;
}

function normalizeCreateAgentBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const stripKnownSuffix = (pathname = '') => String(pathname || '')
    .replace(/\/+$/g, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/images\/generations$/i, '')
    .replace(/\/images\/edits$/i, '')
    .replace(/\/+$/g, '');

  try {
    const url = new URL(raw);
    url.pathname = stripKnownSuffix(url.pathname) || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return stripKnownSuffix(raw);
  }
}

function buildCreateAgentGenerationUrl(baseUrl = '') {
  const normalizedBaseUrl = normalizeCreateAgentBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return '';
  return `${normalizedBaseUrl}/images/generations`;
}

function buildCreateAgentGenerationUrlCandidates(baseUrl = '') {
  const normalizedBaseUrl = normalizeCreateAgentBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return [];
  const baseWithoutSlash = normalizedBaseUrl.replace(/\/+$/g, '');
  const candidates = [`${baseWithoutSlash}/images/generations`];
  if (!/\/v1$/i.test(baseWithoutSlash)) {
    candidates.push(`${baseWithoutSlash}/v1/images/generations`);
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function resolveConfig(overrides = {}) {
  const requestedImageSize = String((overrides.imageSize ?? config.CREATE_AGENT_IMAGE_SIZE) || '1024x1024').trim() || '1024x1024';
  return {
    enabled: overrides.enabled ?? config.CREATE_AGENT_ENABLED,
    apiBaseUrl: normalizeCreateAgentBaseUrl(overrides.apiBaseUrl ?? config.CREATE_AGENT_API_BASE_URL),
    apiKey: String((overrides.apiKey ?? config.CREATE_AGENT_API_KEY) || '').trim(),
    model: String((overrides.model ?? config.CREATE_AGENT_MODEL) || '').trim(),
    allowUserIds: normalizeIdList(overrides.allowUserIds ?? config.CREATE_AGENT_ALLOW_USER_IDS ?? []),
    dailyLimit: Math.max(0, Number(overrides.dailyLimit ?? config.CREATE_AGENT_DAILY_LIMIT ?? 20) || 0),
    timeoutMs: Math.max(1000, Number(overrides.timeoutMs ?? config.CREATE_AGENT_TIMEOUT_MS ?? 120000) || 120000),
    groupOnly: overrides.groupOnly ?? config.CREATE_AGENT_GROUP_ONLY,
    maxConcurrency: Math.max(1, Number(overrides.maxConcurrency ?? config.CREATE_AGENT_MAX_CONCURRENCY ?? 1) || 1),
    requestedImageSize,
    imageSize: normalizeRequestedImageSize(requestedImageSize),
    imageQuality: String((overrides.imageQuality ?? config.CREATE_AGENT_IMAGE_QUALITY) || 'high').trim() || 'high',
    imageBackground: String((overrides.imageBackground ?? config.CREATE_AGENT_IMAGE_BACKGROUND) || 'auto').trim() || 'auto',
    imageStyle: String((overrides.imageStyle ?? config.CREATE_AGENT_IMAGE_STYLE) || 'vivid').trim() || 'vivid',
    imageOutputCompression: Math.max(0, Math.min(100, Number(
      overrides.imageOutputCompression ?? config.CREATE_AGENT_IMAGE_OUTPUT_COMPRESSION ?? 0
    ) || 0)),
    responseFormat: String((overrides.responseFormat ?? config.CREATE_AGENT_RESPONSE_FORMAT) || 'b64_json').trim() || 'b64_json',
    outputFormat: String((overrides.outputFormat ?? config.CREATE_AGENT_OUTPUT_FORMAT) || 'png').trim() || 'png',
    outputDir: path.resolve(String((overrides.outputDir ?? config.CREATE_AGENT_OUTPUT_DIR) || path.join(config.DATA_DIR, 'create-agent', 'output')).trim()),
    timezone: String((overrides.timezone ?? config.TIMEZONE) || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    quotaFile: path.resolve(String(overrides.quotaFile || CREATE_AGENT_QUOTA_FILE)),
    runtimeFile: path.resolve(String(overrides.runtimeFile || CREATE_AGENT_RUNTIME_FILE)),
    errorLogFile: path.resolve(String(overrides.errorLogFile || CREATE_AGENT_ERROR_LOG_FILE))
  };
}

function loadQuotaState(quotaFile = '') {
  const fallback = { day: '', used: 0 };
  const parsed = readJsonFileSafe(quotaFile, fallback);
  return {
    day: String(parsed.day || '').trim(),
    used: Math.max(0, Number(parsed.used || 0) || 0)
  };
}

function getQuotaStatus(runtimeConfig = {}) {
  const quotaState = loadQuotaState(runtimeConfig.quotaFile);
  const today = todayStrInTz(runtimeConfig.timezone);
  if (quotaState.day !== today) {
    return {
      day: today,
      used: 0,
      remaining: Math.max(0, runtimeConfig.dailyLimit)
    };
  }
  return {
    day: today,
    used: quotaState.used,
    remaining: Math.max(0, runtimeConfig.dailyLimit - quotaState.used)
  };
}

function loadRuntimeState(runtimeFile = '') {
  const fallback = { running: 0, updatedAt: 0, ownerPid: 0 };
  const parsed = readJsonFileSafe(runtimeFile, fallback);
  return {
    running: Math.max(0, Number(parsed.running || 0) || 0),
    updatedAt: Math.max(0, Number(parsed.updatedAt || 0) || 0),
    ownerPid: Math.max(0, Number(parsed.ownerPid || 0) || 0)
  };
}

function saveRuntimeState(runtimeFile = '', state = {}) {
  const running = Math.max(0, Number(state.running || 0) || 0);
  writeJsonFileSafe(runtimeFile, {
    running,
    updatedAt: Number(state.updatedAt || Date.now()) || Date.now(),
    ownerPid: running > 0
      ? Math.max(0, Number(state.ownerPid || process.pid) || process.pid)
      : 0
  });
}

function isProcessAlive(pid = 0) {
  const targetPid = Math.max(0, Number(pid || 0) || 0);
  if (!targetPid) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (error) {
    return String(error?.code || '').trim().toUpperCase() === 'EPERM';
  }
}

function isRuntimeStateStale(runtimeConfig = {}, state = {}) {
  const running = Math.max(0, Number(state.running || 0) || 0);
  if (running <= 0) return false;

  const ownerPid = Math.max(0, Number(state.ownerPid || 0) || 0);
  if (ownerPid > 0 && !isProcessAlive(ownerPid)) {
    return true;
  }

  if (ownerPid > 0) return false;

  const updatedAt = Math.max(0, Number(state.updatedAt || 0) || 0);
  const ageMs = updatedAt > 0 ? Math.max(0, Date.now() - updatedAt) : Number.MAX_SAFE_INTEGER;
  const staleAfterMs = Math.max(180000, Number(runtimeConfig.timeoutMs || 120000) + 60000);
  return ageMs >= staleAfterMs;
}

function consumeQuota(runtimeConfig = {}) {
  const today = todayStrInTz(runtimeConfig.timezone);
  const quotaState = loadQuotaState(runtimeConfig.quotaFile);
  const currentUsed = quotaState.day === today ? quotaState.used : 0;
  const nextState = {
    day: today,
    used: currentUsed + 1
  };
  writeJsonFileSafe(runtimeConfig.quotaFile, nextState);
  return nextState;
}

function tryAcquireRuntimeSlot(runtimeConfig = {}) {
  let current = loadRuntimeState(runtimeConfig.runtimeFile);
  if (isRuntimeStateStale(runtimeConfig, current)) {
    current = {
      running: 0,
      updatedAt: Date.now(),
      ownerPid: 0
    };
    saveRuntimeState(runtimeConfig.runtimeFile, current);
  }

  if (current.running >= runtimeConfig.maxConcurrency) {
    return {
      ok: false,
      state: current
    };
  }
  const nextState = {
    running: current.running + 1,
    updatedAt: Date.now(),
    ownerPid: process.pid
  };
  saveRuntimeState(runtimeConfig.runtimeFile, nextState);
  return {
    ok: true,
    state: nextState
  };
}

function releaseRuntimeSlot(runtimeConfig = {}) {
  const current = loadRuntimeState(runtimeConfig.runtimeFile);
  saveRuntimeState(runtimeConfig.runtimeFile, {
    running: Math.max(0, current.running - 1),
    updatedAt: Date.now(),
    ownerPid: Math.max(0, current.running - 1) > 0 ? process.pid : 0
  });
}

function clearRuntimeSlotsForCurrentProcess(runtimeConfig = resolveConfig()) {
  const current = loadRuntimeState(runtimeConfig.runtimeFile);
  if (Number(current.ownerPid || 0) !== process.pid) {
    return {
      cleared: false,
      state: current
    };
  }
  saveRuntimeState(runtimeConfig.runtimeFile, {
    running: 0,
    updatedAt: Date.now(),
    ownerPid: 0
  });
  console.log('[create-agent] cleared runtime slots for shutdown', {
    pid: process.pid,
    previousRunning: Math.max(0, Number(current.running || 0) || 0)
  });
  return {
    cleared: true,
    state: current
  };
}

function validateCreateAgentPrerequisites(runtimeConfig = {}) {
  if (!runtimeConfig.apiBaseUrl) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }
  if (!runtimeConfig.apiKey) {
    throw new Error('CREATE_AGENT_API_KEY is not configured');
  }
  if (!runtimeConfig.model) {
    throw new Error('CREATE_AGENT_MODEL is not configured');
  }
}

function stringifyBody(body = null) {
  if (typeof body === 'string') return body.trim();
  if (body === null || body === undefined) return '';
  try {
    return JSON.stringify(body);
  } catch (_) {
    return String(body || '').trim();
  }
}

function parseJsonTextSafe(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function getCreateAgentStreamTimeoutMs(runtimeConfig = {}) {
  const configuredTimeoutMs = Math.max(1000, Number(runtimeConfig.timeoutMs || 0) || 0);
  const requestStreamTimeoutMs = Math.max(1000, Number(config.REQUEST_STREAM_TIMEOUT_MS || 0) || 0);
  const firstTokenTimeoutMs = Math.max(1000, Number(config.AI_STREAM_FIRST_TOKEN_TIMEOUT_MS || 0) || 0);
  return Math.max(configuredTimeoutMs, requestStreamTimeoutMs, firstTokenTimeoutMs, 420000);
}

function summarizePayloadShape(payload = null) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') {
    return payload.replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  try {
    const text = JSON.stringify(payload);
    return text.slice(0, 400);
  } catch (_) {
    return String(payload || '').trim().slice(0, 400);
  }
}

function normalizeRequestError(error = null) {
  const status = Number(error?.response?.status || 0) || 0;
  const body = stringifyBody(error?.response?.data);
  if (status > 0) {
    return `http_error status=${status} body=${body}`;
  }

  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || lower.includes('timeout') || lower.includes('timed out')) {
    return message || 'timeout';
  }
  if (
    code === 'ENOTFOUND'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'EAI_AGAIN'
  ) {
    return `network_error ${message}`.trim();
  }
  return message || 'unknown error';
}

function logCreateAgentError(runtimeConfig = {}, context = {}, error = null) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    prompt: normalizePromptText(context.prompt || context.payload || '').slice(0, 500),
    groupId: String(context.groupId || '').trim(),
    senderId: String(context.senderId || '').trim(),
    model: String(runtimeConfig.model || '').trim(),
    apiBaseUrl: String(runtimeConfig.apiBaseUrl || '').trim(),
    requestedImageSize: String(runtimeConfig.requestedImageSize || '').trim(),
    effectiveImageSize: String(runtimeConfig.imageSize || '').trim(),
    requestUrl: String(context.requestUrl || buildCreateAgentGenerationUrl(runtimeConfig.apiBaseUrl)).trim(),
    backend: 'openai_images',
    responsePreview: String(context.responsePreview || '').trim(),
    error: String(error?.message || error || '').trim()
  });
  appendTextFileSafe(runtimeConfig.errorLogFile, `${line}\n`);
}

function buildImageOutputPath(runtimeConfig = {}, prompt = '', buffer = Buffer.alloc(0), mimeType = '') {
  const extension = detectImageExtension(buffer, DEFAULT_IMAGE_EXTENSION, mimeType);
  return path.join(runtimeConfig.outputDir, `${buildOutputBasename(prompt)}${extension}`);
}

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

function buildImageGenerationRequestOptions(runtimeConfig = {}, options = {}) {
  return {
    timeout: options.stream ? getCreateAgentStreamTimeoutMs(runtimeConfig) : runtimeConfig.timeoutMs,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    proxy: false,
    responseType: options.responseType || 'json',
    headers: {
      Authorization: `Bearer ${runtimeConfig.apiKey}`,
      'Content-Type': 'application/json',
      Accept: options.stream ? 'text/event-stream, application/json' : 'application/json, text/plain, */*',
      'User-Agent': String(config.HTTP_USER_AGENT || '').trim() || 'Mozilla/5.0'
    }
  };
}

function writeImageBuffer(runtimeConfig = {}, prompt = '', buffer = Buffer.alloc(0), mimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('image buffer empty');
  }
  const outputPath = buildImageOutputPath(runtimeConfig, prompt, buffer, mimeType);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function downloadImageFromUrl(imageUrl = '', prompt = '', runtimeConfig = {}, deps = {}) {
  const rawUrl = String(imageUrl || '').trim();
  if (!rawUrl) {
    throw new Error('generation response missing image data');
  }

  const dataUrlMatch = rawUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const buffer = Buffer.from(String(dataUrlMatch[2] || '').replace(/\s+/g, ''), 'base64');
    const filePath = writeImageBuffer(runtimeConfig, prompt, buffer, dataUrlMatch[1]);
    return { filePath, buffer };
  }

  const httpClient = deps.httpClient || axios;
  try {
    const response = await httpClient.get(rawUrl, {
      responseType: 'arraybuffer',
      timeout: runtimeConfig.timeoutMs,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      proxy: false
    });
    const buffer = Buffer.from(response?.data || []);
    const filePath = writeImageBuffer(
      runtimeConfig,
      prompt,
      buffer,
      String(response?.headers?.['content-type'] || '').trim()
    );
    return { filePath, buffer };
  } catch (error) {
    throw new Error(normalizeRequestError(error));
  }
}

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
    return null;
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

async function materializeGeneratedImage(imageResult = null, prompt = '', runtimeConfig = {}, deps = {}) {
  if (!imageResult || typeof imageResult !== 'object') {
    throw new Error('generation response missing image data');
  }

  if (imageResult.kind === 'b64_json') {
    const buffer = Buffer.from(String(imageResult.value || '').trim(), 'base64');
    const filePath = writeImageBuffer(runtimeConfig, prompt, buffer);
    return { filePath, buffer };
  }

  if (imageResult.kind === 'url') {
    return downloadImageFromUrl(imageResult.value, prompt, runtimeConfig, deps);
  }

  throw new Error('generation response missing image data');
}

async function requestImageGeneration(prompt = '', runtimeConfig = {}, deps = {}) {
  validateCreateAgentPrerequisites(runtimeConfig);
  const requestUrls = buildCreateAgentGenerationUrlCandidates(runtimeConfig.apiBaseUrl);
  if (!requestUrls.length) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }

  const httpClient = deps.httpClient || axios;
  let lastError = null;
  for (const requestUrl of requestUrls) {
    try {
      const response = await httpClient.post(
        requestUrl,
        buildImageGenerationRequestBody(prompt, runtimeConfig),
        buildImageGenerationRequestOptions(runtimeConfig)
      );
      const payload = response?.data || {};
      try {
        extractImageFromGenerationResponse(payload);
      } catch (shapeError) {
        lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(payload)}`);
        lastError.requestUrl = requestUrl;
        continue;
      }
      return {
        payload,
        requestUrl
      };
    } catch (error) {
      const normalized = new Error(normalizeRequestError(error));
      normalized.requestUrl = requestUrl;
      lastError = normalized;
      const lower = String(normalized.message || '').toLowerCase();
      if (!(lower.includes('404') || lower.includes('generation response missing image data'))) {
        break;
      }
    }
  }
  throw lastError || new Error('generation response missing image data');
}

async function requestImageGenerationStream(prompt = '', runtimeConfig = {}, deps = {}) {
  validateCreateAgentPrerequisites(runtimeConfig);
  const requestUrls = buildCreateAgentGenerationUrlCandidates(runtimeConfig.apiBaseUrl);
  if (!requestUrls.length) {
    throw new Error('CREATE_AGENT_API_BASE_URL is not configured');
  }

  const httpClient = deps.httpClient || axios;
  let lastError = null;

  for (const requestUrl of requestUrls) {
    try {
      const response = await httpClient.post(
        requestUrl,
        buildImageGenerationRequestBody(prompt, runtimeConfig, {
          stream: true,
          partialImages: CREATE_AGENT_STREAM_PARTIAL_IMAGES
        }),
        buildImageGenerationRequestOptions(runtimeConfig, { responseType: 'stream', stream: true })
      );

      const responseStream = response?.data;
      if (!responseStream || typeof responseStream.on !== 'function') {
        const directPayload = response?.data || {};
        const directImage = extractImageFromStreamEventPayload(directPayload);
        if (directImage) {
          return {
            imageResult: directImage,
            requestUrl,
            streamMode: false
          };
        }
        try {
          return {
            imageResult: extractImageFromGenerationResponse(directPayload),
            requestUrl,
            streamMode: false
          };
        } catch (shapeError) {
          lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(directPayload)}`);
          lastError.requestUrl = requestUrl;
          continue;
        }
      }

      const parserState = { buffer: '' };
      const rawChunks = [];
      let sawSseEvents = false;
      let finalImage = null;

      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          responseStream.removeListener('data', handleData);
          responseStream.removeListener('end', handleEnd);
          responseStream.removeListener('close', handleClose);
          responseStream.removeListener('error', handleError);
        };

        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };

        const consumeEvents = (events = []) => {
          for (const event of events) {
            if (!event?.json || typeof event.json !== 'object') continue;
            sawSseEvents = true;

            const streamFailure = extractStreamFailureMessage(event.json);
            if (streamFailure) {
              const error = new Error(streamFailure);
              error.requestUrl = requestUrl;
              finish(error);
              return false;
            }

            const imageResult = extractImageFromStreamEventPayload(event.json);
            if (!imageResult) continue;

            const eventType = String(imageResult.eventType || event.json.type || '').trim().toLowerCase();
            if (eventType.endsWith('.partial_image')) {
              continue;
            }
            finalImage = imageResult;
          }
          return true;
        };

        const handleData = (chunk) => {
          rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8'));
          const parsed = extractSSEEvents(parserState, chunk);
          parserState.buffer = parsed.state.buffer;
          consumeEvents(parsed.events || []);
        };

        const finalizeTail = () => {
          const tailEvents = flushSSEState(parserState);
          consumeEvents(tailEvents || []);
        };

        const handleEnd = () => {
          finalizeTail();
          finish();
        };

        const handleClose = () => {
          if (settled) return;
          finalizeTail();
          finish();
        };

        const handleError = (error) => {
          const normalizedError = error instanceof Error ? error : new Error(String(error || 'unknown error'));
          normalizedError.requestUrl = requestUrl;
          finish(normalizedError);
        };

        responseStream.on('data', handleData);
        responseStream.once('end', handleEnd);
        responseStream.once('close', handleClose);
        responseStream.once('error', handleError);
      });

      if (finalImage) {
        return {
          imageResult: finalImage,
          requestUrl,
          streamMode: true
        };
      }

      const rawText = Buffer.concat(rawChunks).toString('utf8').trim();
      if (!sawSseEvents && rawText) {
        const rawPayload = parseJsonTextSafe(rawText);
        if (rawPayload) {
          const fallbackImage = extractImageFromStreamEventPayload(rawPayload);
          if (fallbackImage) {
            return {
              imageResult: fallbackImage,
              requestUrl,
              streamMode: false
            };
          }
          try {
            return {
              imageResult: extractImageFromGenerationResponse(rawPayload),
              requestUrl,
              streamMode: false
            };
          } catch (shapeError) {
            lastError = new Error(`${shapeError.message} response_preview=${summarizePayloadShape(rawPayload)}`);
            lastError.requestUrl = requestUrl;
            continue;
          }
        }
      }

      lastError = new Error(
        `generation stream missing image data${rawText ? ` response_preview=${rawText.replace(/\s+/g, ' ').trim().slice(0, 400)}` : ''}`
      );
      lastError.requestUrl = requestUrl;
    } catch (error) {
      const normalized = error?.response
        ? new Error(normalizeRequestError(error))
        : (error instanceof Error ? error : new Error(String(error || 'unknown error')));
      normalized.requestUrl = error?.requestUrl || requestUrl;
      lastError = normalized;
      const lower = String(normalized.message || '').toLowerCase();
      if (!(lower.includes('404') || lower.includes('generation stream missing image data') || lower.includes('generation response missing image data'))) {
        break;
      }
    }
  }

  throw lastError || new Error('generation stream missing image data');
}

async function generateImageWithOpenAICompatibleApi(prompt = '', runtimeConfig = {}, deps = {}) {
  let streamError = null;
  try {
    const streamedResult = await requestImageGenerationStream(prompt, runtimeConfig, deps);
    return materializeGeneratedImage(streamedResult?.imageResult, prompt, runtimeConfig, deps);
  } catch (error) {
    streamError = error;
  }

  try {
    const generationResult = await requestImageGeneration(prompt, runtimeConfig, deps);
    const payload = generationResult?.payload || {};
    return materializeGeneratedImage(extractImageFromGenerationResponse(payload), prompt, runtimeConfig, deps);
  } catch (error) {
    if (streamError) {
      error.message = `${String(error?.message || error || '').trim()} stream_attempt=${String(streamError?.message || streamError || '').trim()}`.trim();
    }
    throw error;
  }
}

function buildUserFacingFailureReply(error = null, runtimeConfig = {}) {
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  const providerModelMatch = message.match(/unknown provider for model\s+([a-z0-9._-]+)/i);
  const providerModel = String(providerModelMatch?.[1] || runtimeConfig.model || '').trim();
  if (!message) return '生图失败，请稍后重试';
  if (lower.includes('create_agent_api_base_url')) return '生图接口未配置';
  if (lower.includes('create_agent_api_key')) return '生图鉴权未配置';
  if (lower.includes('create_agent_model')) return '生图模型未配置';
  if (message.includes('系统网关次数不足') || message.includes('网关次数不足')) {
    return '生图供应商额度不足，请联系服务商';
  }
  if (lower.includes('error 524') || lower.includes('origin_response_timeout') || lower.includes('cloudflare') && lower.includes('524')) {
    return '生图上游超时，请稍后重试或更换供应商';
  }
  if (lower.includes('unknown provider for model')) {
    return `当前生图供应商不支持 ${providerModel || '该模型'}`;
  }
  if (lower.includes('http_error') && lower.includes('400')) return '生图请求参数无效';
  if (lower.includes('http_error') && lower.includes('404')) return '当前生图接口不存在';
  if (lower.includes('http_error') && (lower.includes('401') || lower.includes('403'))) return '生图鉴权失败';
  if (lower.includes('http_error') && lower.includes('429')) return '生图接口限流，请稍后重试';
  if (lower.includes('http_error') && lower.includes('5')) return '生图供应商暂时异常';
  if (lower.includes('generation stream missing image data')) return '生图结果为空，当前接口返回格式不兼容';
  if (lower.includes('generation response missing image data')) return '生图结果为空，当前接口返回格式不兼容';
  if (lower.includes('image buffer empty')) return '生图结果为空';
  if (lower.includes('timeout') || lower.includes('timed out')) return '生图超时，请稍后重试';
  if (lower.includes('network_error')) return '生图网络异常，请稍后重试';
  return '生图失败，请稍后重试';
}

async function executeCreateCommand(context = {}, deps = {}) {
  const runtimeConfig = resolveConfig(deps.config);
  const prompt = normalizePromptText(context.prompt || context.payload || '');
  const chatType = String(context.chatType || '').trim().toLowerCase();
  const groupId = String(context.groupId || '').trim();

  ensureDirSync(path.dirname(runtimeConfig.quotaFile));
  ensureDirSync(path.dirname(runtimeConfig.runtimeFile));
  ensureDirSync(path.dirname(runtimeConfig.errorLogFile));
  ensureDirSync(runtimeConfig.outputDir);

  if (!runtimeConfig.enabled) {
    return { ok: false, replyText: '生图 worker 未开启', code: 'disabled' };
  }
  if (!prompt) {
    return { ok: false, replyText: '用法: /create <prompt>', code: 'empty_prompt' };
  }
  if (runtimeConfig.groupOnly && chatType === 'private') {
    return { ok: false, replyText: '仅群聊可用', code: 'group_only' };
  }
  if (!groupId) {
    return { ok: false, replyText: '仅群聊可用', code: 'missing_group' };
  }

  const runtimeSlot = tryAcquireRuntimeSlot(runtimeConfig);
  if (!runtimeSlot.ok) {
    return { ok: false, replyText: '生图 worker 正忙，请稍后重试', code: 'busy' };
  }

  let quotaConsumed = false;
  try {
    const quotaStatus = getQuotaStatus(runtimeConfig);
    if (quotaStatus.remaining <= 0) {
      return { ok: false, replyText: '今日生图额度已用完', code: 'quota_exceeded' };
    }

    validateCreateAgentPrerequisites(runtimeConfig);
    consumeQuota(runtimeConfig);
    quotaConsumed = true;

    const normalizedPrompt = buildCreateAgentPrompt(prompt, {
      imageSize: runtimeConfig.imageSize
    });
    const materialized = await (deps.generateImage || generateImageWithOpenAICompatibleApi)(
      normalizedPrompt,
      runtimeConfig,
      deps
    );
    await (deps.sendGroupImageMessage || sendGroupImageMessage)(groupId, materialized.buffer, deps.sendOptions || {});

    return {
      ok: true,
      code: 'sent',
      imagePath: materialized.filePath
    };
  } catch (error) {
    logCreateAgentError(runtimeConfig, {
      ...context,
      requestUrl: String(error?.requestUrl || '').trim(),
      responsePreview: String(error?.message || '').includes('response_preview=')
        ? String(error.message).split('response_preview=').slice(1).join('response_preview=').trim()
        : ''
    }, error);
    return {
      ok: false,
      replyText: quotaConsumed
        ? buildUserFacingFailureReply(error, runtimeConfig)
        : buildUserFacingFailureReply(error, runtimeConfig),
      code: 'failed',
      error: error?.message || String(error || 'unknown error')
    };
  } finally {
    releaseRuntimeSlot(runtimeConfig);
  }
}

module.exports = {
  buildCreateAgentGenerationUrl,
  buildCreateAgentGenerationUrlCandidates,
  buildCreateAgentAllowedUserIds,
  buildCreateAgentPrompt,
  consumeQuota,
  detectImageExtension,
  downloadImageFromUrl,
  executeCreateCommand,
  extractImageFromGenerationResponse,
  extractImageFromStreamEventPayload,
  generateImageWithOpenAICompatibleApi,
  getQuotaStatus,
  loadQuotaState,
  loadRuntimeState,
  isRuntimeStateStale,
  isCreateAgentUserAllowed,
  normalizeCreateAgentBaseUrl,
  normalizeIdList,
  normalizeRequestedImageSize,
  normalizeRequestError,
  readJsonFileSafe,
  requestImageGeneration,
  requestImageGenerationStream,
  resolveConfig,
  tryAcquireRuntimeSlot,
  releaseRuntimeSlot,
  clearRuntimeSlotsForCurrentProcess,
  writeJsonFileSafe
};
