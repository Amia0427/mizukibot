# 舞萌谱面 SQL/RAG

更新时间：2026-08-04 13:05 +08:00
功能提交：`5a53eb3`；误召回收敛提交：`c82ad3d`

用户入口：[使用说明](maimai-user-guide.md)；[更新公告](maimai-update-announcement-2026-08-04.md)。用户文档更新于 2026-08-04 13:05 +08:00。

## 范围

舞萌能力由 `src/features/maimai/` 单独负责。同步结果通过三个只读工具进入现有 ReAct 主回复链路，最终回答继续使用主模型的人格和上下文。首版不写回游戏数据，不定位玩家实际掉音位置，也不提供 Web 管理页。

公开工具：

- `maimai_chart_search`：按查询文本、曲名、等级、SD/DX 和难度检索，最多返回 10 张谱面。
- `maimai_chart_analyze`：返回一张谱面的完整特征和最多 3 个代表段；歧义时返回最多 5 个候选。
- `maimai_player_analysis`：只读取工具上下文中的当前 QQ 用户，不接受外部 `user_id`。

## 数据与版本

默认数据目录为 `DATA_DIR/maimai/`：

- `catalog.sqlite`：同步运行、活动 generation、曲目、谱面、映射、原始 Simai、事件、特征、代表段、摘要缓存和 FTS5。
- `player.sqlite`：加密 Import-Token、成绩快照、标准化成绩和弱项推断。
- `lancedb/`：独立舞萌向量表，不与用户记忆索引混用。

谱面键固定为 `df:<music_id>:<SD|DX>:<difficulty_index>`。查询只读取 `active_generation_id`；同步先在 staging generation 完成解析、映射、摘要和向量，满足以下门禁后才短事务切换：

- 解析成功率不低于 99%。
- 确认映射覆盖率不低于 75%，且相对上一版本下降不超过 2%。
- 文档数与向量数完全一致。

映射硬条件包括规范化曲名、SD/DX、难度索引和 note 总数误差不超过 1%。唯一候选分差不足 0.08 或硬条件不满足时进入隔离区，不参与完整谱面回答。

## 同步与摘要

Worker 使用 GitHub tree 增量下载变化的 `maidata.txt`，Diving-Fish 曲库和统计使用 ETag。全部数据源未变化时只记录 no-op。默认每天 `04:30 Asia/Shanghai` 检查；没有活动数据或最近成功同步超过 24 小时时，启动后立即后台同步。

谱面解析固定使用 `simai.js@1.1.4`。每张确认谱面生成一个全局文档和最多 3 个互不重叠的 8 秒代表段，窗口步长 2 秒。特征算法按 Tap 1.0、Touch 1.1、Hold 1.2、Slide 1.4、Break 1.2，并叠加双押和滑键重叠权重。

离线摘要按每批 8 张、并发 1 调用现有模型 HTTP 栈。模型输出必须通过 chart key、分段数、分段 ID、数值和手法标签校验；失败后使用确定性模板。缓存键包含内容哈希、提示词版本和模型版本。配置模型后，校验通过的全局摘要和分段文本会进入向量文档；未配置或调用失败时公共查询仍可用。

## 路由与执行保护

舞萌工具使用确定性双门禁，不再由单层关键词正则授权：

- 领域门禁：当前消息明确出现“舞萌”或“maimai”，或者同时出现至少两个独立专属谱面信号，例如“DX + 紫谱”“标准 + 白谱”或完整“Re:Master 谱”。“手法、交互、滑键、掉音、定数”等单个泛化词不能确认领域。
- 数据意图门禁：消息还必须明确需要谱面检索、单谱结构分析或当前用户成绩数据。“舞萌好玩吗”“舞萌怎么入坑”等闲聊继续走普通回复。
- 当前消息边界：只读取当前 `cleanText`，不使用 `effectiveIntentText`、引用内容、上下文摘要或上一轮舞萌结果补全领域。“这张呢”不会继承授权，需要用户重新给出完整问题。
- 工具优先级：第一人称成绩问题走 `maimai_player_analysis`；多谱查找、范围筛选、推荐和比较走 `maimai_chart_search`；明确单谱结构分析走 `maimai_chart_analyze`；其他已确认的谱面数据查询走搜索。

每次路由先移除三个舞萌工具，分类成功后只加入唯一目标工具，其他领域已授权工具保持不变。`MAIMAI_ENABLED=false` 时不会向模型暴露任何舞萌工具。

执行器不信任模型生成的工具名和参数，会使用 `__context.question` 或 `cleanText` 重新运行同一分类器。分类结果与目标工具不一致时返回 `blocked: maimai_route_mismatch`，不读取 SQLite、LanceDB 或成绩库。单谱分析的 `title` 必填，并且规范化标题必须能在当前问题中找到；缺少标题、只说“这张”或模型补造标题都会直接要求澄清。

## 检索与结果契约

检索先由 SQL/FTS 产生最多 100 个候选，再将候选内容哈希作为 LanceDB 硬过滤条件。向量结果必须再次与 SQL 候选求交，embedding 失败时返回 `sql_only`。所有证据都包含数据版本、同步时间、映射置信度、检索模式和降级状态。

搜索结果是候选列表，向量分数只用于候选集内重排，不作为谱面身份确认。无结果返回 `not_found`。单谱分析区分 `ok`、`ambiguous`、`not_found`、`unavailable` 和执行器产生的 `blocked`；只有唯一确认的 `ok` 谱面可以返回完整特征和代表段。`ambiguous` 最多返回 5 个候选并设置 `answerPolicy=clarify`，主回复只能要求补充完整曲名、SD/DX 或难度。

