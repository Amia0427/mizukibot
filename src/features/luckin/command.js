const LUCKIN_COMMAND = '瑞希瑞幸';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripCqSegments(text = '', options = {}) {
  const botQQ = String(options.botQQ || '').trim();
  let output = String(text || '')
    .replace(/\[CQ:reply,.*?\]/g, '')
    .replace(/\[CQ:image,.*?\]/g, '')
    .replace(/\[CQ:json,.*?\]/g, '')
    .replace(/\[CQ:forward,.*?\]/g, '');
  if (botQQ) {
    output = output.replace(new RegExp(`\\[CQ:at,qq=${botQQ}\\]`, 'g'), '');
  }
  output = output.replace(/\[CQ:at,qq=[^\]]+\]/g, '');
  return normalizeText(output);
}

function splitCommandBody(text = '') {
  const clean = normalizeText(text);
  if (!clean.startsWith(LUCKIN_COMMAND)) return null;
  const tail = clean.slice(LUCKIN_COMMAND.length);
  if (tail && !/^[\s,，:：]/.test(tail)) return null;
  return normalizeText(tail.replace(/^[\s,，:：]+/, ''));
}

function resolveCommandKind(head = '') {
  const key = normalizeText(head).toLowerCase();
  if (!key || ['菜单', '帮助', 'help', 'menu'].includes(key)) return 'menu';
  if (['推荐', 'recommend'].includes(key)) return 'recommend';
  if (['预览', 'preview'].includes(key)) return 'preview';
  if (['继续', 'continue'].includes(key)) return 'continue';
  if (['取消', 'cancel'].includes(key)) return 'cancel';
  if (['查单', '订单', '取餐码', 'status', 'order'].includes(key)) return 'order_status';
  return 'unknown';
}

function parseLuckinCommand(rawText = '', options = {}) {
  const clean = stripCqSegments(rawText, options);
  const body = splitCommandBody(clean);
  if (body === null) return null;
  if (!body) return {
    trigger: LUCKIN_COMMAND,
    kind: 'menu',
    payload: '',
    cleanText: clean
  };

  const parts = body.split(' ');
  const kind = resolveCommandKind(parts[0]);
  const payload = kind === 'unknown' ? body : normalizeText(parts.slice(1).join(' '));
  return {
    trigger: LUCKIN_COMMAND,
    kind,
    payload,
    cleanText: clean
  };
}

function containsSensitiveToken(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i.test(value)) return true;
  if (/\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/.test(value)) return true;
  return /\b(?:luckin|lkcoffee|token)[-_A-Za-z0-9.]{16,}\b/i.test(value);
}

function buildLuckinMenuReply() {
  return [
    '瑞希瑞幸可以这样用：',
    '1. 瑞希瑞幸 菜单',
    '2. 瑞希瑞幸 推荐',
    '3. 瑞希瑞幸 预览 <位置> <商品>',
    '4. 私聊：瑞希瑞幸 查单 <订单号> <个人Token>',
    '5. 私聊：瑞希瑞幸 取消 <订单号> <个人Token>',
    '',
    '群里只做菜单、推荐和价格预览；个人 Token、创建订单和支付二维码只在私聊里处理。'
  ].join('\n');
}

function buildGroupTokenWarningReply() {
  return [
    '别把瑞幸 Token 发在群里。',
    '请先撤回这条消息，再私聊我继续；个人 Token 只会临时用于本次点单，不会保存。'
  ].join('\n');
}

function buildUnknownCommandReply() {
  return [
    '这个瑞希瑞幸命令我没认出来。',
    '可用：瑞希瑞幸 菜单 / 推荐 / 预览 <位置> <商品> / 私聊查单或取消'
  ].join('\n');
}

module.exports = {
  LUCKIN_COMMAND,
  buildGroupTokenWarningReply,
  buildLuckinMenuReply,
  buildUnknownCommandReply,
  containsSensitiveToken,
  parseLuckinCommand,
  stripCqSegments
};
