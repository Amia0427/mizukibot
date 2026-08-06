const { createWeixinCommandHandler } = require('./commands');

const POLL_INTERVAL_MS = 1_000;
const NOTIFY_STOP_TIMEOUT_MS = 10_000;
const TERMINAL_ATTEMPT_STATUSES = new Set(['confirmed', 'expired', 'cancelled', 'failed']);

function normalizeText(value) {
  return String(value || '').trim();
}

function defaultDelay(delayMs, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function createWeixinRuntime(options = {}) {
  const store = options.store;
  const loginClient = options.loginClient;
  const sendReply = options.sendReply;
  const notifyStop = options.notifyStop;
  const onBindingConfirmed = typeof options.onBindingConfirmed === 'function'
    ? options.onBindingConfirmed
    : () => {};
  const onBindingRemoved = typeof options.onBindingRemoved === 'function'
    ? options.onBindingRemoved
    : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const delay = typeof options.delay === 'function' ? options.delay : defaultDelay;
  const pollIntervalMs = Number(options.pollIntervalMs || POLL_INTERVAL_MS);
  const notifyStopTimeoutMs = Number(options.notifyStopTimeoutMs || NOTIFY_STOP_TIMEOUT_MS);
  const autoPoll = options.autoPoll !== false;
  const activePolls = new Map();
  let closed = false;
  let commandHandler;

  if (!store) throw new TypeError('weixin store is required');
  if (!loginClient || typeof loginClient.getQrCodeStatus !== 'function') {
    throw new TypeError('weixin login client with QR status support is required');
  }
  if (typeof sendReply !== 'function') throw new TypeError('weixin sendReply is required');
  if (typeof notifyStop !== 'function') throw new TypeError('weixin notifyStop is required');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError('weixin poll interval must be positive');
  }
  if (!Number.isFinite(notifyStopTimeoutMs) || notifyStopTimeoutMs <= 0) {
    throw new TypeError('weixin notify stop timeout must be positive');
  }

  function replyContext(attempt, context = {}) {
    if (normalizeText(context.userId || context.user_id || context.qqUserId)) return context;
    return {
      platform: 'qq',
      chatType: 'private',
      userId: attempt.qqUserId
    };
  }

  async function reply(attempt, context, text) {
    await sendReply(replyContext(attempt, context), { text });
  }

  async function failLoginAttempt(attempt, context, text) {
    const updated = store.updateLoginAttempt(attempt.attemptId, { status: 'failed' });
    await reply(attempt, context, text);
    return { status: 'failed', attempt: updated };
  }

  async function pollLoginAttempt(attemptId, context = {}, pollOptions = {}) {
    const attempt = store.getLoginAttemptForWorker(attemptId);
    if (!attempt) return { status: 'not_found' };
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return { status: attempt.status, attempt };
    if (attempt.expiresAt <= now()) {
      const expired = store.expireLoginAttempt(attempt.attemptId);
      await reply(attempt, context, '微信绑定二维码已过期，请重新发起绑定。');
      return { status: 'expired', attempt: expired };
    }

    const response = await loginClient.getQrCodeStatus({
      qrcode: attempt.loginCredential,
      signal: pollOptions.signal
    });
    const status = normalizeText(response?.status).toLowerCase();
    if (status === 'wait' || status === 'scaned_but_redirect') {
      return { status: 'pending', attempt: store.getLoginAttempt(attempt.attemptId) };
    }
    if (status === 'scaned') {
      const scanned = store.updateLoginAttempt(attempt.attemptId, { status: 'scanned' });
      return { status: 'scanned', attempt: scanned };
    }
    if (status === 'expired') {
      const expired = store.expireLoginAttempt(attempt.attemptId);
      await reply(attempt, context, '微信绑定二维码已过期，请重新发起绑定。');
      return { status: 'expired', attempt: expired };
    }
    if (status === 'binded_redirect') {
      const binding = store.getBindingByQqUserId(attempt.qqUserId);
      if (!binding) {
        return failLoginAttempt(attempt, context, '微信未返回新的绑定凭据，请重新生成二维码。');
      }
      const confirmed = store.updateLoginAttempt(attempt.attemptId, { status: 'confirmed' });
      await reply(attempt, context, '该微信 ClawBot 已绑定，无需重复操作。');
      return { status: 'confirmed', attempt: confirmed, binding };
    }
    if (status === 'need_verifycode' || status === 'verify_code_blocked') {
      return failLoginAttempt(attempt, context, '本次扫码需要额外验证，请重新生成二维码后再试。');
    }
    if (status !== 'confirmed') {
      return { status: 'pending', attempt: store.getLoginAttempt(attempt.attemptId) };
    }

    const botToken = normalizeText(response.bot_token);
    const ilinkBotId = normalizeText(response.ilink_bot_id);
    const ilinkUserId = normalizeText(response.ilink_user_id);
    const baseUrl = normalizeText(response.baseurl);
    if (!botToken || !ilinkBotId || !ilinkUserId || !baseUrl) {
      return failLoginAttempt(attempt, context, '微信确认成功，但返回的绑定信息不完整，请重新绑定。');
    }

    const previousBinding = store.getBindingByQqUserId(attempt.qqUserId);
    const previousWorkerBinding = store.getWorkerBindingByQqUserId(attempt.qqUserId);
    let binding;
    try {
      binding = store.saveBinding({
        qqUserId: attempt.qqUserId,
        ilinkUserId,
        ilinkBotId,
        botToken,
        baseUrl,
        notificationPlatform: previousBinding?.notificationPlatform || 'qq'
      });
    } catch (error) {
      if (
        error?.code !== 'WEIXIN_ILINK_USER_ALREADY_BOUND'
        && error?.code !== 'WEIXIN_ILINK_BOT_ALREADY_BOUND'
      ) {
        throw error;
      }
      return failLoginAttempt(attempt, context, '该微信账号或 ClawBot 已绑定到其他 QQ，无法重复绑定。');
    }
    try {
      await onBindingConfirmed(binding, previousBinding);
    } catch (_) {
      if (previousWorkerBinding) {
        store.saveBinding(previousWorkerBinding);
        if (previousWorkerBinding.ilinkBotId !== binding.ilinkBotId) {
          store.deleteAccountState(binding.ilinkBotId);
        }
      }
      else store.deleteBinding(attempt.qqUserId);
      return failLoginAttempt(attempt, context, '微信身份绑定失败，原绑定已保留，请稍后重试。');
    }
    if (previousWorkerBinding && previousWorkerBinding.ilinkBotId !== binding.ilinkBotId) {
      store.deleteAccountState(previousWorkerBinding.ilinkBotId);
    }
    const confirmed = store.updateLoginAttempt(attempt.attemptId, { status: 'confirmed' });
    await reply(attempt, context, '微信 ClawBot 绑定成功。');
    return { status: 'confirmed', attempt: confirmed, binding };
  }

  async function watchLoginAttempt(attempt, context = {}) {
    if (closed) return { status: 'closed' };
    const existing = activePolls.get(attempt.attemptId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = (async () => {
      while (!closed && !controller.signal.aborted) {
        try {
          const result = await pollLoginAttempt(attempt.attemptId, context, {
            signal: controller.signal
          });
          if (result.status !== 'pending' && result.status !== 'scanned') return result;
        } catch (error) {
          if (controller.signal.aborted || closed) return { status: 'closed' };
        }
        await delay(pollIntervalMs, controller.signal);
      }
      return { status: 'closed' };
    })();
    activePolls.set(attempt.attemptId, { controller, promise });
    promise.finally(() => activePolls.delete(attempt.attemptId));
    return promise;
  }

  function trackLoginAttempt(attempt, context) {
    if (autoPoll) void watchLoginAttempt(attempt, context);
  }

  async function stopRemote(binding) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('Weixin notify stop timed out');
        error.code = 'WEIXIN_NOTIFY_STOP_TIMEOUT';
        reject(error);
      }, notifyStopTimeoutMs);
    });
    try {
      await Promise.race([notifyStop(binding, { signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function approvedUnbind(input) {
    const qqUserId = normalizeText(input.qqUserId || input.userId || input.user_id);
    const marked = store.markBindingRevoking(qqUserId);
    if (!marked) return { ok: false, reason: 'not_bound' };
    const binding = store.getWorkerBindingByQqUserId(qqUserId);
    let remoteStopped = true;
    try {
      await stopRemote(binding);
    } catch (_) {
      remoteStopped = false;
    }
    try {
      await onBindingRemoved(binding);
    } catch (error) {
      store.saveBinding(binding);
      throw error;
    }
    store.deleteBinding(qqUserId);
    await sendReply(input, {
      text: remoteStopped
        ? '微信 ClawBot 已解绑。'
        : '本地微信绑定已清除；远端停止通知未确认。'
    });
    return { ok: true, remoteStopped };
  }

  async function approvedRebind(input) {
    return commandHandler.beginLogin(input, 'rebind');
  }

  commandHandler = createWeixinCommandHandler({
    ...options,
    onApprovedRebind: approvedRebind,
    onApprovedUnbind: approvedUnbind,
    onLoginStarted: trackLoginAttempt
  });

  async function close() {
    closed = true;
    const pending = [];
    for (const active of activePolls.values()) {
      active.controller.abort();
      pending.push(active.promise);
    }
    await Promise.allSettled(pending);
  }

  return {
    approvedRebind,
    approvedUnbind,
    close,
    handleCommand: commandHandler.handle,
    pollLoginAttempt,
    watchLoginAttempt
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  createWeixinRuntime
};
