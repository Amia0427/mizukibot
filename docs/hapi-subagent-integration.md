# HAPI 接入本 Agent 的落地方案

## 结论

最小侵入、最容易成功的方案不是把 AstrBot 插件逻辑整套搬进来，而是：

1. 保留当前仓库作为主控 Agent
2. 复用现有 `SUBAGENT_BACKEND` 抽象
3. 新增一个 `hapi` backend
4. 让 HAPI 在本机托管两个 machine / runner：
   - `codex-local`
   - `claude-local`
5. 用当前已有的 `sessionId` 体系把 QQ 会话、后台任务、多 worker 并行任务映射到 HAPI session

这样改动范围小，而且不会破坏当前 `command / openclaw / gateway` 三种后端。

## 为什么选这个形态

当前仓库已经有完整的“外部子代理桥接”入口，不需要重做主链：

- `api/subagentExecutor.js`
- `api/subagentSessionManager.js`
- `api/subagentBackends/commandBackend.js`
- `api/subagentBackends/openclawBackend.js`
- `api/subagentBackends/gatewayBackend.js`

其中最关键的是：

- 当前已经支持按 `SUBAGENT_BACKEND` 切换桥接后端
- 当前已经有稳定的 `sessionId` 生成规则
- 当前已经有 `/full` 多 worker 并行执行能力
- 当前后台任务、路由提示、review 流程都已经接好了

所以 HAPI 最适合作为新的“桥接后端”，而不是作为新的主运行时。

## 推荐架构

```text
QQ / NapCat
  -> 当前主消息链
  -> routeExecution / messageHandler
  -> startSubagentBridgeCall()
  -> hapiBackend
  -> HAPI API
  -> local machine runner
  -> codex / claude
  -> HAPI events / stream
  -> hapiBackend
  -> 当前 review / reply / background task 体系
```

## 代码接入点

### 1. 新增 backend

新增文件：

- `api/subagentBackends/hapiBackend.js`

职责：

- 创建或恢复 HAPI session
- 选择目标 machine
- 向 HAPI 发送消息
- 订阅或轮询事件流
- 聚合最终文本输出
- 暴露 `createHapiBridgeCall()`

接口形态应与现有 backend 对齐：

```js
function createHapiBridgeCall({ question, sessionId, customPrompt, imageUrl, options }) {
  return {
    promise,
    cancel(reason) {}
  };
}
```

### 2. 接入 backend 分发

修改：

- `api/subagentExecutor.js`

新增：

- `if (backend === 'hapi') return createHapiBridgeCall(...)`

这样主链其它地方不用改。

### 3. 增加配置项

修改：

- `config.js`

建议新增：

- `SUBAGENT_BACKEND=hapi`
- `HAPI_BASE_URL`
- `HAPI_AUTH_TOKEN`
- `HAPI_TIMEOUT_MS`
- `HAPI_STREAM=true`
- `HAPI_DEFAULT_MACHINE=claude-local`
- `HAPI_CODEX_MACHINE=codex-local`
- `HAPI_CLAUDE_MACHINE=claude-local`
- `HAPI_AUTO_CREATE_SESSION=true`
- `HAPI_SESSION_PREFIX=mizuki`
- `HAPI_APPROVAL_MODE=manual`

## machine 选择策略

不要一开始就做复杂调度，先固定规则：

- `claude-local`
  - 代码阅读
  - 审查
  - 总结
  - 解释
  - 风险分析

- `codex-local`
  - 明确要改代码
  - `/full` 任务
  - 多文件修复
  - 执行式 coding

可以先在 `options` 或 `routePolicyKey` 上做简单映射：

- `admin/full` -> `codex-local`
- `tool/review` -> `claude-local`
- 默认 -> `claude-local`

后续再加显式指令：

- `/agent codex`
- `/agent claude`

## session 映射

当前仓库已经有会话 id 构造器：

- `api/subagentSessionManager.js`

建议直接复用，不要重新设计。

映射规则：

- 普通会话：`mizuki:group_xxx_user_xxx`
- 后台任务：沿用当前 `sessionChannel/sessionChatId`
- `/full` worker：
  - `...:full:w1`
  - `...:full:w2`

这和参考项目“一个聊天窗口绑定一个 coding 窗口”的思路是一致的，而且刚好兼容你现有多 worker 设计。

## HAPI 侧需要的 machine / runner

### 1. Claude runner

优先用本机已安装 `claude`：

- 当前机器可见 `claude.ps1`
- CLI 支持 `-p`
- CLI 支持 `--output-format stream-json`
- CLI 支持 `--session-id`

适合作为 HAPI 托管 runner。

建议 wrapper：

- `scripts/hapi-runners/run-claude.ps1`

职责：

- 接收 HAPI 传入的 message / session id / cwd
- 转调 `claude`
- 统一输出标准化事件或文本
- 控制权限模式

建议初版参数：

