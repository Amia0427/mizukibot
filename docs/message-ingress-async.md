# Message Ingress Async

更新 2026-06-12 19:50 +08:00：入口已改为默认全链路异步接收。NapCat WebSocket 和 HTTP reverse 回调现在只完成解析、日志、action response 分流和入站队列投递；主回复、路由、模型请求、工具调用与持久化继续由原 `handleIncomingMessage` 在后台 drain 中执行，不再阻塞 NapCat 回调线程。

更新 2026-06-23 09:42 +08:00：入口仍保持单实例消费 OneBot 事件，不引入 `cluster` 或多个 `index.js`。新增的多线程能力只服务本地后台重任务，入口层继续由 `MESSAGE_INGRESS_ASYNC_*` 和业务级 `INBOUND_*` 控制；验收结果：定向并发/线程池测试均通过，`npm run diag:runtime -- --json` 显示主进程 `processCount=1`、post-reply 队列 `queued=0/processing=0`，warning 仅来自历史 failed jobs、stale checkpoint 和事件文件解析记录。

更新 2026-07-07 10:22 +08:00：私聊普通用户入站推荐档改为 `PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY=3`、`PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY=3`、`PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT=1`，实现多用户并行、同用户串行；发送后的后台持久化按 `sessionKey` 串行，避免同一私聊下一条消息抢在上一条短期记忆落盘前读取旧上下文。

更新 2026-08-27 11:00 +08:00：消息入口和业务入站队列不再按队列长度或等待时间拒绝请求；即使超过旧配置上限，消息也会继续等待 active slot 并最终进入回复链路。默认通用入站和私聊入站并发提升为 16，同一 `sessionKey` 仍保持串行；仅进程停机时使用 `stop({ drain: false })` 主动清理尚未开始的队列。

## 行为

- `MESSAGE_INGRESS_ASYNC_ENABLED=true` 默认开启入口异步化。
- `MESSAGE_INGRESS_ASYNC_MAX_ACTIVE` 控制后台同时进入原消息处理链路的最大任务数。
- 入口等待队列不设置运行期容量上限；active slot 满时消息继续排队，不因队列长度丢弃。
- `MESSAGE_INGRESS_ASYNC_SHUTDOWN_DRAIN_MS` 控制正常关闭时等待入口队列 drain 的时间。
- `BOT_WORKER_THREADS_*` 控制后台本地重任务线程池，不改变入口消费模型。
- `INBOUND_*` 和 `PRIVATE_INBOUND_*` 控制业务 active 并发；默认 global/general 为 16，`*_PER_USER_MAX_INFLIGHT=1` 继续保证同一会话顺序。
- 业务等待队列不设置运行期容量或超时拒绝；`PRIVATE_INBOUND_QUEUE_*`、`INBOUND_QUEUE_*` 和 `FOREGROUND_QUEUE_*` 不再作为丢弃机制。

## 边界

原有 `INBOUND_*`、`PRIVATE_INBOUND_*` 和 post-reply worker 仍负责业务级 active 并发、同用户串行、回复后学习。新入口队列只解决 NapCat 接收链路不等待完整主回复的问题；私聊并发不引入多 `index.js` 或 `cluster`。正常运行期不会因队列满或等待超时舍弃消息，停机非 drain 清理属于进程生命周期边界。

小目标完成：NapCat 入站回调已从完整主回复链路中解耦，入口具备快速入队、后台消费、失败隔离和关闭 drain。

小目标完成：私聊已按多用户并发、同用户串行收口，后台持久化也按会话串行。
