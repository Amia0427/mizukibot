# LangGraph V2 SQLite Store Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将 LangGraph V2 checkpoint 与关联事件原子写入 SQLite，在不批量迁移或改写旧 JSON 的前提下提供按 thread 的兼容读取、损坏隔离和可观测诊断。

**Architecture:** 新存储以 `DATA_DIR/langgraph_v2.sqlite` 为唯一在线写入端，checkpoint upsert 与同一状态转换产生的事件插入共享一个 `better-sqlite3` transaction。Checkpoint 按 SQLite 优先、无 SQLite 记录才读 legacy；event 在未被 tombstone 屏蔽时按 `legacy + SQLite` 合并，保证历史事件连续。旧 JSON 永久只读且不批量迁移；数据库物理完整性失败时拒绝启动，逻辑坏行则在单个 transaction 内移入 quarantine 并从在线表删除，避免下次 `quick_check` 把局部坏行升级成整库故障。

**Tech Stack:** Node.js 20 CommonJS、better-sqlite3 12、SQLite WAL、现有 `utils/sqliteConnection.js`、项目自有测试运行器

---

## Chunk 1: Atomic Store Contract

### Task 1: Establish the SQLite path and schema

**Files:**
- Create: `tests/langgraphV2SqliteStore.test.js`
- Modify: `config/index.js`
- Modify: `.env.example`
- Modify: `utils/langgraphV2Store.js`
- Modify: `core/messageTelemetry.js`
- Modify: `tests/messageTelemetry.test.js`
- Modify: `tests/runtimeHostShortTermBatchWiring.test.js`

- [x] **Step 1: Write failing path, schema, and close tests**

先只设置临时 `DATA_DIR`、清除 `LANGGRAPH_V2_STORE_FILE` 并重载 config，断言默认路径精确为 `path.join(DATA_DIR, 'langgraph_v2.sqlite')`。再显式设置 `LANGGRAPH_V2_STORE_FILE`、`LANGGRAPH_V2_CHECKPOINT_DIR`、`LANGGRAPH_V2_EVENT_DIR` 后清理项目模块缓存并加载 store，断言 `createCheckpointStore()` 只创建指定 SQLite 文件，不创建或写入 legacy 目录；数据库启用 WAL、foreign keys 和既有 busy timeout。`close()` 连续调用两次均不抛错，第一次关闭 handle，第二次不重复关闭。

数据库 schema 固定为：

```sql
CREATE TABLE langgraph_v2_checkpoints (
  thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  node TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object')
);

CREATE TABLE langgraph_v2_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json) AND json_type(event_json) = 'object')
);

CREATE TABLE langgraph_v2_legacy_tombstones (
  thread_id TEXT PRIMARY KEY,
  cleared_at INTEGER NOT NULL
);

CREATE TABLE langgraph_v2_quarantined_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  raw_payload TEXT,
  error TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  UNIQUE (source_kind, source_key)
);

CREATE INDEX langgraph_v2_checkpoints_status_updated_at
  ON langgraph_v2_checkpoints(status, updated_at);
CREATE INDEX langgraph_v2_events_thread_id_id
  ON langgraph_v2_events(thread_id, id);
```

- [x] **Step 2: Run the test and verify the storage boundary fails**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL because `LANGGRAPH_V2_STORE_FILE`, SQLite schema, and idempotent `close()` do not exist.

- [x] **Step 3: Implement only configuration, schema, and connection lifecycle**

`config/index.js` 新增 `LANGGRAPH_V2_STORE_FILE`，默认 `path.join(DATA_DIR, 'langgraph_v2.sqlite')`；两个 legacy 目录配置继续只用于兼容读取和诊断。`.env.example` 增加路径说明但不改变默认部署值。`createCheckpointStore(options, dependencies)` 支持显式 `options.storeFile`，生产默认取 config；若调用方显式传 `checkpointDir/eventDir` 却未传 `storeFile`，直接抛 `LANGGRAPH_V2_STORE_FILE_REQUIRED`，禁止静默写入默认生产库。

