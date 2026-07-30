# QQ HTML/SVG 图片渲染与审查

更新时间：2026-07-30 21:02 +08:00

## 实现结论

- 模型工具为 `render_qq_visual`，只接受 `renderer`、`markup`、`width`、`max_height`。
- SVG 使用项目已有 `sharp` 转换为 PNG；HTML 调用本机 `napcat-plugin-puppeteer v1.5.0` 的 `/render` API。
- PNG 通过 OneBot `base64://` 图片段直接发送，不落盘、不使用图床，群聊和私聊均返回 `message_id`。
- `nonebot-plugin-htmlrender` 与 `koishi-plugin-puppeteer` 仅参考资源隔离和生命周期设计；未引入项目内 Puppeteer 或 `resvg-js`。

开源来源：

- [napcat-plugin-puppeteer](https://github.com/AQiaoYo/napcat-plugin-puppeteer)
- [nonebot-plugin-htmlrender](https://github.com/kexue-z/nonebot-plugin-htmlrender)
- [koishi-plugin-puppeteer](https://github.com/koishijs/koishi-plugin-puppeteer)

## 安全边界

- HTML/SVG 在渲染前拒绝脚本、事件属性、表单、iframe、`foreignObject`、嵌入图片、外部字体、协议 URL 和非本地 `url()`；模型不能提交 URL、文件路径或 selector。
- 发送前依次审查运行时保存的用户原始 prompt 和 markup 可见文本，词库由 `config/visual-render-sensitive-words.json` 独立配置，覆盖反动、政治、暴恐、色情、涉枪涉爆分类。
- 命中后不渲染、不发送，管理员不绕过；词库缺失、损坏、禁用或为空时失败关闭。
- 拦截日志只记录阶段、命中数量和分类，不记录 prompt、markup 或具体敏感词。
- 本期不包含 OCR、视觉模型审核和 SVG 路径绘字语义审核。

NapCat 插件的 `/render`、URL 与文件接口本身无认证，因此 WebUI 和 OneBot HTTP 服务均只监听 `127.0.0.1`，机器人只调用固定 `/render` 地址。NapCat 4.18.6 会拒绝不在编译期 allowlist 的第三方插件，本机仅将已校验版本的 `napcat-plugin-puppeteer` 加入 allowlist，未关闭 NapCat 的敏感源码扫描，也未放开其他插件；NapCat 更新可能覆盖该本机改动，升级后必须重新核对。

## 部署配置

项目 `.env`：

```dotenv
VISUAL_RENDER_ENABLED=true
VISUAL_RENDER_HTML_API_URL=http://127.0.0.1:6099/plugin/napcat-plugin-puppeteer/api/render
VISUAL_RENDER_TIMEOUT_MS=10000
```

NapCat：

- `D:\napcat\config\webui.json`：`host=127.0.0.1`。
- `D:\napcat\config\plugins.json`：仅为本插件增加启用项。
- 插件包 SHA-256：`EED1E11D1E120BFFFC811A14F77354396340F886E18E6F5AE7D75E6A11618630`。
- `browser.maxPages=2`。
- Chrome for Testing：`131.0.6778.204`，运行路径为 `C:\Users\Administrator\AppData\Local\puppeteer\chrome\chrome-win64\chrome.exe`。

插件下载 Chrome 后因系统 `Microsoft.PowerShell.Archive` 无法加载而解压失败；保留已下载 ZIP，通过 `tar.exe` 验证并解压到插件约定目录，再由认证配置接口写入执行路径并调用浏览器重启。Chrome ZIP SHA-256 为 `97E3ECD4BEFB54644C3DE006510F39157781F43CCDB84CC92D028DBD3851BDCD`。

## 验收记录

功能提交：`055ad9f feat: add moderated QQ visual rendering`

### 自动测试

```text
node scripts/run-tests.js tests/visualRenderModeration.test.js tests/visualRenderPolicyRouting.test.js tests/visualRenderQqActionService.test.js tests/visualRenderService.test.js tests/visualRenderTool.test.js
结果：5/5 通过

npm run lint
结果：通过

npm run typecheck
结果：通过

npm run check:secrets
结果：通过
```

完整 `npm test` 已运行 176.9 秒，本目标测试通过；退出 1 来自五项与本目标无关的既有失败：

- `adminStableSystemPrompt`
- `configPersonaPrompt`
- `mainReplyUnifiedDiagnostics`
- `memoryV3EmbeddingBackfillConcurrency`
- `memoryV3RagExplainDiagnostic`

### 运行验收

- 2026-07-30 20:50 +08:00：`/plugin/napcat-plugin-puppeteer/api/status` 返回 `code: 0`。
- 2026-07-30 21:02 +08:00：浏览器状态为 `connected=true`、`Chrome/131.0.6778.204`、`failedRenders=0`，端口 3000/6099 仅监听 `127.0.0.1`。
- 机器人通过官方重启脚本恢复健康，主进程 PID `20504`、post-reply worker PID `19516`。
- 群 `1083095371` 的 SVG：消息 ID `781501773`；`get_msg` 返回唯一图片段 `B01960B0FDA64A1F6E67474D573CF2FC.png`，17,568 字节。
- 管理员 `1960901788` 的 HTML 私聊：消息 ID `1185586370`；`get_msg` 返回唯一图片段 `8EAE5364224E21485DBA0C9EB48B5835.png`，13,790 字节。
- 使用运行时真实词库分别命中用户 prompt 和 markup 可见文本，两个场景均返回统一拦截提示；渲染器调用次数 0，QQ 发送调用次数 0，日志输出未包含测试敏感词。

小目标已完成。未推送远端。
