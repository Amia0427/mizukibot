const config = require('../../../config');
const { getUserProfile } = require('../../../utils/memory');
const { createLuckinLocationResolver } = require('./location');
const { createLuckinMcpClient } = require('./mcpClient');
const { createLuckinSessionStore } = require('./sessionStore');
const {
  buildGroupTokenWarningReply,
  buildLuckinMenuReply,
  buildUnknownCommandReply,
  containsSensitiveToken,
  parseLuckinCommand
} = require('./command');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(text = '') {
  try {
    const parsed = JSON.parse(String(text || '').trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function resolveGlobalToken(runtimeConfig = config) {
  return normalizeText(runtimeConfig.LUCKIN_MCP_GLOBAL_TOKEN || runtimeConfig.LUCKIN_MCP_TOKEN || process.env.LUCKIN_MCP_GLOBAL_TOKEN || process.env.LUCKIN_MCP_TOKEN);
}

function splitPreviewPayload(payload = '') {
  const parts = normalizeText(payload).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return {
    locationText: parts.slice(0, -1).join(' '),
    productQuery: parts[parts.length - 1]
  };
}

function pickFirstArray(value = null) {
  if (Array.isArray(value)) return value[0] || null;
  if (Array.isArray(value?.data)) return value.data[0] || null;
  if (Array.isArray(value?.list)) return value.list[0] || null;
  if (Array.isArray(value?.rows)) return value.rows[0] || null;
  if (Array.isArray(value?.shopList)) return value.shopList[0] || null;
  if (Array.isArray(value?.productList)) return value.productList[0] || null;
  if (Array.isArray(value?.products)) return value.products[0] || null;
  return value && typeof value === 'object' ? value : null;
}

function firstTextField(source = {}, fields = []) {
  for (const field of fields) {
    const value = normalizeText(source?.[field]);
    if (value) return value;
  }
  return '';
}

function firstNumberField(source = {}, fields = []) {
  for (const field of fields) {
    const value = Number(source?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `¥${number.toFixed(2)}`;
}

function normalizeMcpToken(value = '') {
  return normalizeText(value).replace(/^Bearer\s+/i, '');
}

function splitOrderPayload(payload = '') {
  const parts = normalizeText(payload).split(' ').filter(Boolean);
  if (!parts.length) return null;
  return {
    orderId: parts[0],
    personalToken: normalizeText(parts.slice(1).join(' '))
  };
}

function assertPersonalTokenLooksUsable(personalToken = '') {
  const token = normalizeText(personalToken);
  return containsSensitiveToken(token) || token.length >= 16;
}

function getPreviewPayAmount(preview = {}) {
  return firstNumberField(preview, ['discountPrice', 'payPrice', 'totalPrice', 'totalInitialPrice']);
}

function buildMiniAppGuide(runtimeConfig = {}) {
  const payload = normalizeText(runtimeConfig.LUCKIN_MINIAPP_CARD_PAYLOAD);
  return {
    cardPayload: payload,
    fallbackText: '也可以直接打开瑞幸官方小程序自行点单。'
  };
}

function buildOrderTokenPrompt(kind = '查单') {
  const command = kind === '取消' ? '取消' : '查单';
  return `请在私聊回复：瑞希瑞幸 ${command} <订单号> <你的个人Token>`;
}

function buildOrderStatusReply(order = {}) {
  const status = firstTextField(order, ['orderStatusDesc', 'statusDesc', 'orderStatus', 'status']) || '已查询';
  const paid = !/(未支付|待支付|取消|关闭)/.test(status);
  const pickupCode = paid ? firstTextField(order, ['pickupCode', 'takeMealCode', 'mealCode']) : '';
  const lines = [
    `订单号：${firstTextField(order, ['orderId', 'orderNo']) || '已查询'}`,
    `状态：${status}`,
    firstTextField(order, ['shopName', 'deptName']) ? `门店：${firstTextField(order, ['shopName', 'deptName'])}` : '',
    firstTextField(order, ['productName', 'productTitle', 'name']) ? `商品：${firstTextField(order, ['productName', 'productTitle', 'name'])}` : '',
    firstNumberField(order, ['discountPrice', 'payPrice', 'totalPrice']) ? `支付金额：${formatMoney(firstNumberField(order, ['discountPrice', 'payPrice', 'totalPrice']))}` : '',
    pickupCode ? `取餐码：${pickupCode}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function buildCancelOrderReply(result = {}, orderId = '') {
  return [
    `订单号：${firstTextField(result, ['orderId', 'orderNo']) || orderId}`,
    firstTextField(result, ['result', 'message', 'statusDesc']) || '取消请求已提交，请以瑞幸官方订单状态为准。'
  ].filter(Boolean).join('\n');
}

function createLuckinRateLimiter(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs || 60 * 1000) || 60 * 1000);
  const max = Math.max(1, Number(options.max || 12) || 12);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const hits = new Map();

  function allow(userId = '') {
    const key = normalizeText(userId) || 'anonymous';
    const current = now();
    const recent = (hits.get(key) || []).filter((time) => current - time < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(current);
    hits.set(key, recent);
    return true;
  }

  return { allow };
}

function buildPreferenceSummary(userId = '') {
  const profile = getUserProfile(userId) || {};
  const candidates = [
    ...(Array.isArray(profile.likes) ? profile.likes : []),
    ...(Array.isArray(profile.dislikes) ? profile.dislikes.map((item) => `不喜欢${item}`) : []),
    ...(Array.isArray(profile.hobbies) ? profile.hobbies : [])
  ].map((item) => normalizeText(item)).filter((item) => /(咖啡|拿铁|美式|茶|奶|甜|冰|热|椰|橙|柠檬|果)/i.test(item));
  return Array.from(new Set(candidates)).slice(0, 5).join('；');
}

function buildRecommendationReply(userId = '') {
  const preference = buildPreferenceSummary(userId);
  const lines = ['可以，先给你一个不读取原始聊天的轻量推荐：'];
  if (preference) lines.push(`本地口味线索：${preference}`);
  lines.push('偏奶咖：生椰拿铁 / 厚乳拿铁');
  lines.push('偏清爽：橙C美式 / 柠C美式');
  lines.push('偏低负担：美式 / 不另外加糖的拿铁');
  lines.push('');
  lines.push('要查门店价格：瑞希瑞幸 预览 <位置> <商品>');
  return lines.join('\n');
}

function buildPreviewMissingReply() {
  return [
    '预览需要位置和商品。',
    '例：瑞希瑞幸 预览 上海张江 生椰拿铁'
  ].join('\n');
}

function buildGlobalTokenMissingReply() {
  return '瑞幸全局查询 Token 还没配置，先在环境变量里配置 LUCKIN_MCP_GLOBAL_TOKEN 或 LUCKIN_MCP_TOKEN。';
}

function buildPersonalTokenPrompt(session = {}) {
  return [
    '安全提示：继续创建订单前，请确认：',
    '1. 订单会使用你自己的瑞幸账号 Token 创建。',
    '2. Token 只在本次私聊流程临时使用，不保存、不写日志。',
    '3. 支付二维码只发在私聊里，未支付前不会展示取餐码。',
    '',
    `确认继续请回复：瑞希瑞幸 继续 ${session.code} <你的个人Token>`
  ].join('\n');
}

function buildPreviewReply({ shop = {}, product = {}, preview = {}, session = null } = {}) {
  const shopName = firstTextField(shop, ['deptName', 'name', 'shopName']) || '瑞幸门店';
  const address = firstTextField(shop, ['address', 'deptAddress', 'shopAddress']);
  const productName = firstTextField(product, ['productName', 'name', 'title']) || '所选商品';
  const estimate = firstNumberField(product, ['estimatePrice', 'price', 'salePrice']);
  const previewPrice = firstNumberField(preview, ['discountPrice', 'payPrice', 'totalPrice', 'totalInitialPrice']);
  const lines = [
    `门店：${shopName}`,
    address ? `地址：${address}` : '',
    `商品：${productName}`,
    estimate ? `预估价：${formatMoney(estimate)}` : '',
    previewPrice ? `预览应付：${formatMoney(previewPrice)}` : '',
    ''
  ].filter(Boolean);
  if (session?.code) {
    lines.push(`要创建订单和拿支付二维码，请私聊我：瑞希瑞幸 继续 ${session.code}`);
  } else {
    lines.push('要创建订单和拿支付二维码，请在私聊继续。');
  }
  lines.push('也可以直接打开瑞幸官方小程序自行点单。');
  return lines.join('\n');
}

function createLuckinCommandService(options = {}) {
  const runtimeConfig = options.config || config;
  const client = options.mcpClient || createLuckinMcpClient({
    endpoint: runtimeConfig.LUCKIN_MCP_ENDPOINT,
    timeoutMs: runtimeConfig.LUCKIN_MCP_TIMEOUT_MS
  });
  const locationResolver = options.locationResolver || createLuckinLocationResolver({
    amapKey: runtimeConfig.AMAP_KEY,
    timeoutMs: runtimeConfig.LUCKIN_LOCATION_TIMEOUT_MS
  });
  const sessionStore = options.sessionStore || createLuckinSessionStore({
    ttlMs: runtimeConfig.LUCKIN_SESSION_TTL_MS
  });
  const rateLimiter = options.rateLimiter || createLuckinRateLimiter({
    windowMs: runtimeConfig.LUCKIN_USER_RATE_LIMIT_WINDOW_MS,
    max: runtimeConfig.LUCKIN_USER_RATE_LIMIT_MAX
  });
  const sendReply = typeof options.sendReply === 'function' ? options.sendReply : async () => false;
  const sendMiniAppCard = typeof options.sendMiniAppCard === 'function' ? options.sendMiniAppCard : async () => false;

  async function reply(context = {}, replyText = '') {
    return sendReply({
      chatType: context.chatType,
      groupId: context.groupId,
      userId: context.senderId,
      senderId: context.senderId,
      replyText,
      atSender: context.chatType === 'group',
      retries: 1,
      waitMs: 300,
      source: 'luckin_command',
      routePolicyKey: 'act/luckin-command',
      triggerReason: 'luckin_command',
      topRouteType: 'direct_chat'
    });
  }

  async function maybeSendMiniAppCard(context = {}) {
    const guide = buildMiniAppGuide(runtimeConfig);
    if (!guide.cardPayload) return false;
    try {
      return await sendMiniAppCard({
        chatType: context.chatType,
        groupId: context.groupId,
        userId: context.senderId,
        cardPayload: guide.cardPayload,
        source: 'luckin_command',
        routePolicyKey: 'act/luckin-command',
        triggerReason: 'luckin_miniapp_card'
      });
    } catch (_) {
      return false;
    }
  }

  async function previewOrder(command, context) {
    const token = resolveGlobalToken(runtimeConfig);
    if (!token) return reply(context, buildGlobalTokenMissingReply());
    const parsedPayload = splitPreviewPayload(command.payload);
    if (!parsedPayload) return reply(context, buildPreviewMissingReply());

    const location = await locationResolver.resolveLocation(parsedPayload.locationText);
    if (!location?.ok) {
      return reply(context, '没定位到这个位置。请换成更具体的城市、商圈、地标或直接发经纬度。');
    }

    const shopResult = await client.callTool({
      token,
      credentialScope: 'global',
      toolName: 'queryShopList',
      arguments: {
        longitude: location.longitude,
        latitude: location.latitude,
        deptName: parsedPayload.locationText
      }
    });
    const shopPayload = safeJsonParse(shopResult.text) || {};
    const shop = pickFirstArray(shopPayload);
    if (!shop) return reply(context, '附近没有查到可用瑞幸门店，换个位置再试试。');
    const deptId = firstNumberField(shop, ['deptId', 'id']);
    if (!deptId) return reply(context, '门店结果缺少 deptId，暂时不能继续预览。');

    const productResult = await client.callTool({
      token,
      credentialScope: 'global',
      toolName: 'searchProductForMcp',
      arguments: {
        deptId,
        query: parsedPayload.productQuery
      }
    });
    const productPayload = safeJsonParse(productResult.text) || {};
    const product = pickFirstArray(productPayload);
    const productId = firstNumberField(product, ['productId', 'id']);
    const skuCode = firstTextField(product, ['skuCode', 'sku']);
    if (!productId || !skuCode) return reply(context, '没匹配到可预览的商品 SKU，换个更准确的商品名试试。');

    const productList = [{ amount: 1, productId, skuCode }];
    const previewResult = await client.callTool({
      token,
      credentialScope: 'global',
      toolName: 'previewOrder',
      arguments: {
        deptId,
        productList
      }
    });
    const preview = safeJsonParse(previewResult.text) || {};
    const session = sessionStore.create({
      userId: String(context.senderId || ''),
      groupId: String(context.groupId || ''),
      shop,
      product,
      productList,
      deptId,
      longitude: firstNumberField(shop, ['longitude', 'lng']) || location.longitude,
      latitude: firstNumberField(shop, ['latitude', 'lat']) || location.latitude,
      preview
    });
    await maybeSendMiniAppCard(context);
    return reply(context, buildPreviewReply({ shop, product, preview, session }));
  }

  async function continueOrder(command, context) {
    if (context.chatType !== 'private') return reply(context, '创建订单和支付二维码只在私聊里继续。');
    const parts = command.payload.split(' ').map((item) => normalizeText(item)).filter(Boolean);
    const code = normalizeText(parts[0]).toUpperCase();
    const personalToken = normalizeText(parts.slice(1).join(' '));
    const session = sessionStore.get(code, { userId: context.senderId });
    if (!session) return reply(context, '这个瑞希瑞幸会话不存在或已过期，请回群里重新预览一次。');
    if (!personalToken) return reply(context, buildPersonalTokenPrompt(session));
    if (!assertPersonalTokenLooksUsable(personalToken)) {
      return reply(context, '这个 Token 看起来不完整。请确认从瑞幸 MCP 开放平台复制的是完整 Token。');
    }

    const previewResult = await client.callTool({
      token: normalizeMcpToken(personalToken),
      credentialScope: 'personal',
      toolName: 'previewOrder',
      arguments: {
        deptId: session.deptId,
        productList: session.productList
      }
    });
    const personalPreview = safeJsonParse(previewResult.text) || {};
    const originalPayAmount = getPreviewPayAmount(session.preview);
    const personalPayAmount = getPreviewPayAmount(personalPreview);
    if (originalPayAmount && personalPayAmount && personalPayAmount > originalPayAmount) {
      return reply(context, `个人账号预览价格从 ${formatMoney(originalPayAmount)} 变为 ${formatMoney(personalPayAmount)}，我先不创建订单。请重新预览或去官方小程序确认。`);
    }
    const createArgs = {
      deptId: session.deptId,
      productList: session.productList,
      longitude: session.longitude,
      latitude: session.latitude
    };
    if (Array.isArray(personalPreview.couponCodeList) && personalPreview.couponCodeList.length > 0) {
      createArgs.couponCodeList = personalPreview.couponCodeList;
    }
    const orderResult = await client.callTool({
      token: normalizeMcpToken(personalToken),
      credentialScope: 'personal',
      toolName: 'createOrder',
      arguments: createArgs
    });
    const order = safeJsonParse(orderResult.text) || {};
    sessionStore.remove(code);
    const qrUrl = firstTextField(order, ['payOrderQrCodeUrl']);
    const initialPrice = firstNumberField(personalPreview, ['totalInitialPrice', 'totalPrice']);
    const discount = firstNumberField(personalPreview, ['privilegeMoney', 'discountMoney']);
    const payAmount = firstNumberField(order, ['discountPrice', 'payPrice']) || firstNumberField(personalPreview, ['discountPrice', 'payPrice']);
    const lines = [
      `订单号：${firstTextField(order, ['orderId', 'orderNo']) || '已创建'}`,
      `门店：${firstTextField(session.shop, ['deptName', 'name', 'shopName']) || '瑞幸门店'}`,
      `商品：${firstTextField(session.product, ['productName', 'name', 'title']) || '所选商品'}`,
      initialPrice ? `订单价格：${formatMoney(initialPrice)}` : '',
      discount ? `优惠减免：${formatMoney(discount)}` : '',
      payAmount ? `应付金额：${formatMoney(payAmount)}` : '',
      qrUrl ? `支付二维码：${qrUrl}` : '支付二维码暂时没有返回，请打开瑞幸官方小程序查看订单。',
      '支付完成后告诉我一声，我可以马上帮你查询订单状态和取餐码。',
      '1. 已支付，帮我查取餐码',
      '2. 还没支付，稍后再查'
    ].filter(Boolean);
    return reply(context, lines.join('\n'));
  }

  async function queryOrder(command, context) {
    if (context.chatType !== 'private') return reply(context, '订单查询只在私聊里处理。');
    const parsed = splitOrderPayload(command.payload);
    if (!parsed?.orderId || !parsed.personalToken) return reply(context, buildOrderTokenPrompt('查单'));
    if (!assertPersonalTokenLooksUsable(parsed.personalToken)) return reply(context, '这个 Token 看起来不完整。请确认后再发一次。');

    const orderResult = await client.callTool({
      token: normalizeMcpToken(parsed.personalToken),
      credentialScope: 'personal',
      toolName: 'queryOrderDetailInfo',
      arguments: {
        orderId: parsed.orderId
      }
    });
    return reply(context, buildOrderStatusReply(safeJsonParse(orderResult.text) || { orderId: parsed.orderId }));
  }

  async function cancelOrder(command, context) {
    if (!command.payload) {
      sessionStore.clearUser(context.senderId);
      return reply(context, '已取消当前瑞希瑞幸临时会话。');
    }
    if (context.chatType !== 'private') return reply(context, '取消订单只在私聊里处理。');
    const parsed = splitOrderPayload(command.payload);
    if (!parsed?.orderId || !parsed.personalToken) return reply(context, buildOrderTokenPrompt('取消'));
    if (!assertPersonalTokenLooksUsable(parsed.personalToken)) return reply(context, '这个 Token 看起来不完整。请确认后再发一次。');

    const result = await client.callTool({
      token: normalizeMcpToken(parsed.personalToken),
      credentialScope: 'personal',
      toolName: 'cancelOrder',
      arguments: {
        orderId: parsed.orderId
      }
    });
    return reply(context, buildCancelOrderReply(safeJsonParse(result.text) || {}, parsed.orderId));
  }

  async function handleCommand(command, context) {
    if (context.chatType === 'group' && containsSensitiveToken(command.cleanText)) {
      return reply(context, buildGroupTokenWarningReply());
    }
    if (!rateLimiter.allow(context.senderId)) {
      return reply(context, '瑞希瑞幸请求有点密集，请稍等一下再试。');
    }
    if (command.kind === 'menu') return reply(context, buildLuckinMenuReply());
    if (command.kind === 'recommend') return reply(context, buildRecommendationReply(context.senderId));
    if (command.kind === 'preview') return previewOrder(command, context);
    if (command.kind === 'continue') return continueOrder(command, context);
    if (command.kind === 'order_status') return queryOrder(command, context);
    if (command.kind === 'cancel') return cancelOrder(command, context);
    return reply(context, buildUnknownCommandReply());
  }

  async function handleIncomingMessage(msg = {}, context = {}) {
    const botQQ = context.botQQ || runtimeConfig.BOT_QQ || msg.self_id;
    const command = parseLuckinCommand(msg.raw_message || '', { botQQ });
    if (!command) return false;
    await handleCommand(command, {
      chatType: String(context.chatType || msg.message_type || '').trim().toLowerCase() === 'private' ? 'private' : 'group',
      groupId: String(context.groupId || msg.group_id || '').trim(),
      senderId: String(context.senderId || msg.user_id || '').trim()
    });
    return true;
  }

  return {
    handleIncomingMessage,
    sessionStore
  };
}

module.exports = {
  createLuckinCommandService
};
