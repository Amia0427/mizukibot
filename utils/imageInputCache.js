const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

const CACHE_DIR = path.join(config.DATA_DIR, 'inbound_image_cache');
const CACHE_REF_PREFIX = 'cached-image://';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function buildCacheKey(url = '') {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex');
}

function buildCacheRef(cacheKey = '') {
  const normalized = normalizeText(cacheKey);
  return normalized ? `${CACHE_REF_PREFIX}${normalized}` : '';
}

function parseCacheRef(value = '') {
  const text = normalizeText(value);
  if (!text.startsWith(CACHE_REF_PREFIX)) return '';
  return normalizeText(text.slice(CACHE_REF_PREFIX.length));
}

function getMetaPath(cacheKey = '') {
  return path.join(CACHE_DIR, `${cacheKey}.json`);
}

function getBinPath(cacheKey = '') {
  return path.join(CACHE_DIR, `${cacheKey}.bin`);
}

function inferMediaType(url = '', headers = {}) {
  const contentType = normalizeText(headers?.['content-type'] || headers?.['Content-Type']).toLowerCase();
  if (contentType.startsWith('image/')) return contentType;
  const lowerUrl = String(url || '').toLowerCase();
  if (lowerUrl.includes('.png')) return 'image/png';
  if (lowerUrl.includes('.webp')) return 'image/webp';
  if (lowerUrl.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function readJsonFile(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeJsonFile(filePath = '', value = {}) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function ensureCachedImageRef(url = '', options = {}) {
  const sourceUrl = normalizeText(url);
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return {
      ok: false,
      ref: '',
      cacheKey: '',
      sourceUrl,
      mediaType: '',
      reason: 'non_remote_image'
    };
  }

  ensureCacheDir();
  const cacheKey = buildCacheKey(sourceUrl);
  const metaPath = getMetaPath(cacheKey);
  const binPath = getBinPath(cacheKey);
  const existingMeta = readJsonFile(metaPath);
  if (existingMeta && fs.existsSync(binPath)) {
    return {
      ok: true,
      ref: buildCacheRef(cacheKey),
      cacheKey,
      sourceUrl,
      mediaType: normalizeText(existingMeta.mediaType || 'image/jpeg') || 'image/jpeg',
      alreadyExisted: true
    };
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const maxBytes = Math.max(1024, Number(options.maxBytes || DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES);

  try {
    const response = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      proxy: false,
      headers: {
        'User-Agent': String(config.HTTP_USER_AGENT || '').trim() || 'Mozilla/5.0'
      }
    });
    const buffer = Buffer.from(response?.data || []);
    if (!buffer.length) {
      return {
        ok: false,
        ref: '',
        cacheKey,
        sourceUrl,
        mediaType: '',
        reason: 'empty_image'
      };
    }

    const mediaType = inferMediaType(sourceUrl, response?.headers || {});
    fs.writeFileSync(binPath, buffer);
    writeJsonFile(metaPath, {
      cacheKey,
      sourceUrl,
      mediaType,
      byteLength: buffer.length,
      createdAt: new Date().toISOString()
    });
    return {
      ok: true,
      ref: buildCacheRef(cacheKey),
      cacheKey,
      sourceUrl,
      mediaType,
      alreadyExisted: false
    };
  } catch (error) {
    return {
      ok: false,
      ref: '',
      cacheKey,
      sourceUrl,
      mediaType: '',
      reason: error?.message || 'cache_download_failed'
    };
  }
}

function readCachedImagePayload(ref = '') {
  const cacheKey = parseCacheRef(ref);
  if (!cacheKey) return null;
  const meta = readJsonFile(getMetaPath(cacheKey));
  const binPath = getBinPath(cacheKey);
  if (!meta || !fs.existsSync(binPath)) return null;
  try {
    const buffer = fs.readFileSync(binPath);
    if (!buffer.length) return null;
    return {
      cacheKey,
      sourceUrl: normalizeText(meta.sourceUrl || ''),
      mediaType: normalizeText(meta.mediaType || 'image/jpeg') || 'image/jpeg',
      data: buffer.toString('base64')
    };
  } catch (_) {
    return null;
  }
}

module.exports = {
  buildCacheRef,
  ensureCachedImageRef,
  parseCacheRef,
  readCachedImagePayload
};
