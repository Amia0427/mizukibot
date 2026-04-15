const { todayStrInTz } = require('../utils/time');
const { hasFreshGroupBinding } = require('../utils/memory');

function shouldSendScheduledGreeting(data, type, today, config) {
  if (!data || !hasFreshGroupBinding(data)) return false;
  if (config?.PROACTIVE_GREETING_FALLBACK_ENABLED === false) return false;

  const minPoints = Number(config?.SCHEDULED_GREETING_MIN_POINTS || 250);
  if (Number(data?.points || 0) <= minPoints) return false;

  if (type === 'morning' && data?.last_morning === today) return false;
  if (type === 'night' && data?.last_night === today) return false;
  return true;
}

function createProactiveGreetingFlow({
  config,
  favorites,
  askAIDispatch,
  normalizeUserFacingReply,
  sendGroupReply,
  maybeSendMemeFollowup,
  sendWithRetry,
  saveData,
  clearGroupBindingForUser
} = {}) {
  async function sendScheduledGreeting(type) {
    const today = todayStrInTz(config.TIMEZONE);

    for (const [userId, data] of Object.entries(favorites || {})) {
      if (!shouldSendScheduledGreeting(data, type, today, config)) continue;

      const prompt = type === 'morning'
        ? '早安。自然一点地和我打个招呼，像熟悉的朋友，简短即可。'
        : '晚安。自然一点地和我道个晚安，像熟悉的朋友，简短即可。';

      let reply = await askAIDispatch(prompt, data, userId, null, null, {
        disableTools: true,
        disableMemoryLearning: true
      });
      reply = normalizeUserFacingReply(reply, {
        policyKey: 'chat/default',
        routeDebugKey: 'direct_chat/text_chat/answer',
        topRouteType: 'direct_chat',
        allowTools: false,
        requestText: prompt
      });
      const sent = await sendGroupReply({
        groupId: data.group_id,
        senderId: userId,
        replyText: reply,
        atSender: true,
        retries: 1,
        waitMs: 500
      });

      if (!sent) {
        const cleared = clearGroupBindingForUser(userId, data.group_id);
        if (cleared) {
          console.warn('[group-binding] cleared stale scheduled greeting target after send failure', {
            userId,
            groupId: data.group_id,
            type
          });
        }
        continue;
      }

      await maybeSendMemeFollowup({
        surface: 'scheduled',
        groupId: data.group_id,
        senderId: userId,
        sendWithRetry,
        routePolicyKey: 'scheduled-greeting',
        topRouteType: 'chat',
        userText: prompt,
        replyText: reply,
        routeMeta: {
          responseIntent: 'answer'
        }
      });

      if (type === 'morning') data.last_morning = today;
      else data.last_night = today;

      saveData();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return {
    sendScheduledGreeting
  };
}

module.exports = {
  createProactiveGreetingFlow,
  shouldSendScheduledGreeting
};
