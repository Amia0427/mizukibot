# 主回复不出声诊断

更新 2026-06-08 00:36 +08:00：本次故障是主 bot 进程退出；QQ/NapCat 进程仍在，守护任务下一次运行前没有主进程在线。

## 现象

- 本机没有 `node index.js` 主 bot 进程，只有 Playwright MCP / openclaw 等无关 Node 进程。
- `data/bot-runtime.out.log` 最后一次进站已经进入主模型调用前后，但随后主进程退出。
- `.mizukibot.lock` 为空，`MizukiBotDaemon` 下一次计划运行在 2026-06-08 01:49:37，无法即时自愈。

## 根因

`data/memory_items.json` 和 `data/memory_index.json` 被标记为 Windows 只读。主进程的热存储定时 flush 写入 `memory_items.json` 时触发：

```text
Error: EPERM: operation not permitted, open 'D:\waifu\data\memory_items.json'
```

异常发生在 `utils/jsonHotStore.js` 的定时器回调里，未被捕获，导致 Node 主进程退出，所以表现为 bot 不回复。

## 处理

- 已清除 `data/memory_items.json` 和 `data/memory_index.json` 的只读属性。
- `jsonHotStore` 写入遇到 `EPERM` / `EACCES` 时会尝试清除只读位并重试。
- 定时 flush 失败会记录错误、保留 dirty 状态并延迟重试，不再直接杀掉主进程。
- 添加只读 JSON 文件回归测试。

## 验证

```powershell
node tests\jsonHotStoreCorruptFallback.test.js
npm run diag:runtime
```

预期：只读文件测试通过；主进程重新上线后 `data/bot-runtime.err.log` 不再出现 `memory_items.json` 的 `EPERM` 崩溃。
