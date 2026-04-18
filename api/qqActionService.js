const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const { getNapCatActionClient } = require('./napcatActionClient');
const { publishQzonePost, publishQzonePostWithImages } = require('./qzoneClient');
const {
  generateBotDiaryDraft,
} = require('./qzoneDiaryService');
const {
  appendQzoneGenerationLog,
  evaluateImageConsistency,
  finalizeSuccessfulQzoneRecord,
  normalizeTelemetryPayload
} = require('../core/qzoneGenerationPhase2');
const { normalizeDailyShareFingerprint } = require('../core/qzoneGenerationState');
const { getScheduledTaskStore } = require('../utils/scheduledTaskStore');
const {
  describeCron,
  normalizeWhenExpression
} = require('../utils/scheduledTaskTime');

const ADMIN_USER_IDS = new Set((config.ADMIN_USER_IDS || []).map((item) => String(item || '').trim()).filter(Boolean));
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

function isAdminUser(userId = '') {
  return ADMIN_USER_IDS.has(String(userId || '').trim());
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMessageId(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  return /^\d+$/.test(text) ? Number(text) : text;
}

function normalizeEmojiIdList(value) {
  const source = Array.isArray(value) ? value : [value];
  return Array.from(new Set(source
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item))));
}

function normalizeQzoneMode(value = '', fallback = 'manual') {
  const mode = normalizeText(value).toLowerCase();
  return mode === 'bot_diary' ? 'bot_diary' : fallback;
}

function normalizeQzonePublishInput(input = {}, options = {}) {
  if (typeof input === 'string') {
    return {
      mode: 'manual',
      content: normalizeText(input),
      hint: ''
    };
  }

  const raw = input && typeof input === 'object' ? input : {};
  const mode = normalizeQzoneMode(raw.mode, options.defaultMode || 'manual');
  return {
    mode,
    content: mode === 'manual' ? normalizeText(raw.content) : '',
    hint: mode === 'bot_diary' ? normalizeText(raw.hint) : normalizeText(raw.hint)
  };
}

function normalizeScheduledMessageInput(input = '') {
  if (typeof input === 'string') return normalizeText(input);
  const raw = input && typeof input === 'object' ? input : {};
  return normalizeText(raw.message || raw.content);
}

function requireGroupContext(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  const groupId = normalizeText(routeMeta.groupId || routeMeta.group_id);
  if (!groupId) {
    throw new Error('group context required');
  }
  return {
    groupId,
    userId: normalizeText(context.userId)
  };
}

function assertAdmin(userId = '') {
  if (!isAdminUser(userId)) {
    throw new Error('admin required');
  }
}

