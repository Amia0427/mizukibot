const { HOLIDAY_CATALOG, getHolidayName } = require('./calendar');

const COMMAND_PREFIX = /^\/邮件问候(?:\s|$)/u;
const PRIVATE_ONLY_REPLY = '邮件问候订阅仅支持 QQ 私聊管理。';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseEmailGreetingCommand(rawText = '') {
  const text = normalizeText(rawText);
  if (!COMMAND_PREFIX.test(text)) return null;
  const rest = text.replace(/^\/邮件问候\s*/u, '');
  if (!rest) return { action: 'help' };

  let match = rest.match(/^订阅\s+(.+)$/u);
  if (match) return { action: 'subscribe', email: normalizeText(match[1]) };
  match = rest.match(/^验证\s+(\d{6})$/u);
  if (match) return { action: 'verify', code: match[1] };
  if (rest === '状态') return { action: 'status' };
  if (rest === '退订') return { action: 'unsubscribe' };

  match = rest.match(/^节日\s+(开启|关闭)\s+(.+)$/u);
  if (match) {
    return { action: 'holiday', enabled: match[1] === '开启', holiday: normalizeText(match[2]) };
  }

  match = rest.match(/^纪念日\s+添加\s+(.+?)\s+(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/u);
  if (match) return { action: 'anniversary_add', name: normalizeText(match[1]), date: match[2] };
  match = rest.match(/^纪念日\s+删除\s+(.+)$/u);
  if (match) return { action: 'anniversary_remove', name: normalizeText(match[1]) };
  if (rest === '纪念日 列表') return { action: 'anniversary_list' };
  return { action: 'help' };
}

function formatAnniversaryList(items = []) {
  if (!items.length) return '尚未添加个人纪念日。';
  return [
    '个人纪念日：',
    ...items.map((item, index) => `${index + 1}. ${item.name}（${item.annual ? `每年 ${item.date}` : item.date}）`)
  ].join('\n');
}

function formatStatus(result = {}) {
  if (result.status === 'not_subscribed') return '尚未订阅邮件问候。';
  const statusLabels = { active: '接收中', pending: '待邮箱验证', inactive: '已退订' };
  const disabled = result.disabledHolidayIds.map(getHolidayName).filter(Boolean);
  return [
    `邮件问候：${statusLabels[result.status] || result.status}`,
    `邮箱：${result.email || '未设置'}`,
    `节日：${disabled.length ? `已关闭 ${disabled.join('、')}` : '九个精选节日全部开启'}`,
    `纪念日：${result.anniversaries.length} 个`
  ].join('\n');
}

function formatResult(result = {}) {
  if (result.status === 'invalid_email') return '邮箱格式不正确，请重新输入。';
  if (result.status === 'verification_sent') return `验证码已发送至 ${result.email}，请在 15 分钟内完成验证。`;
  if (result.status === 'not_pending') return '当前没有待验证的邮箱订阅。';
  if (result.status === 'already_active') return '该邮箱已经完成验证，邮件问候正在接收中。';
  if (result.status === 'expired') return '验证码已过期，请重新执行订阅指令。';
  if (result.status === 'invalid_code') return '验证码不正确。';
  if (result.status === 'verified') return '邮箱验证成功，九个精选节日问候已默认开启。';
  if (result.status === 'unsubscribed') return '已退订邮件问候。';
  if (result.status === 'not_subscribed') return '尚未订阅邮件问候。';
  if (result.status === 'unknown_holiday') {
    return `未知节日，可选：${HOLIDAY_CATALOG.map((item) => item.name).join('、')}`;
  }
  if (result.status === 'not_active') return '请先完成邮箱验证。';
  if (result.status === 'holiday_enabled') return `已开启 ${result.holiday.name} 问候。`;
  if (result.status === 'holiday_disabled') return `已关闭 ${result.holiday.name} 问候。`;
  if (result.status === 'invalid_anniversary') return '纪念日格式不正确，日期请使用 MM-DD 或 YYYY-MM-DD。';
  if (result.status === 'duplicate_anniversary') return '该纪念日已经存在。';
  if (result.status === 'anniversary_added') return `已添加纪念日：${result.anniversary.name}（${result.anniversary.annual ? `每年 ${result.anniversary.date}` : result.anniversary.date}）。`;
  if (result.status === 'anniversary_not_found') return '没有找到该名称的纪念日。';
  if (result.status === 'anniversary_removed') return `已删除纪念日：${result.name}。`;
  if (result.status === 'anniversary_listed') return formatAnniversaryList(result.anniversaries);
  return '邮件问候操作未完成。';
}

function helpText() {
  return [
    '邮件问候指令：',
    '/邮件问候 订阅 <邮箱>',
    '/邮件问候 验证 <6位验证码>',
    '/邮件问候 状态、退订',
    '/邮件问候 节日 开启|关闭 <节日>',
    '/邮件问候 纪念日 添加 <名称> <MM-DD|YYYY-MM-DD>',
    '/邮件问候 纪念日 删除 <名称>、纪念日 列表'
  ].join('\n');
}

function createEmailGreetingCommandHandler(options = {}) {
  const getRuntime = options.getRuntime;
  const sendReply = options.sendReply;

  async function reply(msg, text) {
    if (typeof sendReply === 'function') await sendReply(msg, text);
  }

  async function handle(msg = {}) {
    const command = parseEmailGreetingCommand(msg.raw_message);
    if (!command) return false;
    const platform = String(msg.canonical_message?.platform || 'qq').trim().toLowerCase();
    const privateChat = String(msg.message_type || '').trim().toLowerCase() === 'private';
    if (platform !== 'qq' || !privateChat) {
      await reply(msg, PRIVATE_ONLY_REPLY);
      return true;
    }
    if (command.action === 'help') {
      await reply(msg, helpText());
      return true;
    }

    const runtime = getRuntime?.();
    if (!runtime?.service) {
      await reply(msg, '邮件问候功能当前不可用。');
      return true;
    }
    if (!runtime.enabled && !['status', 'unsubscribe'].includes(command.action)) {
      await reply(msg, '邮件问候功能当前未启用或 SMTP 配置不完整。');
      return true;
    }

    const userId = String(msg.user_id || '').trim();
    try {
      let result;
      if (command.action === 'subscribe') {
        result = await runtime.service.requestSubscription(
          userId,
          command.email,
          msg.sender?.card || msg.sender?.nickname || userId
        );
      } else if (command.action === 'verify') result = runtime.service.verify(userId, command.code);
      else if (command.action === 'status') {
        await reply(msg, formatStatus(runtime.service.getStatus(userId)));
        return true;
      } else if (command.action === 'unsubscribe') result = runtime.service.unsubscribe(userId);
      else if (command.action === 'holiday') result = runtime.service.setHoliday(userId, command.holiday, command.enabled);
      else if (command.action === 'anniversary_add') {
        result = runtime.service.addAnniversary(userId, command.name, command.date);
      } else if (command.action === 'anniversary_remove') {
        result = runtime.service.removeAnniversary(userId, command.name);
      } else if (command.action === 'anniversary_list') result = runtime.service.listAnniversaries(userId);
      await reply(msg, formatResult(result));
    } catch (error) {
      console.error('[email-greeting] command failed:', error?.message || error);
      await reply(msg, '邮件问候操作失败，请稍后重试。');
    }
    return true;
  }

  return {
    handle,
    shouldHandle: (rawText) => COMMAND_PREFIX.test(normalizeText(rawText))
  };
}

module.exports = {
  PRIVATE_ONLY_REPLY,
  createEmailGreetingCommandHandler,
  formatAnniversaryList,
  formatResult,
  formatStatus,
  helpText,
  parseEmailGreetingCommand
};
