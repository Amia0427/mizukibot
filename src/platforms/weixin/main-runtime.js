const { isPrivateChatAccessAllowed } = require('../../../utils/privilegedPrivateChat');
const { createIlinkClient, LOGIN_BASE_URL } = require('./ilink-client');
const { createWeixinApprovalService } = require('./approval');
const { parseWeixinCommand } = require('./commands');
const { renderWeixinQrPng } = require('./qr');
const { createWeixinRuntime } = require('./runtime');

const APPROVAL_COMMAND = /^\/(?:工具确认|工具取消|tool-confirm|tool-cancel)\s+WX-[A-Za-z0-9-]+$/i;

function normalizeText(value) {
  return String(value || '').trim();
}

function buildContext(msg = {}) {
  const canonical = msg.canonical_message;
  const chatType = normalizeText(msg.message_type).toLowerCase() === 'private' ? 'private' : 'group';
  return {
    text: normalizeText(canonical?.text || msg.raw_message),
    platform: normalizeText(msg.platform || canonical?.platform || 'qq').toLowerCase() || 'qq',
    chatType,
    qqUserId: normalizeText(msg.user_id),
    userId: normalizeText(msg.user_id),
    groupId: chatType === 'group' ? normalizeText(msg.group_id) : ''
  };
}

function approvalReply(result = {}) {
  if (result.status === 'cancelled') return '微信操作审批已取消。';
  if (result.status === 'denied') return `微信操作审批失败：${result.reason || 'authorization_denied'}。`;
  if (result.status === 'failed') return '微信操作执行失败，请重新发起。';
  return '';
}

function createWeixinCommandBridge(options = {}) {
  const config = options.config;
  const runtime = options.runtime;
  const approvalService = options.approvalService;
  const sendWithRetry = options.sendWithRetry;
  const privateAccessAllowed = options.isPrivateAccessAllowed || ((context) => isPrivateChatAccessAllowed({
    chatType: context.chatType,
    userId: context.userId,
    config
  }));
  if (!runtime || !approvalService || typeof sendWithRetry !== 'function') {
    throw new TypeError('weixin command bridge dependencies are required');
  }

  async function sendReply(context, payload) {
    const message = [{ type: 'text', data: { text: payload.text } }];
    if (Buffer.isBuffer(payload.image)) {
      message.push({
        type: 'image',
        data: { file: `base64://${payload.image.toString('base64')}` }
      });
    }
    return sendWithRetry({
      action: context.chatType === 'private' ? 'send_private_msg' : 'send_group_msg',
      params: context.chatType === 'private'
        ? { user_id: context.userId, message }
        : { group_id: context.groupId, message }
    }, 1, 300);
  }

  function shouldHandle(text) {
    const normalized = normalizeText(text);
    return Boolean(parseWeixinCommand(normalized) || APPROVAL_COMMAND.test(normalized));
  }

  async function handle(msg) {
    const context = buildContext(msg);
    if (context.chatType === 'private' && !privateAccessAllowed(context)) return false;
    if (APPROVAL_COMMAND.test(context.text)) {
      const handled = await approvalService.handleCommand(context.text, {
        platform: context.platform,
        userId: context.userId,
        chatType: context.chatType,
        groupId: context.groupId
      });
      const text = approvalReply(handled.result);
      if (text) await sendReply(context, { text });
      return true;
    }
    await runtime.handleCommand(context);
    return true;
  }

  return { handle, sendReply, shouldHandle };
}

function createWeixinMainRuntime(options = {}) {
  if (options.config?.WEIXIN_ENABLED !== true) return null;
  const store = options.store;
  const loginClient = options.loginClient || createIlinkClient({
    fetch: options.fetch || globalThis.fetch,
    baseUrl: LOGIN_BASE_URL,
    token: ''
  });
  const approvalService = options.approvalService || createWeixinApprovalService({
    store,
    ttlMs: options.config.TOOL_AUTHORIZATION_TTL_MS
  });
  const runtime = createWeixinRuntime({
    store,
    loginClient,
    qrTtlMs: options.config.WEIXIN_QR_TTL_MS,
    renderQrPng: options.renderQrPng || renderWeixinQrPng,
    sendReply: async (context, payload) => bridge.sendReply(context, payload),
    approvalService,
    notifyStop: async (binding, requestOptions) => {
      const client = createIlinkClient({
        fetch: options.fetch || globalThis.fetch,
        baseUrl: binding.baseUrl,
        token: binding.botToken
      });
      return client.notifyStop(requestOptions);
    },
    onBindingConfirmed: options.onBindingConfirmed,
    onBindingRemoved: options.onBindingRemoved
  });
  approvalService.setHandlers({
    weixin_rebind: runtime.approvedRebind,
    weixin_unbind: runtime.approvedUnbind
  });
  const bridge = createWeixinCommandBridge({
    config: options.config,
    runtime,
    approvalService,
    sendWithRetry: options.sendWithRetry,
    isPrivateAccessAllowed: options.isPrivateAccessAllowed
  });

  return {
    approvalService,
    close: runtime.close,
    commandHandler: bridge,
    runtime
  };
}

module.exports = {
  createWeixinCommandBridge,
  createWeixinMainRuntime
};
