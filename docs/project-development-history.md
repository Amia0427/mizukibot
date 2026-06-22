# MizukiBot 项目开发历史

更新时间：2026-06-22 18:55 +08:00

## 总览

MizukiBot 从 2026-04-15 的初始导入开始，到 2026-06-22 已形成一套面向 QQ 场景的长期运行 AI Agent Runtime。当前分支历史共约 608 次提交，其中 2026-04 约 62 次、2026-05 约 159 次、2026-06 约 387 次。提交密度的变化也反映了项目演进节奏：4 月完成原型和 Agent 骨架，5 月进入系统性重构和记忆治理，6 月集中处理真实运行中的延迟、稳定性、Prompt、NapCat、缓存和部署问题。

这份文档按开发阶段记录项目如何从“能回复的 QQ bot”逐步变成“可诊断、可维护、可长期运行的 Agent 系统”。它不是完整提交清单，而是基于历史提交和维护记录整理出的开发过程叙事。

## 阶段一：原型导入与 QQ Agent 雏形（2026-04-15 至 2026-04-18）

项目最早从 `Initial project import` 开始，随后很快进入 QQ 场景能力验证。早期提交集中在几件事：QQ 空间能力、流式回复、Memory V3、MemOS、Agent run V2/V4、私聊修复和图片转述。

代表性提交：

- `190539b`：初始项目导入。
- `cf1249f`：加入流式回复能力。
- `89ee51d`、`1e4f77a`：开始引入 Memory V3 / MemOS。
- `df73f40`、`69f5e8e`、`1959246`：推进 Agent run V2/V4。
- `de468de`：QQ 空间能力早期迭代。
- `e6a4cb6`：图片转述能力。

这一阶段的重点不是架构优雅，而是验证核心方向是否成立：QQ 消息能进来、模型能回复、角色能维持、图片和空间等 QQ 特色能力能接入。你先把系统跑起来，再开始治理复杂度。

## 阶段二：Agent Runtime 与工具路由成型（2026-04-19 至 2026-04-30）

4 月下旬，项目从“功能堆叠”转向“Runtime 化”。提交中开始出现低延迟回复、工具加载、planner 精度、prompt 模块化、短期记忆、session summary、工具调用限制、安全检查、并发保护、后台研究和推理 fallback。

代表性提交：

- `1eb57ee`：重构 agent runtime，降低回复延迟。
- `c1fb2b1`：重构工具加载，用 native skills 替换 MCP bridge。
- `c2e07ba`：提升 planner 工具选择精度。
- `cd689de`：引入模块化 persona prompts 和 planner 驱动激活。
- `07cbe73`：加入 session summary 和记忆压缩。
- `698a0ff`、`49b8c9d`：加强本地工具路由、安全检查、工具调用上限和参数校验。
- `9df6739`：加固并发和 companion planner 路由。
- `5739473`：加入 hybrid memory embedding 和 rerank recall。

这一阶段解决的是 Agent 系统的基本工程问题：不能所有请求都靠一个大 prompt 扛；工具必须有边界；planner 需要知道什么时候该调用工具；记忆和上下文需要压缩；并发、超时和 fallback 必须成为主流程的一部分。

## 阶段三：记忆系统和 RAG 体系扩张（2026-05-03 至 2026-05-21）

5 月上旬到中旬，项目进入记忆系统的快速扩张期。提交集中在 LanceDB、向量回填、Memory V3、MemOS planner recall、profile memory lifecycle、memory quality governance、recall observability 和 memory index health gating。

代表性提交：

- `8bfd443`：降低启动时记忆开销，并对 post-reply materialization 做 debounce。
- `4c99085`：提升 LanceDB 记忆召回质量和速度。
- `473881f`：把向量回填接入记忆写入。
- `00cfed5`：改进 memory index health gating 和 backfill recovery。
- `b209163`：加入 memory quality governance。
- `2b88b48`：治理 profile memory 生命周期。
- `356e0be`：加入 MemOS planner recall。
- `a1a2019`、`ffb5a5c`：MemOS 和本地记忆去重，并收窄为远端只读召回。
- `423c1ed`：加入 memory recall observability。

