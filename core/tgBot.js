const config = require('../config');
const {
  createTelegramAdapter,
  normalizeTelegramMessage
} = require('../src/platforms/telegramAdapter');

async function loadTelegramBotClass() {
  const mod = await import('node-telegram-bot-api');
  return mod.default || mod.TelegramBot || mod;
}

function isAllowed(chatId) {
  const allow = config.TG_ALLOWED_CHAT_IDS || [];
  if (!allow.length) return true; // Empty allowlist means all chats are allowed.
  return allow.includes(String(chatId));
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

async function handleTelegramMessage(bot, msg, deps = {}) {
  const chatId = msg?.chat?.id;
  try {
    if (chatId === undefined || chatId === null) return;
    if (!isAllowed(chatId)) return;
    const inbound = await normalizeTelegramMessage(bot, msg, {
      botInfo: deps.botInfo,
      passiveChatIds: new Set(config.TG_PASSIVE_CHAT_IDS || config.TG_ALLOWED_CHAT_IDS || [])
    });
    if (!inbound || typeof deps.onMessage !== 'function') return;
    await deps.onMessage(inbound, 'telegram_polling_compat');
  } catch (error) {
    logTelegramError('[TG] message dispatch failed:', error, msg);
  }
}

async function startTgBot(options = {}) {
  if (!config.TG_ENABLE) {
    console.log('[TG] skipped because TG_ENABLE=false');
    return null;
  }
  if (!config.TG_BOT_TOKEN) {
    console.log('[TG] skipped because TG_BOT_TOKEN is missing');
    return null;
  }
  if (typeof options.onMessage !== 'function') {
    throw new Error('Telegram compatibility facade requires onMessage');
  }
  const adapter = createTelegramAdapter({
    enabled: true,
    token: config.TG_BOT_TOKEN,
    passiveChatIds: config.TG_PASSIVE_CHAT_IDS || config.TG_ALLOWED_CHAT_IDS,
    bot: options.bot,
    TelegramBot: options.TelegramBot
  });
  return adapter.start({ onMessage: options.onMessage });
}

module.exports = { startTgBot, handleTelegramMessage, loadTelegramBotClass };