更新 `core/messageTelemetry.js`、`tests/messageTelemetry.test.js`、`tests/runtimeHostShortTermBatchWiring.test.js`，所有自定义 legacy 目录调用都显式传同一临时根目录下的 `storeFile`。Store 初始化只创建 SQLite 父目录，不创建 legacy 目录；模块跟踪打开的 store，实例 `close()` 幂等。

- [x] **Step 4: Run path and schema tests**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/runtimeHostShortTermBatchWiring.test.js tests/messageTelemetry.test.js`

Expected: PASS for configuration, schema, WAL/busy timeout, custom-path guard, and idempotent close assertions.

- [x] **Step 5: Commit the schema boundary**

```text
git add config/index.js .env.example utils/langgraphV2Store.js core/messageTelemetry.js tests/langgraphV2SqliteStore.test.js tests/messageTelemetry.test.js tests/runtimeHostShortTermBatchWiring.test.js
git commit -m "feat: add LangGraph V2 SQLite store"
```

### Task 2: Make checkpoint and event writes atomic

**Files:**
- Modify: `tests/langgraphV2SqliteStore.test.js`
- Modify: `utils/langgraphV2Store.js`

- [x] **Step 1: Add failing transition and rollback tests**

调用 `saveTransition(threadId, checkpoint, events)`，断言 checkpoint 与两条事件均可读取。创建 trigger 仅拒绝第二条 event insert，再尝试更新 checkpoint 并插入两条事件；断言调用抛错、旧 checkpoint 未变化、两条新事件均不存在，证明 checkpoint upsert 和整批 events 同时回滚。

- [x] **Step 2: Run the transaction test and verify it fails**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL because `saveTransition()` does not exist and current JSON writes cannot share one transaction.

- [x] **Step 3: Implement the minimal prepared statements and transaction**

保留 checkpoint compact/sanitize 逻辑。`saveTransition()` 规范化 checkpoint/event 后，在一个 `better-sqlite3` transaction 内 upsert checkpoint 并逐条插入事件；所有 SQL 使用 prepared statement。`saveCheckpoint()` 委托 `saveTransition(..., [])`，`appendEvents()` 使用只插入事件的 transaction。

- [x] **Step 4: Run transaction and compatibility tests**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/langgraphStoreSanitize.test.js tests/langgraphCheckpointSnapshot.test.js tests/messageTelemetry.test.js`

Expected: PASS; trigger failure leaves checkpoint and both events unchanged.

- [x] **Step 5: Commit atomic writes**

```text
git add utils/langgraphV2Store.js tests/langgraphV2SqliteStore.test.js
git commit -m "feat: persist LangGraph V2 transitions atomically"
```

### Task 3: Add lazy legacy reads and atomic tombstones

**Files:**
- Modify: `tests/langgraphV2SqliteStore.test.js`
- Modify: `utils/langgraphV2Store.js`

- [x] **Step 1: Add failing lazy-read and precedence tests**

创建两个 legacy thread：目标 thread 含有效 checkpoint/event，探针 thread 含损坏 JSON。记录全部文件的 bytes、mtime 与 hash。Store 创建后断言所有 SQLite 表为空且 quarantine 为 0；读取目标 thread 后仍无 SQLite checkpoint/event/quarantine，证明没有扫描、复制或批量迁移探针 thread。

规则固定为：SQLite 有有效 checkpoint 时覆盖 legacy checkpoint；没有 SQLite checkpoint 且无 tombstone 时才返回 legacy checkpoint。Event 在无 tombstone 时始终返回 `legacy + SQLite`，按 legacy 数组原顺序和 SQLite 自增 id 顺序拼接；tombstone 存在时只返回 SQLite event。SQLite checkpoint 被识别为坏行后禁止回退 legacy，规则在 Task 4 验证。

- [x] **Step 2: Run lazy compatibility tests and verify they fail**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL because the current implementation has no legacy adapter or SQLite precedence rules.

- [x] **Step 3: Implement per-thread legacy reads**

