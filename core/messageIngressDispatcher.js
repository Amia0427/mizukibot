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
      const result = await handleMessage(item.msg, item.meta);
      completed += 1;
      item.resolve?.(result);
    } catch (error) {
      failed += 1;
      item.reject?.(error);
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

  function enqueueItem(msg, meta = {}, deferred = null) {
    if (!accepting) {
      dropped += 1;
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[message-ingress] drop message after dispatcher stopped', {
          source: meta?.source || ''
        });
      }
      deferred?.reject(Object.assign(new Error('message ingress dispatcher stopped'), {
        code: 'MESSAGE_INGRESS_STOPPED'
      }));
      return false;
    }

    queue.push({
      id: ++nextId,
      msg,
      meta: {
        ...(meta && typeof meta === 'object' ? meta : {}),
        enqueuedAt: Date.now()
      },
      resolve: deferred?.resolve,
      reject: deferred?.reject
    });
    scheduleDrain();
    return true;
  }

  function enqueue(msg, meta = {}) {
    return enqueueItem(msg, meta);
  }

  function dispatch(msg, meta = {}) {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    enqueueItem(msg, meta, { resolve, reject });
    return promise;
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
      for (const item of queue) {
        item.reject?.(Object.assign(new Error('message ingress queue discarded'), {
          code: 'MESSAGE_INGRESS_DISCARDED'
        }));
      }
      queue.length = 0;
      resolveIdleWaiters();
      return buildSnapshot();
    }
    scheduleDrain();
    return waitForIdle(options.timeoutMs);
  }

  return {
    dispatch,
    enqueue,
    stop,
    waitForIdle,
    getSnapshot: buildSnapshot
  };
}

module.exports = {
  createMessageIngressDispatcher
};
