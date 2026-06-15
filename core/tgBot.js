// core/tgBot.js
const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const { askAIByGraph } = require('../api/agentGraph');

function isAllowed(chatId) {
  const allow = config.TG_ALLOWED_CHAT_IDS || [];
  if (!allow.length) return true; // Empty allowlist means all chats are allowed.
  return allow.includes(String(chatId));
}

function tgToUserId(msg) {
  // Combine Telegram user id and chat id to avoid cross-chat collisions.
  const uid = msg.from?.id || 'unknown';
  const cid = msg.chat?.id || 'unknown';
  return `tg_${uid}_${cid}`;
}

async function buildInputText(msg) {
  const text = (msg.text || '').trim();
  if (text) return text;

  // For now, photo-only messages are routed as a simple placeholder text.
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    return 'You sent an image. Please describe what help you want with it.';
  }

  return '';
}

function formatErrorMessage(error) {
  if (error && error.stack) return error.stack;
  if (error && error.message) return error.message;
  return String(error);
}

function logTelegramError(scope, error, msg) {
  console.error(scope, formatErrorMessage(error), {
    msgId: msg?.message_id,
    chatId: msg?.chat?.id
  });
}

async function sendMessageSafely(bot, chatId, text, msg, scope = '[TG] sendMessage failed:') {
  try {
    await bot.sendMessage(chatId, text);
    return true;
  } catch (error) {
    logTelegramError(scope, error, msg);
    return false;
  }
}

async function handleTelegramMessage(bot, msg, deps = {}) {
  const askAI = deps.askAIByGraph || askAIByGraph;
  const chatId = msg?.chat?.id;

  try {
    if (chatId === undefined || chatId === null) return;
    if (!isAllowed(chatId)) return;

    const input = await buildInputText(msg);
    if (!input) return;

    if (input === '/start') {
      await sendMessageSafely(bot, chatId, 'Hello, I am Mizuki Bot. You can send me a message directly.', msg);
      return;
    }
    if (input === '/help') {
      await sendMessageSafely(bot, chatId, 'Send a text message directly and I will reply with the current configuration.', msg);
      return;
    }

    const userId = tgToUserId(msg);
    const userInfo = { level: 'telegram_user' };

    try {
      await bot.sendChatAction(chatId, 'typing');
    } catch (error) {
      logTelegramError('[TG] sendChatAction failed:', error, msg);
    }

    let reply;
    try {
      reply = await askAI(input, userInfo, userId, null, null, { disableStream: true });
    } catch (error) {
      logTelegramError('[TG] AI processing failed:', error, msg);
      await sendMessageSafely(bot, chatId, 'An error occurred while handling this message. Please try again later.', msg);
      return;
    }

    const out = String(reply || 'No reply is available right now.');
    const chunks = out.match(/[\s\S]{1,3500}/g) || [out];
    for (const c of chunks) {
      await sendMessageSafely(bot, chatId, c, msg);
    }
  } catch (error) {
    logTelegramError('[TG] message handler failed:', error, msg);
    if (chatId !== undefined && chatId !== null) {
      await sendMessageSafely(bot, chatId, 'An error occurred while handling this message. Please try again later.', msg);
    }
  }
}

async function startTgBot() {
  if (!config.TG_ENABLE) {
    console.log('[TG] skipped because TG_ENABLE=false');
    return null;
  }
  if (!config.TG_BOT_TOKEN) {
    console.log('[TG] skipped because TG_BOT_TOKEN is missing');
    return null;
  }

  const bot = new TelegramBot(config.TG_BOT_TOKEN, { polling: true });

  bot.on('message', async (msg) => {
    await handleTelegramMessage(bot, msg);
  });

  bot.on('polling_error', (e) => {
    console.error('[TG] polling_error:', e.message);
  });

  console.log('[TG] Telegram Bot started with polling');
  return bot;
}

module.exports = { startTgBot, handleTelegramMessage };
