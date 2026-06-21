# 管理员缓存读写对照验收

更新时间：2026-06-21 22:37 +08:00

## 2026-06-21 更新

- 22:37：补齐第三方 Anthropic 网关需要的 `X-Enable-1h-cache: 1`，并把该 header 加入 trace/model-calls 诊断。现场确认旧主进程 `pid=2544` 启动于 16:40，早于 17:24 的缓存修复提交，因此未重启时仍会继续记录旧的 `anthropicPromptCacheTtl="5m"`。
- 17:15：修复主回复稳定 system 块仍硬编码 `ttl: "5m"`，真实 trace 因此不会进入一小时缓存的问题；默认 `1h` 现在会自动携带 `extended-cache-ttl-2025-04-11`，日志记录 `anthropic_prompt_cache_ttl`。
- 默认稳定缓存块 TTL 改为 `1h`，与主回复 Anthropic prompt caching 默认值一致。
- 若目标 Anthropic 兼容网关拒绝一小时缓存，可临时设置 `ANTHROPIC_PROMPT_CACHE_TTL=5m` 后再运行脚本。
- 本轮验收以 `node scripts/run-tests.js tests/providerRequestNormalization.test.js tests/httpClientAnthropicPromptCache.test.js` 确认请求体 TTL 与兼容回退。

## 目标

对同一管理员连续发两次真实主模型请求，区分“只写不读”到底来自：

- 上游不支持或不返回缓存读写信号。
- 最终请求体不符合缓存条件。
- 本地读取链路没有吃到上游已返回的缓存结果。

## 命令

```bash
npm run verify:admin-cache-read -- --timeout-ms=45000 --output artifacts/tmp/admin-cache-read-20260617.json
```

可先只看本地请求体：

```bash
npm run verify:admin-cache-read -- --dry-run --json
```

## 本次验收

- 命令通过。
- 两次请求：`req_0e1244b5a0c60678`、`req_6b2fdb086a348627`。
- 两次 HTTP 状态均为 `200`。
- 最终请求体差异为 `0`。
- 最终请求体 keys：`max_tokens/messages/model/stream/system/temperature`。
- 估算输入：`4826` tokens。
- 缓存条件：Anthropic cache breakpoint=`1`，默认一小时缓存会发送 `anthropic-beta=prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11` 和 `X-Enable-1h-cache=1`。
- 响应与本地 `model-calls` 都没有 usage/cache 字段：`usage_read=0`、`usage_write=0`、`modelCallUsage=null`。

结论：`upstream_cache_signal_unobservable`。本轮不能证明“只写不读”，只能归因为上游不提供可观测缓存读写信号或该端点不支持上报。
