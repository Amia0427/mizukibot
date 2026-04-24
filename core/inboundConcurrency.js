function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) return fallback;
  return num;
}

function normalizeNonNegativeInt(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) return fallback;
  return num;
}

function buildRequestId(request = {}) {
  const messageId = String(request.messageId || '').trim();
  const sessionKey = String(request.sessionKey || '').trim();
  const userId = String(request.userId || '').trim();
  const groupId = String(request.groupId || '').trim();
  const chatType = String(request.chatType || '').trim();
  return `${chatType}:${groupId}:${sessionKey || userId}:${messageId || Date.now()}`;
}

function createInboundConcurrencyController(options = {}) {
  const globalLimit = normalizeNonNegativeInt(options.globalLimit, 3);
  const generalLimit = normalizeNonNegativeInt(options.generalLimit, 2);
  const adminLimit = normalizeNonNegativeInt(options.adminLimit, 1);
  const perUserLimit = normalizePositiveInt(options.perUserLimit, 1);
  const maxQueueLength = normalizeNonNegativeInt(options.maxQueueLength, 0);
  const queueTimeoutMs = normalizeNonNegativeInt(options.queueTimeoutMs, 0);
  let nextGeneralSessionCursor = 0;

  const laneLimits = {
    general: generalLimit,
    admin: adminLimit
  };
  const queues = {
    general: [],
    admin: []
  };
  const activeByLane = {
    general: 0,
    admin: 0
  };
  const activeBySession = new Map();

  function getActiveForSession(sessionKey = '') {
    return Math.max(0, Number(activeBySession.get(String(sessionKey || '').trim()) || 0) || 0);
  }

  function getTotalActive() {
    return activeByLane.general + activeByLane.admin;
  }

  function buildSnapshot() {
    return {
      globalLimit,
      generalLimit,
      adminLimit,
      totalActive: getTotalActive(),
      activeGeneral: activeByLane.general,
      activeAdmin: activeByLane.admin,
      queuedGeneral: queues.general.length,
      queuedAdmin: queues.admin.length,
      maxQueueLength,
      queueTimeoutMs
    };
  }

  function clearQueuedRequest(item) {
    if (item?.timer) clearTimeout(item.timer);
  }

  function hasLaneCapacity(lane) {
    if (!Object.prototype.hasOwnProperty.call(laneLimits, lane)) return false;
    if (laneLimits[lane] <= 0) return false;
    if (globalLimit <= 0) return false;
    if (getTotalActive() >= globalLimit) return false;
    if (activeByLane[lane] >= laneLimits[lane]) return false;
    return true;
  }

  function canAcquire(request = {}) {
    const lane = String(request.lane || '').trim().toLowerCase();
    const sessionKey = String(request.sessionKey || request.userId || '').trim();
    if (!Object.prototype.hasOwnProperty.call(laneLimits, lane)) return false;
    if (!sessionKey) return false;
    if (!hasLaneCapacity(lane)) return false;
    if (getActiveForSession(sessionKey) >= perUserLimit) return false;
    return true;
  }

  function reserveSlot(request = {}) {
    const lane = String(request.lane || '').trim().toLowerCase();
    const sessionKey = String(request.sessionKey || request.userId || '').trim();
    const userId = String(request.userId || '').trim();
    activeByLane[lane] += 1;
    activeBySession.set(sessionKey, getActiveForSession(sessionKey) + 1);

    if (getTotalActive() > globalLimit) {
      throw new Error('[inbound-concurrency] global limit exceeded');
    }

    const acquiredAt = Date.now();
    const waitMs = Math.max(0, acquiredAt - (Number(request.enqueuedAt || 0) || acquiredAt));
    const requestId = buildRequestId(request);
      console.log('[inbound-concurrency] acquired', {
        lane,
        userId,
        sessionKey,
        requestId,
      groupId: String(request.groupId || '').trim(),
      messageId: String(request.messageId || '').trim(),
      chatType: String(request.chatType || '').trim(),
      concurrencyScope: String(request.concurrencyScope || '').trim(),
      privilegedPrivateChat: request.privilegedPrivateChat === true,
      waitMs,
      ...buildSnapshot()
    });

    let released = false;
    return {
      requestId,
      lane,
      acquiredAt,
      waitMs,
      release(meta = {}) {
        if (released) return;
        released = true;

        activeByLane[lane] = Math.max(0, activeByLane[lane] - 1);
        const remainingForSession = Math.max(0, getActiveForSession(sessionKey) - 1);
        if (remainingForSession > 0) activeBySession.set(sessionKey, remainingForSession);
        else activeBySession.delete(sessionKey);

        console.log('[inbound-concurrency] released', {
          lane,
          userId,
          sessionKey,
          requestId,
          groupId: String(request.groupId || '').trim(),
          messageId: String(request.messageId || '').trim(),
          chatType: String(request.chatType || '').trim(),
          concurrencyScope: String(request.concurrencyScope || '').trim(),
          privilegedPrivateChat: request.privilegedPrivateChat === true,
          abnormalEnd: meta.hadError === true,
          runtimeMs: Math.max(0, Date.now() - acquiredAt),
          ...buildSnapshot()
        });

        drainQueues();
      }
    };
  }

  function takeNextEligible(lane) {
    const queue = queues[lane];
    const seenSessions = new Set();
    const startIndex = lane === 'general' && queue.length > 0 ? nextGeneralSessionCursor % queue.length : 0;
    for (let offset = 0; offset < queue.length; offset += 1) {
      const i = (startIndex + offset) % queue.length;
      const sessionKey = String(queue[i]?.sessionKey || '').trim();
      if (seenSessions.has(sessionKey)) continue;
      seenSessions.add(sessionKey);
      if (canAcquire(queue[i])) {
        const item = queue.splice(i, 1)[0];
        clearQueuedRequest(item);
        if (lane === 'general') nextGeneralSessionCursor = i;
        return item;
      }
    }
    return null;
  }

  function drainQueues() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const lane of ['admin', 'general']) {
        if (!hasLaneCapacity(lane)) continue;
        const next = takeNextEligible(lane);
        if (!next) continue;
        progressed = true;
        next.resolve(reserveSlot(next));
        if (getTotalActive() >= globalLimit) return;
      }
    }
  }

  async function acquire(request = {}) {
    const normalized = {
      userId: String(request.userId || '').trim(),
      sessionKey: String(request.sessionKey || request.userId || '').trim(),
      lane: String(request.lane || 'general').trim().toLowerCase() === 'admin' ? 'admin' : 'general',
      messageId: String(request.messageId || '').trim(),
      groupId: String(request.groupId || '').trim(),
      chatType: String(request.chatType || '').trim(),
      concurrencyScope: String(request.concurrencyScope || '').trim(),
      privilegedPrivateChat: request.privilegedPrivateChat === true,
      enqueuedAt: Date.now()
    };

    if (!normalized.sessionKey) {
      throw new Error('[inbound-concurrency] sessionKey is required');
    }

    if (canAcquire(normalized)) {
      return reserveSlot(normalized);
    }

    if (maxQueueLength > 0 && queues[normalized.lane].length >= maxQueueLength) {
      throw new Error(`[inbound-concurrency] ${normalized.lane} queue is full`);
    }

    return new Promise((resolve, reject) => {
      const queued = {
        ...normalized,
        resolve,
        reject,
        timer: null
      };
      if (queueTimeoutMs > 0) {
        queued.timer = setTimeout(() => {
          const index = queues[normalized.lane].indexOf(queued);
          if (index >= 0) queues[normalized.lane].splice(index, 1);
          reject(new Error(`[inbound-concurrency] queued request timed out after ${queueTimeoutMs}ms`));
        }, queueTimeoutMs);
      }
      queues[normalized.lane].push(queued);
      console.log('[inbound-concurrency] queued', {
        lane: normalized.lane,
        userId: normalized.userId,
        sessionKey: normalized.sessionKey,
        requestId: buildRequestId(normalized),
        groupId: normalized.groupId,
        messageId: normalized.messageId,
        chatType: normalized.chatType,
        concurrencyScope: normalized.concurrencyScope,
        privilegedPrivateChat: normalized.privilegedPrivateChat,
        queueLength: queues[normalized.lane].length,
        ...buildSnapshot()
      });
      drainQueues();
    });
  }

  return {
    acquire,
    getSnapshot: buildSnapshot
  };
}

module.exports = {
  createInboundConcurrencyController
};