只根据 `sanitizeThreadId(threadId)` 拼出目标 JSON 路径并读取这一份文件；不枚举 legacy 目录。读取不写 SQLite，不修改文件。写入 transition 后 checkpoint 取 SQLite，events 返回 `legacy + SQLite`。

- [x] **Step 4: Run lazy-read tests and verify they pass**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: PASS for per-thread lazy access, checkpoint precedence, event merge order, and legacy non-mutation.

- [x] **Step 5: Add failing clear rollback tests**

先写入 SQLite checkpoint/event，再调用 `clear(threadId)`，断言 checkpoint/event 删除与 tombstone upsert 属于同一个 transaction，legacy 文件保持不变且不再可见。再次写同 thread 后只显示新 SQLite 数据，tombstone 永久保留以防旧事件复活。

再创建一个拒绝 tombstone insert 的 trigger，调用 `clear()` 后断言失败、原 SQLite checkpoint/event 均回滚保留，load 仍返回 SQLite checkpoint；不出现“删除成功但 tombstone 失败”的中间状态。

- [x] **Step 6: Run clear tests and verify they fail**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL because `clear()` 尚未用一个 transaction 管理 delete 与 tombstone。

- [x] **Step 7: Implement transactional clear and run tests**

用一个 prepared transaction 依次执行 checkpoint delete、event delete、legacy tombstone upsert；任一步失败由 `better-sqlite3` 自动回滚全部操作。Tombstone 表示永久屏蔽 legacy，不表示当前 SQLite thread 已删除，因此后续 `saveCheckpoint()`、`appendEvents()` 或 `saveTransition()` 都不得删除 tombstone。

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/messageTelemetry.test.js`

Expected: PASS; legacy bytes/mtime/hash 不变，lazy-read 探针未被扫描，clear 失败时三项操作全部回滚。

- [x] **Step 8: Commit legacy compatibility**

```text
git add utils/langgraphV2Store.js tests/langgraphV2SqliteStore.test.js
git commit -m "feat: read legacy LangGraph data lazily"
```

### Task 4: Quarantine logical bad rows and reject physical corruption

**Files:**
- Modify: `tests/langgraphV2SqliteStore.test.js`
- Modify: `utils/langgraphV2Store.js`

- [x] **Step 1: Add failing legacy quarantine tests**

Legacy checkpoint 损坏时返回 `null` 并记录 `legacy_checkpoint`；legacy event 不是数组时只忽略 legacy 部分并保留 SQLite events，记录 `legacy_events`。Legacy `source_key` 固定为 `absolute_path + SHA-256(raw bytes)`；重复读取同一坏文件不重复 quarantine，文件变化后允许新增一条诊断。Legacy quarantine 只保存 source key、thread、错误和时间，不复制大文件。

- [x] **Step 2: Run legacy quarantine tests and verify they fail**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL because legacy parse errors are not recorded.

- [x] **Step 3: Implement minimal legacy quarantine and run tests**

Legacy 文件不存在（`ENOENT`）视为正常缺失；其他 read error 使用 `source_key=<absolute path>:read:<error code>`，解析失败或顶层 shape 错误先对原始 bytes 计算 SHA-256，再使用 `source_key=<absolute path>:<digest>`。通过 prepared `INSERT OR IGNORE` 写入 source kind、source key、thread、错误和时间，`raw_payload` 保持 `NULL`；quarantine 写入失败必须向上抛错，不能静默返回空值掩盖诊断丢失。

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: PASS for legacy isolation, stable deduplication, and source-file preservation.

- [x] **Step 4: Add failing SQLite bad-row isolation tests**

测试连接临时关闭 CHECK 约束并插入：一个坏 checkpoint、同 thread 的一个坏 event 与两个有效 event、另一个 thread 的有效 checkpoint/event。先在 store 保持打开时读取，验证每个坏行在单个 transaction 内被原子插入 quarantine 并从在线表删除；坏 checkpoint 同时 upsert legacy tombstone，因而不得回退旧 checkpoint。SQLite checkpoint `source_key=checkpoint:<threadId>:<SHA-256(raw)>`，event `source_key=event:<rowId>`。

断言同 thread 的两个有效 event 和另一个 thread 全部可读，坏行 raw payload 保存在 quarantine，重复读取不增加记录。另建数据库，插入同类坏行后先关闭，再调用 `createCheckpointStore()`：若 `quick_check` 消息全部且仅为两个已知 payload 表的 CHECK 违规，启动流程必须先隔离所有逻辑坏行、删除源行并复检；复检为 `ok` 才允许启动。关闭并再次重开后 `quick_check` 仍为 `ok`，隔离结果与 tombstone 仍生效。

- [x] **Step 5: Run SQLite isolation tests and verify they fail**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL because bad payloads are neither moved nor deleted atomically.

- [x] **Step 6: Implement transactional row isolation**

运行期解析失败只处理目标 checkpoint 或目标 thread 查询返回的坏 event，不扫描其他 thread。每条 SQLite 坏行在一个 transaction 内执行 `INSERT OR IGNORE quarantine`、必要的 legacy tombstone、`DELETE source row`；任一步失败则坏行保留且错误上抛，不形成半隔离状态。启动期只有当 `quick_check` 的每一条消息都匹配 `CHECK constraint failed in langgraph_v2_checkpoints|langgraph_v2_events` 时，才查询这两个表的 `NOT json_valid(...) OR json_type(...) != 'object'` 行并用相同 transaction 隔离；包含任何其他消息时禁止修复并直接 fail closed。

- [x] **Step 7: Run row-isolation tests and verify they pass**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: PASS for runtime isolation, pre-start isolation, same-thread valid-event preservation, restart health, and legacy suppression.

- [x] **Step 8: Add fail-closed physical integrity tests**

覆盖两条分支：随机文本文件使 SQLite open/pragma 抛错；第二个参数 `dependencies.runQuickCheck` 返回 `{ ok: false, messages: ['synthetic btree corruption'] }`，覆盖数据库可打开但 `quick_check` 非 ok。两种情况都抛稳定 `LANGGRAPH_V2_STORE_CORRUPT`，原文件 bytes/hash 不变，不重命名、删除、截断或创建替代库。

- [x] **Step 9: Run integrity tests and verify they fail**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: FAIL until open errors and non-ok `quick_check` are normalized to fail-closed behavior.

- [x] **Step 10: Implement fail-closed health checks and run Chunk 1 tests**

已有数据库在 schema 初始化前执行 `quick_check`；新库在建表后执行。除两个已知 payload 表的纯 CHECK 违规外，open/pragma/quick-check 错误都关闭已打开 handle，再抛带 `code='LANGGRAPH_V2_STORE_CORRUPT'` 的错误，不更改原文件。逻辑坏行隔离后必须再次执行完整 `quick_check`；复检任何非 `ok` 结果同样 fail closed。

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/langgraphStoreSanitize.test.js tests/langgraphCheckpointSnapshot.test.js tests/messageTelemetry.test.js tests/runtimeHostShortTermBatchWiring.test.js`

