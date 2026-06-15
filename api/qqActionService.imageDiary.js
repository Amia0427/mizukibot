const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { getNapCatActionClient } = require('./napcatActionClient');

const NIGHT_IMAGE_MIN_HOUR = 20;
const NIGHT_IMAGE_MAX_HOUR = 5;
const IMAGE_NEGATIVE_PROMPT = [
  'no chat screenshot',
  'no UI',
  'no text watermark',
  'no realistic portrait',
  'no identifiable group members',
  'no phone screenshot',
  'no exact timestamps',
  'no logos'
].join(', ');

function normalizeText(value) {
  return String(value || '').trim();
}

function isNightDiaryWindow(meta = {}) {
  const hour = Number(meta?.hour);
  if (!Number.isFinite(hour)) return false;
  return hour >= NIGHT_IMAGE_MIN_HOUR || hour < NIGHT_IMAGE_MAX_HOUR;
}

function getImageGenerationModule() {
  return require('./imageGeneration');
}

function ensureDirSync(dirPath = '') {
  const fullPath = path.resolve(String(dirPath || '').trim());
  if (!fullPath) return '';
  fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

function isTimeoutLikeError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'ECONNABORTED'
    || code === 'ETIMEDOUT'
    || message.includes('timeout')
    || message.includes('socket hang up');
}

