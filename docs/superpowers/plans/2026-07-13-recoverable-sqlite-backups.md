# Recoverable SQLite Backups Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为不可重建的 SQLite 数据建立每日 RPO、30 分钟 RTO、AES-256-GCM 加密异地副本和可重复恢复演练，并保留机器可读验收证据。

**Architecture:** 复用 `better-sqlite3.backup()` 生成 WAL 安全的一致性快照，先以 `quick_check` 验证明文快照，再流式加密并写入版本化 manifest，最后复制到独立备份根目录。恢复始终先解密到新文件并再次执行 `quick_check`；默认只演练到隔离目录，覆盖生产文件必须显式 `--apply`，并在目标27提供停机/关闭连接边界后才能接入生产替换流程。

**Tech Stack:** Node.js 20、CommonJS、better-sqlite3、Node `crypto` AES-256-GCM、项目自定义测试运行器。

---

## Chunk 1: Policy and backup artifact

### Task 1: Version the recovery policy

**Files:**
- Create: `config/recovery-policy.json`
- Test: `tests/sqliteBackupRecovery.test.js`

- [ ] **Step 1: Write the failing policy test**

验证策略版本为1，`rpoMinutes=1440`、`rtoMinutes=30`，`profile_journal.sqlite` 为必备源，`local_prompt_recall.sqlite` 明确标记为可由 prompts 重建；本地和异地备份根目录不得位于 `DATA_DIR` 内。

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/run-tests.js tests/sqliteBackupRecovery.test.js`
Expected: FAIL because `config/recovery-policy.json` does not exist.

- [ ] **Step 3: Add the minimal policy file**

策略只描述可验收目标、必备数据库、可重建数据库和默认保留天数；密钥和真实路径只从环境变量或 CLI 获取，不进入仓库。

- [ ] **Step 4: Re-run the policy test**

Run: `node scripts/run-tests.js tests/sqliteBackupRecovery.test.js`
Expected: policy assertions pass and the next missing backup API fails.

### Task 2: Create an authenticated encrypted backup artifact

**Files:**
- Create: `utils/sqliteBackup.js`
- Modify: `utils/sqliteConnection.js`
- Test: `tests/sqliteBackupRecovery.test.js`

- [ ] **Step 1: Add a live-database backup test**

测试库保持 WAL 连接并写入数据，备份期间继续写入另一条记录；断言快照是某一事务边界的完整状态、`quick_check=ok`，输出仅包含密文和 manifest，且异地目录有同一 SHA-256 的副本。

- [ ] **Step 2: Confirm the test fails before implementation**

Run: `node scripts/run-tests.js tests/sqliteBackupRecovery.test.js`
Expected: FAIL because `createEncryptedSqliteBackup` is missing.

- [ ] **Step 3: Implement the backup pipeline**

`createEncryptedSqliteBackup` 必须：

1. 使用现有统一连接策略打开源库。
2. 调用 `db.backup(plaintextTemp)` 生成在线一致性快照。
3. 对快照执行 `quick_check`。
4. 使用环境提供的32字节 base64 密钥流式 AES-256-GCM 加密。
5. 写入包含版本、源标识、时间、明文 SHA-256、密文 SHA-256、大小和完整性结果的 manifest。
6. 将密文与 manifest 复制到独立异地目录。
7. 删除仅由本次操作创建的明文临时快照；执行该步骤前必须取得用户删除授权。

- [ ] **Step 4: Cover wrong keys and tampered ciphertext**

错误密钥、截断密文和修改后的认证标签必须失败，不能生成可用恢复结果。

- [ ] **Step 5: Re-run the backup tests**

Run: `node scripts/run-tests.js tests/sqliteBackupRecovery.test.js tests/sqliteConcurrency.test.js`
Expected: all tests pass.

## Chunk 2: Restore drill and operational CLI

### Task 3: Restore into an isolated target and verify it

**Files:**
- Create: `utils/sqliteRestore.js`
- Create: `scripts/restore-sqlite-backup.js`
- Test: `tests/sqliteBackupRecovery.test.js`

- [ ] **Step 1: Add the restore drill test**

从异地密文和 manifest 恢复到全新目录，验证 SHA-256、AES-GCM、`quick_check`、关键表行数和原始业务值；默认不得覆盖已有文件。

- [ ] **Step 2: Confirm the restore test fails**

Run: `node scripts/run-tests.js tests/sqliteBackupRecovery.test.js`
Expected: FAIL because the restore API and CLI do not exist.

- [ ] **Step 3: Implement verified restore**

恢复流程先写入同目录临时文件，验证通过后原子改名为目标文件；`--apply` 覆盖现有库必须要求显式确认参数，并依赖目标27关闭所有数据库连接。

- [ ] **Step 4: Add structured drill evidence**

CLI 输出 JSON，至少包含 artifact id、source、target、startedAt、completedAt、durationMs、quickCheck、hashVerified 和 `rpoMinutes/rtoMinutes`；失败返回非零退出码。

- [ ] **Step 5: Re-run restore tests**

Run: `node scripts/run-tests.js tests/sqliteBackupRecovery.test.js`
Expected: valid restore passes; existing target, wrong key and corrupted artifact fail.

### Task 4: Add the backup CLI and real scheduling contract

**Files:**
- Create: `scripts/backup-sqlite.js`
- Modify: `.env.example`
- Modify: `docs/env-configuration.md`
- Test: `tests/sqliteBackupRecovery.test.js`

- [ ] **Step 1: Test argument and environment validation**

缺少密钥、本地/异地目录相同、目录位于 `DATA_DIR` 内、必备数据库缺失或路径重复时必须失败；可重建数据库缺失只记录 skipped。

- [ ] **Step 2: Implement the CLI**

默认从当前 config 去重读取 `PROFILE_JOURNAL_DB_FILE`、`PERSONA_WORLDBOOK_DB_FILE` 和 `LOCAL_PROMPT_RECALL_DB_FILE`；密钥只允许来自 `SQLITE_BACKUP_KEY_BASE64`，备份根目录来自 `SQLITE_BACKUP_DIR` 与 `SQLITE_BACKUP_OFFSITE_DIR`。

- [ ] **Step 3: Document RPO/RTO and scheduler ownership**

文档给出每天一次的 Windows Task Scheduler、cron 和容器外部调度示例；应用进程不自行持有备份定时器。异地目录必须是不同磁盘、网络挂载或宿主映射，不得只是 `data/` 子目录。

- [ ] **Step 4: Run the CLI against a test database**

Run: `node scripts/backup-sqlite.js --source <temp-db> --json`
Expected: local and offsite encrypted artifacts succeed with no plaintext snapshot left behind.

## Chunk 3: Verification and roadmap evidence

### Task 5: Run a complete recovery drill

**Files:**
- Modify: `README.md`
- Modify: `docs/maintenance-log.md`
- Modify: `docs/superpowers/plans/2026-07-12-repository-32-goals-roadmap.md`

- [ ] **Step 1: Run Node 20 and current-Node recovery tests**

Run the recovery and SQLite concurrency tests under Node 20.20.2 and the current local Node runtime.

- [ ] **Step 2: Run repository gates**

Run: `npm run lint`, `npm run typecheck`, `npm run check:prompts`, `npm run check:secrets:all`, `npm audit --omit=dev`, `git diff --check`.

- [ ] **Step 3: Run the full test suite**

Run: `$env:TEST_CONCURRENCY='4'; node scripts/run-tests.js`
Expected: exit 0 with the new recovery test included.

- [ ] **Step 4: Record evidence without overstating completion**

只有在加密异地副本、隔离恢复、真实 `quick_check` 和 RPO/RTO 文档均有当前证据时才能完成目标26。JSON/JSONL/LanceDB 的一致性全量快照仍依赖目标27的排空、flush 和资源关闭；该依赖未完成时必须在路线图中明确边界。

- [ ] **Step 5: Commit implementation and documentation separately**

Implementation commit includes utilities, CLIs, policy and tests. Documentation commit records timestamped verification and the remaining target27 dependency.
