const fs = require('fs');

const { createVoiceInputClient } = require('./client');

const TRANSCRIPT_PREFIX = '[语音转写]';
const FAILED_TRANSCRIPT = '[语音识别失败，未获得音频内容]';
const FAILED_REPLY = '语音识别失败，请稍后重试或改发文字。';
const DEDUPE_TTL_MS = 90 * 1000;
const DEDUPE_MAX_ENTRIES = 4096;

function normalizeText(value) {
  return String(value || '').trim();
}

function collectSegments(message) {
  return Array.isArray(message?.message) ? message.message : [];
}

function collectRecordSegments(message) {
  const records = collectSegments(message)
    .filter((segment) => String(segment?.type || '').toLowerCase() === 'record');
  if (records.length > 0) return records;
  return [...String(message?.raw_message || '').matchAll(/\[CQ:record,([^\]]*)\]/gi)]
    .map((match) => normalizeText(match[1].match(/(?:^|,)file=([^,]*)/i)?.[1]).replace(/&amp;/g, '&'))
    .filter(Boolean)
    .map((file) => ({ type: 'record', data: { file } }));
}

function hasOriginalText(message) {
  const segments = collectSegments(message);
  if (segments.some((segment) => (
    String(segment?.type || '').toLowerCase() === 'text'
    && normalizeText(segment?.data?.text)
  ))) return true;
  if (segments.length > 0) return false;
  return Boolean(normalizeText(String(message?.raw_message || '').replace(/\[CQ:[^\]]*\]/gi, ' ')));
}

function mentionsBot(message) {
  const botId = normalizeText(message?.self_id);
  if (!botId) return false;
  return collectSegments(message).some((segment) => (
    String(segment?.type || '').toLowerCase() === 'at'
    && normalizeText(segment?.data?.qq) === botId
  )) || String(message?.raw_message || '').includes(`[CQ:at,qq=${botId}]`);
}

function createTaskLimiter(maxConcurrency) {
  const limit = Math.max(1, Number(maxConcurrency) || 1);
  const queue = [];
  let active = 0;

  function drain() {
    while (active < limit && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

function createVoiceMessageDeduper() {
  const seen = new Map();

  function shouldSkip(message, now = Date.now()) {
    const messageId = normalizeText(message?.message_id);
    if (!messageId) return false;
    const key = [
      normalizeText(message?.message_type),
      normalizeText(message?.group_id),
      normalizeText(message?.user_id),
      messageId
    ].join(':');
    const previous = Number(seen.get(key) || 0);
    seen.set(key, now);
    for (const [entryKey, timestamp] of seen.entries()) {
      if (now - timestamp > DEDUPE_TTL_MS) seen.delete(entryKey);
    }
    while (seen.size > DEDUPE_MAX_ENTRIES) {
      seen.delete(seen.keys().next().value);
    }
    return previous > 0 && now - previous <= DEDUPE_TTL_MS;
  }

  return { shouldSkip };
}

function replaceRecordSegments(message, replacements) {
  let replacementIndex = 0;
  const segments = collectSegments(message).map((segment) => {
    if (String(segment?.type || '').toLowerCase() !== 'record') return segment;
    const text = replacements[replacementIndex] || FAILED_TRANSCRIPT;
    replacementIndex += 1;
    return { type: 'text', data: { text: ` ${text}` } };
  });
  const originalRawMessage = String(message?.raw_message || '');
  let rawReplacementIndex = 0;
  let rawMessage = originalRawMessage.replace(/\[CQ:record,[^\]]*\]/gi, () => {
    const text = replacements[rawReplacementIndex] || FAILED_TRANSCRIPT;
    rawReplacementIndex += 1;
    return text;
  });
  if (!normalizeText(originalRawMessage)) {
    rawMessage = segments.map((segment) => {
      const type = String(segment?.type || '').toLowerCase();
      if (type === 'reply' && segment?.data?.id) return `[CQ:reply,id=${segment.data.id}]`;
      if (type === 'at' && segment?.data?.qq) return `[CQ:at,qq=${segment.data.qq}]`;
      if (type === 'text') return String(segment?.data?.text || '');
      if (type === 'image' && (segment?.data?.url || segment?.data?.file)) {
        return `[CQ:image,url=${segment.data.url || segment.data.file}]`;
      }
      return '';
    }).filter(Boolean).join(' ');
  } else if (rawReplacementIndex < replacements.length) {
    rawMessage = [rawMessage, ...replacements.slice(rawReplacementIndex)].filter(Boolean).join(' ');
  }
  return {
    ...message,
    raw_message: rawMessage.replace(/\s+/g, ' ').trim(),
    message: segments
  };
}

function validateConfig(config) {
  if (config.VOICE_INPUT_ENABLED !== true) return;
  const missing = [
    ['VOICE_INPUT_API_URL', config.VOICE_INPUT_API_URL],
    ['VOICE_INPUT_API_KEY', config.VOICE_INPUT_API_KEY],
    ['VOICE_INPUT_MODEL', config.VOICE_INPUT_MODEL]
  ].filter(([, value]) => !normalizeText(value)).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`[config] Missing voice input env vars: ${missing.join(', ')}`);
  }
}

