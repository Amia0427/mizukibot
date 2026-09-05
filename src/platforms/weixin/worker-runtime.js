const fs = require('fs/promises');
const path = require('path');

const { createIlinkClient } = require('./ilink-client');
const { evaluateInboundMessage: defaultEvaluateInboundMessage } = require('./inbound');
const { createWeixinMediaLoader, createWeixinMediaUploader } = require('./media');

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function wait(ms, signal) {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function errorCode(error) {
  const value = String(error?.code || error?.message || 'worker_error')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return value || 'worker_error';
}

function createWeixinWorkerRuntime(options = {}) {
  const store = options.store;
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const sleep = options.sleep || wait;
  const evaluateInboundMessage = options.evaluateInboundMessage || defaultEvaluateInboundMessage;
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5) || 5);
  const retryBaseMs = Math.max(1, Number(options.retryBaseMs || 1_000) || 1_000);
  const retryMaxMs = Math.max(retryBaseMs, Number(options.retryMaxMs || 60_000) || 60_000);
  const queueLimit = Math.max(1, Number(options.queueLimit || 20) || 20);
  const cycleIntervalMs = Math.max(0, Number(options.cycleIntervalMs || 250) || 250);
  const heartbeatIntervalMs = Math.max(1_000, Number(options.heartbeatIntervalMs || 15_000) || 15_000);
  const voiceSpoolDir = String(options.voiceSpoolDir || '').trim();
  const clients = new Map();
  const mediaLoaders = new Map();
  const mediaUploaders = new Map();
  let state = { stage: 'stopped', heartbeatAt: 0 };
  let abortController = null;
  let heartbeatTimer = null;
  let loopPromise = null;
  let running = false;

  function emitState(stage, extra = {}) {
    state = {
      stage,
      heartbeatAt: Number(now()),
      ...extra
    };
    options.onState?.({ ...state });
    return { ...state };
  }

  function heartbeat() {
    return emitState('heartbeat');
  }

  function bindingFingerprint(binding) {
    return `${binding.baseUrl}\0${binding.botToken}`;
  }

  async function stopClient(entry) {
    if (typeof entry?.client?.notifyStop === 'function') {
      await entry.client.notifyStop();
    }
  }

  async function clientFor(binding) {
    const accountId = String(binding.accountId || binding.ilinkBotId);
    const fingerprint = bindingFingerprint(binding);
    const existing = clients.get(accountId);
    if (existing?.fingerprint === fingerprint) return existing.client;
    if (existing) await stopClient(existing);
    mediaUploaders.delete(accountId);

    const client = options.createClient
      ? await options.createClient(binding)
      : createIlinkClient({
        fetch: options.fetch || globalThis.fetch,
        baseUrl: binding.baseUrl,
        token: binding.botToken
      });
    const entry = { client, fingerprint };
    clients.set(accountId, entry);
    try {
      if (typeof client.notifyStart === 'function') await client.notifyStart();
    } catch (error) {
      clients.delete(accountId);
      throw error;
    }
    return client;
  }

  function mediaLoaderFor(binding) {
    if (options.mediaLoader) return options.mediaLoader;
    const accountId = String(binding.accountId || binding.ilinkBotId);
    if (!mediaLoaders.has(accountId)) {
      mediaLoaders.set(accountId, createWeixinMediaLoader({
        fetch: options.fetch || globalThis.fetch,
        cdnBaseUrl: options.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
        cacheDir: options.mediaCacheDir
      }));
    }
    return mediaLoaders.get(accountId);
  }

  function mediaUploaderFor(binding, client) {
    const accountId = String(binding.accountId || binding.ilinkBotId);
    const existing = mediaUploaders.get(accountId);
    if (existing?.client === client) return existing.uploader;
    const uploader = options.createMediaUploader
      ? options.createMediaUploader(binding, client)
      : createWeixinMediaUploader({
        fetch: options.fetch || globalThis.fetch,
        ilinkClient: client,
        cdnBaseUrl: options.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
        allowedRoots: options.allowedOutboundRoots || []
      });
    mediaUploaders.set(accountId, { client, uploader });
    return uploader;
  }

  function isCurrentBinding(binding) {
    if (typeof store.getWorkerBindingByAccountId !== 'function') return true;
    const accountId = String(binding.accountId || binding.ilinkBotId);
    const current = store.getWorkerBindingByAccountId(accountId);
    return current?.status === 'active'
      && String(current.qqUserId) === String(binding.qqUserId)
      && String(current.ilinkUserId) === String(binding.ilinkUserId)
      && bindingFingerprint(current) === bindingFingerprint(binding);
  }

  async function pollBindingOnce(binding, pollOptions = {}) {
    const accountId = String(binding.accountId || binding.ilinkBotId);
    const client = await clientFor(binding);
    const cursor = store.getSyncCursor(accountId) || '';
    const response = await client.getUpdates({ cursor, signal: pollOptions.signal });
    if (response.ret && response.ret !== 0) {
      const error = new Error(`getUpdates failed with ret=${response.ret}`);
      error.code = 'ILINK_API_ERROR';
      error.ret = response.ret;
      throw error;
    }
    if (!isCurrentBinding(binding)) {
      return {
        accountId,
        accepted: 0,
        rejected: 0,
        received: (response.msgs || []).length,
        cursorAdvanced: false,
        inactive: true
      };
    }

    let accepted = 0;
    let rejected = 0;
    const batchOperations = [];
    const batchStore = typeof store.commitInboundBatch === 'function'
      ? {
        appendAudit: (input) => batchOperations.push({ type: 'audit', input }),
        enqueueInbox: (input) => {
          batchOperations.push({ type: 'inbox', input });
          return { inserted: true };
        },
        enqueueOutbox: (input) => {
          batchOperations.push({ type: 'outbox', input });
          return { inserted: true };
        },
        setContextToken: (tokenAccountId, peerId, token) => {
          batchOperations.push({
            type: 'context_token',
            input: { accountId: tokenAccountId, peerId, token }
          });
        }
      }
      : store;
    for (const message of response.msgs || []) {
      const result = await evaluateInboundMessage(message, binding, {
        store: batchStore,
        mediaLoader: async (item) => {
          if (!isCurrentBinding(binding)) {
            const error = new Error('Weixin binding changed before media download');
            error.code = 'WEIXIN_BINDING_INACTIVE';
            throw error;
          }
          return mediaLoaderFor(binding)(item);
        }
      });
      if (result.accepted) accepted += 1;
      else rejected += 1;
    }
    if (typeof store.commitInboundBatch === 'function') {
      store.commitInboundBatch({
        accountId,
        cursor: response.get_updates_buf,
        operations: batchOperations,
        expectedBinding: {
          qqUserId: binding.qqUserId,
          ilinkUserId: binding.ilinkUserId,
          botToken: binding.botToken,
          baseUrl: binding.baseUrl
        }
      });
    } else if (response.get_updates_buf !== undefined) {
      store.setSyncCursor(accountId, response.get_updates_buf);
    }
    return {
      accountId,
      accepted,
      rejected,
      received: (response.msgs || []).length,
      cursorAdvanced: response.get_updates_buf !== undefined
    };
  }

  async function removeInactiveClients(activeBindings) {
    const activeIds = new Set(activeBindings.map((binding) => String(binding.accountId || binding.ilinkBotId)));
    for (const [accountId, entry] of clients) {
      if (activeIds.has(accountId)) continue;
      await stopClient(entry);
      clients.delete(accountId);
      mediaLoaders.delete(accountId);
      mediaUploaders.delete(accountId);
    }
  }

  async function pollAccountsOnce(pollOptions = {}) {
    const bindings = store.listActiveWorkerBindings();
    await removeInactiveClients(bindings);
    const settled = await Promise.allSettled(
      bindings.map((binding) => pollBindingOnce(binding, pollOptions))
    );
    return settled.map((result, index) => ({
      accountId: String(bindings[index].accountId || bindings[index].ilinkBotId),
      ...result
    }));
  }

  function retryInput(item, error) {
    const failure = { errorCode: errorCode(error) };
    if (error?.code !== 'WEIXIN_OUTBOX_BINDING_MISMATCH' && item.attempts < maxAttempts) {
      const exponent = Math.max(0, item.attempts - 1);
      failure.retryAt = Number(now()) + Math.min(retryMaxMs, retryBaseMs * (2 ** exponent));
    }
    return failure;
  }

  function isWithinVoiceSpool(filePath) {
    if (!voiceSpoolDir || !filePath) return false;
    const root = path.resolve(voiceSpoolDir);
    const target = path.resolve(filePath);
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  async function cleanupOutboxAttachments(payload) {
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    for (const attachment of attachments) {
      const filePath = String(attachment?.path || '').trim();
      if (!attachment?.cleanupAfterSend || !isWithinVoiceSpool(filePath)) continue;
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') logger.warn('[weixin-worker] voice spool cleanup failed', {
          filePath,
          errorCode: errorCode(error)
        });
      }
    }
  }

  async function processInboxOnce() {
    if (typeof options.dispatchInbox !== 'function') {
      return { claimed: 0, completed: 0, failed: 0 };
    }
    const items = store.claimInbox({ limit: queueLimit });
    let completed = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await options.dispatchInbox(item.payload, item);
        store.completeInbox(item.id);
        completed += 1;
      } catch (error) {
        store.failInbox(item.id, retryInput(item, error));
        failed += 1;
      }
    }
    return { claimed: items.length, completed, failed };
  }

  async function outboxBody(item, binding, client) {
    const payload = item.payload || {};
    let sourceMessage;
    if (payload.msg) {
      sourceMessage = payload.msg;
    } else {
        const itemList = [];
      const text = String(payload.text || '').trim();
      if (text) itemList.push({ type: 1, text_item: { text } });
      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        const uploader = mediaUploaderFor(binding, client);
        for (const attachment of payload.attachments) {
          const kind = ['image', 'voice'].includes(attachment.kind) ? attachment.kind : 'file';
          const uploaded = await uploader({
            filePath: attachment.path,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            voice: attachment.voice,
            kind,
            toUserId: item.peerId
          });
          itemList.push(uploaded.messageItem);
        }
      }
      sourceMessage = { item_list: itemList };
    }
    const contextToken = sourceMessage.context_token || store.getContextToken(item.accountId, item.peerId) || undefined;
    const msg = {
      ...sourceMessage,
      from_user_id: binding.ilinkBotId,
      to_user_id: item.peerId,
      client_id: item.clientId,
      message_type: sourceMessage.message_type ?? 2,
      message_state: sourceMessage.message_state ?? 2,
      context_token: contextToken
    };
    return payload.msg ? { ...payload, msg } : { msg };
  }

  async function processOutboxOnce() {
    const items = store.claimOutbox({ limit: queueLimit });
    let completed = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const binding = store.getWorkerBindingByAccountId(item.accountId);
        if (!binding) throw new Error('binding unavailable');
        if (
          binding.status !== 'active'
          || String(binding.ilinkBotId) !== String(item.accountId)
          || String(binding.ilinkUserId) !== String(item.peerId)
        ) {
          const error = new Error('Weixin outbox binding mismatch');
          error.code = 'WEIXIN_OUTBOX_BINDING_MISMATCH';
          throw error;
        }
        const client = await clientFor(binding);
        await client.sendMessage(await outboxBody(item, binding, client));
        store.completeOutbox(item.id);
        await cleanupOutboxAttachments(item.payload);
        completed += 1;
      } catch (error) {
        const failure = retryInput(item, error);
        store.failOutbox(item.id, failure);
        if (!failure.retryAt) await cleanupOutboxAttachments(item.payload);
        failed += 1;
      }
    }
    return { claimed: items.length, completed, failed };
  }

  async function runLoop(signal) {
    while (running && !signal.aborted) {
      try {
        const accounts = await pollAccountsOnce({ signal });
        for (const account of accounts) {
          if (account.status === 'rejected') {
            logger.error('[weixin-worker] account poll failed', {
              accountId: account.accountId,
              errorCode: errorCode(account.reason)
            });
          }
        }
      } catch (error) {
        logger.error('[weixin-worker] account poll cycle failed', { errorCode: errorCode(error) });
      }
      if (signal.aborted || !running) break;
      try {
        await processInboxOnce();
        await processOutboxOnce();
      } catch (error) {
        logger.error('[weixin-worker] queue cycle failed', { errorCode: errorCode(error) });
      }
      await sleep(cycleIntervalMs, signal);
    }
  }

  function start() {
    if (running) return { ...state };
    emitState('starting');
    running = true;
    abortController = new AbortController();
    emitState('ready');
    heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    if (options.autoRun !== false) loopPromise = runLoop(abortController.signal);
    return { ...state };
  }

  async function drainAndStop() {
    if (!running && state.stage === 'stopped') return { ...state };
    emitState('draining');
    running = false;
    abortController?.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (loopPromise) await loopPromise;
    loopPromise = null;
    const stopping = [...clients.values()].map((entry) => stopClient(entry));
    await Promise.allSettled(stopping);
    clients.clear();
    mediaLoaders.clear();
    mediaUploaders.clear();
    return emitState('stopped');
  }

  return {
    drainAndStop,
    getState: () => ({ ...state }),
    heartbeat,
    pollAccountsOnce,
    pollBindingOnce,
    processInboxOnce,
    processOutboxOnce,
    start
  };
}

module.exports = {
  DEFAULT_CDN_BASE_URL,
  createWeixinWorkerRuntime
};