Expected: PASS;关闭重开后 quick check 仍为 `ok`，所有 logical/physical corruption 边界均满足。

- [x] **Step 11: Commit isolation behavior**

```text
git add utils/langgraphV2Store.js tests/langgraphV2SqliteStore.test.js
git commit -m "fix: isolate corrupt LangGraph V2 records"
```

## Chunk 2: Runtime Atomic Boundaries

### Task 5: Route ordinary node transitions through one transaction

**Files:**
- Create: `api/runtimeV2/host/persistence.js`
- Create: `tests/runtimeV2Persistence.test.js`
- Modify: `api/runtimeV2/host/index.js`

- [x] **Step 1: Write failing runtime persistence tests**

用 spy store 构造 runtime persistence helper，调用 `saveAndEmit(state, node, status, events)` 后断言：

- 只调用一次 `store.saveTransition(threadId, checkpoint, events)`，不分别调用 `saveCheckpoint()`/`appendEvents()`。
- checkpoint 使用 compact 后的 `snapshotState(state)` 和同一 `nowTs()`。
- request trace、`onEvent` 回调等外部发布只发生在 transaction 成功之后。
- `saveTransition()` 抛错时，不发布 request trace 和事件回调，错误原样向上抛。

- [x] **Step 2: Run the persistence test and verify it fails**

