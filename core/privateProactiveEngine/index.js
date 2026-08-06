const crypto = require('crypto');
const appConfig = require('../../config');
const { sendPrivateMessage } = require('../../api/qqActionService');
const {
  getNapCatActionClient,
  isActionClientConnected
} = require('../../api/napcatActionClient');
const {
  appendSessionTurn,
  updateSessionState
} = require('../../utils/memory');
const {
  applyPersonaContinuityDelta,
  resolveShortTermSessionKey
} = require('../../utils/shortTermMemory');
const { runWithDeliveryContext } = require('../../src/platforms/deliveryContext');
const {
  findDueWindow,
  getLocalClock,
  resolvePrivateProactiveConfig
} = require('./config');
const { createPrivateProactiveContextProvider } = require('./context');
const { createPrivateProactiveModelClient } = require('./model');
const {
  buildPrivateProactiveStatus,
  createPrivateProactiveStateStore,
  defaultUserState
} = require('./state');

const CONTROL_COMMAND_PATTERN = /^\/主动私聊\s+(关闭|开启|状态)\s*$/;
const FIRST_NOTICE_FALLBACK = '偶尔会来找你说说话，不想收到的话用 /主动私聊 关闭 就好。';
const INTERNAL_CONTENT_PATTERN = /(系统提示|system\s*prompt|开发者消息|developer\s*message|内部指令|提示词|API_BASE_URL|API_KEY|AI_MODEL|NapCat|工具调用|tool\s*call|模型输出|记忆存储|运行时日志|人工智能|\bAI\b)/i;
const MEDIA_CONTENT_PATTERN = /(\[CQ:|!\[[^\]]*\]\(|\[(?:image|audio|video|file|图片|语音|视频|文件)(?::[^\]]*)?\]|<\/?(?:img|image|audio|video|file)|data:(?:image|audio|video)\/|file:\/\/)/i;

function contentLength(value = '') {
  return Array.from(String(value || '')).length;
}

function contentSignature(value = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function sanitizeDecision(raw, signatures = [], now = Date.now(), duplicateWindowMs = 48 * 60 * 60 * 1000) {
  if (
    !raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || typeof raw.send !== 'boolean'
    || typeof raw.reason !== 'string'
    || !Array.isArray(raw.messages)
  ) {
    return { valid: false, send: false, reason: 'invalid_structure', messages: [] };
  }
  const reason = String(raw.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!raw.send) return { valid: true, send: false, reason, messages: [] };
  if (!Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > 3) {
    return { valid: false, send: false, reason: 'invalid_message_count', messages: [] };
  }

  const recentHashes = new Set((Array.isArray(signatures) ? signatures : [])
    .filter((item) => now - Number(item?.at || 0) <= duplicateWindowMs)
    .map((item) => String(item?.hash || '').trim())
    .filter(Boolean));
  const batchHashes = new Set();
  const messages = [];
  for (const value of raw.messages) {
    if (typeof value !== 'string') continue;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text || contentLength(text) > 50) continue;
    if (INTERNAL_CONTENT_PATTERN.test(text) || MEDIA_CONTENT_PATTERN.test(text)) continue;
    const hash = contentSignature(text);
    if (recentHashes.has(hash) || batchHashes.has(hash)) continue;
    batchHashes.add(hash);
    messages.push(text);
  }
  return {
    valid: messages.length > 0,
    send: messages.length > 0,
    reason: messages.length > 0 ? reason : 'all_messages_filtered',
    messages
  };
}

function normalizeNoticeDecision(raw) {
  const message = Array.isArray(raw?.messages) ? String(raw.messages[0] || '').replace(/\s+/g, ' ').trim() : '';
  if (
    raw?.send !== true
    || !message.includes('/主动私聊 关闭')
    || contentLength(message) > 90
    || INTERNAL_CONTENT_PATTERN.test(message)
    || MEDIA_CONTENT_PATTERN.test(message)
  ) {
    return FIRST_NOTICE_FALLBACK;
  }
  return message;
}

function createAbortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(true);
    }, Math.max(0, Number(ms) || 0));
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function createPrivateProactiveEngine(options = {}) {
  const runtimeConfig = options.config || appConfig;
  const privateConfig = resolvePrivateProactiveConfig(runtimeConfig, options);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const stateStore = options.stateStore || createPrivateProactiveStateStore(privateConfig.stateFile, { now });
  const actionClient = options.actionClient || getNapCatActionClient();
  const napCatConnected = options.isNapCatConnected || (() => isActionClientConnected(actionClient));
  const resolvePrivateTarget = typeof options.resolvePrivateTarget === 'function'
    ? options.resolvePrivateTarget
    : null;
  const requestDecision = options.requestDecision || createPrivateProactiveModelClient(runtimeConfig, options.modelClientOptions);
  const buildContext = options.buildContext || createPrivateProactiveContextProvider(options.contextOptions);
  const delay = options.delay || createAbortableDelay;
  const sendMessage = options.sendPrivateMessage || ((userId, message, target) => {
    const task = () => sendPrivateMessage(userId, message, {
      actionClient,
      source: 'private_proactive',
      triggerReason: 'private_proactive'
    });
    return target ? runWithDeliveryContext({ target, personId: userId }, task) : task();
  });
  const recordAssistantBubble = options.recordAssistantBubble || ((userId, message, source, timestamp, target) => {
    const sessionKey = resolveShortTermSessionKey(userId, target ? {
      platform: target.platform,
      chatType: 'private',
      conversationKey: target.key
    } : {});
    appendSessionTurn(sessionKey, {
      role: 'assistant',
      content: message,
      source,
      createdAt: timestamp
    });
    updateSessionState(sessionKey, (current) => applyPersonaContinuityDelta(current, {
      interaction: {
        activeTopic: message,
        recentTurns: [
          ...(Array.isArray(current?.interaction?.recentTurns) ? current.interaction.recentTurns : []),
          { role: 'assistant', content: message }
        ],
        sourceFlags: [
          ...(Array.isArray(current?.interaction?.sourceFlags) ? current.interaction.sourceFlags : []),
          source
        ],
        confidence: Math.max(0.5, Number(current?.interaction?.confidence || 0) || 0)
      },
      expression: {
        initiative: 'proactive',
        confidence: 0.7
      }
    }));
  });
  const activeControllers = new Map();
  let timer = null;
  let running = false;
  let stopping = false;
  let scanPromise = null;

  function getPrivateTarget(userId) {
    return resolvePrivateTarget ? resolvePrivateTarget(userId) : null;
  }

  function canDeliver(userId, target = getPrivateTarget(userId)) {
    return resolvePrivateTarget ? Boolean(target) : napCatConnected();
  }

  function updateState(mutator, flushNow = false) {
    return stateStore.update((state) => {
      mutator(state);
      return state;
    }, { flushNow });
  }

  function syncDayState(state, user, timestamp) {
    const day = getLocalClock(timestamp, privateConfig.timezone).day;
    if (state.budget.day !== day) state.budget = { day, used: 0 };
    if (user.cursor.day !== day) user.cursor = { day, consumedWindowKeys: [] };
    if (user.daily.day !== day) user.daily = { day, batchesSent: 0 };
    user.signatures = user.signatures.filter((item) => timestamp - Number(item.at || 0) <= privateConfig.duplicateWindowMs);
    return day;
  }

  function setLastResult(result, flushNow = false) {
    updateState((state) => {
      state.runtime.lastResult = { at: now(), ...result };
    }, flushNow);
  }

  function reserveModelBudget(timestamp) {
    let reserved = false;
    updateState((state) => {
      const day = getLocalClock(timestamp, privateConfig.timezone).day;
      if (state.budget.day !== day) state.budget = { day, used: 0 };
      if (state.budget.used >= privateConfig.globalModelDailyLimit) return;
      state.budget.used += 1;
      reserved = true;
    }, true);
    return reserved;
  }

  function getUserSnapshot(userId) {
    const user = stateStore.read().users[String(userId || '').trim()];
    return user ? JSON.parse(JSON.stringify(user)) : null;
  }

  function abortUserWork(userId) {
    const controller = activeControllers.get(String(userId || '').trim());
    if (controller) controller.abort();
  }

  function recordObservedActivity(userId, activity = {}) {
    const id = String(userId || '').trim();
    if (!id) return false;
    abortUserWork(id);
    let recorded = false;
    const timestamp = Number(activity.at || now()) || now();
    const source = String(activity.source || activity.chatType || 'observed').trim() || 'observed';
    const isPrivate = String(activity.chatType || source).toLowerCase().includes('private');
    updateState((state) => {
      const user = state.users[id];
      if (!user || user.registeredAt <= 0) return;
      user.activityVersion += 1;
      user.lastActivityAt = timestamp;
      user.lastActivitySource = source;
      if (isPrivate) {
        user.lastPrivateActivityAt = timestamp;
        user.unansweredBatches = 0;
        user.autoPaused = false;
      }
      if (user.inFlight) user.inFlight.cancelledAt = timestamp;
      recorded = true;
    });
    return recorded;
  }

  async function sendFirstNotice(userId) {
    const id = String(userId || '').trim();
    const initial = getUserSnapshot(id);
    if (!privateConfig.enabled || !initial || !initial.enabled || initial.firstNotice.status !== 'pending') return false;
    if (!canDeliver(id)) return false;
    const activityVersion = initial.activityVersion;
    const controller = new AbortController();
    activeControllers.set(id, controller);
    updateState((state) => {
      const user = state.users[id];
      if (!user || user.firstNotice.status !== 'pending') return;
      user.firstNotice.status = 'generating';
      user.firstNotice.attemptedAt = now();
    }, true);

    let message = FIRST_NOTICE_FALLBACK;
    try {
      const timestamp = now();
      if (reserveModelBudget(timestamp)) {
        try {
          const user = getUserSnapshot(id);
          const context = await buildContext(id, user, timestamp, getPrivateTarget(id));
          const decision = await requestDecision({
            kind: 'notice',
            userId: id,
            context,
            signal: controller.signal
          });
          message = normalizeNoticeDecision(decision);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          message = FIRST_NOTICE_FALLBACK;
        }
      }
      const current = getUserSnapshot(id);
      const target = getPrivateTarget(id);
      if (
        controller.signal.aborted
        || !current
        || !current.enabled
        || current.activityVersion !== activityVersion
        || !canDeliver(id, target)
      ) {
        updateState((state) => {
          if (state.users[id]?.firstNotice.status === 'generating') state.users[id].firstNotice.status = 'pending';
        }, true);
        return false;
      }
      updateState((state) => {
        if (state.users[id]) state.users[id].firstNotice.status = 'sending';
      }, true);
      await sendMessage(id, message, target);
      const sentAt = now();
      updateState((state) => {
        const user = state.users[id];
        if (!user) return;
        user.firstNotice.status = 'sent';
        user.firstNotice.sentAt = sentAt;
      }, true);
      recordAssistantBubble(id, message, 'private_proactive_first_notice', sentAt, target);
      return true;
    } catch {
      updateState((state) => {
        const user = state.users[id];
        if (!user) return;
        if (user.firstNotice.status === 'generating') {
          user.firstNotice.status = 'pending';
        } else {
          user.firstNotice.status = 'sent_unknown';
        }
      }, true);
      return false;
    } finally {
      if (activeControllers.get(id) === controller) activeControllers.delete(id);
    }
  }

  async function registerPrivateUser(userId, registration = {}) {
    const id = String(userId || '').trim();
    if (!id) return { registered: false, reason: 'missing_user_id' };
    if (!privateConfig.enabled) return { registered: false, reason: 'disabled' };
    const timestamp = Number(registration.at || now()) || now();
    let isNew = false;
    updateState((state) => {
      if (!state.users[id] || state.users[id].registeredAt <= 0) {
        state.users[id] = defaultUserState(timestamp);
        isNew = true;
      }
      syncDayState(state, state.users[id], timestamp);
    }, true);
    const notified = registration.notify === false ? false : await sendFirstNotice(id);
    return { registered: true, isNew, notified };
  }

  function formatControlStatus(user, timestamp) {
    if (!user || user.registeredAt <= 0) return '主动私聊尚未登记，完成一次正常私聊后会自动开启。';
    const stateText = !user.enabled ? '已关闭' : (user.autoPaused ? '已自动暂停' : '已开启');
    const day = getLocalClock(timestamp, privateConfig.timezone).day;
    const batches = user.daily.day === day ? user.daily.batchesSent : 0;
    return `主动私聊${stateText}，今日已发送 ${batches}/${privateConfig.maxPerDay} 批。`;
  }

  function handleControlCommand(rawText, context = {}) {
    const match = String(rawText || '').trim().match(CONTROL_COMMAND_PATTERN);
    if (!match) return { handled: false, replyText: '' };
    const id = String(context.userId || '').trim();
    const timestamp = Number(context.at || now()) || now();
    const command = match[1];
    let replyText = '';
    abortUserWork(id);
    updateState((state) => {
      const user = state.users[id];
      if (!user || user.registeredAt <= 0) {
        replyText = formatControlStatus(null, timestamp);
        return;
      }
      syncDayState(state, user, timestamp);
      if (command === '关闭') {
        user.enabled = false;
        user.activityVersion += 1;
        user.inFlight = null;
        replyText = '主动私聊已关闭。需要时用 /主动私聊 开启。';
      } else if (command === '开启') {
        user.enabled = true;
        user.enabledAt = timestamp;
        user.autoPaused = false;
        user.unansweredBatches = 0;
        user.lastActivityAt = timestamp;
        user.lastActivitySource = 'private_control_enable';
        user.activityVersion += 1;
        user.inFlight = null;
        replyText = '主动私聊已开启，从现在重新计算沉默时间。';
      } else {
        replyText = formatControlStatus(user, timestamp);
      }
    }, true);
    return { handled: true, command, replyText };
  }

  function isAttemptCurrent(userId, activityVersion) {
    const current = getUserSnapshot(userId);
    return Boolean(
      current
      && current.enabled
      && !current.autoPaused
      && current.activityVersion === activityVersion
    );
  }

  function randomBubbleGapMs() {
    const min = Math.min(privateConfig.minBubbleGapMs, privateConfig.maxBubbleGapMs);
    const max = Math.max(privateConfig.minBubbleGapMs, privateConfig.maxBubbleGapMs);
    return Math.round(min + ((max - min) * Math.max(0, Math.min(1, Number(random()) || 0))));
  }

  async function runOpportunity(userId, window, timestamp) {
    const id = String(userId || '').trim();
    let user = getUserSnapshot(id);
    if (!user) return { userId: id, status: 'skipped', reason: 'not_registered' };
    if (!canDeliver(id)) return { userId: id, windowKey: window.key, status: 'skipped', reason: 'private_target_unavailable' };
    if (timestamp - user.lastActivityAt < privateConfig.idleMs) {
      return { userId: id, windowKey: window.key, status: 'skipped', reason: 'not_idle' };
    }
    if (user.lastProactiveSentAt > 0 && timestamp - user.lastProactiveSentAt < privateConfig.minGapMs) {
      return { userId: id, windowKey: window.key, status: 'skipped', reason: 'minimum_gap' };
    }
    if (user.daily.batchesSent >= privateConfig.maxPerDay) {
      return { userId: id, windowKey: window.key, status: 'skipped', reason: 'daily_limit' };
    }

    const activityVersion = user.activityVersion;
    const controller = new AbortController();
    activeControllers.set(id, controller);
    updateState((state) => {
      const current = state.users[id];
      if (!current) return;
      current.inFlight = {
        phase: 'generating',
        day: window.day,
        windowKey: window.key,
        activityVersion,
        startedAt: timestamp,
        sentCount: 0,
        nextIndex: 0
      };
    }, true);

    const successfulMessages = [];
    let status = 'skipped';
    let reason = '';
    try {
      const context = await buildContext(id, user, timestamp, getPrivateTarget(id));
      if (!isAttemptCurrent(id, activityVersion) || controller.signal.aborted) {
        reason = 'activity_changed_during_context';
        return { userId: id, windowKey: window.key, status, reason };
      }
      if (!reserveModelBudget(timestamp)) {
        reason = 'global_model_budget';
        return { userId: id, windowKey: window.key, status, reason };
      }
      const rawDecision = await requestDecision({
        kind: 'proactive',
        userId: id,
        context,
        signal: controller.signal
      });
      if (!isAttemptCurrent(id, activityVersion) || controller.signal.aborted) {
        reason = 'activity_changed_during_generation';
        return { userId: id, windowKey: window.key, status, reason };
      }
      user = getUserSnapshot(id);
      const decision = sanitizeDecision(rawDecision, user.signatures, timestamp, privateConfig.duplicateWindowMs);
      if (!decision.valid || !decision.send) {
        status = decision.valid ? 'declined' : 'filtered';
        reason = decision.reason || 'model_declined';
        return { userId: id, windowKey: window.key, status, reason };
      }

      updateState((state) => {
        if (!state.users[id]?.inFlight) return;
        state.users[id].inFlight.phase = 'sending';
        state.users[id].inFlight.messageCount = decision.messages.length;
      }, true);

      for (let index = 0; index < decision.messages.length; index += 1) {
        if (index > 0) {
          const waited = await delay(randomBubbleGapMs(), controller.signal);
          if (!waited) {
            reason = 'activity_changed_between_bubbles';
            break;
          }
        }
        if (!isAttemptCurrent(id, activityVersion) || controller.signal.aborted) {
          reason = 'activity_changed_before_send';
          break;
        }
        const target = getPrivateTarget(id);
        if (!canDeliver(id, target)) {
          reason = 'private_target_unavailable_before_send';
          break;
        }
        const message = decision.messages[index];
        updateState((state) => {
          const current = state.users[id];
          if (!current?.inFlight) return;
          current.inFlight.nextIndex = index;
          current.signatures.push({ hash: contentSignature(message), at: now() });
          current.signatures = current.signatures.slice(-100);
        }, true);
        try {
          await sendMessage(id, message, target);
        } catch (error) {
          reason = error?.message || 'private_send_failed';
          status = successfulMessages.length > 0 ? 'partial_failure' : 'send_failed';
          break;
        }
        const sentAt = now();
        successfulMessages.push(message);
        recordAssistantBubble(id, message, 'private_proactive', sentAt, target);
        updateState((state) => {
          const current = state.users[id];
          if (!current?.inFlight) return;
          current.inFlight.sentCount = successfulMessages.length;
          current.inFlight.nextIndex = index + 1;
        }, true);
      }

      if (successfulMessages.length > 0 && !status.endsWith('failure')) status = 'sent';
      if (!reason && successfulMessages.length < decision.messages.length) reason = 'cancelled';
      if (!reason) reason = decision.reason || 'sent';
      return {
        userId: id,
        windowKey: window.key,
        status,
        reason,
        sentCount: successfulMessages.length
      };
    } catch (error) {
      status = controller.signal.aborted ? 'cancelled' : 'model_failed';
      reason = error?.message || String(error || 'private proactive failed');
      return { userId: id, windowKey: window.key, status, reason, sentCount: successfulMessages.length };
    } finally {
      const finishedAt = now();
      updateState((state) => {
        const current = state.users[id];
        if (!current) return;
        syncDayState(state, current, finishedAt);
        if (successfulMessages.length > 0) {
          current.daily.batchesSent += 1;
          current.lastProactiveSentAt = finishedAt;
          const answeredDuringAttempt = current.lastPrivateActivityAt > timestamp;
          current.unansweredBatches = answeredDuringAttempt ? 0 : current.unansweredBatches + 1;
          current.autoPaused = !answeredDuringAttempt
            && current.unansweredBatches >= privateConfig.maxUnansweredBatches;
          current.narratives.push({ at: finishedAt, messages: successfulMessages.slice() });
          current.narratives = current.narratives.slice(-12);
        }
        current.inFlight = null;
      }, true);
      if (activeControllers.get(id) === controller) activeControllers.delete(id);
    }
  }

  async function runScan(timestamp) {
    const scanResults = [];
    const userIds = Object.keys(stateStore.read().users);
    for (const userId of userIds) {
      if (stopping) break;
      let dueWindow = null;
      updateState((state) => {
        const user = state.users[userId];
        if (!user || user.registeredAt <= 0 || !user.enabled || user.autoPaused) return;
        syncDayState(state, user, timestamp);
        dueWindow = findDueWindow(userId, timestamp, user.cursor.consumedWindowKeys, privateConfig);
        if (!dueWindow) return;
        user.cursor.consumedWindowKeys.push(dueWindow.key);
      }, true);
      if (!dueWindow) continue;
      const result = await runOpportunity(userId, dueWindow, timestamp);
      scanResults.push(result);
      setLastResult(result, true);
    }
    updateState((state) => {
      state.runtime.lastScanAt = timestamp;
      state.runtime.nextScanAt = running ? timestamp + privateConfig.scanIntervalMs : 0;
      if (scanResults.length === 0) {
        state.runtime.lastResult = {
          at: timestamp,
          status: 'scan_complete',
          reason: 'no_due_opportunity'
        };
      }
    });
    return {
      scannedUsers: userIds.length,
      opportunityCount: scanResults.length,
      results: scanResults
    };
  }

  function scan(input = {}) {
    if (!privateConfig.enabled) return Promise.resolve({ skipped: true, reason: 'disabled' });
    if (scanPromise) return scanPromise;
    const timestamp = Number(input instanceof Date ? input.getTime() : (input.now || input.timestamp || input || now())) || now();
    scanPromise = runScan(timestamp).finally(() => {
      scanPromise = null;
    });
    return scanPromise;
  }

  function start() {
    if (!privateConfig.enabled || running) return false;
    stopping = false;
    running = true;
    const startedAt = now();
    updateState((state) => {
      state.runtime.startedAt = startedAt;
      state.runtime.stoppedAt = 0;
      state.runtime.nextScanAt = startedAt;
    }, true);
    void scan({ now: startedAt }).catch((error) => {
      setLastResult({ status: 'scan_failed', reason: error?.message || String(error || '') }, true);
    });
    timer = setInterval(() => {
      const scanAt = now();
      void scan({ now: scanAt }).catch((error) => {
        setLastResult({ status: 'scan_failed', reason: error?.message || String(error || '') }, true);
      });
    }, privateConfig.scanIntervalMs);
    timer.unref?.();
    return true;
  }

  async function stop() {
    stopping = true;
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    for (const controller of activeControllers.values()) controller.abort();
    activeControllers.clear();
    if (scanPromise) await scanPromise.catch(() => {});
    updateState((state) => {
      state.runtime.stoppedAt = now();
      state.runtime.nextScanAt = 0;
    }, true);
    return true;
  }

  function getStatus() {
    const state = stateStore.read();
    const users = Object.values(state.users).filter((user) => user.registeredAt > 0);
    const day = getLocalClock(now(), privateConfig.timezone).day;
    return {
      enabled: privateConfig.enabled,
      running,
      registeredCount: users.length,
      enabledCount: users.filter((user) => user.enabled && !user.autoPaused).length,
      pausedCount: users.filter((user) => user.enabled && user.autoPaused).length,
      disabledCount: users.filter((user) => !user.enabled).length,
      budget: {
        day,
        used: state.budget.day === day ? state.budget.used : 0,
        limit: privateConfig.globalModelDailyLimit
      },
      nextScanAt: state.runtime.nextScanAt,
      lastResult: state.runtime.lastResult
    };
  }

  return {
    start,
    stop,
    scan,
    registerPrivateUser,
    recordObservedActivity,
    handleControlCommand,
    getStatus,
    _test: {
      contentSignature,
      getUserSnapshot,
      privateConfig,
      reserveModelBudget,
      sanitizeDecision,
      sendFirstNotice,
      stateStore
    }
  };
}

module.exports = {
  CONTROL_COMMAND_PATTERN,
  FIRST_NOTICE_FALLBACK,
  buildPrivateProactiveStatus,
  contentSignature,
  createPrivateProactiveEngine,
  sanitizeDecision
};
