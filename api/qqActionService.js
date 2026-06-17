const config = require('../config');
const {
  getActionClientConnectionState,
  getNapCatActionClient,
  isActionClientConnected,
  isNapCatOfflineError
} = require('./napcatActionClient');
const { recordNapCatDegradation } = require('../utils/napcatHealthDiagnostics');
const { AUTO_PUBLISH, DRAFT_ONLY, runQzoneAgent } = require('./qzoneAgentService');
const { getScheduledTaskStore } = require('../utils/scheduledTaskStore');
const {
  describeCron,
  normalizeWhenExpression
} = require('../utils/scheduledTaskTime');
const {
  buildBotDiaryImagePrompt,
  cleanupLocalImage,
  downloadImageToLocal,
  isNightDiaryWindow,
  sanitizeDiaryImageMeta,
  sanitizeDiaryImageText,
  sendGroupImageMessage,
  shouldAttemptBotDiaryImage,
  tryGenerateBotDiaryQzoneImage
} = require('./qqActionService.imageDiary');

const ADMIN_USER_IDS = new Set((config.ADMIN_USER_IDS || []).map((item) => String(item || '').trim()).filter(Boolean));
const REASONING_FORWARD_NODE_MAX_CHARS = 3500;

function isAdminUser(userId = '') {
  return ADMIN_USER_IDS.has(String(userId || '').trim());
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMessageId(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  return /^\d+$/.test(text) ? Number(text) : text;
}

function normalizeEmojiIdList(value) {
  const source = Array.isArray(value) ? value : [value];
  return Array.from(new Set(source
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item))));
}

function normalizeQzoneMode(value = '', fallback = 'manual') {
  const mode = normalizeText(value).toLowerCase();
  if (mode === 'bot_diary') return 'bot_diary';
  if (mode === 'agent' || mode === 'generic_autodraft') return mode;
  return fallback;
}

function normalizeQzonePublishInput(input = {}, options = {}) {
  if (typeof input === 'string') {
    return {
      mode: 'manual',
      content: normalizeText(input),
      hint: ''
    };
  }

  const raw = input && typeof input === 'object' ? input : {};
  const mode = normalizeQzoneMode(raw.mode, options.defaultMode || 'manual');
  return {
    mode,
    content: mode === 'manual' ? normalizeText(raw.content) : '',
    hint: normalizeText(raw.hint || (mode === 'agent' || mode === 'generic_autodraft' ? raw.content : ''))
  };
}

function normalizeScheduledMessageInput(input = '') {
  if (typeof input === 'string') return normalizeText(input);
  const raw = input && typeof input === 'object' ? input : {};
  return normalizeText(raw.message || raw.content);
}

function requireGroupContext(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  const groupId = normalizeText(routeMeta.groupId || routeMeta.group_id);
  if (!groupId) {
    throw new Error('group context required');
  }
  return {
    groupId,
    userId: normalizeText(context.userId)
  };
}

function assertAdmin(userId = '') {
  if (!isAdminUser(userId)) {
    throw new Error('admin required');
  }
}

function summarizeTask(task = {}, options = {}) {
  const cronSummary = String(options.cronSummary || '').trim();
  const nextRunAt = normalizeText(task.nextRunAt);
  const lines = [
    `Task ID: ${task.id}`,
    `Task Type: ${task.kind}/${task.commandType}`,
    `Next Run: ${nextRunAt || 'none'}`
  ];
  if (normalizeText(task.scheduleType) === 'cron') {
    lines.push(`Cron: ${task.cronExpr}`);
    lines.push(`Summary: ${cronSummary || describeCron(task.cronExpr) || 'recurring task'}`);
  }
  return lines.join('\n');
}

async function sendGroupMessage(groupId = '', message = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetGroupId = normalizeText(groupId);
  const text = normalizeText(message);
  if (!targetGroupId) throw new Error('groupId is required');
  if (!text) throw new Error('message content is required');
  await actionClient.callAction('send_group_msg', {
    group_id: targetGroupId,
    message: text
  });
  return {
    success: true,
    reason: 'group message sent'
  };
}

async function sendPrivateMessage(userId = '', message = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetUserId = normalizeText(userId);
  const text = normalizeText(message);
  if (!targetUserId) throw new Error('userId is required');
  if (!text) throw new Error('message content is required');
  await actionClient.callAction('send_private_msg', {
    user_id: targetUserId,
    message: text
  });
  return {
    success: true,
    reason: 'private message sent'
  };
}