Run: `node scripts/run-tests.js tests/runtimeV2Persistence.test.js`

Expected: FAIL because host currently appends events before saving the checkpoint and has no isolated persistence helper.

- [x] **Step 3: Extract the runtime persistence helper**

`api/runtimeV2/host/persistence.js` 只负责三类操作：独立 checkpoint、独立事件、checkpoint+events transition。它接收已有的 normalize/trace/emit/snapshot 依赖，避免重新实现事件发布规则；host 保留 latency state 组装，随后调用 helper 的原子 transition。独立事件仍用于 preflight 遥测，独立 checkpoint 仅用于没有对应事件的明确场景。

- [x] **Step 4: Run persistence tests and verify they pass**

Run: `node scripts/run-tests.js tests/runtimeV2Persistence.test.js tests/runtimeV2DirectReplyFailureTelemetry.test.js tests/messageTelemetry.test.js`

Expected: PASS; ordinary node transition uses one store transaction, and transaction failure publishes no external event.

### Task 6: Make side-effect checkpoint boundaries atomic

**Files:**
- Modify: `api/runtimeV2/nodes/dispatch.js`
- Modify: `api/runtimeV2/host/index.js`
- Modify: `tests/toolPolicyRuntimeEffects.test.js`

- [x] **Step 1: Add failing dispatch transition assertions**

在现有 dispatch spy 测试中分别执行串行 side effect 与并发 batch side effect，断言 `before_side_effect`、`after_side_effect` 各自只调用一次 `saveTransition(state, 'dispatch', 'running', events)`；事件中的 step id 与同一调用 state 的 `pendingInterrupt` 必须匹配。Preflight start/complete 继续只调用 `appendRuntimeEvents()`。

- [x] **Step 2: Run dispatch tests and verify they fail**

Run: `node scripts/run-tests.js tests/toolPolicyRuntimeEffects.test.js`

Expected: FAIL because dispatch still calls append and checkpoint persistence separately around side effects.

- [x] **Step 3: Replace paired writes with one transition call**

`dispatch` 的 `before_side_effect` 与 `after_side_effect` 当前均为先 `appendRuntimeEvents()` 再 `persistCheckpoint()`。将这两处和并发 side-effect batch 改为一次 `saveTransition(dispatchState, 'dispatch', 'running', checkpointEvents)`；preflight start/complete 仍只追加事件。更新现有 spy 测试，断言副作用边界各执行一次 transition，事件与 `pendingInterrupt` 状态属于同一次调用。

- [x] **Step 4: Run dispatch tests and verify they pass**

Run: `node scripts/run-tests.js tests/toolPolicyRuntimeEffects.test.js tests/runtimeV2Persistence.test.js tests/runtimeV2DirectReplyFailureTelemetry.test.js`

Expected: PASS; side-effect checkpoint/event pairs no longer have a split-write window.

### Task 7: Close the previous runtime during hot reset

**Files:**
- Modify: `api/runtimeV2/host/index.js`
- Modify: `tests/runtimeSingletonHotReload.test.js`

- [x] **Step 1: Add failing handle-close assertions**

测试显式设置临时 `DATA_DIR` 和 `LANGGRAPH_V2_STORE_FILE`，取得 first runtime/store handle 后调用 `resetRuntime()`；断言旧 handle 关闭、新 runtime 使用新 handle、连续 reset 不抛错，最终 close 后临时 SQLite 文件可在 Windows 上重命名并改回，证明没有旧连接持锁。

- [x] **Step 2: Run hot-reset tests and verify they fail**

Run: `node scripts/run-tests.js tests/runtimeSingletonHotReload.test.js`