这一阶段的核心转变是：记忆不再只是“把聊天记录存起来”，而是开始具备质量治理、冲突处理、生命周期、召回观察和远端知识库协同。你开始处理 RAG 项目真正困难的部分：召回什么、信不信、过期怎么办、冲突怎么办、污染怎么发现。

## 阶段四：大文件拆分与工程结构治理（2026-05-19 至 2026-05-24）

5 月中下旬，提交明显转向工程结构治理。项目开始拆大模块、回流 facade、移除历史代码、切换小模块入口、归档大 facade 文件，并给 README 和维护日志建立位置。

代表性提交：

- `7e89c31`、`646d417`：重构项目结构并移除过时代码。
- `fa52459`：将大型 utils 拆成更小模块。
- `8681a13`、`da899f7`：规划并扩大大文件 backflow 审计范围。
- `cde5cbf`、`ff96346`、`c8edff1`、`e546503`、`aa97685`：分批把 config、web context preview、image summary、router memory recall、create agent 和 mcp 等逻辑回流到 runtime 模块。
- `38d960f`、`31e39ad`、`efc016b`：归档大 facade，切换 boot chain 到小模块入口，再移除归档的大 facade 文件。
- `0554b22`：记录维护日志位置。

这一阶段体现了一个重要开发习惯：当功能增长到一定程度，继续堆代码会让每次修复都变得危险。你选择先治理结构边界，让后续修复和新能力可以落在更小、更清楚的模块里。

## 阶段五：post-reply worker 与后台学习闭环（2026-05-23 至 2026-05-24）

5 月 23 日到 24 日，提交密集围绕 post-reply worker 展开。目标是把回复后的学习、记忆抽取和画像维护从主回复链路中拆出去，降低前台延迟，同时保留可追踪、可回滚、可恢复的任务系统。

代表性提交：

- `5ccce5d`：规划 post-reply worker 改进。
- `e17c953`：加入 post-reply job trace 和 leases。
- `1afb81b`：为 post-reply learning 加 intent gate。
- `98fe10b`：加入 post-reply queue index。
- `dd3126d`：给 job leases 加 heartbeat。
- `c7796de`：追踪 post-reply task states。
- `77b630a`：压力下自动降级 post-reply work。
- `e334e54`：加入 post-reply learning rollback。
- `e0e4d13`：加入 post-reply task runner。
- `69aa406`：整合 post-reply worker 运行手册。

这一阶段把“回复后学习”从同步副作用改成了后台任务系统。它不只是性能优化，也让记忆写入、失败重试、任务取消、回滚和评估变得可管理。

## 阶段六：角色 Prompt、人格一致性与安全边界反复打磨（2026-05-25 至 2026-06-13）

从 5 月末到 6 月中旬，项目进入 Prompt 和角色体验的高频迭代。提交中出现 root system prompt、persona prompt、roleplay liveness、Gemini prompt、admin stable prompt、normal user default prompt、安全边界、性骚扰保护、关系边界、reasoning 展示和世界书召回。

代表性提交：

- `0009293`：加入 root system prompt block。
- `4b1c8c8`、`fe92ef3`：放宽和修订 persona prompt 边界。
- `2360d04`：加入 roleplay inner protocol。
- `1ce4c67`：加入 admin stable system prompt。
- `5ea3dc7`、`099ad88`、`4632da9`：重构 persona 提示词结构，并增强真人感和沉浸度。
- `fcaed57`：接入 normal user default prompt。
- `cfe9f0e`：强化普通用户内容安全边界。
- `0d8f72e`、`0635273`：加入性骚扰保护和关系边界限制。
- `0af05fd`、`3d26143`：将 worldbook recall SQL 化，并接入 normal fast reply。

这一阶段的开发特点是“体验问题驱动工程规则”。你不是只写更长的 prompt，而是逐渐建立 manifest、模块拆分、注入顺序、运行时协议、测试和诊断。Prompt 开始像代码一样被治理。

