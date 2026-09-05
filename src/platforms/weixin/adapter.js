const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { createInboundMessage } = require('../contracts');
const { createFfmpegNativeVoiceEncoder, sanitizeFileName } = require('./media');

const WEIXIN_CAPABILITIES = Object.freeze(['text', 'image', 'file', 'audio']);

function normalizeText(value) {
  return String(value || '').trim();
}

function targetAccountId(target = {}) {
  return normalizeText(target.accountId || target.containerId);
}

function targetPeerId(target = {}) {
  return normalizeText(target.peerId || target.externalUserId || target.conversationId);
}

function matchesBinding(input, binding) {
  if (!binding || binding.status !== 'active') return false;
  return normalizeText(input.chatType) === 'private'
    && normalizeText(input.accountId) === normalizeText(binding.accountId || binding.ilinkBotId)
    && normalizeText(input.peerId) === normalizeText(binding.ilinkUserId)
    && normalizeText(input.qqUserId) === normalizeText(binding.qqUserId);
}

function createWeixinAdapter(options = {}) {
  const enabled = options.enabled === true;
  const store = options.store;
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs || 250) || 250);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const createClientId = typeof options.createClientId === 'function'
    ? options.createClientId
    : crypto.randomUUID;
  const getWorkerHealth = typeof options.getWorkerHealth === 'function'
    ? options.getWorkerHealth
    : null;
  const voiceSpoolDir = normalizeText(options.voiceSpoolDir);
  const nativeVoiceEnabled = options.nativeVoiceEnabled === true;
  const nativeVoiceEncoder = options.nativeVoiceEncoder
    || createFfmpegNativeVoiceEncoder({ ffmpegPath: options.ffmpegPath });
  let timer = null;
  let running = false;
  let inFlight = null;
  let dispatch = null;

  if (enabled && !store) throw new TypeError('weixin store is required when adapter is enabled');

  function bindingForTarget(target) {
    if (!enabled || normalizeText(target?.platform) !== 'weixin') return null;
    const accountId = targetAccountId(target);
    const peerId = targetPeerId(target);
    const qqUserId = normalizeText(
      target?.context?.personId
      || target?.personId
      || target?.canonicalUserId
    );
    if (normalizeText(target?.chatType) !== 'private' || !accountId || !peerId) return null;
    const binding = store.getBindingByAccountId(accountId);
    return matchesBinding({
      accountId,
      peerId,
      qqUserId: qqUserId || binding?.qqUserId,
      chatType: target.chatType
    }, binding) ? binding : null;
  }

  function validateTarget(target) {
    return Boolean(bindingForTarget(target));
  }

  function normalizeInboxItem(item) {
    const payload = item.payload || {};
    const accountId = normalizeText(payload.accountId || item.accountId);
    const peerId = normalizeText(payload.peerId || payload.platformUserId || item.peerId);
    const qqUserId = normalizeText(payload.canonicalUserId || item.qqUserId);
    const binding = store.getBindingByAccountId(accountId);
    if (!matchesBinding({ accountId, peerId, qqUserId, chatType: payload.chatType }, binding)) return null;
    return createInboundMessage({
      platform: 'weixin',
      eventId: normalizeText(payload.messageId || item.messageId),
      occurredAt: Number(payload.occurredAt || now()),
      actor: {
        externalId: peerId,
        personId: qqUserId,
        displayName: peerId
      },
      conversation: {
        chatType: 'private',
        conversationId: peerId,
        containerId: accountId
      },
      text: payload.text,
      attachments: payload.attachments,
      botExternalId: accountId,
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : WEIXIN_CAPABILITIES
    });
  }

  async function processInboxOnce(onMessage = dispatch) {
    if (!enabled || typeof onMessage !== 'function') {
      return { claimed: 0, completed: 0, failed: 0, rejected: 0 };
    }
    const items = store.claimInbox({ limit: 20 });
    let completed = 0;
    let failed = 0;
    let rejected = 0;
    for (const item of items) {
      try {
        const message = normalizeInboxItem(item);
        if (!message) {
          store.appendAudit({
            accountId: item.accountId,
            eventType: 'inbound_rejected',
            reason: 'inbox_binding_mismatch',
            senderId: item.peerId
          });
          store.completeInbox(item.id);
          completed += 1;
          rejected += 1;
          continue;
        }
        await onMessage(message, 'weixin_inbox');
        store.completeInbox(item.id);
        completed += 1;
      } catch (error) {
        const attempts = Number(item.attempts || 0);
        store.failInbox(item.id, {
          errorCode: normalizeText(error?.code || 'main_dispatch_failed').toLowerCase(),
          ...(attempts < 5 ? { retryAt: now() + Math.min(60_000, 1_000 * (2 ** Math.max(0, attempts - 1))) } : {})
        });
        failed += 1;
      }
    }
    return { claimed: items.length, completed, failed, rejected };
  }

  async function enqueue(target, payload) {
    const binding = bindingForTarget(target);
    if (!binding) return false;
    const result = store.enqueueOutbox({
      clientId: normalizeText(createClientId()),
      accountId: normalizeText(binding.accountId || binding.ilinkBotId),
      peerId: normalizeText(binding.ilinkUserId),
      payload
    });
    return result.inserted || result.item?.status === 'pending' || result.item?.status === 'processing';
  }

  function sendText(target, text) {
    const normalized = normalizeText(text);
    return normalized ? enqueue(target, { text: normalized, attachments: [] }) : Promise.resolve(false);
  }

  function sendAttachment(target, value, kind) {
    const filePath = normalizeText(value).replace(/^file:\/\//i, '');
    if (!filePath || /^(?:https?:|base64:|data:)/i.test(filePath)) return Promise.resolve(false);
    return enqueue(target, { text: '', attachments: [{ kind, path: filePath }] });
  }

  async function sendAudio(target, audio) {
    const binding = bindingForTarget(target);
    const buffer = Buffer.isBuffer(audio) ? audio : audio?.buffer;
    if (!binding || !Buffer.isBuffer(buffer) || buffer.length === 0 || !voiceSpoolDir) {
      return { status: 'not_submitted', mode: 'file' };
    }
    const fileName = sanitizeFileName(audio?.fileName || 'voice.mp3');
    const spoolId = normalizeText(createClientId());
    const sourcePath = path.join(voiceSpoolDir, `${spoolId}-${fileName}`);
    await fs.mkdir(voiceSpoolDir, { recursive: true });
    await fs.writeFile(sourcePath, buffer);
    let filePath = sourcePath;
    let kind = 'file';
    let outputFileName = fileName;
    let outputMimeType = normalizeText(audio?.mimeType) || 'audio/mpeg';
    let voice = null;
    if (nativeVoiceEnabled) {
      const nativeFileName = `${path.parse(fileName).name}.silk`;
      const nativePath = path.join(voiceSpoolDir, `${spoolId}-${nativeFileName}`);
      try {
        const encoded = await nativeVoiceEncoder({
          inputPath: sourcePath,
          outputPath: nativePath,
          fileName: nativeFileName,
          playTimeMs: audio?.playTimeMs
        });
        filePath = encoded.filePath;
        outputFileName = sanitizeFileName(encoded.fileName || nativeFileName);
        outputMimeType = normalizeText(encoded.mimeType) || 'audio/silk';
        kind = 'voice';
        voice = {
          encodeType: encoded.encodeType,
          sampleRate: encoded.sampleRate,
          bitsPerSample: encoded.bitsPerSample,
          playTimeMs: encoded.playTimeMs
        };
        await fs.unlink(sourcePath);
      } catch (error) {
        await fs.unlink(nativePath).catch(() => {});
        console.warn('[weixin] native voice experiment fell back to file', error?.message || error);
      }
    }
    try {
      const queued = await enqueue(target, {
        text: '',
        attachments: [{
          kind,
          path: filePath,
          name: outputFileName,
          mimeType: outputMimeType,
          cleanupAfterSend: true,
          ...(voice ? { voice } : {})
        }]
      });
      if (!queued) {
        await fs.unlink(filePath);
        return { status: 'not_submitted', mode: 'file' };
      }
      return { status: 'accepted', mode: 'file' };
    } catch (error) {
      await fs.unlink(filePath).catch(() => {});
      throw error;
    }
  }

  function schedule() {
    if (!running || inFlight) return;
    inFlight = processInboxOnce()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
  }

  async function start(input = {}) {
    if (!enabled || running) return;
    dispatch = input.onMessage;
    running = true;
    schedule();
    timer = setInterval(schedule, pollIntervalMs);
    timer.unref?.();
  }

  async function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    await inFlight;
    inFlight = null;
  }

  return {
    platform: 'weixin',
    enabled,
    capabilities: WEIXIN_CAPABILITIES,
    getHealth() {
      if (!enabled) return { status: 'disabled' };
      if (!running) return { status: 'starting' };
      const worker = getWorkerHealth?.();
      return worker ? { status: worker.status === 'online' ? 'online' : 'degraded', worker } : { status: 'online' };
    },
    processInboxOnce,
    sendAudio,
    sendFile: (target, filePath) => sendAttachment(target, filePath, 'file'),
    sendImage: (target, filePath) => sendAttachment(target, filePath, 'image'),
    sendText,
    start,
    stop,
    validateTarget
  };
}

module.exports = {
  WEIXIN_CAPABILITIES,
  createWeixinAdapter
};
