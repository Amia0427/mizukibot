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

function createForegroundConcurrencyController(options = {}) {
  const globalLimit = normalizePositiveInt(options.globalLimit, 10);
  const adminReservedSlots = Math.max(0, Math.min(globalLimit, normalizeNonNegativeInt(options.adminReservedSlots, 1)));
  const perUserLimit = normalizePositiveInt(options.perUserLimit, 1);
  const generalLimit = Math.max(0, globalLimit - adminReservedSlots);

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
      adminReservedSlots,
      totalActive: getTotalActive(),
      activeGeneral: activeByLane.general,
      activeAdmin: activeByLane.admin,
      queuedGeneral: queues.general.length,
      queuedAdmin: queues.admin.length
    };
  }

  function hasGeneralCapacity() {
    if (generalLimit <= 0) return false;
    if (activeByLane.general >= generalLimit) return false;
    return getTotalActive() < globalLimit;
  }

  function hasAdminCapacity() {
    return getTotalActive() < globalLimit;
  }

  function hasLaneCapacity(lane = 'general') {
    return lane === 'admin' ? hasAdminCapacity() : hasGeneralCapacity();
  }

  function canAcquire(request = {}) {
    const lane = String(request.lane || '').trim().toLowerCase() === 'admin' ? 'admin' : 'general';
    const sessionKey = String(request.sessionKey || request.userId || '').trim();
    if (!sessionKey) return false;
    if (!hasLaneCapacity(lane)) return false;
    if (getActiveForSession(sessionKey) >= perUserLimit) return false;
    return true;
  }

  function reserveSlot(request = {}) {
    const lane = String(request.lane || '').trim().toLowerCase() === 'admin' ? 'admin' : 'general';
    const sessionKey = String(request.sessionKey || request.userId || '').trim();
    const userId = String(request.userId || '').trim();
    activeByLane[lane] += 1;
    activeBySession.set(sessionKey, getActiveForSession(sessionKey) + 1);
    const acquiredAt = Date.now();
    const requestId = buildRequestId(request);
    const waitMs = Math.max(0, acquiredAt - (Number(request.enqueuedAt || 0) || acquiredAt));

    console.log('[foreground-concurrency] acquired', {
      lane,
      userId,
      sessionKey,
      requestId,
      groupId: String(request.groupId || '').trim(),
      messageId: String(request.messageId || '').trim(),
      chatType: String(request.chatType || '').trim(),
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

        console.log('[foreground-concurrency] released', {
          lane,
          userId,
          sessionKey,
          requestId,
          groupId: String(request.groupId || '').trim(),
          messageId: String(request.messageId || '').trim(),
          chatType: String(request.chatType || '').trim(),
          abnormalEnd: meta.hadError === true,
          runtimeMs: Math.max(0, Date.now() - acquiredAt),
          ...buildSnapshot()
        });

        drainQueues();
      }
    };
  }

  function takeNextEligible(lane = 'general') {
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
      sessionKey: String(request.sessionKey || request.userId || '').trim(),
      lane: String(request.lane || '').trim().toLowerCase() === 'admin' ? 'admin' : 'general',
      messageId: String(request.messageId || '').trim(),
      groupId: String(request.groupId || '').trim(),
      chatType: String(request.chatType || '').trim(),
      enqueuedAt: Date.now()
    };

    if (!normalized.sessionKey) {
      throw new Error('[foreground-concurrency] sessionKey is required');
    }

    if (canAcquire(normalized)) {
      return reserveSlot(normalized);
    }

    return new Promise((resolve) => {
      queues[normalized.lane].push({
        ...normalized,
        resolve
      });
      console.log('[foreground-concurrency] queued', {
        lane: normalized.lane,
        userId: normalized.userId,
        sessionKey: normalized.sessionKey,
        requestId: buildRequestId(normalized),
        groupId: normalized.groupId,
        messageId: normalized.messageId,
        chatType: normalized.chatType,
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
  createForegroundConcurrencyController
};
