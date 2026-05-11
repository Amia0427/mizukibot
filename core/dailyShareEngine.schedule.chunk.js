function parseTimeToMinutes(text = '', fallback = 0) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return (hour * 60) + minute;
}

function parseWindowRange(text = '', fallbackStart, fallbackEnd) {
  const match = String(text || '').trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) {
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  const startMinutes = parseTimeToMinutes(match[1], fallbackStart);
  const endMinutes = parseTimeToMinutes(match[2], fallbackEnd);
  if (endMinutes <= startMinutes) {
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  return { startMinutes, endMinutes };
}

function getCurrentMinutes(date = new Date(), timezone = config.TIMEZONE) {
  const parts = getDatePartsInTz(date, timezone);
  return (parts.hour * 60) + parts.minute;
}

function stableMinute(seed = '', startMinutes, endMinutes) {
  const input = String(seed || '');
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  const span = Math.max(1, (endMinutes - startMinutes) + 1);
  return startMinutes + (Math.abs(hash) % span);
}

function minuteToTimestamp(date, minutes) {
  const day = formatDateInTz(date, config.TIMEZONE);
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return new Date(`${day}T${hour}:${minute}:00+08:00`).getTime();
}

function formatHm(timestamp = 0) {
  const value = Math.max(0, Number(timestamp || 0) || 0);
  if (!value) return '--:--';
  const parts = getDatePartsInTz(new Date(value), config.TIMEZONE);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function getWindowDefinitions(targetConfig) {
  const isQzone = String(targetConfig?.surface || '').trim().toLowerCase() === 'qzone';
  return WINDOW_KEYS.map((key) => {
    const fallback = isQzone
      ? (
        key === 'morning'
          ? { start: (7 * 60) + 30, end: 9 * 60 }
          : key === 'afternoon'
            ? { start: 13 * 60, end: 15 * 60 }
            : { start: 22 * 60, end: (23 * 60) + 40 }
      )
      : (
        key === 'morning'
          ? { start: 8 * 60, end: 10 * 60 }
          : key === 'afternoon'
            ? { start: 13 * 60, end: (15 * 60) + 30 }
            : { start: 20 * 60, end: (22 * 60) + 30 }
      );

    const parsed = parseWindowRange(targetConfig?.windows?.[key], fallback.start, fallback.end);
    return {
      key,
      label: WINDOW_LABELS[key],
      startMinutes: parsed.startMinutes,
      endMinutes: parsed.endMinutes
    };
  });
}

function formatWindowRange(windowDef) {
  const start = `${String(Math.floor(windowDef.startMinutes / 60)).padStart(2, '0')}:${String(windowDef.startMinutes % 60).padStart(2, '0')}`;
  const end = `${String(Math.floor(windowDef.endMinutes / 60)).padStart(2, '0')}:${String(windowDef.endMinutes % 60).padStart(2, '0')}`;
  return `${start}-${end}`;
}

function getMaxAutoSendsPerWindow(targetConfig = {}) {
  const surface = String(targetConfig?.surface || '').trim().toLowerCase();
  return surface === 'qzone' ? QZONE_MAX_AUTO_SENDS_PER_WINDOW : GROUP_MAX_AUTO_SENDS_PER_WINDOW;
}

function getWindowRemainingCapacity(schedule = {}, targetConfig = {}) {
  return Math.max(
    0,
    getMaxAutoSendsPerWindow(targetConfig) - Math.max(0, Number(schedule?.sentCount || 0) || 0)
  );
}

function ensureWindowSchedule(entry, targetId, windowDef, today, date, targetConfig = {}) {
  const schedule = entry.scheduleByWindow[windowDef.key];
  if (schedule.plannedAt > 0 && getWindowRemainingCapacity(schedule, targetConfig) > 0) return schedule;
  const minute = stableMinute(`${targetId}:${today}:${windowDef.key}`, windowDef.startMinutes, windowDef.endMinutes);
  schedule.plannedAt = minuteToTimestamp(date, minute);
  schedule.completedAt = 0;
  schedule.skippedAt = 0;
  schedule.deferred = false;
  schedule.deferredAt = 0;
  logDailyShare({
    groupId: targetId,
    windowKey: windowDef.key,
    reason: `planned:${formatHm(schedule.plannedAt)}`,
    event: 'schedule generated'
  });
  return schedule;
}

function getLastHumanMessage(groupId) {
  const botId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  const recent = getRecentMessages(groupId).slice().reverse();
  return recent.find((item) => String(item?.sender_id || '').trim() !== botId) || null;
}

function analyzeGroupRhythm(groupId) {
  const recentMessages = getRecentMessages(groupId);
  const lastHuman = getLastHumanMessage(groupId);
  const senderId = String(lastHuman?.sender_id || '').trim();
  const text = String(lastHuman?.text || '').trim();
  const now = Date.now();
  const window = buildConversationWindow({ recentMessages, now });
  return {
    recentMessages,
    lastHuman,
    analysis: analyzeConversationWindow({
      window,
      senderId,
      text
    })
  };
}

function shouldDeferOrSkip({ groupId, targetConfig, windowDef, stateEntry, now = Date.now() }) {
  const { analysis, lastHuman } = analyzeGroupRhythm(groupId);
  const status = stateEntry.windowStatus[windowDef.key];
  const schedule = stateEntry.scheduleByWindow[windowDef.key];
  const lastHumanAt = Number(lastHuman?.timestamp || 0) || 0;
  const silenceMs = Math.max(1, Number(targetConfig.minSilenceMinutes || 20)) * 60 * 1000;
  const isTooSoon = lastHumanAt > 0 && (now - lastHumanAt) < silenceMs;
  const isFastChat = Boolean(analysis?.isTwoPersonRapidExchange || analysis?.isMultiPartyRapidExchange);

  if (!isTooSoon && !isFastChat) {
    return { allowed: true, reason: '' };
  }

  const reason = isFastChat
    ? (analysis?.isMultiPartyRapidExchange ? 'fast-multi-party-chat' : 'fast-two-person-chat')
    : 'recent-human-message';

  schedule.deferred = true;
  schedule.deferredAt = now + (Math.max(1, Number(targetConfig.deferMinutes || 8)) * 60 * 1000);
  status.status = 'deferred';
  status.lastReason = reason;
  status.lastAttemptAt = now;
  logDailyShare({ groupId, windowKey: windowDef.key, reason, event: 'gating defer' });
  return { allowed: false, deferred: true, reason };
}

function getAutoTypeForWindow(targetConfig, stateEntry, windowKey) {
  const sequence = Array.isArray(targetConfig?.sequences?.[windowKey]) ? targetConfig.sequences[windowKey] : [];
  if (!sequence.length) return null;
  if (String(targetConfig?.surface || '').trim().toLowerCase() === 'qzone') {
    return chooseQzoneTypeByWeight(
      sequence,
      getRecentQzoneHistory(),
      `${windowKey}:${stateEntry?.today || ''}:${Math.max(0, Number(stateEntry?.dailyCount || 0) || 0)}`
    );
  }
  const pointer = Math.max(0, Number(stateEntry?.sequencePointers?.[windowKey] || 0) || 0);
  return sequence[pointer % sequence.length];
}

