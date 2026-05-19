const path = require('path');
const appConfig = require('../../config');

const CREATE_AGENT_DIR = path.join(appConfig.DATA_DIR, 'create-agent');
const CREATE_AGENT_QUOTA_FILE = path.join(CREATE_AGENT_DIR, 'quota.json');
const CREATE_AGENT_RUNTIME_FILE = path.join(CREATE_AGENT_DIR, 'runtime.json');
const CREATE_AGENT_ERROR_LOG_FILE = path.join(CREATE_AGENT_DIR, 'errors.log');
const CREATE_AGENT_ADMIN_USER_IDS = new Set(
  (appConfig.ADMIN_USER_IDS || []).map((item) => String(item || '').trim()).filter(Boolean)
);

function normalizeIdList(list = []) {
  return Array.from(new Set(
    (Array.isArray(list) ? list : [list])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));
}

function buildCreateAgentAllowedUserIds(overrides = {}) {
  const configAllowUserIds = normalizeIdList(overrides.allowUserIds ?? appConfig.CREATE_AGENT_ALLOW_USER_IDS ?? []);
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

function normalizeCreateAgentProtocol(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (
    normalized === 'chat'
    || normalized === 'chat_completion'
    || normalized === 'chat_completions'
    || normalized === 'completions'
  ) {
    return 'chat_completions';
  }
  return 'images';
}

function buildCreateAgentChatCompletionsUrl(baseUrl = '') {
  const normalizedBaseUrl = normalizeCreateAgentBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return '';
  const baseWithoutSlash = normalizedBaseUrl.replace(/\/+$/g, '');
  if (/\/chat\/completions$/i.test(baseWithoutSlash)) return baseWithoutSlash;
  if (/\/v\d+$/i.test(baseWithoutSlash)) return `${baseWithoutSlash}/chat/completions`;
  return `${baseWithoutSlash}/v1/chat/completions`;
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

function buildCreateAgentChatCompletionsUrlCandidates(baseUrl = '') {
  const normalizedBaseUrl = normalizeCreateAgentBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return [];
  const baseWithoutSlash = normalizedBaseUrl.replace(/\/+$/g, '');

  if (/\/chat\/completions$/i.test(baseWithoutSlash)) {
    return [baseWithoutSlash];
  }

  if (/\/v\d+$/i.test(baseWithoutSlash)) {
    return [`${baseWithoutSlash}/chat/completions`];
  }

  return [`${baseWithoutSlash}/v1/chat/completions`];
}

function resolveConfig(overrides = {}) {
  const requestedImageSize = String((overrides.imageSize ?? appConfig.CREATE_AGENT_IMAGE_SIZE) || '1024x1024').trim() || '1024x1024';
  return {
    enabled: overrides.enabled ?? appConfig.CREATE_AGENT_ENABLED,
    apiBaseUrl: normalizeCreateAgentBaseUrl(overrides.apiBaseUrl ?? appConfig.CREATE_AGENT_API_BASE_URL),
    apiKey: String((overrides.apiKey ?? appConfig.CREATE_AGENT_API_KEY) || '').trim(),
    model: String((overrides.model ?? appConfig.CREATE_AGENT_MODEL) || '').trim(),
    protocol: normalizeCreateAgentProtocol(overrides.protocol ?? appConfig.CREATE_AGENT_PROTOCOL),
    allowUserIds: normalizeIdList(overrides.allowUserIds ?? appConfig.CREATE_AGENT_ALLOW_USER_IDS ?? []),
    dailyLimit: Math.max(0, Number(overrides.dailyLimit ?? appConfig.CREATE_AGENT_DAILY_LIMIT ?? 20) || 0),
    timeoutMs: Math.max(1000, Number(overrides.timeoutMs ?? appConfig.CREATE_AGENT_TIMEOUT_MS ?? 120000) || 120000),
    groupOnly: overrides.groupOnly ?? appConfig.CREATE_AGENT_GROUP_ONLY,
    maxConcurrency: Math.max(1, Number(overrides.maxConcurrency ?? appConfig.CREATE_AGENT_MAX_CONCURRENCY ?? 1) || 1),
    requestedImageSize,
    imageSize: normalizeRequestedImageSize(requestedImageSize),
    imageQuality: String((overrides.imageQuality ?? appConfig.CREATE_AGENT_IMAGE_QUALITY) || 'high').trim() || 'high',
    imageBackground: String((overrides.imageBackground ?? appConfig.CREATE_AGENT_IMAGE_BACKGROUND) || 'auto').trim() || 'auto',
    imageStyle: String((overrides.imageStyle ?? appConfig.CREATE_AGENT_IMAGE_STYLE) || 'vivid').trim() || 'vivid',
    imageOutputCompression: Math.max(0, Math.min(100, Number(
      overrides.imageOutputCompression ?? appConfig.CREATE_AGENT_IMAGE_OUTPUT_COMPRESSION ?? 0
    ) || 0)),
    responseFormat: String((overrides.responseFormat ?? appConfig.CREATE_AGENT_RESPONSE_FORMAT) || 'b64_json').trim() || 'b64_json',
    outputFormat: String((overrides.outputFormat ?? appConfig.CREATE_AGENT_OUTPUT_FORMAT) || 'png').trim() || 'png',
    outputDir: path.resolve(String((overrides.outputDir ?? appConfig.CREATE_AGENT_OUTPUT_DIR) || path.join(appConfig.DATA_DIR, 'create-agent', 'output')).trim()),
    timezone: String((overrides.timezone ?? appConfig.TIMEZONE) || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    quotaFile: path.resolve(String(overrides.quotaFile || CREATE_AGENT_QUOTA_FILE)),
    runtimeFile: path.resolve(String(overrides.runtimeFile || CREATE_AGENT_RUNTIME_FILE)),
    errorLogFile: path.resolve(String(overrides.errorLogFile || CREATE_AGENT_ERROR_LOG_FILE))
  };
}

module.exports = {
  CREATE_AGENT_ERROR_LOG_FILE,
  CREATE_AGENT_QUOTA_FILE,
  CREATE_AGENT_RUNTIME_FILE,
  buildCreateAgentAllowedUserIds,
  buildCreateAgentChatCompletionsUrl,
  buildCreateAgentChatCompletionsUrlCandidates,
  buildCreateAgentGenerationUrl,
  buildCreateAgentGenerationUrlCandidates,
  isCreateAgentUserAllowed,
  normalizeCreateAgentBaseUrl,
  normalizeCreateAgentProtocol,
  normalizeIdList,
  normalizeRequestedImageSize,
  resolveConfig
};