function sanitizeDiaryImageText(text = '') {
  return normalizeText(text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .replace(/[@＠][^\s,，。！？!?]+/g, ' ')
    .replace(/\b\d{5,12}\b/g, ' ')
    .replace(/(^|[^\d])1\d{10}([^\d]|$)/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?/g, ' ')
    .replace(/QQ群|群号|QQ号|链接|网址|截图|聊天记录|群里谁说了什么/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeDiaryImageMeta(meta = {}) {
  const groupMoodTags = Array.isArray(meta.groupMoodTags)
    ? meta.groupMoodTags.map((item) => sanitizeDiaryImageText(item)).filter(Boolean).slice(0, 3)
    : [];
  const botStyleTags = Array.isArray(meta.botStyleTags)
    ? meta.botStyleTags.map((item) => sanitizeDiaryImageText(item)).filter(Boolean).slice(0, 4)
    : [];
  return {
    hour: Number(meta.hour),
    timeBucket: sanitizeDiaryImageText(meta.timeBucket),
    weekday: sanitizeDiaryImageText(meta.weekday),
    sourceType: sanitizeDiaryImageText(meta.sourceType),
    groupMoodTags,
    botStyleTags
  };
}

function createDeterministicSeed(input = '') {
  const source = String(input || '');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pickSeededItem(items = [], random = Math.random) {
  if (!Array.isArray(items) || !items.length) return '';
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return String(items[index] || '').trim();
}

function pickSeededSample(items = [], count = 1, random = Math.random) {
  const pool = Array.isArray(items) ? items.slice() : [];
  const picked = [];
  while (pool.length && picked.length < count) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(String(pool.splice(index, 1)[0] || '').trim());
  }
  return picked.filter(Boolean);
}

function buildBotDiaryImagePrompt(content = '', meta = {}) {
  if (meta?.imagePromptHints && Array.isArray(meta.imagePromptHints) && meta.imagePromptHints.length) {
    return [
      'masterpiece, best quality, ultra-detailed, highres, 8k,',
      'anime style, 2D illustration, soft cel shading,',
      'Akiyama Mizuki, Project SEKAI, androgynous, long lavender hair, purple eyes,',
      ...meta.imagePromptHints.map((item) => `${normalizeText(item)},`)
    ].filter(Boolean).join('\n');
  }
  const safeContent = sanitizeDiaryImageText(content);
  const safeMeta = sanitizeDiaryImageMeta(meta);
  const seed = createDeterministicSeed([
    safeContent,
    safeMeta.weekday,
    safeMeta.timeBucket
  ].join('|'));
  const random = createSeededRandom(seed);
  const action = pickSeededItem([
    'looking down at diary, writing intently',
    'pausing with pen to lips, lost in thought',
    'resting chin on hand, gazing softly at window',
    'smiling gently at the open diary page',
    'reaching for a steaming teacup beside the diary'
  ], random);
  const weather = pickSeededItem([
    'full moon outside window, silver moonbeams streaming in',
    'light rain pattering on window glass, rain streaks',
    'brilliant starry sky, soft starlight',
    'overcast cloudy night, gentle ambient glow',
    'distant city lights twinkling through window'
  ], random);
  const props = pickSeededSample([
    'dried rose petals on desk',
    'small music box nearby',
    'polaroid photos pinned above desk',
    'tiny succulent in ceramic pot',
    'fairy lights draped on shelf',
    'half-empty mug of chamomile tea',
    'folded handwritten note',
    'open sketchbook with doodles'
  ], 2, random).join(', ');
  return [
    'masterpiece, best quality, ultra-detailed, highres, 8k,',
    'anime style, 2D illustration, soft cel shading,',
    'Akiyama Mizuki, Project SEKAI, androgynous, long lavender hair, purple eyes,',
    `${action || 'looking down at diary, writing intently'},`,
    'sitting at wooden desk, open diary, fountain pen,',
    `bedroom at night, warm desk lamp glow, ${weather || 'full moon outside window, silver moonbeams streaming in'},`,
    'pajamas, oversized pastel sweater,',
    props ? `${props},` : '',
    'bokeh, depth of field, soft shadows, rim light, intimate framing,',
    'sheer curtains, cozy atmosphere, floral wallpaper, fairy lights'
  ].filter(Boolean).join('\n');
}

function shouldAttemptBotDiaryImage(meta = {}) {
  if (!config.BOT_DIARY_QZONE_IMAGE_ENABLED) return false;
  if (meta?.imageIntent || (Array.isArray(meta?.imagePromptHints) && meta.imagePromptHints.length)) return true;
  return isNightDiaryWindow(meta);
}

async function downloadImageToLocal(imageUrl = '', options = {}) {
  const url = normalizeText(imageUrl);
  if (!url) {
    return {
      ok: false,
      stage: 'drawPicture',
      reason: 'image url missing'
    };
  }

  const httpClient = options.httpClient || axios;
  const downloadTimeoutMs = Math.max(
    1000,
    Number(options.downloadTimeoutMs || config.BOT_DIARY_QZONE_IMAGE_DOWNLOAD_TIMEOUT_MS || 30000)
  );
  const maxBytes = Math.max(
    1024,
    Number(options.maxBytes || config.BOT_DIARY_QZONE_IMAGE_MAX_BYTES || 8 * 1024 * 1024)
  );
  const targetDir = ensureDirSync(options.tmpDir || config.QZONE_UPLOAD_TMP_DIR);
  const extension = (() => {
    const dataUrlMatch = url.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
    if (dataUrlMatch) {
      const mediaType = String(dataUrlMatch[1] || '').toLowerCase();
      if (mediaType === 'image/png') return '.png';
      if (mediaType === 'image/webp') return '.webp';
      return '.jpg';
    }
    const pathname = (() => {
      try {
        return new URL(url).pathname || '';
      } catch (_) {
        return '';
      }
    })();
    const ext = path.extname(pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
  })();
  const filename = `bot-diary-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`;
  const targetPath = path.join(targetDir, filename);

  try {
    const dataUrlMatch = url.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
    if (dataUrlMatch) {
      const buffer = Buffer.from(String(dataUrlMatch[2] || '').replace(/\s+/g, ''), 'base64');
      if (!buffer.length) {
        return {
          ok: false,
          stage: 'download',
          reason: 'downloaded image empty'
        };
      }
      if (buffer.length > maxBytes) {
        return {
          ok: false,
          stage: 'download',
          reason: 'downloaded image too large'
        };
      }
      fs.writeFileSync(targetPath, buffer);
      return {
        ok: true,
        path: targetPath
      };
    }

    const response = await httpClient.get(url, {
      responseType: 'arraybuffer',
      timeout: downloadTimeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      proxy: false,
      headers: {
        'User-Agent': String(config.HTTP_USER_AGENT || config.CODEX_USER_AGENT || '').trim() || config.CODEX_USER_AGENT
      }
    });
    const buffer = Buffer.from(response?.data || []);
    if (!buffer.length) {
      return {
        ok: false,
        stage: 'download',
        reason: 'downloaded image empty'
      };
    }
    if (buffer.length > maxBytes) {
      return {
        ok: false,
        stage: 'download',
        reason: 'downloaded image too large'
      };
    }
    fs.writeFileSync(targetPath, buffer);
    return {
      ok: true,
      path: targetPath
    };
  } catch (error) {
    return {
      ok: false,
      stage: 'download',
      reason: isTimeoutLikeError(error) ? 'image download timeout' : 'image download failed',
      uncertain: isTimeoutLikeError(error)
    };
  }
}

function cleanupLocalImage(filePath = '') {
  const target = normalizeText(filePath);
  if (!target) return;
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (_) {}
}

async function tryGenerateBotDiaryQzoneImage(content = '', meta = {}, options = {}) {
  const result = {
    attempted: false,
    generated: false,
    uploaded: false,
    imagePublishMode: 'text_only',
    imageFallbackStage: '',
    imageProviderUsed: normalizeText(config.BOT_DIARY_QZONE_IMAGE_PROVIDER_MODEL || ''),
    imagePath: '',
    prompt: ''
  };

  if (!shouldAttemptBotDiaryImage(meta)) {
    return result;
  }

  result.attempted = true;
  const providerConfig = typeof options.buildProviderConfig === 'function'
    ? options.buildProviderConfig()
    : getImageGenerationModule().buildBotDiaryQzoneImageProviderConfig();
  result.imageProviderUsed = normalizeText(providerConfig?.model || result.imageProviderUsed);
  if (!providerConfig?.enabled) {
    result.imagePublishMode = 'image_degraded';
    result.imageFallbackStage = 'provider_config';
    return result;
  }

  const prompt = buildBotDiaryImagePrompt(content, meta);
  result.prompt = prompt;
  if (!prompt) {
    result.imagePublishMode = 'image_degraded';
    result.imageFallbackStage = 'prompt_build';
    return result;
  }

  const draw = typeof options.drawPicture === 'function'
    ? options.drawPicture
    : getImageGenerationModule().drawBotDiaryQzonePicture;
  let imageUrl = '';
  try {
    imageUrl = normalizeText(await draw(prompt));
  } catch (_) {
    imageUrl = '';
  }
  if (!imageUrl) {
    result.imagePublishMode = 'image_degraded';
    result.imageFallbackStage = 'drawPicture';
    return result;
  }
  result.generated = true;

  const download = typeof options.downloadImageToLocal === 'function'
    ? options.downloadImageToLocal
    : downloadImageToLocal;
  const downloaded = await download(imageUrl, {
    httpClient: options.httpClient,
    downloadTimeoutMs: options.downloadTimeoutMs,
    maxBytes: options.maxBytes,
    tmpDir: options.tmpDir
  });
  if (!downloaded.ok) {
    result.imagePublishMode = 'image_degraded';
    result.imageFallbackStage = normalizeText(downloaded.stage || 'download');
    return result;
  }

  result.uploaded = true;
  result.imagePath = downloaded.path;
  return result;
}

async function sendGroupImageMessage(groupId = '', imageInput = null, options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetGroupId = normalizeText(groupId);
  if (!targetGroupId) throw new Error('groupId is required');

  let base64Body = '';
  if (Buffer.isBuffer(imageInput)) {
    base64Body = imageInput.toString('base64');
  } else if (typeof imageInput === 'string') {
    const trimmed = String(imageInput || '').trim();
    if (trimmed.startsWith('base64://')) {
      base64Body = trimmed.slice('base64://'.length).trim();
    } else {
      base64Body = trimmed.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
    }
  } else if (imageInput && typeof imageInput === 'object') {
    if (Buffer.isBuffer(imageInput.buffer)) {
      base64Body = imageInput.buffer.toString('base64');
    } else if (typeof imageInput.base64 === 'string') {
      base64Body = String(imageInput.base64 || '').trim()
        .replace(/^base64:\/\//i, '')
        .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
        .replace(/\s+/g, '');
    } else if (typeof imageInput.file === 'string') {
      const filePath = path.resolve(String(imageInput.file || '').trim());
      if (filePath && fs.existsSync(filePath)) {
        base64Body = fs.readFileSync(filePath).toString('base64');
      }
    }
  }

  if (!base64Body) throw new Error('image content is required');

  await actionClient.callAction('send_group_msg', {
    group_id: targetGroupId,
    message: [{
      type: 'image',
      data: {
        file: `base64://${base64Body}`
      }
    }]
  });

  return {
    success: true,
    reason: 'group image sent'
  };
}

module.exports = {
  buildBotDiaryImagePrompt,
  cleanupLocalImage,
  downloadImageToLocal,
  isNightDiaryWindow,
  sanitizeDiaryImageMeta,
  sanitizeDiaryImageText,
  sendGroupImageMessage,
  shouldAttemptBotDiaryImage,
  tryGenerateBotDiaryQzoneImage
};
