const Holidays = require('date-holidays');
const config = require('../config');
const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const {
  formatDateInTz,
  formatTimeInTz,
  formatWeekdayInTz,
  getDatePartsInTz,
  isPastTimeToday
} = require('../utils/time');
const { getRecentMessages } = require('../utils/groupAwarenessState');
const { sendGroupReply, recordSystemGroupSend } = require('./systemGroupReply');
const {
  acquireInitiativeLock,
  evaluateInitiativePolicy,
  releaseInitiativeLock
} = require('./initiativePolicyEngine');
const { markInitiativeSent, setLastCycleKey } = require('./initiativeState');
const {
  ensureLifeDay,
  ensureLifeTarget,
  getLifeDay,
  getLifeHistoryDays,
  getLifeScheduleTime,
  listEnabledLifeGroups,
  loadLifeState,
  loadLifeTargets,
  markLifeBroadcastResult,
  resetLifeBroadcastsForDate,
  saveLifeState,
  saveLifeTargets,
  setLifeScheduleTime,
  setLifeTargetEnabled
} = require('./lifeSchedulerStore');

const STYLE_PREFIX_RE = /^\s*(?:风格|【风格】|\[风格\])\s*[:：]\s*(.+?)(?:\n|$)/;

function trimText(value, maxChars = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function parseOutputTimeDesc(date = new Date(), timezone = config.TIMEZONE) {
  const hour = Number(getDatePartsInTz(date, timezone).hour || 0);
  if (hour < 6) return '娣卞';
  if (hour < 9) return '娓呮櫒';
  if (hour < 12) return '涓婂崍';
  if (hour < 14) return '涓崍';
  if (hour < 18) return '涓嬪崍';
  if (hour < 22) return '鏅氫笂';
  return '娣卞';
}

function isAdmin(userId = '') {
  return require('../api/qqActionService').isAdminUser(userId);
}

function normalizeSummaryLine(groupId, item = {}) {
  const sender = String(item?.sender_name || item?.sender_id || '鎴愬憳').trim() || '鎴愬憳';
  const text = trimText(item?.text || '', 100);
  if (!text) return '';
  return `[缇?${groupId}] ${sender}: ${text}`;
}

function collectGlobalRecentMessages(targets = {}, maxPerGroup = 6) {
  const enabledGroups = listEnabledLifeGroups(targets);
  const limit = Math.max(1, Number(maxPerGroup) || 6);
  const lines = [];
  for (const groupId of enabledGroups) {
    const recent = getRecentMessages(groupId)
      .slice(-limit)
      .map((item) => normalizeSummaryLine(groupId, item))
      .filter(Boolean);
    lines.push(...recent);
  }
  return lines;
}

function extractJsonObject(text = '') {
  const input = String(text || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = input.indexOf('{');
  if (start < 0) return null;

  let brace = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < input.length; index += 1) {
    const ch = input[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') brace += 1;
    if (ch === '}') {
      brace -= 1;
      if (brace === 0) {
        try {
          const parsed = JSON.parse(input.slice(start, index + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function extractStyleFromOutfit(outfit = '') {
  const match = String(outfit || '').trim().match(STYLE_PREFIX_RE);
  return match ? String(match[1] || '').trim() : '';
}

function validateLifePayload(payload, requiredStyle = '') {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: '鏈В鏋愬嚭 JSON 瀵硅薄' };
  const outfit = String(payload.outfit || '').trim();
  const schedule = String(payload.schedule || '').trim();
  const broadcastText = String(payload.broadcastText || payload.broadcast_text || '').trim();
  if (!outfit) return { ok: false, reason: 'outfit 涓嶈兘涓虹┖' };
  if (!schedule) return { ok: false, reason: 'schedule 涓嶈兘涓虹┖' };
  if (!broadcastText) return { ok: false, reason: 'broadcastText 涓嶈兘涓虹┖' };
  if (!requiredStyle) return { ok: true, reason: '' };
  const style = String(payload.outfitStyle || payload.outfit_style || '').trim();
  if (style !== requiredStyle) return { ok: false, reason: `outfitStyle 蹇呴』涓ユ牸绛変簬 "${requiredStyle}"` };
  if (!new RegExp(`^\\s*(?:风格|【风格】|\\[风格\\])\\s*[:：]\\s*${requiredStyle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(outfit)) {
    return { ok: false, reason: `outfit 第一行必须以 "风格：${requiredStyle}" 开头` };
  }
  return { ok: true, reason: '' };
}

function pickOutfitStyle(candidates = [], historyEntries = []) {
  const styles = Array.isArray(candidates) ? candidates.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (!styles.length) return '';
  if (styles.length === 1) return styles[0];
  const used = new Set(
    historyEntries
      .map((entry) => String(entry?.outfitStyle || extractStyleFromOutfit(entry?.outfit || '')).trim())
      .filter(Boolean)
  );
  const available = styles.filter((style) => !used.has(style));
  const pool = available.length ? available : styles;
  const index = Math.floor(Math.random() * pool.length);
  return pool[index] || pool[0] || '';
}

function buildHistoryText(historyEntries = []) {
  if (!Array.isArray(historyEntries) || historyEntries.length === 0) return '(无历史记录)';
  return historyEntries.map((entry) => {
    const day = String(entry?.date || '').trim();
    const style = String(entry?.outfitStyle || extractStyleFromOutfit(entry?.outfit || '')).trim();
    const outfit = trimText(entry?.outfit || '', 60);
    const schedule = trimText(entry?.schedule || '', 80);
    if (style) return `[${day}] 风格：${style} 穿搭：${outfit} 日程：${schedule}`;
    return `[${day}] 穿搭：${outfit} 日程：${schedule}`;
  }).join('\n');
}

function getHolidayText(date = new Date()) {
  try {
    const hd = new Holidays('CN');
    const result = hd.isHoliday(date);
    if (!result) return '';
    const items = Array.isArray(result) ? result : [result];
    const names = items.map((item) => String(item?.name || '').trim()).filter(Boolean);
    return names.length ? `浠婂ぉ鏄?${names.join(' / ')}` : '';
  } catch (_) {
    return '';
  }
}

function formatDateLabel(date = new Date(), timezone = config.TIMEZONE) {
  const parts = getDatePartsInTz(date, timezone);
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

function formatInjectionBlock(entry = {}, date = new Date()) {
  return buildRuntimePrompt('life-scheduler-injection', {
    timeDesc: parseOutputTimeDesc(date, config.TIMEZONE),
    outfit: String(entry.outfit || '').trim() || '鏆傛棤',
    schedule: String(entry.schedule || '').trim() || '鏆傛棤'
  });
}

function formatLifeShowReply(entry = {}, date = new Date()) {
  const day = formatDateInTz(date, config.TIMEZONE);
  return [
    `${day}`,
    `今日穿搭：${String(entry.outfit || '').trim() || '暂无'}`,
    `今日日程：${String(entry.schedule || '').trim() || '暂无'}`,
    `主动文案：${String(entry.broadcastText || '').trim() || '暂无'}`
  ].join('\n');
}

function formatLifeStatusReply({ day, targets, currentGroupId = '' }) {
  const enabledGroups = listEnabledLifeGroups(targets);
  const gid = String(currentGroupId || '').trim();
  const currentEnabled = gid ? Boolean(targets?.[gid]?.enabled) : false;
  return [
    `Life Scheduler：${config.LIFE_SCHEDULER_ENABLED ? '已启用' : '已禁用'}`,
    `每日生成时间：${String(day?.scheduleTime || '').trim() || String(config.LIFE_SCHEDULER_TIME || '07:00').trim() || '07:00'}`,
    `浠婃棩鐘舵€侊細${String(day?.status || 'pending').trim() || 'pending'}`,
    `生成时间：${String(day?.generatedAt || '').trim() || '暂无'}`,
    `鍚敤缇ゆ暟閲忥細${enabledGroups.length}`,
    gid ? `当前群启用：${currentEnabled ? '是' : '否'}` : '当前群启用：当前不在群聊'
  ].join('\n');
}

function pickLatestSuccessfulEntry(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (entry && String(entry.status || '').trim() === 'ok') return entry;
  }
  return null;
}

function createLifeSchedulerEngine() {
  let state = loadLifeState();
  let targets = loadLifeTargets();
  let generatingPromise = null;

  function persist() {
    state.targets = targets;
    saveLifeState(state);
    saveLifeTargets(targets);
  }

  function ensureCaches() {
    if (!state || typeof state !== 'object') state = loadLifeState();
    if (!targets || typeof targets !== 'object') targets = loadLifeTargets();
    state.targets = targets;
    return { state, targets };
  }

  function getInjectionEntry(date = new Date()) {
    ensureCaches();
    const todayKey = formatDateInTz(date, config.TIMEZONE);
    const todayEntry = getLifeDay(state, todayKey);
    if (todayEntry && String(todayEntry.status || '').trim() === 'ok') {
      return {
        entry: todayEntry,
        source: 'today'
      };
    }

    const historyEntries = getLifeHistoryDays(
      state,
      Math.max(1, Number(config.LIFE_SCHEDULER_HISTORY_DAYS || 3) || 3),
      todayKey
    );
    const fallbackEntry = pickLatestSuccessfulEntry(historyEntries);
    if (!fallbackEntry) {
      return {
        entry: null,
        source: 'none'
      };
    }
    return {
      entry: fallbackEntry,
      source: 'history'
    };
  }

  async function summarizeContext(askAIByGraph, today) {
    const summaryLines = collectGlobalRecentMessages(targets, config.LIFE_SCHEDULER_SUMMARY_MAX_MESSAGES_PER_GROUP);
    if (!summaryLines.length) return '鏆傛棤杩戞湡缇よ亰鎽樿';
    const prompt = buildRuntimePrompt('life-scheduler-summary', {
      recentMessages: summaryLines.join('\n')
    });
    const userId = 'life_scheduler:summary';
    const userInfo = { level: 'system', points: 0, relationship: 'system' };
    const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
      systemInitiated: true,
      topRouteType: 'proactive',
      routePolicyKey: 'proactive/life-summary',
      disableTools: true,
      disableStream: true,
      disableMemoryLearning: true,
      disableDailyJournal: true,
      routeMeta: {
        taskType: 'life_scheduler_summary',
        channelId: 'life_scheduler',
        generatedDate: formatDateInTz(today, config.TIMEZONE)
      }
    });
    return trimText(reply, 900) || '鏆傛棤杩戞湡缇よ亰鎽樿';
  }

async function generateDay(askAIByGraph, date = new Date(), options = {}) {
    if (generatingPromise) throw new Error('life-scheduler-generating');
    const dayKey = formatDateInTz(date, config.TIMEZONE);
    const extra = String(options.extra || '').trim();

    generatingPromise = (async () => {
      const currentDay = ensureLifeDay(state, dayKey);
      const historyEntries = getLifeHistoryDays(state, config.LIFE_SCHEDULER_HISTORY_DAYS, dayKey)
        .filter((entry) => String(entry?.status || '').trim() === 'ok');
      const historyText = buildHistoryText(historyEntries);
      const contextSummary = await summarizeContext(askAIByGraph, date);
      const promptVars = {
        dateStr: formatDateLabel(date, config.TIMEZONE),
        weekday: formatWeekdayInTz('zh-CN', date, config.TIMEZONE),
        holidayText: getHolidayText(date),
        historyText,
        contextSummary,
        extra,
        dailyTheme: ['探索日', '社交日', '创作日', '整理日', '放空日'][Math.floor(Math.random() * 5)],
        moodColor: ['鎱垫噿', '娲诲姏', '瀹夐潤', '杞诲揩', '娓╂煍'][Math.floor(Math.random() * 5)],
        outfitStyle: pickOutfitStyle(['知性学院风', '街头休闲风', '温柔淑女风', '极简都市风', '复古文艺风', '慵懒居家风', '甜酷混搭风'], historyEntries),
        scheduleType: ['独处充电型', '外出探索型', '社交聚会型', '工作专注型', '松弛恢复型'][Math.floor(Math.random() * 5)]
      };
      const generatePrompt = buildRuntimePrompt('life-scheduler-generate', promptVars);
      const userId = `life_scheduler:generate:${dayKey}`;
      const userInfo = { level: 'system', points: 0, relationship: 'system' };
      let repairCount = 0;
      let rawReply = await askAIByGraph(generatePrompt, userInfo, userId, generatePrompt, null, {
        systemInitiated: true,
        topRouteType: 'proactive',
        routePolicyKey: 'proactive/life-generate',
        disableTools: true,
        disableStream: true,
        disableMemoryLearning: true,
        disableDailyJournal: true,
        routeMeta: {
          taskType: 'life_scheduler_generate',
          channelId: 'life_scheduler',
          generatedDate: dayKey
        }
      });
      let payload = extractJsonObject(rawReply);
      let validation = validateLifePayload(payload, promptVars.outfitStyle);

      for (let attempt = 0; attempt < 2 && !validation.ok; attempt += 1) {
        repairCount += 1;
        const repairPrompt = buildRuntimePrompt('life-scheduler-repair', {
          reason: validation.reason,
          outfitStyle: promptVars.outfitStyle,
          previousOutput: String(rawReply || '').trim()
        });
        rawReply = await askAIByGraph(repairPrompt, userInfo, `${userId}:repair:${attempt}`, repairPrompt, null, {
          systemInitiated: true,
          topRouteType: 'proactive',
          routePolicyKey: 'proactive/life-repair',
          disableTools: true,
          disableStream: true,
          disableMemoryLearning: true,
          disableDailyJournal: true,
          routeMeta: {
            taskType: 'life_scheduler_repair',
            channelId: 'life_scheduler',
            generatedDate: dayKey
          }
        });
        payload = extractJsonObject(rawReply);
        validation = validateLifePayload(payload, promptVars.outfitStyle);
      }

      if (!validation.ok || !payload) {
        Object.assign(currentDay, {
          date: dayKey,
          status: 'failed',
          outfitStyle: promptVars.outfitStyle,
          outfit: '鐢熸垚澶辫触',
          schedule: '鐢熸垚澶辫触',
          broadcastText: '',
          contextSummary,
          holidayText: promptVars.holidayText,
          generatedAt: new Date().toISOString(),
          repairCount
        });
        persist();
        return currentDay;
      }

      Object.assign(currentDay, {
        date: dayKey,
        status: 'ok',
        outfitStyle: String(payload.outfitStyle || payload.outfit_style || promptVars.outfitStyle).trim(),
        outfit: String(payload.outfit || '').trim(),
        schedule: String(payload.schedule || '').trim(),
        broadcastText: String(payload.broadcastText || payload.broadcast_text || '').trim(),
        contextSummary,
        holidayText: promptVars.holidayText,
        generatedAt: new Date().toISOString(),
        repairCount
      });
      if (options.resetBroadcasts === true) {
        resetLifeBroadcastsForDate(state, dayKey);
      }
      persist();
      return currentDay;
    })();

    try {
      return await generatingPromise;
    } finally {
      generatingPromise = null;
    }
  }

  async function maybeGenerateForToday({ askAIByGraph, date = new Date() }) {
    if (!config.LIFE_SCHEDULER_ENABLED) return { generated: false, reason: 'disabled' };
    const dayKey = formatDateInTz(date, config.TIMEZONE);
    const entry = getLifeDay(state, dayKey);
    if (entry && String(entry.status || '').trim() === 'ok') return { generated: false, reason: 'already-ok', entry };
    if (entry && String(entry.status || '').trim() === 'failed') return { generated: false, reason: 'already-failed', entry };
    if (!isPastTimeToday(getLifeScheduleTime(state), date, config.TIMEZONE)) {
      return { generated: false, reason: 'before-schedule-time', entry };
    }
    const generated = await generateDay(askAIByGraph, date);
    return { generated: String(generated?.status || '').trim() === 'ok', reason: generated?.status || 'unknown', entry: generated };
  }

  async function maybeBroadcastToday({ sendWithRetry, askAIByGraph, date = new Date(), scope = 'pending' }) {
    if (!config.LIFE_SCHEDULER_ENABLED) return { sentCount: 0, reason: 'disabled' };
    const dayKey = formatDateInTz(date, config.TIMEZONE);
    let entry = getLifeDay(state, dayKey);
    if (!entry || String(entry.status || '').trim() !== 'ok') {
      const generation = await maybeGenerateForToday({ askAIByGraph, date });
      entry = generation.entry || getLifeDay(state, dayKey);
      if (!entry || String(entry.status || '').trim() !== 'ok') {
        return { sentCount: 0, reason: generation.reason || 'not-generated' };
      }
    }
    const targetGroups = listEnabledLifeGroups(targets);
    let sentCount = 0;
    for (const groupId of targetGroups) {
      const broadcast = state.broadcasts?.[dayKey]?.[groupId];
      if (scope !== 'all' && String(broadcast?.status || '').trim() === 'sent') continue;
      const initiativePolicy = evaluateInitiativePolicy({
        source: 'life_scheduler',
        groupId,
        userId: '',
        candidateReason: 'life_scheduler',
        contextHints: {
          primaryContext: trimText(entry.broadcastText || '', 120),
          secondaryContext: trimText(entry.schedule || '', 120)
        }
      }, Date.now());
      if (!initiativePolicy.allowed) {
        markLifeBroadcastResult(state, dayKey, groupId, {
          status: 'pending',
          sentAt: '',
          lastError: initiativePolicy.reason
        });
        continue;
      }
      const initiativeLockOwner = `life_scheduler:${groupId}:${dayKey}`;
      const initiativeLock = acquireInitiativeLock({
        groupId,
        owner: initiativeLockOwner,
        now: Date.now()
      });
      if (!initiativeLock.acquired) {
        markLifeBroadcastResult(state, dayKey, groupId, {
          status: 'pending',
          sentAt: '',
          lastError: initiativeLock.reason
        });
        continue;
      }
      let sent = false;
      try {
        sent = await sendGroupReply({
          sendWithRetry,
          groupId,
          senderId: '',
          replyText: entry.broadcastText,
          atSender: false,
          retries: 1,
          waitMs: 300,
          runtimeConfig: config
        });
      } finally {
        releaseInitiativeLock({
          groupId,
          owner: initiativeLockOwner,
          now: Date.now()
        });
      }
      if (sent) {
        recordSystemGroupSend({
          groupId,
          senderId: '',
          text: entry.broadcastText,
          senderName: '鐟炲笇',
          updatePresence: true,
          updateBotPresence: true,
          now: Date.now(),
          source: 'life_scheduler',
          routePolicyKey: 'proactive/life-broadcast'
        });
        markInitiativeSent(groupId, {
          source: 'life_scheduler',
          reason: 'life_scheduler',
          cycleKey: String(initiativePolicy.cycleKey || '').trim()
        }, Date.now());
        if (initiativePolicy.cycleKey) {
          setLastCycleKey(groupId, initiativePolicy.cycleKey, Date.now());
        }
        markLifeBroadcastResult(state, dayKey, groupId, {
          status: 'sent',
          sentAt: new Date().toISOString(),
          lastError: ''
        });
        sentCount += 1;
      } else {
        markLifeBroadcastResult(state, dayKey, groupId, {
          status: 'failed',
          sentAt: '',
          lastError: 'life-broadcast-send-failed'
        });
      }
    }
    persist();
    return { sentCount, reason: sentCount > 0 ? 'sent' : 'no-targets' };
  }

  async function runLifeCycle({ sendWithRetry, askAIByGraph, date = new Date() }) {
    ensureCaches();
    const generation = await maybeGenerateForToday({ askAIByGraph, date });
    const broadcast = await maybeBroadcastToday({ sendWithRetry, askAIByGraph, date, scope: 'pending' });
    return {
      ran: true,
      generation,
      broadcast
    };
  }

  async function handleAdminCommand({
    rawText,
    groupId,
    userId,
    sendWithRetry,
    askAIByGraph,
    date = new Date()
  }) {
    const text = String(rawText || '').trim();
    if (!/^\/life(?:\s|$)/i.test(text)) return null;
    const parts = text.split(/\s+/).slice(1);
    const sub = String(parts[0] || 'show').trim().toLowerCase();
    const dayKey = formatDateInTz(date, config.TIMEZONE);
    const entry = getLifeDay(state, dayKey);

    if (sub === 'show') {
      if (!entry || String(entry.status || '').trim() !== 'ok') {
        return { handled: true, replyText: '今天还没有可用的 life 状态。' };
      }
      return { handled: true, replyText: formatLifeShowReply(entry, date) };
    }

    if (!isAdmin(userId)) return { handled: true, replyText: '这个按钮现在只给管理员按哦。' };

    if (sub === 'status') {
      return {
        handled: true,
        replyText: formatLifeStatusReply({
          day: {
            ...(entry || {}),
            scheduleTime: getLifeScheduleTime(state)
          },
          targets,
          currentGroupId: groupId
        })
      };
    }

    if (sub === 'enable') {
      if (!String(groupId || '').trim()) return { handled: true, replyText: '这个要在群里才接得住啦。' };
      setLifeTargetEnabled(targets, groupId, true);
      persist();
      return { handled: true, replyText: '当前群已启用 life 主动发送。' };
    }

    if (sub === 'disable') {
      if (!String(groupId || '').trim()) return { handled: true, replyText: '这个要在群里才接得住啦。' };
      setLifeTargetEnabled(targets, groupId, false);
      persist();
      return { handled: true, replyText: '当前群已禁用 life 主动发送。' };
    }

    if (sub === 'renew') {
      const extra = parts.slice(1).join(' ').trim();
      try {
        const renewed = await generateDay(askAIByGraph, date, {
          extra,
          resetBroadcasts: false
        });
        if (String(renewed?.status || '').trim() !== 'ok') {
          return { handled: true, replyText: 'life 今日状态生成失败。' };
        }
        return { handled: true, replyText: formatLifeShowReply(renewed, date) };
      } catch (error) {
        return { handled: true, replyText: `执行失败：${error?.message || String(error)}` };
      }
    }

    if (sub === 'time') {
      const value = String(parts[1] || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(value)) return { handled: true, replyText: '请使用 HH:MM 格式。' };
      const minutes = require('../utils/time').parseHmToMinutes(value);
      if (minutes === null) return { handled: true, replyText: '请使用合法时间，小时 0-23，分钟 0-59。' };
      setLifeScheduleTime(state, value);
      persist();
      return { handled: true, replyText: `已将每日生成时间更新为 ${value}。` };
    }

    if (sub === 'broadcast') {
      const mode = String(parts[1] || 'current').trim().toLowerCase();
      if (mode === 'current') {
        if (!String(groupId || '').trim()) return { handled: true, replyText: '这个要在群里才接得住啦。' };
        const currentEntry = getLifeDay(state, dayKey);
        if (!currentEntry || String(currentEntry.status || '').trim() !== 'ok') {
          return { handled: true, replyText: '今天还没有可补发的 life 状态。' };
        }
        const sent = await sendGroupReply({
          sendWithRetry,
          groupId,
          senderId: '',
          replyText: currentEntry.broadcastText,
          atSender: false,
          retries: 1,
          waitMs: 300,
          runtimeConfig: config
        });
        if (!sent) return { handled: true, replyText: '当前群补发失败。' };
        recordSystemGroupSend({
          groupId,
          senderId: '',
          text: currentEntry.broadcastText,
          senderName: '鐟炲笇',
          updatePresence: true,
          updateBotPresence: true,
          now: Date.now()
        });
        markLifeBroadcastResult(state, dayKey, groupId, {
          status: 'sent',
          sentAt: new Date().toISOString(),
          lastError: ''
        });
        persist();
        return { handled: true, replyText: '已向当前群补发今日 life 文案。' };
      }
      if (mode === 'all') {
        const result = await maybeBroadcastToday({
          sendWithRetry,
          askAIByGraph,
          date,
          scope: 'all'
        });
        return { handled: true, replyText: `已尝试向全部启用群补发，成功 ${result.sentCount} 个。` };
      }
      return { handled: true, replyText: '仅支持 `/life broadcast current|all`。' };
    }

    return {
      handled: true,
      replyText: '可用命令：/life show | status | enable | disable | renew [extra] | time HH:MM | broadcast current|all'
    };
  }

  return {
    ensureCaches,
    formatInjectionBlock,
    generateDay,
    getInjectionEntry,
    getTodayEntry(date = new Date()) {
      return getLifeDay(state, formatDateInTz(date, config.TIMEZONE));
    },
    handleAdminCommand,
    runLifeCycle
  };
}

let singleton = null;

function getLifeSchedulerEngine() {
  if (!singleton) singleton = createLifeSchedulerEngine();
  return singleton;
}

module.exports = {
  createLifeSchedulerEngine,
  formatInjectionBlock,
  getLifeSchedulerEngine,
  parseOutputTimeDesc,
  validateLifePayload
};

