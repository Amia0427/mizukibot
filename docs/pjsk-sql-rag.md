# PJSK 曲库、谱面分析与 RAG

更新时间：2026-08-05 10:57 +08:00

功能提交：`77e1b1c`

## 能力范围

PJSK 能力由 `src/features/pjsk/` 独立负责，通过现有 Router、工具执行器和 QQ 回复链路提供两个工具：

- `pjsk_song_search`：查询、筛选、比较或语义推荐已发布的日服曲目和谱面，最多返回 10 条。
- `pjsk_chart_analyze`：分析唯一命中的单张谱面，返回结构特征、最多 3 个代表段、数据 generation 和图片发送状态；歧义时最多返回 5 个候选。

首版不处理个人成绩、社区定数、歌词或 Web 管理页，也不会修改游戏数据。

## 使用方式

当前问题必须明确出现 `PJSK`、`Project Sekai`、`プロセカ` 或“世界计划”，并说明要查询曲库、难度、等级、物量或谱面结构。普通闲聊不会触发工具。

```text
PJSK 查洛基 MASTER 谱的等级和物量。
```

```text
PJSK 找 27 到 29 级、Flick 偏多的 MASTER 谱，返回 5 张。
```

```text
分析 PJSK Tell Your World MASTER 的密度、滑条和代表段。
```

```text
PJSK 看 Tell Your World MASTER 的谱面图。
```

私聊的唯一单谱分析会自动发送完整谱面图。群聊只有当前消息明确包含“谱面图”“看谱”或“发图”等意图时才发送；否则只返回文本分析。渲染、封面或发送失败时，文本结果仍保留并标记降级。

唯一成功结果会建立一次性引用。引用只允许同一用户、同一聊天类型的下一条消息使用，5 分钟后过期；无关消息立即清除，模糊结果不建立引用。例如获得唯一结果后，可在下一条发送“发这张谱面图”。

## 数据与存储

日服 Sekai-World master DB 是曲目、演唱版本、难度、等级和官方物量的唯一事实来源。简中 master DB 只按相同 `musicId` 提取简中和英文标题别名。SUS 与封面在运行时从 sekai.best 拉取，不提交进仓库。

默认目录为 `DATA_DIR/pjsk/`：

- `catalog.sqlite`：同步 generation、曲目、别名、标签、角色、演唱版本、谱面、原始 SUS、版本化特征、代表段和 FTS5。
- `lancedb/`：PJSK 独立向量表，不与记忆或舞萌索引混用。
- `covers/`：按需下载的封面缓存。
- `smoke/`：本地真实渲染验收输出。

谱面键固定为 `jp:<musicId>:<easy|normal|hard|expert|master|append>`。查询只暴露 `publishedAt <= 当前时间` 的数据；单张 SUS 解析失败或物量不一致时隔离该谱面，但曲目基础元数据仍可查询。

## 同步与 generation

启动后每 6 小时使用 ETag 检查一次 master；master 变化或有待发布内容到期时，再增量检查对应 SUS。没有活动 generation，或最后成功数据超过 24 小时时，启动后台同步；所有相关源均未变化时只记录 no-op。

新 SQL generation 只有在解析成功率和官方物量校验覆盖率都不低于 99% 时才能激活。向量写入在 SQL 激活后独立完成；失败时 generation 保持 `active_sql_only`。向量 generation 与当前 SQL generation 不一致时禁止使用旧向量冒充新数据。

镜像不可用时继续服务最后一个成功 generation。维护时应查看 `catalog.sqlite` 的活动 generation、最近同步状态和降级原因，不要手工切换 generation 或直接编辑原始 JSON 字段。

## 谱面分析与检索

SUS 固定由 `@next-sekai/sonolus-next-sekai-engine@2.4.3` 的 `susToUSC` 解析。版本化特征包含 Tap、Flick、Slide、Trace、Critical、多押、宽键、滑条持续时间、BPM、变速、平均密度和峰值密度。