function resolveFailureReason(error) {
  const message = normalizeText(error?.message).toLowerCase();
  if (message.includes('record file is missing')) return 'record_file_missing';
  if (message.includes('get_record returned no file')) return 'converted_file_missing';
  if (message.includes('exceeds size limit')) return 'audio_too_large';
  if (message.includes('empty text')) return 'empty_transcript';
  if (error?.response?.status) return `asr_http_${error.response.status}`;
  if (error?.code === 'ENOENT') return 'audio_file_unavailable';
  return 'transcription_failed';
}

function createVoiceInputService(options = {}) {
  const config = options.config || {};
  validateConfig(config);
  const enabled = config.VOICE_INPUT_ENABLED === true;
  const actionClient = options.actionClient;
  const sendWithRetry = options.sendWithRetry;
  const logger = options.logger || console;
  const stat = options.stat || fs.promises.stat;
  const client = options.client || createVoiceInputClient({
    apiUrl: config.VOICE_INPUT_API_URL,
    apiKey: config.VOICE_INPUT_API_KEY,
    model: config.VOICE_INPUT_MODEL,
    timeoutMs: config.VOICE_INPUT_TIMEOUT_MS
  });
  const maxBytes = Math.max(1, Number(config.VOICE_INPUT_MAX_BYTES) || 5 * 1024 * 1024);
  const runLimited = createTaskLimiter(config.VOICE_INPUT_MAX_CONCURRENCY);
  const deduper = createVoiceMessageDeduper();

  async function transcribeRecord(record, messageId) {
    return runLimited(async () => {
      const sourceFile = normalizeText(record?.data?.file);
      if (!sourceFile) throw new Error('record file is missing');
      const converted = await actionClient.callAction('get_record', {
        file: sourceFile,
        out_format: 'mp3'
      });
      const filePath = normalizeText(converted?.file || converted?.path || converted);
      if (!filePath) throw new Error('NapCat get_record returned no file');
      const fileStat = await stat(filePath);
      if (Number(fileStat?.size || 0) > maxBytes) throw new Error('audio file exceeds size limit');
      return `${TRANSCRIPT_PREFIX} ${await client.transcribe(filePath)}`;
    }).catch((error) => {
      logger.warn('[voice-input] transcription failed', {
        messageId,
        reason: resolveFailureReason(error)
      });
      return FAILED_TRANSCRIPT;
    });
  }

  async function sendFailureReply(message) {
    if (typeof sendWithRetry !== 'function') return;
    const chatType = normalizeText(message?.message_type).toLowerCase();
    const payload = chatType === 'private'
      ? {
          action: 'send_private_msg',
          params: {
            user_id: normalizeText(message?.user_id),
            message: FAILED_REPLY
          }
        }
      : {
          action: 'send_group_msg',
          params: {
            group_id: normalizeText(message?.group_id),
            message: `[CQ:at,qq=${normalizeText(message?.user_id)}] ${FAILED_REPLY}`
          }
        };
    try {
      await sendWithRetry(payload, 1, 300);
    } catch (error) {
      logger.warn('[voice-input] failure reply send failed', {
        messageId: normalizeText(message?.message_id),
        reason: 'send_failed'
      });
    }
  }

  async function prepare(rawMessage) {
    if (!enabled) return { message: rawMessage, consumed: false };
    const records = collectRecordSegments(rawMessage);
    if (records.length === 0) return { message: rawMessage, consumed: false };
    if (deduper.shouldSkip(rawMessage)) return { message: null, consumed: true };

    const messageId = normalizeText(rawMessage?.message_id);
    const replacements = [];
    for (const record of records) {
      replacements.push(await transcribeRecord(record, messageId));
    }
    const allFailed = replacements.every((text) => text === FAILED_TRANSCRIPT);
    if (allFailed && !hasOriginalText(rawMessage)) {
      const privateChat = normalizeText(rawMessage?.message_type).toLowerCase() === 'private';
      if (privateChat || mentionsBot(rawMessage)) await sendFailureReply(rawMessage);
      return { message: null, consumed: true };
    }
    return {
      message: replaceRecordSegments(rawMessage, replacements),
      consumed: false
    };
  }

  return { prepare };
}

module.exports = {
  createVoiceInputService
};
