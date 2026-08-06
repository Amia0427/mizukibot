const { createInboundMessage } = require('./contracts');

const CAPABILITIES = Object.freeze(['text', 'image', 'reply', 'mention', 'typing', 'reaction', 'forward']);
const NATIVE_COMMANDS = Object.freeze([
  { command: 'help', description: '查看机器人命令' },
  { command: 'bind', description: '生成或使用跨平台绑定码' },
  { command: 'bindings', description: '查看已绑定账号' },
  { command: 'unbind', description: '解绑当前平台账号' },
  { command: 'mai', description: '查询舞萌数据' },
  { command: 'pjsk', description: '查询 PJSK 曲目或谱面' },
  { command: 'create', description: '生成图片' },
  { command: 'small_theater', description: '生成番外小剧场' },
  { command: 'group_summary', description: '总结当前群最近消息' },
  { command: 'status', description: '查看任务状态' }
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function telegramCommandAlias(text = '') {
  const input = normalizeText(text);
  if (/^\/small_theater(?:@\w+)?(?:\s|$)/i.test(input)) return input.replace(/^\/small_theater(?:@\w+)?/i, '/小剧场');
  if (/^\/group_summary(?:@\w+)?(?:\s|$)/i.test(input)) return input.replace(/^\/group_summary(?:@\w+)?/i, '/群总结');
  if (/^\/status(?:@\w+)?\s*$/i.test(input)) return '任务状态';
  return input.replace(/^\/(bind|bindings|unbind|mai|pjsk|create)(?:@\w+)?/i, '/$1');
}

function chatDisplayName(chat = {}) {
  return normalizeText(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' '));
}

function userDisplayName(user = {}) {
  return normalizeText([user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.id);
}

function isPassiveTelegramTarget(chatId, threadId, passiveChatIds) {
  const chat = normalizeText(chatId);
  const topic = normalizeText(threadId);
  return passiveChatIds.has(chat) || (topic && passiveChatIds.has(`${chat}:${topic}`));
}

async function normalizeTelegramMessage(bot, message = {}, options = {}) {
  const chatId = normalizeText(message.chat?.id);
  const externalUserId = normalizeText(message.from?.id);
  if (!message.message_id || !chatId || !externalUserId) return null;
  if (message.from?.is_bot) return null;
  const botInfo = options.botInfo || {};
  const botId = normalizeText(botInfo.id);
  const botUsername = normalizeText(botInfo.username);
  const chatType = message.chat?.type === 'private' ? 'private' : 'group';
  const threadId = normalizeText(message.message_thread_id);
  const passiveChatIds = options.passiveChatIds instanceof Set ? options.passiveChatIds : new Set();
  const rawText = normalizeText(message.text || message.caption);
  const mentionPattern = botUsername ? new RegExp(`@${botUsername}\\b`, 'ig') : /^$/;
  const mentionsBot = Boolean(
    (botUsername && mentionPattern.test(rawText))
    || (botId && normalizeText(message.reply_to_message?.from?.id) === botId)
  );
  const text = telegramCommandAlias(rawText.replace(mentionPattern, ' ').trim());
  const attachments = [];
  const largestPhoto = Array.isArray(message.photo) && message.photo.length ? message.photo[message.photo.length - 1] : null;
  if (largestPhoto?.file_id) {
    const url = await bot.getFileLink(largestPhoto.file_id);
    attachments.push({ kind: 'image', url: String(url), size: largestPhoto.file_size });
  } else if (String(message.document?.mime_type || '').startsWith('image/') && message.document?.file_id) {
    const url = await bot.getFileLink(message.document.file_id);
    attachments.push({
      kind: 'image',
      url: String(url),
      name: message.document.file_name,
      mimeType: message.document.mime_type,
      size: message.document.file_size
    });
  }

  const replyMessage = message.reply_to_message;
  const replyTo = replyMessage ? {
    messageId: normalizeText(replyMessage.message_id),
    senderId: normalizeText(replyMessage.from?.id),
    senderName: userDisplayName(replyMessage.from),
    text: normalizeText(replyMessage.text || replyMessage.caption),
    imageUrls: []
  } : null;

  return createInboundMessage({
    platform: 'telegram',
    eventId: normalizeText(message.message_id),
    occurredAt: Number(message.date || 0) > 0 ? Number(message.date) * 1000 : Date.now(),
    actor: {
      externalId: externalUserId,
      displayName: userDisplayName(message.from)
    },
    conversation: {
      chatType,
      conversationId: chatId,
      threadId,
      displayName: chatDisplayName(message.chat)
    },
    text,
    attachments,
    replyTo,
    mentionsBot,
    botExternalId: botId || botUsername,
    allowPassiveContext: chatType === 'group' && isPassiveTelegramTarget(chatId, threadId, passiveChatIds),
    allowLongTermGroupMemory: false,
    capabilities: CAPABILITIES
  });
}

function createTelegramAdapter(options = {}) {
  const enabled = options.enabled === true;
  const passiveChatIds = new Set((Array.isArray(options.passiveChatIds) ? options.passiveChatIds : [])
    .map(normalizeText)
    .filter(Boolean));
  let bot = options.bot || null;
  let botInfo = null;
  let status = enabled ? 'stopped' : 'disabled';
  let lastError = '';
  let startedAt = 0;

  async function loadTelegramBotClass() {
    if (options.TelegramBot) return options.TelegramBot;
    const imported = await import('node-telegram-bot-api');
    return imported.default || imported.TelegramBot || imported;
  }

  async function start(runtime = {}) {
    if (!enabled) return null;
    status = 'connecting';
    if (!bot) {
      const TelegramBot = await loadTelegramBotClass();
      bot = new TelegramBot(options.token, { polling: true });
    }
    botInfo = await bot.getMe();
    await bot.setMyCommands(NATIVE_COMMANDS);
    bot.on('message', async (message) => {
      try {
        const inbound = await normalizeTelegramMessage(bot, message, { botInfo, passiveChatIds });
        if (inbound) await runtime.onMessage(inbound, 'telegram_polling');
      } catch (error) {
        console.error('[platform:telegram] message dispatch failed', {
          messageId: normalizeText(message?.message_id),
          error: normalizeText(error?.message || error)
        });
      }
    });
    bot.on('polling_error', (error) => {
      status = 'degraded';
      lastError = normalizeText(error?.message || error);
    });
    status = 'online';
    lastError = '';
    startedAt = Date.now();
    return bot;
  }

  function messageOptions(target, sendOptions = {}) {
    return {
      ...(normalizeText(target.threadId) ? { message_thread_id: Number(target.threadId) } : {}),
      ...(normalizeText(sendOptions.replyToMessageId) ? { reply_to_message_id: Number(sendOptions.replyToMessageId) } : {})
    };
  }

  async function sendText(target, text, sendOptions = {}) {
    const value = normalizeText(text);
    if (!value) return false;
    await bot.sendMessage(target.conversationId, value, messageOptions(target, sendOptions));
    return true;
  }

  async function sendImage(target, image, sendOptions = {}) {
    await bot.sendPhoto(target.conversationId, image, messageOptions(target, sendOptions));
    return true;
  }

  async function setTyping(target) {
    await bot.sendChatAction(target.conversationId, 'typing', messageOptions(target));
    return true;
  }

  async function react(target, messageId, emoji) {
    if (typeof bot.setMessageReaction !== 'function' || !normalizeText(messageId)) return false;
    await bot.setMessageReaction(target.conversationId, Number(messageId), {
      reaction: [{ type: 'emoji', emoji }]
    });
    return true;
  }

  async function stop() {
    if (bot?.stopPolling) await bot.stopPolling({ cancel: true });
    status = enabled ? 'stopped' : 'disabled';
  }

  function markDegraded(error) {
    status = 'degraded';
    lastError = normalizeText(error?.message || error);
  }

  return {
    platform: 'telegram',
    enabled,
    capabilities: CAPABILITIES,
    fetchMessage: async () => null,
    getHealth: () => ({ status, lastError, startedAt }),
    loadTelegramBotClass,
    markDegraded,
    react,
    sendImage,
    sendText,
    setTyping,
    start,
    stop
  };
}

module.exports = {
  CAPABILITIES,
  NATIVE_COMMANDS,
  createTelegramAdapter,
  normalizeTelegramMessage,
  telegramCommandAlias
};