代表段使用 8 秒窗口、2 秒步长，按动作数、Flick、滑条端点、多押、跨度和变速计算强度，最多选择 3 个互不重叠区间。技术标签按同等级谱面的分位数生成，不表示官方定数或主观难度结论。

检索先由别名、FTS 和结构化条件生成最多 100 个 SQL 候选，再将候选内容哈希作为 LanceDB 硬过滤条件。向量结果必须与 SQL 候选再次求交，只用于候选集内重排；embedding、LanceDB 或 generation 校验失败时返回 `sql_only`。

## 路由与执行保护

Router 只使用当前消息确认 PJSK 领域和数据意图，并只授权目标工具。执行器再次校验当前问题、工具类型、曲名和难度；模型补造曲名、`musicId`、难度或继承对象会在读取数据库前阻断。

一次性引用使用随机 token，并绑定用户与 private/group 类型。token 只能消费一次；过期、跨会话或重复使用都会返回引用失效。PJSK 后处理只清理原路由中已有的 PJSK 工具，不会改写其他功能的 `force_tools`。

## 图片渲染

渲染由锁定的 `pjsekai-scores-rs-skia-image==0.5.0` 完成。Python 子进程只从 stdin 读取 JSON/SUS，默认 15 秒超时；Node 端用 Sharp 校验 PNG，并限制为最多 32 MiPixel、8 MiB。

Docker 使用 CPython 3.11 wheel 哈希锁定安装，并安装 Noto CJK 字体。图片发送复用现有敏感词审查和 QQ base64 链路，不落入外部曲库或素材仓库。

## 配置

```dotenv
PJSK_ENABLED=false
PJSK_EMBEDDING_MODEL=BAAI/bge-m3
PJSK_EMBEDDING_MODEL_VERSION=bge-m3-v1
PJSK_EMBEDDING_DIMENSION=1024
PJSK_SUS_DOWNLOAD_CONCURRENCY=8
PJSK_PYTHON_BIN=/opt/pjsk-venv/bin/python
```

默认关闭功能。部署前安装 `requirements-pjsk.txt` 中锁定的 wheel，并将 `PJSK_PYTHON_BIN` 指向对应 Python；本地 Windows smoke 可以使用当前 `python` 环境。

## 验收与维护

常用命令：

```text
node scripts/run-tests.js tests/pjskCatalogRetrieval.test.js tests/pjskChartAnalysis.test.js tests/pjskRenderer.test.js tests/pjskRoutingTools.test.js tests/pjskSourceClient.test.js tests/pjskSyncScheduler.test.js tests/pjskSyncWorker.test.js
npm run lint
npm run typecheck
npm run check:prompts
npm run check:secrets:all
npm test
npm run smoke:pjsk
docker build -t mizukibot:pjsk-test .
```

2026-08-05 验收结果：

- 7 项 PJSK 回归通过；lint 检查 828 个文件通过；typecheck、Prompt、全仓及暂存区密钥扫描和 diff check 通过。
- 完整 `npm test` 用时 158.1 秒并退出 0。首次运行发现 PJSK 后处理误清普通操作路由，修复后相邻回归和完整测试通过。
- `npm run smoke:pjsk` 命中 `jp:1:master`：Tell Your World，MASTER 26；master DB 与解析物量均为 1147。
- smoke PNG 为 5248×2688、14,106,624 像素、1,143,348 字节且非空，封面缓存成功；QQ 私聊和群聊策略由伪发送测试验证，未向真实 QQ 发送图片。
- Docker 构建未通过。本机只有 Docker CLI，没有 daemon、Docker Desktop、WSL 或其他容器运行时，命令在 220.7 秒后因 `docker_engine` 不存在退出 1；不能据此宣称镜像已构建。

`prompts/admin.txt` 未修改，外部 master、SUS、封面、note 素材和 smoke PNG 均未提交。
