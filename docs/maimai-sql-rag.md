# 舞萌谱面 SQL/RAG

更新时间：2026-08-04 11:00 +08:00
功能提交：`5a53eb3`

用户入口：[使用说明](maimai-user-guide.md)；[更新公告](maimai-update-announcement-2026-08-04.md)。用户文档更新于 2026-08-04 12:19 +08:00。

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

## 检索

检索先由 SQL/FTS 产生最多 100 个候选，再将候选内容哈希作为 LanceDB 硬过滤条件。向量结果必须再次与 SQL 候选求交，embedding 失败时返回 `sql_only`。所有证据都包含数据版本、同步时间、映射置信度、检索模式和降级状态。

工具结果不能声称知道玩家的实际掉音位置。个人弱项只使用高置信成绩映射，以 Diving-Fish `avg/std_dev` 计算残差，再计算手法强度与残差的 Spearman 相关；有效成绩不足 20 张、单项非零样本不足 8 张或相关系数高于 -0.20 时不报告该弱项。

当前 Planner 对“手法、纵连、交互、滑键”等明确信号优先选择单谱分析。面向用户的多谱检索示例只组合曲名、定数、谱面类型和难度；需要按手法挑谱时，先搜索候选，再指定单谱分析。

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
node --test tests/maimaiCatalogStore.test.js tests/maimaiChartDomain.test.js tests/maimaiCommands.test.js tests/maimaiNapcatIngressSecurity.test.js tests/maimaiPlannerRouting.test.js tests/maimaiPlayerService.test.js tests/maimaiPlayerStore.test.js tests/maimaiRetrieval.test.js tests/maimaiSourceClient.test.js tests/maimaiSummaryVector.test.js tests/maimaiSyncScheduler.test.js tests/maimaiSyncWorker.test.js tests/maimaiToolsContract.test.js
npm run lint
npm run typecheck
npm run check:prompts
npm run check:secrets
git diff --cached --check
npm test
```

前六项通过。`npm test` 在 Node `v24.14.1` 下运行 158.9 秒后退出 1；单独复现为 `localAclScriptSource.test.js` 调用 `scripts/harden-local-acl.ps1` 时 `Path` 为空。13 个舞萌测试在定向和全量运行中均通过。项目声明 Node `>=20 <21`，本次没有在 Node 20 重跑，因此保留版本偏差。