function splitTextIntoFixedChunks(text = '', maxChars = REASONING_FORWARD_NODE_MAX_CHARS) {
  const raw = String(text || '');
  const limit = Math.max(500, Math.floor(Number(maxChars) || REASONING_FORWARD_NODE_MAX_CHARS));
  if (!raw) return [];
  const chunks = [];
  for (let index = 0; index < raw.length; index += limit) {
    chunks.push(raw.slice(index, index + limit));
  }
  return chunks;
}

function buildReasoningForwardNodes(reasoningText = '', options = {}) {
  const text = String(reasoningText || '').trim();
  if (!text) return [];
  const name = normalizeText(options.name || options.botName || '瑞希') || '瑞希';
  const uin = normalizeText(options.uin || options.botUin || config.BOT_QQ || '0') || '0';
  return splitTextIntoFixedChunks(text, options.maxNodeChars).map((content) => ({
    type: 'node',
    data: {
      name,
      uin,
      content
    }
  }));
}

async function sendGroupForwardMessage(groupId = '', messages = [], options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetGroupId = normalizeText(groupId);
  const forwardMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!targetGroupId) throw new Error('groupId is required');
  if (!forwardMessages.length) throw new Error('forward messages are required');
  await actionClient.callAction('send_group_forward_msg', {
    group_id: targetGroupId,
    messages: forwardMessages
  });
  return {
    success: true,
    reason: 'group forward message sent'
  };
}

async function sendPrivateForwardMessage(userId = '', messages = [], options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetUserId = normalizeText(userId);
  const forwardMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!targetUserId) throw new Error('userId is required');
  if (!forwardMessages.length) throw new Error('forward messages are required');
  await actionClient.callAction('send_private_forward_msg', {
    user_id: targetUserId,
    messages: forwardMessages
  });
  return {
    success: true,
    reason: 'private forward message sent'
  };
}

async function sendReasoningForwardMessage(input = {}, options = {}) {
  const chatType = normalizeText(input.chatType || input.chat_type).toLowerCase() === 'private' ? 'private' : 'group';
  const reasoningText = String(input.reasoningText || '').trim();
  if (!reasoningText) return { success: false, skipped: true, reason: 'empty_reasoning' };
  const messages = buildReasoningForwardNodes(reasoningText, {
    botName: input.botName || options.botName,
    botUin: input.botUin || options.botUin,
    maxNodeChars: input.maxNodeChars || options.maxNodeChars
  });
  if (!messages.length) return { success: false, skipped: true, reason: 'empty_nodes' };
  try {
    if (chatType === 'private') {
      await sendPrivateForwardMessage(input.userId || input.user_id, messages, options);
    } else {
      await sendGroupForwardMessage(input.groupId || input.group_id, messages, options);
    }
    return { success: true, reason: 'reasoning forward sent', nodeCount: messages.length };
  } catch (error) {
    console.warn('[reasoning-forward] send failed', {
      chatType,
      groupId: normalizeText(input.groupId || input.group_id),
      userId: normalizeText(input.userId || input.user_id),
      nodeCount: messages.length,
      error: error?.message || String(error || '')
    });
    return {
      success: false,
      reason: error?.message || String(error || 'reasoning forward failed'),
      nodeCount: messages.length
    };
  }
}

async function sendPrivatePoke(userId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetUserId = normalizeText(userId);
  if (!targetUserId) throw new Error('userId is required');
  await actionClient.callAction('friend_poke', {
    user_id: targetUserId
  });
  return {
    success: true,
    reason: 'private poke sent'
  };
}

async function sendGroupPoke(groupId = '', userId = '', options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const targetGroupId = normalizeText(groupId);
  const targetUserId = normalizeText(userId);
  if (!targetGroupId) throw new Error('groupId is required');
  if (!targetUserId) throw new Error('userId is required');
  await actionClient.callAction('group_poke', {
    group_id: targetGroupId,
    user_id: targetUserId
  });
  return {
    success: true,
    reason: 'group poke sent'
  };
}

