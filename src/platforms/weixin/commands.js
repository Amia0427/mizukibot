const crypto = require('crypto');

const DEFAULT_QR_TTL_MS = 5 * 60 * 1000;

function normalizeText(value) {
  return String(value || '').trim();
}

function parseWeixinCommand(text = '') {
  const match = normalizeText(text).match(/^\/微信\s+(绑定|状态|换绑|解绑|通知\s+(QQ|微信))$/i);
  if (!match) return null;
  if (match[1] === '绑定') return { action: 'bind' };
  if (match[1] === '状态') return { action: 'status' };
  if (match[1] === '换绑') return { action: 'rebind' };
  if (match[1] === '解绑') return { action: 'unbind' };
  return {
    action: 'notification',
    platform: match[2].toUpperCase() === 'QQ' ? 'qq' : 'weixin'
  };
}

function approvalTicketId(result = {}) {
  return normalizeText(result.ticketId || result.id || result.authorization?.ticketId);
}

function createWeixinCommandHandler(options = {}) {
  const store = options.store;
  const loginClient = options.loginClient;
  const renderQrPng = options.renderQrPng;
  const sendReply = options.sendReply;
  const approvalService = options.approvalService;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const createAttemptId = typeof options.createAttemptId === 'function'
    ? options.createAttemptId
    : crypto.randomUUID;
  const qrTtlMs = Number(options.qrTtlMs || DEFAULT_QR_TTL_MS);
  const onLoginStarted = typeof options.onLoginStarted === 'function'
    ? options.onLoginStarted
    : () => {};
  const onApprovedRebind = options.onApprovedRebind;
  const onApprovedUnbind = options.onApprovedUnbind;

  if (!store) throw new TypeError('weixin store is required');
  if (!loginClient || typeof loginClient.getQrCode !== 'function') {
    throw new TypeError('weixin login client is required');
  }
  if (typeof renderQrPng !== 'function') throw new TypeError('weixin QR PNG renderer is required');
  if (typeof sendReply !== 'function') throw new TypeError('weixin sendReply is required');
  if (!approvalService || typeof approvalService.request !== 'function') {
    throw new TypeError('weixin approval service is required');
  }
  if (!Number.isFinite(qrTtlMs) || qrTtlMs <= 0) throw new TypeError('weixin QR TTL must be positive');

  async function reply(input, payload) {
    await sendReply(input, payload);
    return payload.text;
  }

  async function beginLogin(input, mode) {
    const qqUserId = normalizeText(input.qqUserId || input.userId || input.user_id);
    const qr = await loginClient.getQrCode();
    const loginCredential = normalizeText(qr?.qrcode);
    const qrCodeContent = normalizeText(qr?.qrcode_img_content || loginCredential);
    if (!loginCredential || !qrCodeContent) throw new Error('Weixin QR response is incomplete');
    const image = await renderQrPng(qrCodeContent);
    const attempt = store.beginLoginAttempt({
      attemptId: normalizeText(createAttemptId()),
      qqUserId,
      mode,
      qrCode: qrCodeContent,
      loginCredential,
      expiresAt: now() + qrTtlMs
    });
    const replyText = await reply(input, {
      text: '请在 5 分钟内使用微信扫描二维码并在手机上确认。',
      image,
      imageMimeType: 'image/png'
    });
    await onLoginStarted(attempt, input);
    return {
      handled: true,
      action: mode === 'rebind' ? 'rebind' : 'bind',
      attemptId: attempt.attemptId,
      expiresAt: attempt.expiresAt,
      replyText
    };
  }

  async function requestApproval(input, action) {
    const qqUserId = normalizeText(input.qqUserId || input.userId || input.user_id);
    const isRebind = action === 'rebind';
    const execute = isRebind ? onApprovedRebind : onApprovedUnbind;
    if (typeof execute !== 'function') throw new Error(`approved ${action} callback is unavailable`);
    const result = await approvalService.request({
      type: isRebind ? 'weixin_rebind' : 'weixin_unbind',
      qqUserId,
      actor: {
        platform: 'qq',
        userId: qqUserId,
        chatType: 'private',
        groupId: ''
      },
      confirmation: isRebind ? '确认更换当前微信绑定' : '确认解绑当前微信账号',
      execute: () => execute(input)
    });
    const ticketId = approvalTicketId(result);
    if (!ticketId) throw new Error('weixin approval service returned no ticket ID');
    const replyText = await reply(input, {
      text: `请在当前 QQ 私聊发送 /工具确认 ${ticketId} 完成${isRebind ? '换绑' : '解绑'}。`
    });
    return { handled: true, action, ticketId, replyText, approval: result };
  }

  async function handle(input = {}) {
    const command = parseWeixinCommand(input.text);
    if (!command) return { handled: false };
    const platform = normalizeText(input.platform).toLowerCase();
    const chatType = normalizeText(input.chatType || input.chat_type).toLowerCase();
    if (platform !== 'qq' || chatType !== 'private') {
      const replyText = await reply(input, { text: '微信绑定只能在 QQ 私聊中操作。' });
      return { handled: true, action: command.action, replyText };
    }

    const qqUserId = normalizeText(input.qqUserId || input.userId || input.user_id);
    if (!qqUserId) throw new TypeError('QQ user ID is required');
    const binding = store.getBindingByQqUserId(qqUserId);

    if (command.action === 'status') {
      let text = '尚未绑定微信 ClawBot。';
      if (binding?.status === 'active') {
        const platformLabel = binding.notificationPlatform === 'weixin' ? '微信' : 'QQ';
        text = `微信 ClawBot 已绑定。主动通知平台：${platformLabel}。`;
      } else if (binding?.status === 'revoking') {
        text = '微信 ClawBot 正在解绑。';
      }
      const replyText = await reply(input, { text });
      return { handled: true, action: command.action, replyText };
    }

    if (command.action === 'bind') {
      if (binding) {
        const text = binding.status === 'revoking'
          ? '当前微信绑定正在解绑，请稍后再试。'
          : '当前 QQ 已绑定微信 ClawBot；如需更换，请使用 /微信 换绑。';
        const replyText = await reply(input, { text });
        return { handled: true, action: command.action, replyText };
      }
      return beginLogin(input, 'bind');
    }

    if (command.action === 'notification') {
      if (!binding || binding.status !== 'active') {
        const replyText = await reply(input, { text: '尚未绑定可用的微信 ClawBot。' });
        return { handled: true, action: command.action, replyText };
      }
      store.setNotificationPlatform(qqUserId, command.platform);
      const platformLabel = command.platform === 'weixin' ? '微信' : 'QQ';
      const replyText = await reply(input, { text: `主动通知已切换到${platformLabel}。` });
      return { handled: true, action: command.action, notificationPlatform: command.platform, replyText };
    }

    if (!binding || binding.status !== 'active') {
      const replyText = await reply(input, { text: '尚未绑定可用的微信 ClawBot。' });
      return { handled: true, action: command.action, replyText };
    }
    return requestApproval(input, command.action);
  }

  return {
    beginLogin,
    handle
  };
}

module.exports = {
  DEFAULT_QR_TTL_MS,
  createWeixinCommandHandler,
  parseWeixinCommand
};
