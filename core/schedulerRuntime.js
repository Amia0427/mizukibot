const config = require('../config');
const { getScheduledTaskStore, nowDateTimeText } = require('../utils/scheduledTaskStore');
const { isAdminUser, publishQzoneForContext } = require('../api/qqActionService');

function clampScanIntervalMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(5000, Math.floor(n));
}

function createSchedulerRuntime(options = {}) {
  const store = options.store || getScheduledTaskStore();
  const sendGroupMessage = typeof options.sendGroupMessage === 'function'
    ? options.sendGroupMessage
    : async () => false;
  const publishQzone = typeof options.publishQzoneForContext === 'function'
    ? options.publishQzoneForContext
    : publishQzoneForContext;
  const isAdmin = typeof options.isAdminUser === 'function'
    ? options.isAdminUser
    : isAdminUser;
  const scanIntervalMs = clampScanIntervalMs(
    options.scanIntervalMs || config.SCHEDULED_TASK_SCAN_INTERVAL_MS,
    30000
  );

  let timer = null;
  let isRunning = false;
  let isScanning = false;

  async function executeTask(task = {}) {
    const commandType = String(task.commandType || '').trim();
    if (commandType === 'group_message') {
      const ok = await sendGroupMessage(task.groupId, task.payload?.message || '');
      return {
        success: ok,
        reason: ok ? '群消息已发送' : '群消息发送失败'
      };
    }

    if (commandType === 'qzone_post') {
      if (!isAdmin(task.ownerUserId)) {
        return {
          success: false,
          reason: 'owner no longer admin',
          ownerNoLongerAdmin: true
        };
      }
      const result = await publishQzone({
        mode: String(task.payload?.mode || '').trim() === 'bot_diary' ? 'bot_diary' : 'manual',
        content: task.payload?.content || '',
        hint: task.payload?.hint || ''
      }, {
        userId: String(task.ownerUserId || ''),
        routeMeta: {
          groupId: String(task.groupId || '')
        }
      });
      return {
        success: Boolean(result?.ok),
        reason: String(result?.reason || '').trim() || (result?.ok ? '空间已发布' : '空间发布失败'),
        source: result?.source || ''
      };
    }

    return {
      success: false,
      reason: `不支持的 commandType: ${commandType || 'unknown'}`
    };
  }

  function shouldSkipCronBacklog(task = {}, nowText = nowDateTimeText()) {
    if (String(task.scheduleType || '').trim() !== 'cron') return false;
    const nextRunAt = String(task.nextRunAt || '').trim();
    if (!nextRunAt) return false;
    return nextRunAt < nowText;
  }

  async function scan(nowText = nowDateTimeText()) {
    if (isScanning) return [];
    isScanning = true;
    const executed = [];
    try {
      const dueTasks = store.getDueTasks(nowText);
      for (const task of dueTasks) {
        if (String(task.scheduleType || '').trim() === 'cron' && shouldSkipCronBacklog(task, nowText)) {
          store.advanceCronWithoutExecution(task.id, nowText);
          continue;
        }

        const result = await executeTask(task);
        const nextStatus = result.ownerNoLongerAdmin
          ? (task.scheduleType === 'once' ? 'failed' : 'cancelled')
          : (task.scheduleType === 'once'
            ? (result.success ? 'completed' : 'failed')
            : 'active');
        store.markRunResult(task.id, {
          status: nextStatus,
          lastRunAt: new Date().toISOString(),
          nowText,
          lastResult: {
            success: Boolean(result.success),
            reason: String(result.reason || '').trim(),
            source: String(result.source || '').trim()
          }
        });
        executed.push({
          id: task.id,
          success: Boolean(result.success),
          reason: String(result.reason || '').trim()
        });
      }
      return executed;
    } finally {
      isScanning = false;
    }
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    timer = setInterval(() => {
      void scan().catch((error) => {
        console.error('[scheduler] scan failed', error?.message || error);
      });
    }, scanIntervalMs);
  }

  function stop() {
    isRunning = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    executeTask,
    scan,
    start,
    stop
  };
}

let singletonRuntime = null;

function getSchedulerRuntime(options = {}) {
  if (!singletonRuntime) {
    singletonRuntime = createSchedulerRuntime(options);
  }
  return singletonRuntime;
}

module.exports = {
  createSchedulerRuntime,
  getSchedulerRuntime
};
