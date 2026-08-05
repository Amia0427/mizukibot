const { runWithDeliveryContext } = require('./deliveryContext');
const { isQqOnlyCommand, isQqPlatform } = require('./accessPolicy');

function createPlatformMessageProcessor(options = {}) {
  const identityCommandHandler = options.identityCommandHandler;
  const commandHandlers = Array.isArray(options.commandHandlers) ? options.commandHandlers : [];
  const sendWithRetry = options.sendWithRetry;
  if (!identityCommandHandler || typeof sendWithRetry !== 'function') {
    throw new Error('identity command handler and sendWithRetry are required');
  }

  async function sendReply(msg, text) {
    const privateChat = String(msg?.message_type || '').trim().toLowerCase() === 'private';
    return sendWithRetry({
      action: privateChat ? 'send_private_msg' : 'send_group_msg',
      params: privateChat
        ? { user_id: String(msg?.user_id || '').trim(), message: text }
        : { group_id: String(msg?.group_id || '').trim(), message: text }
    }, 1, 300);
  }

  async function handleCommand(msg) {
    const canonical = msg?.canonical_message;
    if (canonical) {
      if (!isQqPlatform(canonical.platform) && isQqOnlyCommand(canonical.text)) {
        await sendReply(msg, '这个命令仅支持 QQ 平台。');
        return true;
      }
      const identityResult = identityCommandHandler.handle({
        text: canonical.text,
        platform: canonical.platform,
        chatType: canonical.conversation.chatType,
        externalUserId: canonical.actor.externalId,
        displayName: canonical.actor.displayName,
        deliveryTarget: canonical.deliveryTarget
      });
      if (identityResult.handled) {
        await sendReply(msg, identityResult.replyText);
        return true;
      }
    }

    for (const handler of commandHandlers) {
      if (!handler?.shouldHandle?.(msg?.raw_message)) continue;
      if (await handler.handle(msg)) return true;
    }
    return false;
  }

  function run(msg, task) {
    if (typeof task !== 'function') throw new Error('message task is required');
    return runWithDeliveryContext(msg?.delivery_context || null, async () => {
      if (await handleCommand(msg)) return true;
      await task(msg);
      return true;
    });
  }

  return { handleCommand, run };
}

module.exports = { createPlatformMessageProcessor };
