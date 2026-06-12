function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function normalizeNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createMessageIngressDispatcher(options = {}) {
  const handleMessage = typeof options.handleMessage === 'function'
    ? options.handleMessage
    : async () => {};
  const maxActive = normalizePositiveInt(options.maxActive, 64);
  const maxQueueLength = normalizeNonNegativeInt(options.maxQueueLength, 200);
  const logger = options.logger || console;
  const queue = [];
  const active = new Set();
  const waiters = [];
  let accepting = true;
  let scheduled = false;
  let nextId = 0;
  let dropped = 0;
  let completed = 0;
  let failed = 0;

  function buildSnapshot() {
    return {
      accepting,
      maxActive,
      maxQueueLength,
      queued: queue.length,
      active: active.size,
      dropped,
      completed,
      failed
    };
  }

  function isIdle() {
    return queue.length === 0 && active.size === 0;
  }

  function resolveIdleWaiters() {
    if (!isIdle()) return;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.resolve(buildSnapshot());
    }
  }

  function scheduleDrain() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(drain);
  }

  async function runItem(item) {
    active.add(item);
    try {
      await handleMessage(item.msg, item.meta);
      completed += 1;
    } catch (error) {
      failed += 1;
      if (logger && typeof logger.error === 'function') {
        logger.error('[message-ingress] async job failed', {
          id: item.id,
          source: item.meta?.source || '',
          error: error?.message || String(error || '')
        });
      }
    } finally {
      active.delete(item);
      scheduleDrain();
      resolveIdleWaiters();
    }
  }

  function drain() {
    scheduled = false;
    while (active.size < maxActive && queue.length > 0) {
      const item = queue.shift();
      void runItem(item);
    }
    resolveIdleWaiters();
  }

  function enqueue(msg, meta = {}) {
    if (!accepting) {
      dropped += 1;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[message-ingress] drop message after dispatcher stopped', {
          source: meta?.source || ''
        });
      }
      return false;
    }

    if (maxQueueLength > 0 && queue.length >= maxQueueLength) {
      dropped += 1;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[message-ingress] async queue full; drop message', {
          source: meta?.source || '',
          maxQueueLength,
          active: active.size,
          queued: queue.length
        });
      }
      return false;
    }

    queue.push({
      id: ++nextId,
      msg,
      meta: {
        ...(meta && typeof meta === 'object' ? meta : {}),
        enqueuedAt: Date.now()
      }
    });
    scheduleDrain();
    return true;
  }

  function waitForIdle(timeoutMs = 0) {
    if (isIdle()) return Promise.resolve(buildSnapshot());
    const deferred = createDeferred();
    waiters.push(deferred);
    const ms = normalizeNonNegativeInt(timeoutMs, 0);
    if (ms <= 0) return deferred.promise;
    return Promise.race([
      deferred.promise,
      new Promise((resolve) => {
        setTimeout(() => resolve({
          ...buildSnapshot(),
          timedOut: true
        }), ms);
      })
    ]);
  }

  async function stop(options = {}) {
    accepting = false;
    if (options.drain === false) {
      dropped += queue.length;
      queue.length = 0;
      resolveIdleWaiters();
      return buildSnapshot();
    }
    scheduleDrain();
    return waitForIdle(options.timeoutMs);
  }

  return {
    enqueue,
    stop,
    waitForIdle,
    getSnapshot: buildSnapshot
  };
}

module.exports = {
  createMessageIngressDispatcher
};