Expected: FAIL because `resetRuntime()` currently drops the singleton reference without closing its store.

- [x] **Step 3: Close before replacing the singleton**

`resetRuntime()` 在替换 singleton 前调用旧 `runtimeSingleton.store.close()`；重复 reset 不得抛错。测试在临时 `DATA_DIR` 创建 runtime，保存 SQLite handle，reset 后断言旧 handle 已关闭、新 runtime 使用新 handle，Windows 临时目录不再因旧 singleton 被锁定。

- [x] **Step 4: Run focused runtime tests**

Run: `node scripts/run-tests.js tests/runtimeV2Persistence.test.js tests/toolPolicyRuntimeEffects.test.js tests/runtimeSingletonHotReload.test.js tests/runtimeV2DirectReplyFailureTelemetry.test.js tests/messageTelemetry.test.js`

Expected: PASS; transaction 失败时没有对外发布事件，副作用 checkpoint 和 event 不再分两次写。

- [x] **Step 5: Commit runtime atomic boundaries**

```text
git add api/runtimeV2/host/persistence.js api/runtimeV2/host/index.js api/runtimeV2/nodes/dispatch.js tests/runtimeV2Persistence.test.js tests/toolPolicyRuntimeEffects.test.js tests/runtimeSingletonHotReload.test.js
git commit -m "fix: make runtime V2 persistence atomic"
```

## Chunk 3: Concurrency, Diagnostics, and Shutdown

### Task 8: Verify concurrent SQLite writers

**Files:**
- Modify: `tests/langgraphV2SqliteStore.test.js`

- [x] **Step 1: Add a failing multi-process concurrency case**

复用 `tests/sqliteConcurrency.test.js` 的 worker-flag 模式：4 个子进程同时写同一 SQLite 文件，每个 worker 对独立 thread 写 30 次 transition。全部退出后断言 4 个 checkpoint 均为最后版本、事件总数精确为 120、每个 thread 的 30 个事件都存在且无重复，并执行 `quick_check`。

- [x] **Step 2: Run the concurrency case and record the result**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js`

Expected: PASS if Chunk 1 的 WAL/busy-timeout/schema initialization 已覆盖多进程竞争；若 FAIL，错误必须明确指向丢事件、重复、`SQLITE_BUSY` 或 schema race，随后才进入 Step 3。

- [x] **Step 3: Apply only concurrency fixes required by the test**

若测试暴露 schema 初始化竞争或 `SQLITE_BUSY`，只通过已有 `openSqliteDatabase()` 的 busy timeout、WAL 和 prepared transaction 修正 store；不引入应用级队列或全局锁。每个 worker 在退出前调用 `store.close()`。

- [x] **Step 4: Run concurrency tests and verify they pass**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/sqliteConcurrency.test.js`

Expected: PASS; 120 个事件无丢失/重复且最终 `quick_check` 为 `ok`。

### Task 9: Expose SQLite and legacy health in runtime diagnostics

**Files:**
- Modify: `utils/langgraphV2Store.js`
- Modify: `utils/runtimeStatusDiagnostics/stores.js`
- Modify: `utils/runtimeStatusDiagnostics/index.js`
- Modify: `tests/runtimeStatusDiagnostics.test.js`

- [x] **Step 1: Add failing diagnostics assertions**

在 `runtimeStatusDiagnostics.test.js` 的临时数据目录中同时创建：

- SQLite checkpoint：一个 stale running、一个 completed。
- SQLite events：两个有效事件。
- 一条 quarantine。
- 一个有效 legacy checkpoint/event，以及一个损坏 legacy event 文件。

断言报告明确区分 `sqlite` 与 `legacy`：SQLite 文件路径、存在性、`quick_check` 健康状态、checkpoint/event 记录数、active/stale 数、数据库字节数、quarantine 数；legacy 保留文件数、字节数、坏文件列表。总览文本显示 SQLite health 和 quarantine。物理损坏 SQLite 返回 `langgraph_v2_store_corrupt` error signal；单条 quarantine 与 legacy 损坏返回 warning，不使诊断器自身崩溃。