## 阶段七：真实运行稳定性、延迟和运维治理（2026-06-11 至 2026-06-18）

6 月中旬开始，项目明显进入真实运行问题密集收口期。提交主题包括 HTTP reverse NapCat、主 bot restart diagnostics、NapCat health diagnostics、async message ingress、main reply lag、continuous hold、Windows restart script、main bot silent exits、admin private timeout、Anthropic Messages 请求、普通用户每日模型限额等。

代表性提交：

- `5da0c95`、`3490cad`：加入并迁移 NapCat HTTP reverse connection mode。
- `0ce9127`：加入 main bot restart diagnostics。
- `c2076cc`：加入 NapCat health diagnostics。
- `f3a5bfc`：加入 async message ingress dispatcher。
- `cfaf0e7`、`99f5cd4`：加入并加固 main reply lag diagnostics。
- `783ca72`、`af1cf0c`、`95bb273`：定位和收口回复延迟阻塞。
- `e58862a`：重写 Windows restart script。
- `50cd63b`、`8ae0612`、`c27b63c`、`8c50e35`：连续修复 restart stdout、远程目标停止、清理反馈和双击重启。
- `8aae650`：加入普通用户每日模型调用限制。
- `3779d54`：修复 Anthropic 空文本块问题。

这一阶段的重点已经不是“做新功能”，而是让系统在坏现场里能恢复、能诊断、能复现。你开始用请求 trace、健康检查、状态文件、PowerShell AST parse、真实 restart 演练和目标测试来定义“完成”。

## 阶段八：缓存、被动感知、reasoning 外发和 README 收口（2026-06-17 至 2026-06-22）

最近一段提交聚焦几个真实问题：reasoning 外发不能泄漏 raw thinking、被动群感知图片不能漏判、普通群单图不能被连续消息窗口拖到 25 秒、Anthropic prompt cache 不能只写不读、README 不能继续充当维护流水账。

代表性提交：

- `89cc85d`：把 QQ reasoning 作为合并转发消息发送。
- `662695c`、`8d0eb1a`、`00a6a2f`、`b89d017`：将 reasoning 外发收口为 persona-safe 的短想法，并统一中文情绪内心口径。
- `8a14fa8`：让被动群感知对图片 visual cue 做探测。
- `1e44ce7`：避免普通群单图预处理直接命中 max-hold。
- `5e8ddce`、`24439c8`、`e654fe3`、`061b582`、`1afca87`：连续修复 Anthropic prompt cache TTL、header、breakpoints 和动态断点只写不读问题。
- `858001e`：允许主 bot 缺席但 worker 仍在时执行重启。
- `e0fc6a9`：重写 README，把维护手册收口为项目介绍和项目经历。
- `e91a301`：新增面向 AI 开发工程师岗位的项目说明。

这一阶段说明项目已经开始进入“作品集化”和“对外表达”阶段。README 不再承载全部维护流水，而是变成入口；细节迁移到独立文档和维护日志中。

## 开发方法的变化

从提交历史看，开发方法大致经历了四次变化。

第一阶段是功能验证：快速接入 QQ、流式、图片、空间、记忆和 Agent run，先证明方向能跑通。

第二阶段是工程化：拆 Runtime、拆大文件、收紧工具边界、增加测试、增加诊断，让功能可以继续增长。

第三阶段是真实运行驱动：从日志和现场问题出发，围绕延迟、重启、NapCat 离线、模型异常、prompt cache、图片预算等问题做可复跑修复。

第四阶段是表达和沉淀：README 收口，维护日志结构化，岗位说明和开发历史独立成文，把项目从“自己能维护”推进到“别人能理解、面试能讲清”。

## 关键技术主线

### Agent 编排

项目从早期 Agent run V2/V4 演进到 Runtime V2，将路由、planner、工具 dispatch、回复生成、校验和持久化拆成节点。这条主线解决的是复杂 Agent 不可维护的问题。

### Prompt 工程

