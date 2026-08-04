const DAY_MS = 24 * 60 * 60 * 1000;

function createLocalFormatter(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getLocalParts(formatter, date) {
  return formatter.formatToParts(date).reduce((parts, part) => {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
    return parts;
  }, {});
}

function localDateToUtc(formatter, local) {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  const rendered = getLocalParts(formatter, new Date(guess));
  const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second, 0);
  return new Date(guess - (renderedAsUtc - guess));
}

function addLocalDay(local) {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + 1);
  return { ...local, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function createMaimaiSyncScheduler(options = {}) {
  const catalog = options.catalog;
  const worker = options.worker;
  if (!catalog || !worker || typeof worker.runOnce !== 'function') {
    throw new Error('maimai sync scheduler dependencies are required');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const timezone = String(options.timezone || 'Asia/Shanghai');
  const hour = Number.isInteger(options.hour) ? options.hour : 4;
  const minute = Number.isInteger(options.minute) ? options.minute : 30;
  const staleAfterMs = Number.isFinite(Number(options.staleAfterMs))
    ? Math.max(0, Number(options.staleAfterMs))
    : DAY_MS;
  const formatter = createLocalFormatter(timezone);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  let running = false;
  let timer = null;
  let activeRun = null;

  function needsStartupSync() {
    const active = catalog.getActiveGeneration();
    if (!active) return true;
    const lastSuccessful = catalog.getLastSuccessfulSync?.() || active;
    const finishedAt = Date.parse(String(lastSuccessful.finishedAt || lastSuccessful.finished_at || ''));
    return !Number.isFinite(finishedAt) || now().getTime() - finishedAt > staleAfterMs;
  }

  function nextRunAt(from = now()) {
    const local = getLocalParts(formatter, from);
    let target = localDateToUtc(formatter, { ...local, hour, minute, second: 0 });
    if (target.getTime() <= from.getTime()) {
      target = localDateToUtc(formatter, { ...addLocalDay(local), hour, minute, second: 0 });
    }
    return target;
  }

  function scheduleNext() {
    if (!running) return;
    if (timer) clearTimeout(timer);
    const target = nextRunAt();
    const delay = Math.max(1000, target.getTime() - now().getTime());
    timer = setTimeout(() => {
      timer = null;
      const run = trigger('scheduled');
      Promise.resolve(run.promise).finally(scheduleNext);
    }, delay);
    timer.unref?.();
  }

  function trigger(reason = 'manual') {
    if (activeRun) return { status: 'already_running', promise: activeRun };
    const startedAt = now().toISOString();
    const promise = Promise.resolve()
      .then(() => worker.runOnce())
      .catch((error) => {
        const result = { status: 'failed', error: String(error?.message || error), reason, startedAt };
        onError(error, result);
        return result;
      })
      .finally(() => {
        activeRun = null;
      });
    activeRun = promise;
    return { status: 'started', promise };
  }

  function start() {
    if (running) return false;
    running = true;
    catalog.markStaleRunsFailed?.();
    scheduleNext();
    if (needsStartupSync()) trigger('startup');
    return true;
  }

  function stop({ drain = false } = {}) {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return drain && activeRun ? activeRun : undefined;
  }

  return {
    getNextRunAt: () => nextRunAt(),
    getState: () => ({ running, active: Boolean(activeRun), nextRunAt: nextRunAt().toISOString() }),
    needsStartupSync,
    start,
    stop,
    trigger
  };
}

module.exports = {
  DAY_MS,
  createMaimaiSyncScheduler
};