- [x] **Step 2: Run diagnostics tests and verify they fail**

Run: `node scripts/run-tests.js tests/runtimeStatusDiagnostics.test.js`

Expected: FAIL because diagnostics only reports legacy JSON directories.

- [x] **Step 3: Implement read-only SQLite diagnostics**

`inspectCheckpointStore()` 仅在文件存在时用 readonly/fileMustExist 连接，执行 `quick_check` 和固定统计查询后立即关闭，不创建表、不写 WAL、不 quarantine。`buildLangGraphV2StoreSummary()` 合并该结构与现有 legacy 扫描结果，但不把 SQLite thread 与同名 legacy 文件重复伪装为“唯一总数”；顶层 summary 使用显式的 `sqliteCheckpoints/sqliteEvents/legacyCheckpointFiles/legacyEventFiles` 字段。

- [x] **Step 4: Run diagnostics tests and verify they pass**

Run: `node scripts/run-tests.js tests/runtimeStatusDiagnostics.test.js`

Expected: PASS; missing/healthy/corrupt SQLite and valid/invalid legacy inputs all produce stable serializable diagnostics.

### Task 10: Register LangGraph in global SQLite shutdown

**Files:**
- Modify: `utils/langgraphV2Store.js`
- Modify: `utils/sqliteRuntime.js`
- Modify: `tests/sqliteRuntimeShutdown.test.js`

- [x] **Step 1: Add failing global-close assertions**

先显式打开 LangGraph store，再调用 `closeLoadedSqliteConnections()`；断言返回列表包含 `langgraphV2Store`、handle 已关闭、第二次 global close 不抛错，之后可重开并读取原记录。

- [x] **Step 2: Run shutdown tests and verify they fail**

Run: `node scripts/run-tests.js tests/sqliteRuntimeShutdown.test.js`

Expected: FAIL because `utils/sqliteRuntime.js` does not know the LangGraph store.

- [x] **Step 3: Implement module-level closeDb**

`utils/langgraphV2Store.js` 的 `closeDb()` 遍历模块跟踪集合并幂等关闭全部实例；`utils/sqliteRuntime.js` 增加 `langgraphV2Store` 项并调用该导出。

- [x] **Step 4: Run diagnostics and shutdown tests**

Run: `node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/runtimeStatusDiagnostics.test.js tests/sqliteRuntimeShutdown.test.js tests/runtimeSingletonHotReload.test.js`

Expected: PASS; SQLite 结构损坏被报告为 error，局部 payload/legacy 损坏被报告为 warning，所有连接均可关闭重开。

- [x] **Step 5: Commit concurrency, diagnostics, and shutdown**

```text
git add utils/langgraphV2Store.js utils/runtimeStatusDiagnostics/stores.js utils/runtimeStatusDiagnostics/index.js utils/sqliteRuntime.js tests/langgraphV2SqliteStore.test.js tests/runtimeStatusDiagnostics.test.js tests/sqliteRuntimeShutdown.test.js
git commit -m "feat: diagnose LangGraph V2 SQLite health"
```

## Chunk 4: Acceptance and Evidence

### Task 11: Verify both supported Node runtimes and record the migration boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/development/02-architecture-map.md`
- Modify: `docs/development/03-message-and-agent-runtime.md`
- Modify: `docs/development/06-testing-and-quality.md`
- Modify after implementation commit: `docs/maintenance-log.md`
- Modify after implementation commit: `docs/superpowers/plans/2026-08-02-langgraph-v2-sqlite-store.md`

- [x] **Step 1: Run focused Node 20 and current-Node acceptance**

Run on the verified Node 20.20.2 runtime and the current Node runtime:

```text
node scripts/run-tests.js tests/langgraphV2SqliteStore.test.js tests/runtimeV2Persistence.test.js tests/toolPolicyRuntimeEffects.test.js tests/runtimeStatusDiagnostics.test.js tests/runtimeSingletonHotReload.test.js tests/sqliteRuntimeShutdown.test.js tests/messageTelemetry.test.js
```

