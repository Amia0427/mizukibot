# OpenAI-compatible GIF vision input 修复计划

## 目标

修复 `gcli-gemini-3-flash-preview-nothinking` 通过 OpenAI-compatible 请求接收 GIF 时返回 500 的问题。该网关接受同一图片字节的 JPEG MIME，因此只在请求整形边界把 GIF 首帧转换为 JPEG，缓存仍保留原始 GIF。

## 实施范围

- 在 `src/model/http/images.chunk.js` 的 OpenAI-compatible 图片解析中统一处理内联、缓存和远程 GIF。
- 使用现有 `sharp` 依赖和惰性加载；非 GIF 图片保持原有 MIME 与数据不变。
- 在 `tests/httpClientQqImageInlining.test.js` 增加缓存 GIF 和远程 GIF 回归覆盖。
- 更新 README 与维护日志，记录实际验收命令和结果；提交当前分支，不推送。

## 验收

- 定向图片请求回归通过，确认 GIF 输出为 JPEG data URL、PNG 仍为 PNG data URL。
- `npm run lint`、`npm run typecheck`、`git diff --check` 通过。
- 使用真实缓存 GIF 对目标模型做一次只读请求验收，记录上游状态。

## 完成记录

2026-08-16 10:50 +08:00：实现提交 `05ddbead` 已创建。远程、内联、缓存 GIF 及 PNG 保持回归通过，真实缓存 GIF 本地转换为 4,376 字节 JPEG；`npm run lint`、`npm run typecheck`、`git diff --check` 和 188.9 秒完整 `npm test` 均退出 0。目标模型两次实时请求均被上游超时阻断，未再返回 `#sym:500`，但没有取得 200 成功证据。