async function setMessageEmojiLike(messageId = '', emojiIds = [], options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const normalizedMessageId = normalizeMessageId(messageId);
  const normalizedEmojiIds = normalizeEmojiIdList(emojiIds);
  const set = options.set !== false;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : 0;

  if (!normalizedMessageId) {
    return { success: false, reason: 'message_id is required', appliedEmojiIds: [] };
  }

  if (!normalizedEmojiIds.length) {
    return { success: true, reason: 'no emoji ids configured', appliedEmojiIds: [] };
  }

  if (!isActionClientConnected(actionClient)) {
    const connectionState = getActionClientConnectionState(actionClient);
    recordNapCatDegradation('thinking-emoji', {
      module: 'thinking-emoji',
      reason: 'napcat_offline',
      messageId: normalizedMessageId,
      connectionState
    });
    return {
      success: false,
      reason: 'napcat_offline',
      retryable: true,
      skipped: true,
      connectionState,
      appliedEmojiIds: [],
      failures: []
    };
  }

  const failures = [];
  for (const emojiId of normalizedEmojiIds) {
    try {
      await actionClient.callAction('set_msg_emoji_like', {
        message_id: normalizedMessageId,
        emoji_id: emojiId,
        set
      }, timeoutMs > 0 ? { timeoutMs } : {});
    } catch (error) {
      failures.push({
        emojiId,
        error: error?.message || String(error || 'unknown error'),
        offline: isNapCatOfflineError(error)
      });
    }
  }

  if (failures.length > 0) {
    const offline = failures.some((item) => item.offline === true);
    const connectionState = offline ? getActionClientConnectionState(actionClient) : undefined;
    if (offline) {
      recordNapCatDegradation('thinking-emoji', {
        module: 'thinking-emoji',
        reason: 'napcat_offline',
        messageId: normalizedMessageId,
        connectionState
      });
    }
    return {
      success: false,
      reason: offline ? 'napcat_offline' : (failures[0]?.error || 'set_msg_emoji_like failed'),
      retryable: offline,
      skipped: offline,
      connectionState,
      appliedEmojiIds: normalizedEmojiIds.filter((emojiId) => !failures.some((item) => item.emojiId === emojiId)),
      failures
    };
  }

  return {
    success: true,
    reason: 'message emoji updated',
    appliedEmojiIds: normalizedEmojiIds
  };
}

async function publishQzoneForContext(input = '', context = {}, options = {}) {
  const { userId, groupId } = requireGroupContext(context);
  assertAdmin(userId);
  const normalized = normalizeQzonePublishInput(input);
  return runQzoneAgent({
    mode: normalized.mode,
    content: normalized.content,
    hint: normalized.hint,
    source: options.qzoneSource || (normalized.mode === 'manual' ? 'manual_qzone_post' : normalized.mode),
    type: options.qzoneType || (normalized.mode === 'manual' ? 'manual_qzone_post' : normalized.mode),
    publishPolicy: options.publishPolicy === AUTO_PUBLISH ? AUTO_PUBLISH : DRAFT_ONLY,
    allowImage: options.allowImage
  }, {
    ...context,
    userId,
    routeMeta: {
      ...(context.routeMeta || {}),
      groupId
    }
  }, {
    ...options,
    assertAdmin,
    helpers: {
      tryGenerateBotDiaryQzoneImage,
      cleanupLocalImage,
      ...(options.helpers || {})
    }
  });
}

function createTaskResponse(task = {}, normalizedWhen = {}) {
  return summarizeTask(task, {
    cronSummary: normalizedWhen.kind === 'cron' ? (normalizedWhen.summary || describeCron(task.cronExpr)) : ''
  });
}

function createScheduledTask(input = {}, context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const when = normalizeText(input.when);
  const normalizedWhen = normalizeWhenExpression(when);
  const created = store.createTask({
    ownerUserId: userId,
    groupId,
    kind: input.kind,
    commandType: input.commandType,
    when,
    payload: input.payload
  });
  return {
    task: created.task,
    text: createTaskResponse(created.task, normalizedWhen)
  };
}

function scheduleGroupMessage(message = '', when = '', context = {}, options = {}) {
  return createScheduledTask({
    kind: 'message',
    commandType: 'group_message',
    when,
    payload: {
      message: normalizeText(message)
    }
  }, context, options);
}

