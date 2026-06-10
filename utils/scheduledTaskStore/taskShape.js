const {
  ACTIVE_STATUSES,
  ALLOWED_COMMAND_TYPES,
  ALLOWED_KINDS,
  ALLOWED_SCHEDULE_TYPES,
  ALLOWED_STATUSES,
  cloneJson,
  makeTaskId,
  normalizeText,
  nowDateTimeText,
  nowIso
} = require('./common');
const {
  computeNextCronRun,
  normalizeWhenExpression
} = require('../scheduledTaskTime');

const QZONE_MODES = new Set(['manual', 'bot_diary', 'agent', 'generic_autodraft']);
const QZONE_AUTODRAFT_MODES = new Set(['bot_diary', 'agent', 'generic_autodraft']);

function computeNextRunAt(task = {}, nowText = nowDateTimeText()) {
  if (task.scheduleType === 'once') {
    return normalizeText(task.executeAt);
  }
  if (task.scheduleType === 'cron') {
    return computeNextCronRun(task.cronExpr, nowText);
  }
  return '';
}

function normalizePayload(task = {}) {
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  if (normalizeText(task.commandType) === 'qzone_post') {
    const rawMode = normalizeText(payload.mode).toLowerCase();
    const mode = QZONE_MODES.has(rawMode) ? rawMode : 'agent';
    return cloneJson({
      mode,
      ...(mode === 'manual'
        ? { content: normalizeText(payload.content) }
        : { hint: normalizeText(payload.hint || payload.content) })
    }, {});
  }
  return cloneJson(payload, {});
}

function normalizeTask(task = {}, options = {}) {
  const nowText = normalizeText(options.nowText || nowDateTimeText()) || nowDateTimeText();
  const createdAt = normalizeText(task.createdAt || task.created_at) || nowIso();
  const updatedAt = normalizeText(task.updatedAt || task.updated_at) || createdAt;
  const scheduleType = ALLOWED_SCHEDULE_TYPES.has(normalizeText(task.scheduleType))
    ? normalizeText(task.scheduleType)
    : (normalizeText(task.cronExpr) ? 'cron' : 'once');
  const kind = ALLOWED_KINDS.has(normalizeText(task.kind)) ? normalizeText(task.kind) : 'message';
  const commandType = ALLOWED_COMMAND_TYPES.has(normalizeText(task.commandType))
    ? normalizeText(task.commandType)
    : (kind === 'message' ? 'group_message' : '');
  const status = ALLOWED_STATUSES.has(normalizeText(task.status))
    ? normalizeText(task.status)
    : 'active';
  const normalized = {
    id: normalizeText(task.id) || makeTaskId(),
    ownerUserId: normalizeText(task.ownerUserId || task.owner_user_id || task.userId || task.user_id),
    groupId: normalizeText(task.groupId || task.group_id),
    kind,
    commandType,
    status,
    scheduleType,
    cronExpr: scheduleType === 'cron' ? normalizeText(task.cronExpr || task.cron_expr) : '',
    executeAt: scheduleType === 'once' ? normalizeText(task.executeAt || task.execute_at) : '',
    nextRunAt: normalizeText(task.nextRunAt || task.next_run_at),
    payload: normalizePayload(task),
    createdAt,
    updatedAt,
    lastRunAt: normalizeText(task.lastRunAt || task.last_run_at),
    lastResult: task.lastResult && typeof task.lastResult === 'object' ? cloneJson(task.lastResult, {}) : null
  };

  if (!normalized.nextRunAt && ACTIVE_STATUSES.has(normalized.status)) {
    normalized.nextRunAt = computeNextRunAt(normalized, nowText);
  }
  return normalized;
}

function buildQzonePayload(payload = {}) {
  const rawMode = normalizeText(payload.mode).toLowerCase();
  const mode = QZONE_MODES.has(rawMode)
    ? rawMode
    : (normalizeText(payload.content) ? 'manual' : 'agent');

  return cloneJson({
    mode,
    ...(QZONE_AUTODRAFT_MODES.has(rawMode) || !normalizeText(payload.content)
      ? { hint: normalizeText(payload.hint || payload.content) }
      : { content: normalizeText(payload.content) })
  }, {});
}

function validateTaskInput(input = {}) {
  const ownerUserId = normalizeText(input.ownerUserId);
  const groupId = normalizeText(input.groupId);
  const kind = normalizeText(input.kind);
  const commandType = normalizeText(input.commandType);

  if (!ownerUserId) throw new Error('ownerUserId 不能为空');
  if (!groupId) throw new Error('groupId 不能为空');
  if (!ALLOWED_KINDS.has(kind)) throw new Error('kind 仅支持 message 或 command');
  if (!ALLOWED_COMMAND_TYPES.has(commandType)) throw new Error('commandType 仅支持 group_message 或 qzone_post');
  if (kind === 'message' && commandType !== 'group_message') {
    throw new Error('message 任务仅支持 group_message');
  }

  const normalizedWhen = normalizeWhenExpression(input.when);
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  if (commandType === 'group_message') {
    if (!normalizeText(payload.message)) throw new Error('群消息内容不能为空');
  }
  if (commandType === 'qzone_post') {
    const rawMode = normalizeText(payload.mode).toLowerCase();
    const mode = QZONE_MODES.has(rawMode)
      ? rawMode
      : (normalizeText(payload.content) ? 'manual' : 'agent');
    if (mode === 'manual' && !normalizeText(payload.content)) throw new Error('空间内容不能为空');
    if (mode !== 'manual') {
      return {
        ownerUserId,
        groupId,
        kind,
        commandType,
        scheduleType: normalizedWhen.kind === 'cron' ? 'cron' : 'once',
        cronExpr: normalizedWhen.cronExpr || '',
        executeAt: normalizedWhen.executeAt || '',
        payload: cloneJson({
          mode,
          hint: normalizeText(payload.hint || payload.content)
        }, {}),
        whenSummary: normalizedWhen.summary || ''
      };
    }
  }

  return {
    ownerUserId,
    groupId,
    kind,
    commandType,
    scheduleType: normalizedWhen.kind === 'cron' ? 'cron' : 'once',
    cronExpr: normalizedWhen.cronExpr || '',
    executeAt: normalizedWhen.executeAt || '',
    payload: commandType === 'qzone_post' ? buildQzonePayload(payload) : cloneJson(payload, {}),
    whenSummary: normalizedWhen.summary || ''
  };
}

module.exports = {
  computeNextRunAt,
  normalizePayload,
  normalizeTask,
  validateTaskInput
};
