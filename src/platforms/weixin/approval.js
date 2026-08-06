const crypto = require('crypto');

const COMMAND_PATTERN = /^\/(工具确认|工具取消|tool-confirm|tool-cancel)\s+(WX-[A-Za-z0-9-]+)$/i;

function normalizeText(value) {
  return String(value || '').trim();
}

function createWeixinApprovalService(options = {}) {
  const store = options.store;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Math.max(60_000, Number(options.ttlMs || 10 * 60_000) || 10 * 60_000);
  const createTicketId = typeof options.createTicketId === 'function'
    ? options.createTicketId
    : () => `WX-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  let handlers = { ...(options.handlers || {}) };

  if (!store) throw new TypeError('weixin store is required');

  function setHandlers(nextHandlers = {}) {
    handlers = { ...handlers, ...nextHandlers };
  }

  function request(input = {}) {
    const createdAt = now();
    return store.createApproval({
      ticketId: normalizeText(createTicketId()),
      qqUserId: normalizeText(input.qqUserId),
      action: normalizeText(input.type || input.action),
      createdAt,
      expiresAt: createdAt + ttlMs
    });
  }

  async function confirm(ticketId, actor = {}) {
    const claimed = store.claimApproval(ticketId, actor);
    if (!claimed.ok) return { status: 'denied', executed: false, reason: claimed.reason };
    const handler = handlers[claimed.approval.action];
    if (typeof handler !== 'function') {
      store.failApproval(ticketId, 'handler_unavailable');
      return { status: 'failed', executed: false, reason: 'handler_unavailable' };
    }
    try {
      const result = await handler({
        qqUserId: claimed.approval.qqUserId,
        userId: claimed.approval.qqUserId,
        platform: 'qq',
        chatType: 'private'
      });
      store.completeApproval(ticketId);
      return { status: 'completed', executed: true, result };
    } catch (error) {
      store.failApproval(ticketId, normalizeText(error?.code || 'execution_failed').toLowerCase());
      return {
        status: 'failed',
        executed: true,
        reason: 'execution_failed',
        error: normalizeText(error?.message || error)
      };
    }
  }

  function cancel(ticketId, actor = {}) {
    const result = store.cancelApproval(ticketId, actor);
    return result.ok
      ? { status: 'cancelled', executed: false }
      : { status: 'denied', executed: false, reason: result.reason };
  }

  async function handleCommand(text, actor = {}) {
    const match = normalizeText(text).match(COMMAND_PATTERN);
    if (!match) return { handled: false };
    const confirmation = /确认|confirm/i.test(match[1]);
    const result = confirmation
      ? await confirm(match[2], actor)
      : cancel(match[2], actor);
    return { handled: true, ticketId: match[2], result };
  }

  return {
    cancel,
    confirm,
    handleCommand,
    request,
    setHandlers
  };
}

module.exports = {
  createWeixinApprovalService
};