function createScheduledCommand(action = '', when = '', contentOrArgs = '', context = {}, options = {}) {
  const normalizedAction = normalizeText(action);
  if (!new Set(['group_message', 'qzone_post']).has(normalizedAction)) {
    throw new Error('unsupported action');
  }

  const { userId } = requireGroupContext(context);
  if (normalizedAction === 'qzone_post') {
    assertAdmin(userId);
    const qzoneAutoPublishEnabled = options.qzoneAutoPublishEnabled !== undefined
      ? options.qzoneAutoPublishEnabled
      : config.QZONE_AUTO_PUBLISH_ENABLED;
    if (!qzoneAutoPublishEnabled) {
      throw new Error('QZone auto publish disabled');
    }
  }

  const qzoneInput = normalizedAction === 'qzone_post'
    ? normalizeQzonePublishInput(contentOrArgs)
    : null;
  const qzoneMode = qzoneInput && qzoneInput.mode === 'manual' && !qzoneInput.content
    ? 'agent'
    : qzoneInput?.mode;

  return createScheduledTask({
    kind: 'command',
    commandType: normalizedAction,
    when,
    payload: normalizedAction === 'group_message'
      ? { message: normalizeScheduledMessageInput(contentOrArgs) }
      : {
        mode: qzoneMode,
        ...(qzoneMode === 'manual'
          ? { content: qzoneInput.content }
          : { hint: qzoneInput.hint })
      }
  }, context, options);
}

function canAccessTask(task = {}, userId = '', groupId = '') {
  if (!task) return false;
  if (normalizeText(task.groupId) !== normalizeText(groupId)) return false;
  if (isAdminUser(userId)) return true;
  return normalizeText(task.ownerUserId) === normalizeText(userId);
}

function listScheduledTasks(scope = 'mine', context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const normalizedScope = normalizeText(scope || 'mine').toLowerCase() || 'mine';
  const wantsAll = normalizedScope === 'all';
  if (wantsAll && !isAdminUser(userId)) {
    throw new Error('admin required for all tasks');
  }

  const tasks = store.listTasks({
    groupId,
    ownerUserId: wantsAll ? '' : userId
  }).filter((task) => canAccessTask(task, userId, groupId));

  if (!tasks.length) {
    return {
      tasks: [],
      text: 'no visible tasks'
    };
  }

  const lines = [`Task Count: ${tasks.length}`];
  for (const task of tasks) {
    lines.push(summarizeTask(task));
  }
  return {
    tasks,
    text: lines.join('\n\n')
  };
}

function cancelScheduledTask(taskId = '', context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const task = store.getTask(taskId);
  if (!task) throw new Error('task not found');
  if (!canAccessTask(task, userId, groupId)) {
    throw new Error('no permission');
  }
  const updated = store.cancelTask(taskId);
  return {
    task: updated,
    text: summarizeTask(updated)
  };
}

function deleteScheduledTask(taskId = '', context = {}, options = {}) {
  const store = options.store || getScheduledTaskStore();
  const { groupId, userId } = requireGroupContext(context);
  const task = store.getTask(taskId);
  if (!task) throw new Error('task not found');
  if (!canAccessTask(task, userId, groupId)) {
    throw new Error('no permission');
  }
  store.deleteTask(taskId);
  return {
    task,
    text: `Task ID: ${task.id}\nTask Type: ${task.kind}/${task.commandType}\nStatus: deleted`
  };
}

module.exports = {
  buildBotDiaryImagePrompt,
  cancelScheduledTask,
  createScheduledCommand,
  createScheduledTask,
  deleteScheduledTask,
  downloadImageToLocal,
  isAdminUser,
  isNightDiaryWindow,
  listScheduledTasks,
  normalizeQzonePublishInput,
  publishQzoneForContext,
  requireGroupContext,
  sanitizeDiaryImageMeta,
  sanitizeDiaryImageText,
  sendGroupImageMessage,
  sendGroupPoke,
  scheduleGroupMessage,
  buildReasoningForwardNodes,
  sendGroupMessage,
  sendGroupForwardMessage,
  sendPrivatePoke,
  sendPrivateMessage,
  sendPrivateForwardMessage,
  sendReasoningForwardMessage,
  setMessageEmojiLike,
  shouldAttemptBotDiaryImage,
  tryGenerateBotDiaryQzoneImage
};
