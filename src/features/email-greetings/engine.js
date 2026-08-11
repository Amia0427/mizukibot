const { formatDateInTz, getDatePartsInTz, isPastTimeToday } = require('../../../utils/time');
const { getEventsForDate } = require('./calendar');
const { renderGreetingEmail } = require('./template');

const RETRY_DELAYS_MS = Object.freeze([10 * 60 * 1000, 60 * 60 * 1000]);
const MAX_FAILURE_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractJsonObject(value = '') {
  const text = String(value || '').trim()
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/```$/u, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function normalizeGeneratedContent(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const content = {
    subject: normalizeText(value.subject),
    greeting: normalizeText(value.greeting),
    body: String(value.body || '').trim(),
    closing: normalizeText(value.closing)
  };
  if (!content.subject || !content.greeting || !content.body || !content.closing) return null;
  return {
    subject: content.subject.slice(0, 90),
    greeting: content.greeting.slice(0, 120),
    body: content.body.slice(0, 2200),
    closing: content.closing.slice(0, 240)
  };
}

function buildGreetingPrompt(user = {}, events = [], dateLabel = '') {
  const names = events.map((event) => event.name).filter(Boolean);
  return [
    '你正在为已订阅邮件问候的用户写一封中文节日或纪念日祝福邮件。',
    '可读取该用户长期记忆来个性化，但不要复述私密细节，也不要提及记忆、系统或模型。',
    '语气自然、温柔、克制，适合电子邮件；不要使用 Markdown、HTML 或表情符号。',
    '只输出一个 JSON 对象，字段必须为 subject、greeting、body、closing，全部是非空中文字符串。',
    `日期：${dateLabel}`,
    `事件：${names.join('、')}`,
    `收件人称呼：${normalizeText(user.displayName) || '朋友'}`
  ].join('\n');
}

function formatDateLabel(date, timezone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(date);
}

function shouldAttemptDelivery(delivery, timestamp) {
  if (!delivery || !['pending', 'retry_wait'].includes(delivery.status)) return false;
  return Number(delivery.nextAttemptAt || 0) <= timestamp;
}

function createEmailGreetingEngine(options = {}) {
  const runtimeConfig = options.config || {};
  const enabled = runtimeConfig.EMAIL_GREETING_ENABLED === true && options.enabled !== false;
  const timezone = runtimeConfig.TIMEZONE || 'Asia/Shanghai';
  const sendTime = runtimeConfig.EMAIL_GREETING_SEND_TIME || '09:00';
  const intervalMs = Math.max(60 * 1000, Number(runtimeConfig.EMAIL_GREETING_SCAN_INTERVAL_MS || 10 * 60 * 1000));
  const stateStore = options.stateStore;
  const mailer = options.mailer;
  const askAIByGraph = options.askAIByGraph || ((...args) => require('../../../api/agentGraph').askAIByGraph(...args));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const getEvents = options.getEvents || getEventsForDate;
  if (!stateStore || !mailer) throw new Error('stateStore and mailer are required');

  let timer = null;
  let scanPromise = null;
  let running = false;

  function ensureDelivery(userId, dateKey, events, timestamp) {
    const existing = stateStore.getDelivery(userId, dateKey);
    if (existing) return existing;
    stateStore.updateDelivery(userId, dateKey, (delivery) => {
      delivery.status = 'pending';
      delivery.events = events.map((event) => ({ ...event }));
      delivery.content = null;
      delivery.attempts = 0;
      delivery.nextAttemptAt = timestamp;
      delivery.lastAttemptAt = 0;
      delivery.sentAt = 0;
      delivery.lastError = '';
      delivery.createdAt = timestamp;
    }, { flushNow: true });
    return stateStore.getDelivery(userId, dateKey);
  }

  function markFailure(userId, dateKey, timestamp, error) {
    stateStore.updateDelivery(userId, dateKey, (delivery) => {
      const attempts = Number(delivery.attempts || 0) + 1;
      delivery.attempts = attempts;
      delivery.status = attempts >= MAX_FAILURE_ATTEMPTS ? 'retry_exhausted' : 'retry_wait';
      delivery.nextAttemptAt = attempts >= MAX_FAILURE_ATTEMPTS ? 0 : timestamp + RETRY_DELAYS_MS[attempts - 1];
      delivery.lastAttemptAt = timestamp;
      delivery.lastError = normalizeText(error?.message || error).slice(0, 300);
    }, { flushNow: true });
  }

  async function generateContent(userId, user, delivery, date, dateKey) {
    const dateLabel = formatDateLabel(date, timezone);
    const prompt = buildGreetingPrompt(user, delivery.events, dateLabel);
    const response = await askAIByGraph(prompt, {
      level: 'user',
      relationship: 'friend',
      displayName: user.displayName
    }, userId, prompt, null, {
      systemInitiated: true,
      topRouteType: 'proactive',
      routePolicyKey: 'proactive/email-greeting',
      disableTools: true,
      disableStream: true,
      disableMemoryLearning: true,
      disableDailyJournal: true,
      routeMeta: {
        chatType: 'private',
        taskType: 'email_greeting',
        platform: 'qq',
        channelId: userId,
        deliveryDate: dateKey,
        eventCount: delivery.events.length
      }
    });
    const content = normalizeGeneratedContent(extractJsonObject(response?.content ?? response));
    if (!content) throw new Error('模型未返回有效邮件文案');
    stateStore.updateDelivery(userId, dateKey, (current) => {
      current.content = content;
      current.lastError = '';
    }, { flushNow: true });
    return content;
  }

  async function processDelivery(userId, dateKey, date, timestamp) {
    const user = stateStore.getUser(userId);
    if (user.status !== 'active' || !user.email) return { userId, status: 'inactive' };
    const initial = stateStore.getDelivery(userId, dateKey);
    if (!shouldAttemptDelivery(initial, timestamp)) return { userId, status: 'not_due' };
    let content = initial.content;
    if (!content) {
      try {
        content = await generateContent(userId, user, initial, date, dateKey);
      } catch (error) {
        markFailure(userId, dateKey, timestamp, error);
        return { userId, status: 'model_failed' };
      }
    }

    const email = renderGreetingEmail({
      recipientName: user.displayName || '你好',
      dateLabel: formatDateLabel(date, timezone),
      events: initial.events,
      ...content
    });
    try {
      const result = await mailer.send({ to: user.email, ...email });
      if (result === false) throw new Error('SMTP 发送失败');
    } catch (error) {
      markFailure(userId, dateKey, timestamp, error);
      return { userId, status: 'smtp_failed' };
    }
    stateStore.updateDelivery(userId, dateKey, (delivery) => {
      delivery.status = 'sent';
      delivery.sentAt = timestamp;
      delivery.lastAttemptAt = timestamp;
      delivery.nextAttemptAt = 0;
      delivery.lastError = '';
    }, { flushNow: true });
    return { userId, status: 'sent' };
  }

  async function runScan(timestamp) {
    const date = new Date(timestamp);
    if (!isPastTimeToday(sendTime, date, timezone)) {
      return { skipped: true, reason: 'before_send_time', results: [] };
    }
    const dateKey = formatDateInTz(date, timezone);
    const results = [];
    for (const userId of stateStore.listActiveUserIds()) {
      const user = stateStore.getUser(userId);
      const events = getEvents(date, timezone, {
        disabledHolidayIds: user.disabledHolidayIds,
        anniversaries: user.anniversaries
      });
      if (events.length === 0) {
        results.push({ userId, status: 'no_events' });
        continue;
      }
      const delivery = ensureDelivery(userId, dateKey, events, timestamp);
      if (!shouldAttemptDelivery(delivery, timestamp)) {
        results.push({ userId, status: delivery.status });
        continue;
      }
      results.push(await processDelivery(userId, dateKey, date, timestamp));
    }
    stateStore.updateRuntime((runtime) => {
      runtime.lastScanAt = timestamp;
      runtime.nextScanAt = running ? timestamp + intervalMs : 0;
      runtime.lastError = '';
    }, { flushNow: true });
    return { dateKey, results };
  }

  function scan(input = {}) {
    if (!enabled) return Promise.resolve({ skipped: true, reason: 'disabled' });
    if (scanPromise) return scanPromise;
    const timestamp = Number(input instanceof Date ? input.getTime() : (input.now || input.timestamp || input || now())) || now();
    scanPromise = runScan(timestamp).catch((error) => {
      stateStore.updateRuntime((runtime) => {
        runtime.lastScanAt = timestamp;
        runtime.lastError = normalizeText(error?.message || error);
      }, { flushNow: true });
      throw error;
    }).finally(() => {
      scanPromise = null;
    });
    return scanPromise;
  }

  function start() {
    if (!enabled || running) return false;
    running = true;
    void scan({ now: now() }).catch((error) => console.error('[email-greeting] scan failed:', error?.message || error));
    timer = setInterval(() => {
      void scan({ now: now() }).catch((error) => console.error('[email-greeting] scan failed:', error?.message || error));
    }, intervalMs);
    timer.unref?.();
    return true;
  }

  async function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (scanPromise) await scanPromise.catch(() => {});
    stateStore.updateRuntime((runtime) => { runtime.nextScanAt = 0; }, { flushNow: true });
    return true;
  }

  return {
    scan,
    start,
    stop
  };
}

module.exports = {
  MAX_FAILURE_ATTEMPTS,
  RETRY_DELAYS_MS,
  buildGreetingPrompt,
  createEmailGreetingEngine,
  extractJsonObject,
  normalizeGeneratedContent,
  shouldAttemptDelivery
};
