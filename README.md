# MizukiBot

MizukiBot 是一个面向 QQ 场景的角色 Agent 项目。它基于 Node.js、LangGraph 和 NapCat，把“晓山瑞希”角色扮演、群聊/私聊消息处理、分层记忆、工具调用、后台学习和运行诊断整合成一套可长期运行的本地机器人系统。

## 项目介绍

项目目标不是做一个简单问答 bot，而是做一个能在真实聊天环境里稳定运转的角色 Agent。它需要理解 QQ 消息上下文，判断是否应该回复，选择直接聊天、工具调用、后台处理或拒绝策略，并在回复后把有价值的信息沉淀到记忆系统。

放到 AI 开发工程师岗位语境下，MizukiBot 对应的是一套可落地的 Agent 工作流样板：它把平台事件接入、Prompt 编排、工具调用、RAG 知识召回、模型请求、输出校验和运行诊断串成完整闭环。岗位中提到的 Dify / Coze / FastGPT / Flowise 更偏低代码工作流平台，本项目则用代码实现了同类底层能力，适合展示对 Agent 编排机制本身的理解。

核心能力：

- QQ 接入：通过 NapCat / OneBot 接收私聊、群聊、图片、引用、转发、戳一戳等事件。
- 路由执行：按 `ignore`、`refuse`、`admin`、`direct_chat` 等路线分流，避免所有消息都走大模型。
- 角色扮演：通过 prompt manifest、persona worldbook、运行时协议和回复清洗保持瑞希风格一致。
- 分层记忆：短期上下文、会话摘要、用户画像、Memory V3、LanceDB 向量召回和本地知识库协同工作。
- 工具调用：支持本地命令、诊断、知识检索、图片处理、日程和自定义 skill。
- 后台学习：post-reply worker 在回复后异步抽取记忆、维护画像和生成日记，不阻塞主回复。
- 运维诊断：提供重启、健康检查、请求 trace、token 预算、NapCat 状态、记忆质量和运行热点诊断。

技术栈：

- Runtime：Node.js 20、CommonJS、LangGraph
- 模型适配：Anthropic Messages、OpenAI-compatible、Gemini-style provider
- QQ 接入：NapCat、OneBot WebSocket / HTTP action
- 存储：JSONL、SQLite、LanceDB、本地文件分片
- Web：Express 本地管理入口
- 测试与诊断：自研 `scripts/run-tests.js`、prompt 检查、运行态诊断脚本

## 项目经历

这个项目从一个 QQ 角色聊天机器人逐步演进为长期运行的 Agent Runtime。早期重点是打通 NapCat 接入、主回复链路和基础 prompt；随后补上路由、工具、记忆、主动任务和后台学习，形成“消息进入 -> 路由判断 -> Runtime 执行 -> 回复发送 -> 持久化/学习”的闭环。

这段经历可以对应到岗位里的四类工作：Agent workflow 搭建、Prompt 调优、平台 API 数据处理、RAG 知识库维护。当前项目没有直接接入 Amazon SP-API，但已经完成了 NapCat / OneBot、模型 provider、本地工具和诊断数据的 API 化接入；同样的封装方式可以迁移到电商平台、广告平台或公司内部业务系统。

主要工作经历：

- 搭建 Runtime V2：把准备上下文、路由、planner、工具 dispatch、回复草稿、润色、校验和持久化拆成可测试节点，降低单文件主流程复杂度。
- 重构记忆系统：从全量 JSON 常驻内存改为磁盘优先和按用户/群组分片召回，减少主进程启动和回复路径的内存压力。
- 优化真实聊天延迟：定位连续消息聚合、入站锁、模型流式生成和 QQ 发送阶段的耗时，给普通群文本、图片和引用消息设置不同等待策略。
- 建立安全与角色边界：普通用户、管理员、被动群感知和 fast reply 分别接入安全 prompt、回复标记和 emoji 反馈，避免安全规则只在单一路径生效。
- 清理历史隐私数据：从 Git 历史移除本地截图、运行数据、评估样本、备份包和代理本地配置，并用 `.gitignore` 阻止再次入库。
- 完善 Anthropic prompt cache：统一最终请求里的缓存断点、TTL 和网关 header，避免动态历史消息破坏缓存读取。
- 加固 Windows 运行：修复双击重启、远程重启、旧进程清理、worker 残留、锁文件和成功反馈问题，使本地长期运行更可控。
- 治理工程复杂度：拆分大文件、补充诊断脚本、沉淀维护日志，把 README 从维护流水账收回为项目入口。

当前主链路：

```text
NapCat / OneBot
  -> core/messageHandler.js
  -> core/messageIngress.js
  -> core/router/index.js
  -> core/routeExecution.js
  -> core/messageRouteFlow/index.js
  -> api/runtimeV2/host/index.js
  -> Runtime V2 nodes / tools / memory
  -> QQ 回复发送
  -> post-reply worker / memory / diagnostics
```

## 快速运行

环境要求：

- Node.js `>= 20`
- npm
- NapCat / OneBot
- 可用模型 API Key

安装依赖：

```bash
npm install
```

最小 `.env`：

```env
API_KEY=你的模型 API Key
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_WS_TOKEN=
DATA_DIR=./data
```

启动主 bot：

```bash
npm start
```

可选入口：

```bash
npm run console
npm run start:post-reply-worker
```

## 常用命令

```bash
npm test
npm run lint
npm run check:prompts
npm run diag:napcat-health -- --text
npm run diag:main-reply
npm run diag:memory -- audit --limit 5
```

Windows 本地运维：

```bash
restart-bot.cmd status
restart-bot.cmd restart confirm
npm run win:daemon:status
```

Linux 运维：

```bash
npm run linux:install
npm run linux:start
npm run linux:status
npm run linux:logs
```

## 目录说明

```text
api/        模型调用、工具注册、Runtime V2、Agent 能力
core/       QQ 消息入口、路由、调度、被动感知和主动任务
utils/      记忆、prompt、诊断、存储和工具策略
config/     环境变量解析和运行时配置
prompts/    人格、系统提示词、worldbook 和 prompt manifest
scripts/    启动、测试、诊断、部署和维护脚本
tests/      单元测试和回归测试
web/        本地管理 Web 服务
docs/       架构说明、维护记录和排障文档
data/       本地运行数据，默认不提交
```

## 文档入口

- `docs/maintenance-log.md`：近期维护记录和验收结果。
- `docs/repository-structure.md`：目录边界和清理规则。
- `docs/main-reply-context.md`：主回复上下文设计。
- `docs/post-reply-worker.md`：回复后学习 worker 说明。
- `docs/ai-agent-job-application.md`：面向 AI 开发工程师岗位的项目说明和面试讲法。
- `docs/project-development-history.md`：基于 Git 历史整理的项目开发过程。
- `docs/showcase/index.html`：面向投递和面试展示的静态 HTML 文档入口。
- `scripts/README.md`：脚本说明。
- `deploy/README.md`：部署说明。

更新时间：2026-06-22 20:00 +08:00
