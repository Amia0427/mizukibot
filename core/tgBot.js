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
    try {
      const chatId = msg.chat.id;
      if (!isAllowed(chatId)) return;

      const input = await buildInputText(msg);
      if (!input) return;

      if (input === '/start') {
        await bot.sendMessage(chatId, 'Hello, I am Mizuki Bot. You can send me a message directly.');
        return;
      }
      if (input === '/help') {
        await bot.sendMessage(chatId, 'Send a text message directly and I will reply with the current configuration.');
        return;
      }

      const userId = tgToUserId(msg);
      const userInfo = { level: 'telegram_user' };

      await bot.sendChatAction(chatId, 'typing');

      const reply = await askAIByGraph(input, userInfo, userId, null, null, { disableStream: true });
      const out = String(reply || 'No reply is available right now.');

      const chunks = out.match(/[\s\S]{1,3500}/g) || [out];
      for (const c of chunks) {
        await bot.sendMessage(chatId, c);
      }
    } catch (e) {
      console.error('[TG] message error:', e.message);
      try {
        await bot.sendMessage(msg.chat.id, 'An error occurred while handling this message. Please try again later.');
      } catch (_) {}
    }
  });

  bot.on('polling_error', (e) => {
    console.error('[TG] polling_error:', e.message);
  });

  console.log('[TG] Telegram Bot started with polling');
  return bot;
}

module.exports = { startTgBot };