Expected: both exit 0. Node 20 uses the existing ABI 115 `better-sqlite3` hook and system npm path already established by the Harness verification.

- [x] **Step 2: Run repository acceptance**

Run:

```text
npm run lint
npm run typecheck
npm run check:agent:static
npm run check:prompts
npm run check:secrets:all
git diff --check
npm test
npm run coverage
```

Expected: every command exits 0 and coverage gates remain at or above the calibrated Node 20 thresholds.

- [x] **Step 3: Verify production-data non-mutation and diagnostics**

再次计算 `data/langgraph_v2_checkpoints` 与 `data/langgraph_v2_events` 的文件数量、总字节数、逐文件 hash 集合和最近 mtime；与实现前基线对比必须完全一致。运行 `npm run diag:runtime -- --json`，确认 SQLite health、legacy 文件规模和 quarantine 字段存在；诊断命令不得创建、修改或迁移 legacy 文件。

基线（2026-08-02 +08:00）：120 个 checkpoint、137,990,244 bytes、6209 个 event 文件、80,529,200 bytes；JSON 结构损坏数均为 0，最近 24 小时写入分别为 9/25。

- [x] **Step 4: Update stable documentation after implementation commits**

更新 README 和三份 development 文档，明确新写入端、legacy 只读规则、tombstone、故障等级、临时 `DATA_DIR/LANGGRAPH_V2_STORE_FILE` 测试要求和诊断字段。文档引用本计划全部实现提交 hash；不暂存未跟踪 `AGENT.md`，不推送远端。

- [x] **Step 5: Append timestamped verification evidence**

在 README、维护日志和本计划追加简短时间戳、实现提交 hash、Node 20/当前 Node 聚焦与全量验收结果、覆盖率和 legacy hash 对比结论，再创建独立文档提交：

```text
docs: record LangGraph V2 SQLite verification
```

保护检查：不暂存 `AGENT.md`；`AGENT.md` 与 `prompts/admin.txt` 的既有保护 hash 必须保持不变；不推送远端。

## 实际验收记录

**2026-08-02 17:21 +08:00：** 实现提交 `0a45d71`、`e2664a1`、`21e3080`、`3cfd85b`、`cc5468d`、`654170a` 已完成；提交 `662914a` 补齐 SQLite 测试连接关闭与独立诊断路径。最终计划审查为 `APPROVED`。

- Node 20.20.2（ABI 115 hook）与 Node 24.14.1 聚焦测试通过；新增生命周期回归合并后，完整测试为 574/574。
- `npm run lint`（804 文件）、`npm run typecheck`、`npm run check:agent:static`、`npm run check:prompts`、`npm run check:secrets:all`、`git diff --check`、`npm test` 和 `npm run coverage` 均通过。
- 覆盖率：Statements/Lines `72.19%`、Branches `62.18%`、Functions `80.00%`；overall-production `72.20/80.01/62.19`、web `79.84/87.50/80.59`、Runtime V2 non-chunk `77.97/75.33/63.86`、stable boundaries `86.00/82.47/72.76`（行/函数/分支），全部基线通过。
- `diag:runtime -- --json` 报告 SQLite `healthy`、`quick_check=ok`、0 checkpoint、0 event、0 quarantine。Legacy 保持 120/6209 文件、137,990,244/80,529,200 bytes、0 坏 JSON，聚合 SHA-256 分别为 `03a2b843ee304ddcf7644f7e112d8af1eeb8e9a60e2a8f2de78cde9c311a3b19`、`b32db4452e9c3a4eb75f1884165c77ac06b8c7f6311601fba996667455869686`。
- `AGENT.md` 与 `prompts/admin.txt` SHA-256 分别保持 `B9289694CCC4820507B75DBF26746C778E4ED574004EB5DBF9FBDD10D49788FF`、`2D42628CF64AB3235F1AB7AE6306081CA0FBCE8114AB344B193F686A7DB7C607`；未推送远端。