工具结果不能声称知道玩家的实际掉音位置。个人弱项只使用高置信成绩映射，以 Diving-Fish `avg/std_dev` 计算残差，再计算手法强度与残差的 Spearman 相关；有效成绩不足 20 张、单项非零样本不足 8 张或相关系数高于 -0.20 时不报告该弱项。

## 凭据与命令

`/mai bind <Import-Token>` 仅私聊可用。Token 先通过 `/player/records` 验证，再以 AES-256-GCM 写入 `player.sqlite`；AAD 同时绑定 QQ 用户和密文版本。NapCat 入站在原始包日志、follower 分发、Router、模型、记忆、被动感知和诊断之前消费 bind 命令。

命令：

- `/mai bind <Import-Token>`：私聊绑定。
- `/mai unbind`：删除 Token、快照、标准化成绩和派生弱项。
- `/mai status`：查看绑定状态和活动数据版本。
- `/mai refresh`：强制刷新当前用户成绩。
- `/mai sync`：管理员查看或触发后台同步，不阻塞消息线程。

成绩快照 TTL 为 15 分钟。刷新失败时使用上一快照并附 `fetched_at`；没有快照时提示重新绑定或刷新。

## 配置

```dotenv
MAIMAI_ENABLED=false
MAIMAI_CREDENTIAL_MASTER_KEY=placeholder
MAIMAI_EMBEDDING_MODEL=BAAI/bge-m3
MAIMAI_EMBEDDING_MODEL_VERSION=bge-m3-v1
MAIMAI_EMBEDDING_DIMENSION=1024
MAIMAI_SYNC_TIMEZONE=Asia/Shanghai
MAIMAI_SUMMARY_API_BASE_URL=""
MAIMAI_SUMMARY_API_KEY=placeholder
MAIMAI_SUMMARY_MODEL=
MAIMAI_SUMMARY_MODEL_VERSION=
```

`MAIMAI_CREDENTIAL_MASTER_KEY` 必须是严格 Base64 编码的 32 字节值。缺少主密钥时只拒绝绑定和个人分析，不影响公共谱面查询。摘要模型配置为空时复用 Memory/Main 模型配置。

## 真实验收

2026-08-04 13:05 +08:00 完成误召回收敛复核：

- 固定路由矩阵包含 32 条普通聊天负例、9 条舞萌闲聊负例和 13 条正例，预期工具命中率为 100%；引用或历史中含舞萌而当前消息为普通聊天时，舞萌工具授权为 0。
- 功能关闭、AI Router 注入舞萌工具、模型伪造工具调用和标题均在执行前阻断，SQLite、LanceDB 与成绩查询调用为 0。
- 15 项舞萌回归通过；`npm run lint` 检查 812 个文件通过，`npm run typecheck`、`npm run check:prompts`、全仓与暂存区密钥扫描、`git diff --check` 均通过；完整 `npm test` 用时 166.9 秒并退出 0。
- 真实活动 generation 2 只读探针中，定数 13.7 至 14.0 的 DX 紫谱返回 5 条；`PANDORA PARADOXXX` 标准白谱唯一命中 `df:834:SD:4`，定数 15.0、物量 1342、映射置信度 1.0。写作手法、UI 交互、键盘滑键、数学定数和录音掉音 5 条探针的舞萌工具授权均为 0。
- 本轮未使用真实用户 Import-Token，不宣称完成个人成绩接口验收；同步、映射、特征、向量候选求交和玩家弱项算法未修改。

2026-08-04 10:55 +08:00 对 `data/maimai-diagnostic-20260804/maimai/catalog.sqlite` 只读复核：

- 活动 generation：2；同步完成时间：2026-08-04 10:08:16 +08:00。
- 曲目 1362；谱面 5432；解析率 100%。
- 确认映射 3792；隔离 1141；覆盖率 76.87%。
- 代表段 11376；文档 15168；向量 15168。
- 向量表：`maimai_chart_segments_baai_bge_m3_1024_bge_m3_v1_g2`。
- 真实混合查询耗时 579 ms。
- SQL 复核 `PANDORA PARADOXXX`：`df:834:SD:4`，Re:Master 15，定数 15.0，物量 1342，置信度 1.0，标签包含交互、纵连、双押、滑键组合、Break 和变速。

该 generation 的 3792 条摘要缓存均为 `deterministic`。真实数据同步和真实混合查询已完成，但没有对真实摘要模型和真实用户 Import-Token 做外部接口验收，不能据此宣称个人成绩链路已在线验证。

实际门禁命令：

```text
node --test tests/maimaiCatalogStore.test.js tests/maimaiChartDomain.test.js tests/maimaiCommands.test.js tests/maimaiNapcatIngressSecurity.test.js tests/maimaiPlannerRouting.test.js tests/maimaiPlayerService.test.js tests/maimaiPlayerStore.test.js tests/maimaiRetrieval.test.js tests/maimaiSourceClient.test.js tests/maimaiSummaryVector.test.js tests/maimaiSyncScheduler.test.js tests/maimaiSyncWorker.test.js tests/maimaiToolIsolation.test.js tests/maimaiToolsContract.test.js
npm run lint
npm run typecheck
npm run check:prompts
npm run check:secrets:all
npm run check:secrets
git diff --check
npm test
```

以上门禁在误召回收敛提交上全部通过。原始功能验收时曾出现的本机 ACL 测试失败已不再复现；当前运行时仍为 Node `v24.14.1`，超出项目声明的 `>=20 <21`，保留版本偏差。