- `claude -p`
- `--output-format stream-json`
- `--permission-mode default`
- 必要时 `--add-dir D:\waifu`

### 2. Codex runner

优先不要直接让 HAPI 裸调 WindowsApps 下的 `codex.exe`。

原因：

- 当前环境里能 `Get-Command codex`
- 但直接 spawn `codex.exe` 出现过“拒绝访问”
- 这类路径通常更适合通过 wrapper 或正常用户 shell 拉起

建议 wrapper：

- `scripts/hapi-runners/run-codex.cmd`
  或
- `scripts/hapi-runners/run-codex.ps1`

职责：

- 在正常 shell 环境里启动 `codex`
- 统一 cwd
- 注入消息
- 处理 session id
- 把 stdout/stderr 标准化给 HAPI

如果 HAPI runner 支持长期交互式进程，Codex 更适合跑在“持久 session”模式，而不是每条消息起一个新进程。

## 审批流

这是参考项目最值得保留的部分。

最小 MVP 不要做“自动批准危险操作”，应当做：

1. HAPI 收到 runner 的权限请求事件
2. `hapiBackend` 或一个独立的 HAPI 事件监听器把事件写入本地 pending approvals
3. 当前 bot 把审批请求推送到对应聊天窗口
4. 用户回复“批准 / 拒绝”
5. bot 调 HAPI approval API 继续或拒绝该 session

当前仓库已经有后台任务与会话概念，适合加一层：

- `data/hapiApprovals.json`
  或
- 新增一个轻量 store 模块

建议先支持三类动作：

- `approve`
- `deny`
- `status`

建议新增管理命令：

- `批准`
- `拒绝`
- `任务状态`
- `取消任务`

## 动态工具注册思路

参考项目里“只有绑定 coding 窗口才注册完整远控工具”这个思路值得保留，但在你这个仓库里不应该照搬 AstrBot 的插件工具注册方式，而应该落在路由和命令层。

建议：

- 普通群聊：不暴露远控管理指令
- 已绑定 coding 会话的群 / 私聊：开放以下控制动作
  - 切 agent
  - 新建 session
  - 查看状态
  - 批准 / 拒绝
  - 中断
  - 继续

这样不会污染普通对话上下文。

## 与当前仓库的配合方式

### 路由层

不改主路由结构，只补充少量策略：

- coding 类高执行任务优先走 `hapi`
- review / explain 类可以走 `claude-local`
- `/full` 默认走 `codex-local`

### review 层

当前仓库已经有“外部子代理结果 -> 本地 review”机制。

建议继续保留：

- 外部 runner 负责做事
- 当前主 Agent 负责二次审核、润色、统一回复风格

这样可以降低 Codex / Claude 原始输出直接暴露给 QQ 的风险。

## 推荐实施顺序

### Phase 1: 打通最小链路

目标：

- 当前 bot 能通过 `SUBAGENT_BACKEND=hapi` 把消息发到 HAPI
- 至少能调用 `claude-local`
- 能拿回最终文本

只做：

- `hapiBackend.js`
- `config.js`
- `subagentExecutor.js`

先不做审批，不做多 machine 切换。

### Phase 2: 接入 Codex

目标：

- HAPI 上新增 `codex-local`
- `/full` 默认走 Codex
- worker session 后缀保留

只做：

- codex wrapper
- machine 选择逻辑

### Phase 3: 审批流

目标：

- 权限请求能从 HAPI 回推到 QQ
- 用户可批准/拒绝

这一步完成后，才算真正接近参考项目的“远控 coding”体验。

### Phase 4: 会话管理

目标：

- 一个群/私聊对应一个 coding window
- 支持切换 agent、重开 session、查看历史状态

## 需要注意的坑

### 1. Codex 在这台机器上不适合直接裸 spawn

当前环境里：

- `codex.exe` 在 WindowsApps 路径下可见
- 但直接运行曾返回“拒绝访问”

所以 Codex 必须通过 wrapper 处理，不要直接在 Node 里裸 `spawn('codex')` 当作最终方案。

### 2. Claude CLI 更适合优先接

当前机器上 `claude` 的 CLI 参数已经比较明确，接 HAPI runner 更稳，建议先用它打通第一条链路。

### 3. 不要把审批权交给普通聊天推理链

审批必须是显式控制动作，不能让普通闲聊模型“顺手决定批准危险权限”。

### 4. 不要破坏现有 backend

`command / openclaw / gateway` 先保持兼容，`hapi` 作为新增项接入。

## 我建议的下一步

如果直接开始实装，我建议顺序是：

1. 先补 `hapiBackend.js` 的最小可用版
2. 先只接 `claude-local`
3. 跑通一次真实问答
4. 再加 `codex-local`
5. 最后补审批回推

这样返工最少。

## 参考

- GitHub: `https://github.com/LiJinHao999/astrbot_plugin_hapi_connector`
- 设计说明帖: `https://linux.do/t/topic/1799761`
