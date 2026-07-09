# 瑞希瑞幸命令

更新 2026-07-09 19:09 +08:00。

## 功能边界

- 只在消息等于 `瑞希瑞幸`，或以 `瑞希瑞幸` 加空格、逗号、冒号开头时触发；普通聊天里提到瑞幸、咖啡不会进入该功能。
- 群聊只处理菜单、推荐、门店商品预览和官方小程序引导；创建订单、支付二维码、查单、取消订单只在私聊处理。
- 官方 `my-coffee` skill 已安装到 `skills/my-coffee`，运行配置保留 `.mcp.json` 的 `my-coffee` streamable HTTP MCP 入口；生产链路通过 `src/features/luckin/mcpClient.js` 调用瑞幸 MCP。

## 命令

```text
瑞希瑞幸
瑞希瑞幸 菜单
瑞希瑞幸 推荐
瑞希瑞幸 预览 <位置> <商品>
私聊：瑞希瑞幸 继续 <会话码>
私聊：瑞希瑞幸 继续 <会话码> <个人Token>
私聊：瑞希瑞幸 查单 <订单号> <个人Token>
私聊：瑞希瑞幸 取消 <订单号> <个人Token>
瑞希瑞幸 取消
```

位置不做 IP 粗定位；用户提供城市、商圈、地址、门店名或经纬度。文本地址会优先走高德地理编码，缺少 `AMAP_KEY` 或定位失败时只追问更具体位置。

## Token 与隐私

- `LUCKIN_MCP_GLOBAL_TOKEN` 或兼容的 `LUCKIN_MCP_TOKEN` 只允许调用 `queryShopList`、`searchProductForMcp`、`queryProductDetailInfo`、`switchProduct`、`previewOrder`。
- 个人 Token 只在私聊当前命令中使用，不写入文件、日志或会话存储；群聊发现疑似 Token 时只提示撤回并改私聊。
- 下单前会用个人 Token 重新 `previewOrder`，价格高于群内预览时停止创建订单。
- 支付信息只展示 `payOrderQrCodeUrl`，不展示 `payOrderUrl`；未支付前不展示取餐码。

## 配置

```env
LUCKIN_MCP_ENDPOINT=https://gwmcp.lkcoffee.com/order/user/mcp
LUCKIN_MCP_GLOBAL_TOKEN=
LUCKIN_MCP_TOKEN=
LUCKIN_MCP_TIMEOUT_MS=12000
LUCKIN_LOCATION_TIMEOUT_MS=8000
LUCKIN_SESSION_TTL_MS=900000
LUCKIN_USER_RATE_LIMIT_WINDOW_MS=60000
LUCKIN_USER_RATE_LIMIT_MAX=12
LUCKIN_MINIAPP_CARD_PAYLOAD=
AMAP_KEY=
```

`LUCKIN_MINIAPP_CARD_PAYLOAD` 可配置为 NapCat/OneBot 可直接发送的小程序卡片消息；发送失败或未配置时仍返回文本引导。

## 验收

本轮验收命令均已通过：

```bash
node scripts/run-tests.js tests/luckinCommand.test.js tests/luckinMcpClient.test.js tests/luckinService.test.js tests/luckinMessageHandler.test.js tests/routerChineseKeywords.test.js tests/messageHandlerAdminCheckConcurrency.test.js tests/mcpLazyDiscovery.test.js
node -e "require('./core/messageHandler'); console.log('message handler load ok')"
node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8')); console.log('mcp json ok')"
git diff --check
```

小目标已完成：`瑞希瑞幸` 已作为独立命令入口接入，普通聊天和 direct chat planner 不受该命令影响。
