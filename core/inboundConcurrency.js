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
  const userId = String(request.userId || '').trim();
  const groupId = String(request.groupId || '').trim();
  const chatType = String(request.chatType || '').trim();
  return `${chatType}:${groupId}:${userId}:${messageId || Date.now()}`;
}

function createInboundConcurrencyController(options = {}) {
  const globalLimit = normalizeNonNegativeInt(options.globalLimit, 3);
  const generalLimit = normalizeNonNegativeInt(options.generalLimit, 2);
  const adminLimit = normalizeNonNegativeInt(options.adminLimit, 1);
  const perUserLimit = normalizePositiveInt(options.perUserLimit, 1);

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
  const activeByUser = new Map();

  function getActiveForUser(userId = '') {
    return Math.max(0, Number(activeByUser.get(String(userId || '').trim()) || 0) || 0);
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
      queuedAdmin: queues.admin.length
    };
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
    const userId = String(request.userId || '').trim();
    if (!Object.prototype.hasOwnProperty.call(laneLimits, lane)) return false;
    if (!userId) return false;
    if (!hasLaneCapacity(lane)) return false;
    if (getActiveForUser(userId) >= perUserLimit) return false;
    return true;
  }

  function reserveSlot(request = {}) {
    const lane = String(request.lane || '').trim().toLowerCase();
    const userId = String(request.userId || '').trim();
    activeByLane[lane] += 1;
    activeByUser.set(userId, getActiveForUser(userId) + 1);

    if (getTotalActive() > globalLimit) {
      throw new Error('[inbound-concurrency] global limit exceeded');
    }

    const acquiredAt = Date.now();
    const waitMs = Math.max(0, acquiredAt - (Number(request.enqueuedAt || 0) || acquiredAt));
    const requestId = buildRequestId(request);
    console.log('[inbound-concurrency] acquired', {
      lane,
      userId,
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
        const remainingForUser = Math.max(0, getActiveForUser(userId) - 1);
        if (remainingForUser > 0) activeByUser.set(userId, remainingForUser);
        else activeByUser.delete(userId);

        console.log('[inbound-concurrency] released', {
          lane,
          userId,
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
    for (let i = 0; i < queue.length; i += 1) {
      if (canAcquire(queue[i])) {
        return queue.splice(i, 1)[0];
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
      lane: String(request.lane || 'general').trim().toLowerCase() === 'admin' ? 'admin' : 'general',
      messageId: String(request.messageId || '').trim(),
      groupId: String(request.groupId || '').trim(),
      chatType: String(request.chatType || '').trim(),
      concurrencyScope: String(request.concurrencyScope || '').trim(),
      privilegedPrivateChat: request.privilegedPrivateChat === true,
      enqueuedAt: Date.now()
    };

    if (!normalized.userId) {
      throw new Error('[inbound-concurrency] userId is required');
    }

    if (canAcquire(normalized)) {
      return reserveSlot(normalized);
    }

    return new Promise((resolve) => {
      queues[normalized.lane].push({
        ...normalized,
        resolve
      });
      console.log('[inbound-concurrency] queued', {
        lane: normalized.lane,
        userId: normalized.userId,
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