Prompt 从普通系统提示词演进到 manifest、persona worldbook、runtime protocol、admin prompt、normal user prompt、reasoning forward prompt 和检查脚本。这条主线解决的是角色一致性、安全边界和多模型差异。

### RAG 与记忆治理

记忆从 Memory V3 和 MemOS 原型，发展到 LanceDB、向量回填、Memory V3 lifecycle、profile journal、quality gate、recall observability 和磁盘优先召回。这条主线解决的是长期对话的连续性和记忆污染问题。

### 运行稳定性

项目不断补齐 restart、daemon、NapCat health、main reply lag、runtime exceptions、request trace、prompt assembly timing、pre-release smoke 等诊断入口。这条主线解决的是长期运行系统最容易被忽视的可恢复性。

### 性能与成本控制

提交中多次出现 token budget、prompt cache、normal fast reply、planner timeout、inline image cap、LanceDB PQ、worker RSS、disk-backed recall stores。这条主线解决的是真实使用中“能跑”和“跑得起”的问题。

## 可在面试中讲述的开发过程

可以把项目开发过程概括成这样：

我一开始做的是一个 QQ 场景角色 bot，先打通消息接入、流式回复、图片理解和基础记忆。随着功能增多，单条主链路开始变复杂，于是我把它重构成 Runtime V2：消息进入后先做上下文准备和路由，再决定是否调用 planner、工具、RAG、回复生成和持久化。

中期我重点做记忆系统和工程结构治理。记忆不只是简单存聊天记录，而是拆成短期上下文、会话摘要、用户画像、Memory V3、LanceDB 向量召回和本地知识库，并补了质量治理、污染检查、冲突处理和召回诊断。代码结构上，我把大文件和 facade 拆成小模块，让后续修复可以定位到更小的边界。

后期主要是在真实运行中修问题：回复慢、连续消息等待过长、NapCat 离线、Windows 重启不稳定、模型请求格式不兼容、Anthropic prompt cache 只写不读、图片输入 token 爆炸、被动群感知漏图。这些问题都不是靠猜修的，而是通过 request trace、model-calls、健康诊断、目标测试和真实重启演练确认。

最终这个项目从一个聊天机器人变成了一个可长期运行、可诊断、可扩展、可讲清楚工程过程的 AI Agent 项目。

## 验收习惯

历史提交和维护日志中反复出现几类验收方式：

- `node scripts/run-tests.js ...` 跑目标回归测试。
- `node --check ...` 做语法检查。
- `npm run check:prompts` 检查 prompt manifest 和提示词装配。
- `npm run diag:*` 复核运行态、记忆、主回复、NapCat 和请求 trace。
- 实际执行 `restart-bot.cmd status` / `restart-bot.cmd restart confirm` 验证 Windows 运行链路。
- 对真实日志文件做只读诊断，例如 `request-trace.ndjson`、`model-calls.ndjson`、`inbound_timing.jsonl`。

这让每次“修好了”尽量有证据，而不是只靠代码看起来合理。

## 当前状态

截至 2026-06-22，MizukiBot 已经具备以下项目形态：

- 可运行的 QQ AI Agent 主链路。
- Runtime V2 节点化执行结构。
- 分层记忆和 RAG 召回体系。
- post-reply worker 后台学习闭环。
- Prompt manifest、persona worldbook 和角色运行协议。
- NapCat / OneBot 接入、HTTP action、健康诊断和重启恢复。
- 主回复延迟、token 预算、模型请求、prompt cache 和运行异常诊断。
- 面向作品集和岗位投递的 README、岗位说明和本开发历史文档。

## 参考入口

- `README.md`：项目介绍和项目经历。
- `docs/maintenance-log.md`：详细维护记录和验收结果。
- `docs/ai-agent-job-application.md`：面向 AI 开发工程师岗位的项目说明。
- `docs/repository-structure.md`：目录边界和清理规则。
- `docs/main-reply-context.md`：主回复上下文设计。
- `docs/post-reply-worker.md`：后台学习 worker 说明。
