const assert = require('assert');

const { createLuckinCommandService } = require('../src/features/luckin/service');

function createMockClient(calls) {
  return {
    async callTool(input) {
      calls.push(input);
      if (input.toolName === 'queryShopList') {
        return {
          text: JSON.stringify({
            shopList: [{
              deptId: 101,
              deptName: '瑞幸上海张江店',
              address: '上海市浦东新区张江',
              longitude: 121.61,
              latitude: 31.20
            }]
          })
        };
      }
      if (input.toolName === 'searchProductForMcp') {
        return {
          text: JSON.stringify({
            productList: [{
              productId: 202,
              skuCode: 'SKU202',
              productName: '生椰拿铁',
              estimatePrice: 19
            }]
          })
        };
      }
      if (input.toolName === 'previewOrder') {
        return {
          text: JSON.stringify({
            totalInitialPrice: 29,
            privilegeMoney: 10,
            discountPrice: 19,
            couponCodeList: ['coupon-1']
          })
        };
      }
      if (input.toolName === 'createOrder') {
        return {
          text: JSON.stringify({
            orderId: 'ORDER123',
            discountPrice: 19,
            payOrderQrCodeUrl: 'https://pay.example.test/qr'
          })
        };
      }
      if (input.toolName === 'queryOrderDetailInfo') {
        return {
          text: JSON.stringify({
            orderId: input.arguments.orderId,
            orderStatusDesc: '已支付',
            pickupCode: 'A123',
            productName: '生椰拿铁',
            discountPrice: 19
          })
        };
      }
      if (input.toolName === 'cancelOrder') {
        return {
          text: JSON.stringify({
            orderId: input.arguments.orderId,
            result: '已取消'
          })
        };
      }
      throw new Error(`unexpected tool ${input.toolName}`);
    }
  };
}

function createService() {
  const replies = [];
  const calls = [];
  const miniAppCards = [];
  const service = createLuckinCommandService({
    config: {
      BOT_QQ: 'bot_test',
      LUCKIN_MCP_GLOBAL_TOKEN: 'global-token',
      LUCKIN_MCP_ENDPOINT: 'https://example.test/mcp',
      LUCKIN_MCP_TIMEOUT_MS: 1000,
      LUCKIN_SESSION_TTL_MS: 15 * 60 * 1000,
      LUCKIN_MINIAPP_CARD_PAYLOAD: '[CQ:json,data={"app":"luckin"}]'
    },
    mcpClient: createMockClient(calls),
    locationResolver: {
      async resolveLocation() {
        return {
          ok: true,
          longitude: 121.6,
          latitude: 31.2,
          label: '上海张江'
        };
      }
    },
    sendReply: async (reply) => {
      replies.push(reply);
      return true;
    },
    sendMiniAppCard: async (card) => {
      miniAppCards.push(card);
      return false;
    }
  });
  return { service, replies, calls, miniAppCards };
}

module.exports = (async () => {
  const tokenCase = createService();
  await tokenCase.service.handleIncomingMessage({
    message_type: 'group',
    group_id: 'group_1',
    user_id: 'user_1',
    raw_message: '瑞希瑞幸 Bearer secret_token_value_123456789'
  });
  assert.strictEqual(tokenCase.calls.length, 0);
  assert.ok(String(tokenCase.replies[0].replyText).includes('撤回'));

  const previewCase = createService();
  await previewCase.service.handleIncomingMessage({
    message_type: 'group',
    group_id: 'group_1',
    user_id: 'user_1',
    raw_message: '瑞希瑞幸 预览 上海张江 生椰拿铁'
  });
  assert.deepStrictEqual(previewCase.calls.map((item) => item.toolName), [
    'queryShopList',
    'searchProductForMcp',
    'previewOrder'
  ]);
  assert.ok(previewCase.calls.every((item) => item.credentialScope === 'global'));
  assert.strictEqual(previewCase.miniAppCards.length, 1);
  assert.ok(String(previewCase.replies[0].replyText).includes('私聊我：瑞希瑞幸 继续'));
  assert.ok(String(previewCase.replies[0].replyText).includes('打开瑞幸官方小程序'));
  assert.ok(!String(previewCase.replies[0].replyText).includes('global-token'));

  const code = String(previewCase.replies[0].replyText).match(/继续 ([A-F0-9]{8})/)?.[1];
  assert.ok(code);

  await previewCase.service.handleIncomingMessage({
    message_type: 'private',
    user_id: 'user_1',
    raw_message: `瑞希瑞幸 继续 ${code}`
  });
  assert.ok(String(previewCase.replies[1].replyText).includes('安全'));
  assert.ok(String(previewCase.replies[1].replyText).includes('临时'));

  await previewCase.service.handleIncomingMessage({
    message_type: 'private',
    user_id: 'user_1',
    raw_message: `瑞希瑞幸 继续 ${code} personal-token-value-123456789`
  });
  assert.deepStrictEqual(previewCase.calls.slice(3).map((item) => item.toolName), [
    'previewOrder',
    'createOrder'
  ]);
  assert.ok(previewCase.calls.slice(3).every((item) => item.credentialScope === 'personal'));
  assert.ok(String(previewCase.replies[2].replyText).includes('https://pay.example.test/qr'));
  assert.ok(!String(previewCase.replies[2].replyText).includes('personal-token-value'));

  await previewCase.service.handleIncomingMessage({
    message_type: 'private',
    user_id: 'user_1',
    raw_message: '瑞希瑞幸 查单 ORDER123 personal-token-value-123456789'
  });
  assert.deepStrictEqual(previewCase.calls.slice(5, 6).map((item) => item.toolName), ['queryOrderDetailInfo']);
  assert.ok(String(previewCase.replies[3].replyText).includes('A123'));

  await previewCase.service.handleIncomingMessage({
    message_type: 'private',
    user_id: 'user_1',
    raw_message: '瑞希瑞幸 取消 ORDER123 personal-token-value-123456789'
  });
  assert.deepStrictEqual(previewCase.calls.slice(6, 7).map((item) => item.toolName), ['cancelOrder']);
  assert.ok(String(previewCase.replies[4].replyText).includes('取消'));

  console.log('luckinService.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
