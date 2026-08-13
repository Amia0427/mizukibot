const GROUP_PRIVATE_ONLY_REPLY = '天气预警订阅只能在私聊中管理。';
const COMMAND_PATTERN = /^\/天气预警(?:\s+(订阅|取消|列表|暂停|恢复)(?:\s+(.+?))?)?\s*$/u;
const NATURAL_MANAGEMENT_PATTERN = /(?:订阅|退订|取消|管理|暂停|恢复|查看|列出|关注|提醒我|通知我).{0,12}天气预警|天气预警.{0,12}(?:订阅|退订|取消|管理|暂停|恢复|列表|关注)/u;

const ACTIONS = Object.freeze({
  '订阅': 'subscribe',
  '取消': 'unsubscribe',
  '列表': 'list',
  '暂停': 'pause',
  '恢复': 'resume'
});

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseWeatherAlertCommand(rawText = '') {
  const match = normalizeText(rawText).match(COMMAND_PATTERN);
  if (!match) return null;
  return {
    action: ACTIONS[match[1]] || 'help',
    location: normalizeText(match[2])
  };
}

function isWeatherAlertManagementText(rawText = '') {
  return NATURAL_MANAGEMENT_PATTERN.test(normalizeText(rawText));
}

function formatSubscriptionList(result = {}) {
  const subscriptions = Array.isArray(result.subscriptions) ? result.subscriptions : [];
  if (subscriptions.length === 0) {
    return result.paused ? '天气预警通知已暂停，尚未订阅任何地区。' : '尚未订阅任何天气预警地区。';
  }
  return [
    `天气预警订阅（${result.paused ? '已暂停' : '接收中'}）：`,
    ...subscriptions.map((item, index) => `${index + 1}. ${item.displayName}（${item.locationId}）`)
  ].join('\n');
}

function formatSubscriptionResult(result = {}) {
  if (result.status === 'subscribed') return `已订阅 ${result.subscription.displayName} 的天气预警。`;
  if (result.status === 'duplicate') return `${result.subscription.displayName} 已在订阅列表中。`;
  if (result.status === 'unsubscribed') return `已取消 ${result.subscription.displayName} 的天气预警订阅。`;
  if (result.status === 'not_subscribed') return '没有找到该地区的已有订阅。';
  if (result.status === 'not_found') return '和风天气未找到该地区，请换用更完整的市、区或县名。';
  if (result.status === 'unsupported_region') return '天气预警目前仅支持中国地区。';
  if (result.status === 'limit_reached') return `每个用户最多订阅 ${result.limit || 5} 个地区，请先取消一个已有订阅。`;
  if (result.status === 'ambiguous') {
    return [
      '地名有歧义，请使用下面的完整地区名重试：',
      ...(Array.isArray(result.candidates) ? result.candidates : [])
        .slice(0, 8)
        .map((item) => `- ${item.displayName}（${item.locationId}）`)
    ].join('\n');
  }
  if (result.status === 'paused') return '已暂停天气预警通知。';
  if (result.status === 'resumed') return '已恢复天气预警通知。';
  if (result.status === 'listed') return formatSubscriptionList(result);
  return '天气预警订阅操作未完成。';
}

function createWeatherAlertCommandHandler(options = {}) {
  const getRuntime = options.getRuntime;
  const sendReply = options.sendReply;

  function shouldHandle(rawText) {
    return Boolean(parseWeatherAlertCommand(rawText)) || isWeatherAlertManagementText(rawText);
  }

  async function reply(msg, text) {
    if (typeof sendReply === 'function') await sendReply(msg, text);
  }

  async function handle(msg = {}) {
    const parsed = parseWeatherAlertCommand(msg.raw_message);
    const privateChat = normalizeText(msg.message_type).toLowerCase() === 'private';
    if (!privateChat) {
      await reply(msg, GROUP_PRIVATE_ONLY_REPLY);
      return true;
    }
    if (!parsed) return false;
    if (parsed.action === 'help') {
      await reply(msg, '用法：/天气预警 订阅 <市区县>、取消 <市区县>、列表、暂停、恢复');
      return true;
    }
    if (['subscribe', 'unsubscribe'].includes(parsed.action) && !parsed.location) {
      await reply(msg, `请提供要${parsed.action === 'subscribe' ? '订阅' : '取消'}的完整市、区或县名。`);
      return true;
    }
    const runtime = getRuntime?.();
    if (!runtime?.enabled || !runtime.service) {
      await reply(msg, '天气预警功能当前未启用。');
      return true;
    }
    try {
      const result = await runtime.service.execute(String(msg.user_id || '').trim(), parsed.action, parsed.location);
      await reply(msg, formatSubscriptionResult(result));
    } catch (error) {
      console.error('[weather-alert] command failed:', error?.message || error);
      await reply(msg, '天气预警订阅操作失败，请稍后重试。');
    }
    return true;
  }

  return { handle, shouldHandle };
}

module.exports = {
  GROUP_PRIVATE_ONLY_REPLY,
  createWeatherAlertCommandHandler,
  formatSubscriptionList,
  formatSubscriptionResult,
  isWeatherAlertManagementText,
  parseWeatherAlertCommand
};
