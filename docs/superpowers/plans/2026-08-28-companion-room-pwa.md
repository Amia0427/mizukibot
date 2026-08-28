# 陪伴房间 PWA 实施记录

更新时间：2026-08-28 11:43 +08:00。

## 目标

给现有 QQ 私聊共处房间增加一个可安装、适合手机使用的 Web 操作面，同时保持房间状态、计时、共同回忆和模型收尾只有一套真值。

## 实施范围

1. 在主进程创建 Web 服务时注入现有 `companionRoomRuntime`。
2. 运行时公开当前用户快照和确定性动作入口，Web 与 QQ 命令复用同一 `handleParsedAction`。
3. 新增 `/companion-room` 页面、manifest、Service Worker 和本地裁切角色资产。
4. 新增状态与动作 API，固定绑定 `COMPANION_ROOM_WEB_USER_ID`，不允许客户端指定其他用户。
5. 继续使用现有 Web session、viewer/admin 角色、严格同源校验和审计中间件。
6. 覆盖开始、暂停、继续、结束、内容进度、陪伴密度、共同回忆、离线应用壳和最近状态。

## 非目标

- 不新增 React、Vue、Vite 或独立前端构建链。
- 不复制房间状态文件、计时器或共同回忆逻辑。
- 不从网页向 QQ 发送每次操作的确认消息。
- 不允许从 URL、查询参数或请求体切换绑定用户。
- 不新增媒体下载、同步播放或内容抓取。

## 验收证据

- 定向自动测试：`companionRoomRuntime.test.js`、`companionRoomWebRoute.test.js`、`webAuthSecurity.test.js`、`webSessionSecurity.test.js`、`webSecurityHeaders.test.js` 已通过。
- 浏览器验收、完整静态门禁和提交号将在验收完成后追加。
