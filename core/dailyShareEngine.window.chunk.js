function findCurrentWindow(targetConfig, date) {
  const currentMinutes = getCurrentMinutes(date, config.TIMEZONE);
  return getWindowDefinitions(targetConfig).find((item) => currentMinutes >= item.startMinutes && currentMinutes <= item.endMinutes) || null;
}

function isManualDailyShareType(type) {
  return DAILY_SHARE_TYPES.includes(String(type || '').trim().toLowerCase());
}

function isManualQzoneDailyShareType(type) {
  return QZONE_DAILY_SHARE_TYPES.includes(String(type || '').trim().toLowerCase());
}

function getNextWindowInfo(targetConfig, entry, date) {
  const today = formatDateInTz(date, config.TIMEZONE);
  const windows = getWindowDefinitions(targetConfig);
  const pending = windows
    .map((windowDef) => {
      const schedule = entry.scheduleByWindow[windowDef.key];
      const status = entry.windowStatus[windowDef.key];
      return { windowDef, schedule, status };
    })
      .filter((item) => item.status.status !== 'skipped' && getWindowRemainingCapacity(item.schedule, targetConfig) > 0)
    .sort((a, b) => {
      const aTime = (a.schedule.deferred && a.schedule.deferredAt) ? a.schedule.deferredAt : a.schedule.plannedAt;
      const bTime = (b.schedule.deferred && b.schedule.deferredAt) ? b.schedule.deferredAt : b.schedule.plannedAt;
      return aTime - bTime;
    });

  if (!pending.length) return { label: '今日无后续窗口', time: '--:--', today };
  const next = pending[0];
  const when = (next.schedule.deferred && next.schedule.deferredAt) ? next.schedule.deferredAt : next.schedule.plannedAt;
  return {
    label: next.windowDef.label,
    time: formatHm(when),
    today
  };
}

function shouldRunWindowNow({ entry, windowDef, now, date, targetConfig = {} }) {
  const schedule = entry.scheduleByWindow[windowDef.key];
  const status = entry.windowStatus[windowDef.key];
  const currentMinutes = getCurrentMinutes(date, config.TIMEZONE);
  if (currentMinutes > windowDef.endMinutes) {
    if (getWindowRemainingCapacity(schedule, targetConfig) > 0 && status.status !== 'skipped') {
      status.status = 'skipped';
      status.lastReason = 'window-expired';
      status.lastAttemptAt = now;
      schedule.skippedAt = now;
      logDailyShare({ groupId: '', windowKey: windowDef.key, reason: 'window-expired', event: 'window skip' });
    }
    return false;
  }
  if (status.status === 'skipped') return false;
  if (getWindowRemainingCapacity(schedule, targetConfig) <= 0) return false;
  if (Math.max(0, Number(schedule.cooldownUntil || 0) || 0) > now) return false;
  if (schedule.deferred && schedule.deferredAt > now) return false;
  return schedule.plannedAt > 0 && now >= schedule.plannedAt;
}

