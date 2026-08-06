const {
  cancelToolAuthorization,
  confirmToolAuthorization
} = require('../api/toolAuthorization');

const COMMAND_PATTERN = /^\/(tool-confirm|tool-cancel|工具确认|工具取消)\s+([A-Za-z0-9-]+)$/i;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseToolAuthorizationCommand(text = '') {
  const match = normalizeText(text).match(COMMAND_PATTERN);
  if (!match) return null;
  const command = match[1].toLowerCase();
  return {
    action: command === 'tool-confirm' || command === '工具确认' ? 'confirm' : 'cancel',
    ticketId: match[2]
  };
}

function formatDeniedReply(result = {}) {
  const reason = normalizeText(result.reason);
  if (reason === 'expired') return '确认票据已过期，工具未执行。';
  if (reason === 'identity_mismatch' || reason === 'context_mismatch') {
    return '这张确认票据不属于当前用户或聊天，工具未执行。';
  }
  if (reason === 'already_consumed') return '这张确认票据已处理，系统不会重复执行。';
  if (reason === 'admin_required') return '当前账号没有执行这项操作的管理员权限。';
  if (reason === 'not_found') return '没有找到这张确认票据，工具未执行。';
  if (
    reason === 'invalid_args'
    || reason === 'policy_changed'
    || reason === 'ticket_integrity_failed'
    || reason === 'unknown_capability'
  ) {
    return '工具或参数已发生变化，原确认票据已作废。';
  }
  return '确认失败，工具未执行。';
}

function formatConfirmationReply(result = {}) {
  if (result.status === 'completed') {
    const output = normalizeText(
      typeof result.result === 'string' ? result.result : JSON.stringify(result.result)
    );
    return output ? `工具已执行：${output}` : '工具已执行。';
  }
  if (result.status === 'uncertain') {
    return '工具可能已经执行，但结果无法确认；为避免重复操作，系统已禁止重试。';
  }
  return formatDeniedReply(result);
}

async function handleToolAuthorizationCommand(text = '', context = {}, deps = {}) {
  const command = parseToolAuthorizationCommand(text);
  if (!command) return { handled: false };
  const actor = {
    platform: normalizeText(context.platform).toLowerCase() || 'qq',
    userId: normalizeText(context.userId || context.user_id),
    chatType: normalizeText(context.chatType || context.chat_type).toLowerCase(),
    groupId: normalizeText(context.groupId || context.group_id)
  };
  const confirm = typeof deps.confirm === 'function' ? deps.confirm : confirmToolAuthorization;
  const cancel = typeof deps.cancel === 'function' ? deps.cancel : cancelToolAuthorization;
  const result = command.action === 'confirm'
    ? await confirm(command.ticketId, actor)
    : await cancel(command.ticketId, actor);
  const replyText = command.action === 'confirm'
    ? formatConfirmationReply(result)
    : (result.status === 'cancelled' ? '已取消这次工具执行。' : formatDeniedReply(result));
  return {
    handled: true,
    action: command.action,
    ticketId: command.ticketId,
    replyText,
    result,
    ...(
      result.status !== 'denied' && result.authorization?.originRoute
        ? { deliveryTarget: result.authorization.originRoute }
        : {}
    )
  };
}

module.exports = {
  formatConfirmationReply,
  handleToolAuthorizationCommand,
  parseToolAuthorizationCommand
};