function summarizeTask(task = {}, options = {}) {
  const cronSummary = String(options.cronSummary || '').trim();
  const nextRunAt = normalizeText(task.nextRunAt);
  const lines = [
    `Task ID: ${task.id}`,
    `Task Type: ${task.kind}/${task.commandType}`,
    `Next Run: ${nextRunAt || 'none'}`
  ];
  if (normalizeText(task.scheduleType) === 'cron') {
    lines.push(`Cron: ${task.cronExpr}`);
    lines.push(`Summary: ${cronSummary || describeCron(task.cronExpr) || 'recurring task'}`);
  }
  return lines.join('\n');
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
  return Boolean(config.BOT_DIARY_QZONE_IMAGE_ENABLED) && isNightDiaryWindow(meta);
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
        'User-Agent': String(config.HTTP_USER_AGENT || '').trim() || 'Mozilla/5.0'
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

async function sendGroupMessage(groupId = '', message = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetGroupId = normalizeText(groupId);
  const text = normalizeText(message);
  if (!targetGroupId) throw new Error('groupId is required');
  if (!text) throw new Error('message content is required');
  await actionClient.callAction('send_group_msg', {
    group_id: targetGroupId,
    message: text
  });
  return {
    success: true,
    reason: 'group message sent'
  };
}

async function sendPrivateMessage(userId = '', message = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetUserId = normalizeText(userId);
  const text = normalizeText(message);
  if (!targetUserId) throw new Error('userId is required');
  if (!text) throw new Error('message content is required');
  await actionClient.callAction('send_private_msg', {
    user_id: targetUserId,
    message: text
  });
  return {
    success: true,
    reason: 'private message sent'
  };
}

async function sendPrivatePoke(userId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetUserId = normalizeText(userId);
  if (!targetUserId) throw new Error('userId is required');
  await actionClient.callAction('friend_poke', {
    user_id: targetUserId
  });
  return {
    success: true,
    reason: 'private poke sent'
  };
}

async function setMessageEmojiLike(messageId = '', emojiIds = [], options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const normalizedMessageId = normalizeMessageId(messageId);
  const normalizedEmojiIds = normalizeEmojiIdList(emojiIds);
  const set = options.set !== false;

  if (!normalizedMessageId) {
    return { success: false, reason: 'message_id is required', appliedEmojiIds: [] };
  }

  if (!normalizedEmojiIds.length) {
    return { success: true, reason: 'no emoji ids configured', appliedEmojiIds: [] };
  }

  const failures = [];
  for (const emojiId of normalizedEmojiIds) {
    try {
      await actionClient.callAction('set_msg_emoji_like', {
        message_id: normalizedMessageId,
        emoji_id: emojiId,
        set
      });
    } catch (error) {
      failures.push({
        emojiId,
        error: error?.message || String(error || 'unknown error')
      });
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      reason: failures[0]?.error || 'set_msg_emoji_like failed',
      appliedEmojiIds: normalizedEmojiIds.filter((emojiId) => !failures.some((item) => item.emojiId === emojiId)),
      failures
    };
  }

  return {
    success: true,
    reason: 'message emoji updated',
    appliedEmojiIds: normalizedEmojiIds
  };
}

async function publishQzoneForContext(input = '', context = {}, options = {}) {
  const { userId, groupId } = requireGroupContext(context);
  assertAdmin(userId);
  const normalized = normalizeQzonePublishInput(input);
  const publishQzone = typeof options.publishQzonePost === 'function'
    ? options.publishQzonePost
    : publishQzonePost;
  const publishQzoneImages = typeof options.publishQzonePostWithImages === 'function'
    ? options.publishQzonePostWithImages
    : publishQzonePostWithImages;
  let content = normalized.content;
  let meta = {};

  if (normalized.mode === 'bot_diary') {
    const diaryDraft = await generateBotDiaryDraft({
      groupId,
      hint: normalized.hint
    }, {
      ...(options.diaryOptions || {}),
      groupId,
      memoryUserId: normalizeText((options.diaryOptions || {}).memoryUserId || config.BOT_QQ)
    });
    if (!diaryDraft.ok) {
      return {
        ok: false,
        text: `failed\nreason: ${diaryDraft.reason || 'bot diary generation failed'}`,
        content: '',
        mode: 'bot_diary',
        meta: diaryDraft.meta || {}
      };
    }
    content = diaryDraft.content;
    meta = diaryDraft.meta || {};
  }

  let localImagePath = '';
  let publishResult = null;
  let imageMeta = {
    imageAttempted: false,
    imageGenerated: false,
    imageUploaded: false,
    imagePublishMode: 'text_only',
    imageFallbackStage: '',
    imageProviderUsed: ''
  };

  if (normalized.mode === 'bot_diary') {
    const preparedImage = await tryGenerateBotDiaryQzoneImage(content, meta, {
      buildProviderConfig: options.buildProviderConfig,
      drawPicture: options.drawPicture,
      downloadImageToLocal: options.downloadImageToLocal,
      httpClient: options.httpClient,
      downloadTimeoutMs: options.downloadTimeoutMs,
      maxBytes: options.maxBytes,
      tmpDir: options.tmpDir
    });
    imageMeta = {
      imageAttempted: preparedImage.attempted,
      imageGenerated: preparedImage.generated,
      imageUploaded: false,
      imagePublishMode: preparedImage.imagePublishMode,
      imageFallbackStage: preparedImage.imageFallbackStage,
      imageProviderUsed: preparedImage.imageProviderUsed
    };
    localImagePath = preparedImage.imagePath || '';

    if (meta?.imageIntent) {
      const imageConsistency = evaluateImageConsistency({
        text: content,
        plan: {
          imageIntent: meta.imageIntent,
          sceneAnchors: Array.isArray(meta.imagePromptHints) ? meta.imagePromptHints : []
        }
      });
      imageMeta.imageConsistencyScore = imageConsistency.score;
      imageMeta.imageVisualFingerprint = imageConsistency.visualFingerprint;
      if (!imageConsistency.consistent) {
        localImagePath = '';
        imageMeta.imagePublishMode = 'image_degraded';
        imageMeta.imageFallbackStage = 'image_consistency';
      }
    }

    if (localImagePath) {
      const imagePublish = await publishQzoneImages({
        content,
        imagePaths: [localImagePath]
      });
      if (imagePublish.success) {
        publishResult = imagePublish;
        imageMeta.imageUploaded = true;
        imageMeta.imagePublishMode = 'image_attached';
      } else if (!imagePublish.uncertain) {
        imageMeta.imagePublishMode = 'image_degraded';
        imageMeta.imageFallbackStage = normalizeText(imagePublish.stage || 'image_publish');
      } else {
        cleanupLocalImage(localImagePath);
        return {
          ok: false,
          text: `failed\nreason: ${imagePublish.reason || 'QZone image publish failed'}`,
          content,
          mode: normalized.mode,
          reason: imagePublish.reason || 'QZone image publish failed',
          source: imagePublish.source || '',
          meta: {
            ...meta,
            ...imageMeta
          }
        };
      }
    }
  }

  if (!publishResult) {
    publishResult = await publishQzone(content);
  }
  cleanupLocalImage(localImagePath);

  if (!publishResult.success) {
    return {
      ok: false,
      text: `failed\nreason: ${publishResult.reason || 'QZone publish failed'}`,
      content,
      mode: normalized.mode,
      reason: publishResult.reason || 'QZone publish failed',
      source: publishResult.source || '',
      meta: {
        ...meta,
        ...imageMeta
      }
    };
  }
  const qzoneSource = normalizeText(options.qzoneSource || normalized.mode || 'manual_qzone_post').toLowerCase() || 'manual_qzone_post';
  finalizeSuccessfulQzoneRecord({
    source: qzoneSource === 'manual' ? 'manual_qzone_post' : qzoneSource,
    text: content,
    type: normalizeText(options.qzoneType || normalized.mode || 'manual').toLowerCase(),
    topicKey: normalizeText(meta.topicKey || options.topicKey || ''),
    topicGroup: normalizeText(meta.topicGroup || options.topicGroup || ''),
    variationProfile: {
      lens: normalizeText(meta.lens || options.lens || ''),
      emotion: normalizeText(meta.emotion || options.emotion || ''),
      anchor: normalizeText(meta.anchor || options.anchor || ''),
      structure: normalizeText(meta.structure || options.structure || ''),
      ending: normalizeText(meta.ending || options.ending || ''),
      arc: normalizeText(meta.arc || options.arc || ''),
      tempo: normalizeText(meta.tempo || options.tempo || ''),
      distance: normalizeText(meta.distance || options.distance || '')
    },
    plan: meta.plan || {
      type: normalizeText(options.qzoneType || normalized.mode || 'manual').toLowerCase(),
      theme: meta.topicKey ? { key: normalizeText(meta.topicKey || '', 80).toLowerCase() } : null,
      variationProfile: {
        lens: normalizeText(meta.lens || options.lens || ''),
        emotion: normalizeText(meta.emotion || options.emotion || ''),
        anchor: normalizeText(meta.anchor || options.anchor || ''),
        structure: normalizeText(meta.structure || options.structure || ''),
        ending: normalizeText(meta.ending || options.ending || ''),
        arc: normalizeText(meta.arc || options.arc || ''),
        tempo: normalizeText(meta.tempo || options.tempo || ''),
        distance: normalizeText(meta.distance || options.distance || '')
      },
      imageIntent: meta.imageIntent || null
    },
    at: Date.now()
  });
  appendQzoneGenerationLog(normalizeTelemetryPayload({
    source: qzoneSource === 'manual' ? 'manual_qzone_post' : qzoneSource,
    type: normalizeText(options.qzoneType || normalized.mode || 'manual').toLowerCase(),
    groupId,
    status: 'sent',
    selectedFingerprint: normalizeDailyShareFingerprint ? normalizeDailyShareFingerprint(content) : '',
    selectedScore: Number.isFinite(Number(meta.selectedScore)) ? Number(meta.selectedScore) : 0,
    similarity: Number.isFinite(Number(meta.similarity)) ? Number(meta.similarity) : 0,
    imagePublishMode: normalizeText(imageMeta.imagePublishMode || '', 32).toLowerCase(),
    imageConsistencyScore: Number.isFinite(Number(imageMeta.imageConsistencyScore)) ? Number(imageMeta.imageConsistencyScore) : 0,
    failureReasons: [],
    planSummary: {
      fingerprint: normalizeText(meta.planFingerprint || '', 200).toLowerCase(),
      topicKey: normalizeText(meta.topicKey || options.topicKey || '', 80).toLowerCase(),
      topicGroup: normalizeText(meta.topicGroup || options.topicGroup || '', 80).toLowerCase(),
      lens: normalizeText(meta.lens || options.lens || '', 32).toLowerCase(),
      anchor: normalizeText(meta.anchor || options.anchor || '', 32).toLowerCase(),
      structure: normalizeText(meta.structure || options.structure || '', 32).toLowerCase(),
      arc: normalizeText(meta.arc || options.arc || '', 32).toLowerCase(),
      tempo: normalizeText(meta.tempo || options.tempo || '', 32).toLowerCase(),
      distance: normalizeText(meta.distance || options.distance || '', 32).toLowerCase()
    },
    candidates: Array.isArray(meta.candidates) ? meta.candidates : []
  }));
  return {
    ok: true,
    text: `success\nreason: ${publishResult.reason || 'QZone publish success'}\ngroup: ${groupId}`,
    content,
    mode: normalized.mode,
    reason: publishResult.reason || 'QZone publish success',
    source: publishResult.source || '',
    meta: {
      ...meta,
      ...imageMeta
    }
  };
}

function createTaskResponse(task = {}, normalizedWhen = {}) {
  return summarizeTask(task, {
    cronSummary: normalizedWhen.kind === 'cron' ? (normalizedWhen.summary || describeCron(task.cronExpr)) : ''
  });
}

function createScheduledTask(input = {}, context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const when = normalizeText(input.when);
  const normalizedWhen = normalizeWhenExpression(when);
  const created = store.createTask({
    ownerUserId: userId,
    groupId,
    kind: input.kind,
    commandType: input.commandType,
    when,
    payload: input.payload
  });
  return {
    task: created.task,
    text: createTaskResponse(created.task, normalizedWhen)
  };
}

function scheduleGroupMessage(message = '', when = '', context = {}, options = {}) {
  return createScheduledTask({
    kind: 'message',
    commandType: 'group_message',
    when,
    payload: {
      message: normalizeText(message)
    }
  }, context, options);
}

function createScheduledCommand(action = '', when = '', contentOrArgs = '', context = {}, options = {}) {
  const normalizedAction = normalizeText(action);
  if (!new Set(['group_message', 'qzone_post']).has(normalizedAction)) {
    throw new Error('unsupported action');
  }

  const { userId } = requireGroupContext(context);
  if (normalizedAction === 'qzone_post') {
    assertAdmin(userId);
  }

  const qzoneInput = normalizedAction === 'qzone_post'
    ? normalizeQzonePublishInput(contentOrArgs)
    : null;

  return createScheduledTask({
    kind: 'command',
    commandType: normalizedAction,
    when,
    payload: normalizedAction === 'group_message'
      ? { message: normalizeScheduledMessageInput(contentOrArgs) }
      : {
        mode: qzoneInput.mode,
        ...(qzoneInput.mode === 'manual'
          ? { content: qzoneInput.content }
          : { hint: qzoneInput.hint })
      }
  }, context, options);
}

function canAccessTask(task = {}, userId = '', groupId = '') {
  if (!task) return false;
  if (normalizeText(task.groupId) !== normalizeText(groupId)) return false;
  if (isAdminUser(userId)) return true;
  return normalizeText(task.ownerUserId) === normalizeText(userId);
}

function listScheduledTasks(scope = 'mine', context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const normalizedScope = normalizeText(scope || 'mine').toLowerCase() || 'mine';
  const wantsAll = normalizedScope === 'all';
  if (wantsAll && !isAdminUser(userId)) {
    throw new Error('admin required for all tasks');
  }

  const tasks = store.listTasks({
    groupId,
    ownerUserId: wantsAll ? '' : userId
  }).filter((task) => canAccessTask(task, userId, groupId));

  if (!tasks.length) {
    return {
      tasks: [],
      text: 'no visible tasks'
    };
  }

  const lines = [`Task Count: ${tasks.length}`];
  for (const task of tasks) {
    lines.push(summarizeTask(task));
  }
  return {
    tasks,
    text: lines.join('\n\n')
  };
}

function cancelScheduledTask(taskId = '', context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const task = store.getTask(taskId);
  if (!task) throw new Error('task not found');
  if (!canAccessTask(task, userId, groupId)) {
    throw new Error('no permission');
  }
  const updated = store.cancelTask(taskId);
  return {
    task: updated,
    text: summarizeTask(updated)
  };
}

function deleteScheduledTask(taskId = '', context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const task = store.getTask(taskId);
  if (!task) throw new Error('task not found');
  if (!canAccessTask(task, userId, groupId)) {
    throw new Error('no permission');
  }
  store.deleteTask(taskId);
  return {
    task,
    text: `Task ID: ${task.id}\nTask Type: ${task.kind}/${task.commandType}\nStatus: deleted`
  };
}

module.exports = {
  buildBotDiaryImagePrompt,
  cancelScheduledTask,
  createScheduledCommand,
  createScheduledTask,
  deleteScheduledTask,
  downloadImageToLocal,
  isAdminUser,
  isNightDiaryWindow,
  listScheduledTasks,
  normalizeQzonePublishInput,
  publishQzoneForContext,
  requireGroupContext,
  sanitizeDiaryImageMeta,
  sanitizeDiaryImageText,
  scheduleGroupMessage,
  sendGroupMessage,
  sendPrivatePoke,
  sendPrivateMessage,
  setMessageEmojiLike,
  shouldAttemptBotDiaryImage,
  tryGenerateBotDiaryQzoneImage
};
