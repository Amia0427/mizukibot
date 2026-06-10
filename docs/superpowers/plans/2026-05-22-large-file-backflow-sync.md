# Large File Backflow Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every feature added back into old large facade files after the split is discovered, migrated into the split modules, verified, and reflected in the split-status documents.

**Architecture:** Treat old large files as compatibility facades, not active feature homes. Each backflow pass starts from git history, maps feature deltas to the owning split module, migrates behavior in small commits, then updates README and cleanup notes with a timestamped status line.

**Tech Stack:** Node.js CommonJS, PowerShell, git, existing `node` test scripts.

---

## Scope

This plan covers old large files that were already marked as split but received feature updates after the split began. There are two levels:

1. **Must migrate:** old files with confirmed post-2026-05-19 feature backflow still visible in the old facade.
2. **Must audit:** old files touched later on 2026-05-19 where the same commit may already have moved code into split modules. These are not automatically migration work, but they must be checked before the plan is considered complete.

Confirmed must-migrate files:

- `config.js`
- `web/server.js`
- `core/continuousMessagePreprocessor.js`
- `core/router.js`
- `utils/memoryCli.js`
- `api/createAgentExecutor.js`

Additional must-audit files:

- `api/mcpRuntime.js`
- `utils/dailyJournal.js`
- `utils/memory-v3/query.js`
- `utils/personaMemoryState.js`
- `utils/shortTermMemory.js`

Do not touch unrelated large files in the same pass. If another old facade appears in `git log` or `git status`, add it to the audit table first and stop before editing code.

## Current Backflow Inventory

| Old file | Backflow features to preserve | Likely target modules |
| --- | --- | --- |
| `config.js` | planner semantic refine config, planner main-model fallback, MemOS recall governance/cache/circuit options, post-reply vector watchdog config, image visual summary config, widened main reply/short-term context limits | `config/envRuntime.js`, `config/promptRuntime.js`, or a new focused `config/*Runtime.js` module if existing split cannot own the settings cleanly |
| `web/server.js` | `/api/main-reply-context-preview` endpoint and Web UI table/refresh loop | `web/settingsRuntime.js`, `web/auth.js`, or new `web/mainReplyContextPreviewRoute.js` / `web/adminConsoleHtml.js` modules |
| `core/continuousMessagePreprocessor.js` | image visual summary enqueue during cached image ref creation | `core/continuousMessage/contentExtraction.js` or a new `core/continuousMessage/imageVisualSummary.js` helper |
| `core/router.js` | memory/image recall routing allows `memory_cli` in notebook/local-read routes | `core/router/safety.js`, `core/router/intentScoring.js`, or a new route helper if ownership is not safety/scoring |
| `utils/memoryCli.js` | image memory search normalization and merge into `source=all` search payload; MemOS/profile governance-related command additions from 2026-05-19 commits | existing `utils/memoryCli/*` helpers, or new `utils/memoryCli/imageRecall.js` and governance-specific helpers |
| `api/createAgentExecutor.js` | user-facing error for expired temporary image resource | existing `api/createAgent/*` response/error helper; create one if no response helper owns it |

## Current Audit-Only Inventory

These files are not yet confirmed migration work. They were touched by post-split same-day commits and must be reviewed so the plan does not miss late backflow.

| Old file | Commit evidence | Audit decision to make |
| --- | --- | --- |
| `api/mcpRuntime.js` | `d351d3f fix: stabilize MemOS MCP runtime integration` changed spawn args, added `discoverMcpServerTools`, and exported `__buildSpawnConfigForTest`; same commit also touched `api/mcp/config.js` | Decide whether these helpers should move to `api/mcp/protocol.js`, `api/mcp/config.js`, or a new split helper, or document why they remain facade-owned |
| `utils/dailyJournal.js` | `ffb5a5c Restrict MemOS to remote recall only` touched the old file while adding `utils/dailyJournal/memorySync.js`, `summaryRunner.js`, and `views.js` | Confirm the commit was completing the split, not adding new facade-owned behavior; migrate any remaining helper blocks if found |
| `utils/memory-v3/query.js` | `ffb5a5c` touched query behavior after earlier split files existed | Confirm query additions live in `queryPolicy.js`, `queryCandidates.js`, `queryRanking.js`, or another split module; migrate if old file still owns feature logic |
| `utils/personaMemoryState.js` | `ffb5a5c` touched old file while adding `utils/personaMemoryState/continuityCandidates.js` | Confirm continuity candidate behavior is fully in the split module |
| `utils/shortTermMemory.js` | `ffb5a5c` touched old file while adding `continuityDelta.js`, `restartRecall.js`, and `summaries.js` | Confirm old file only wires helpers and does not retain migrated behavior |

## Guardrails

- Before any code edit, run `git status --short` and `git diff -- <target files>`.
- If any target file is dirty before the pass starts, treat the dirty changes as another agent's work. Do not overwrite or reorder them.
- Do not delete old facade files. The goal is thin compatibility, not route removal.
- Keep require paths stable. Callers should keep using old public entrypoints unless the specific task says otherwise.
- For each old file, migrate one feature cluster at a time and commit separately when tests pass.
- Update docs in the same commit as each completed backflow cluster with a short timestamp.

## Chunk 1: Audit And Freeze Baseline

### Task 1: Capture the exact old-file delta surface

**Files:**
- Read: `config.js`
- Read: `web/server.js`
- Read: `core/continuousMessagePreprocessor.js`
- Read: `core/router.js`
- Read: `utils/memoryCli.js`
- Read: `api/createAgentExecutor.js`
- Read: `api/mcpRuntime.js`
- Read: `utils/dailyJournal.js`
- Read: `utils/memory-v3/query.js`
- Read: `utils/personaMemoryState.js`
- Read: `utils/shortTermMemory.js`
- Modify: this plan only if inventory changes

- [ ] **Step 1: Check working tree**

Run:

```powershell
git status --short --branch
```

Expected: Either clean or only known user changes. If dirty files overlap the must-migrate or must-audit files, inspect them before editing.

- [ ] **Step 2: List post-split commits touching old files**

Run:

```powershell
git log --since='2026-05-19' --name-only --pretty=format:'COMMIT %h %ad %s' --date=short -- config.js web\server.js core\continuousMessagePreprocessor.js core\router.js utils\memoryCli.js api\createAgentExecutor.js api\mcpRuntime.js utils\dailyJournal.js utils\memory-v3\query.js utils\personaMemoryState.js utils\shortTermMemory.js
```

Expected: Includes the known commits from this plan. Add any new commits to the inventory table before implementation.

- [ ] **Step 2b: Separate migration work from audit-only work**

Run:

```powershell
git show --stat --name-status --oneline d351d3f -- api\mcpRuntime.js api\mcp
git show --stat --name-status --oneline ffb5a5c -- utils\dailyJournal.js utils\dailyJournal utils\memory-v3\query.js utils\memory-v3\queryCache.js utils\memory-v3\queryPolicy.js utils\memory-v3\queryCandidates.js utils\memory-v3\queryRanking.js utils\personaMemoryState.js utils\personaMemoryState utils\shortTermMemory.js utils\shortTermMemory
```

Expected: If the matching split modules were created or modified in the same commit and old files only wire exports/imports, keep the file in audit-only status. If real feature logic remains in the old file, move it into must-migrate status before code edits.

- [ ] **Step 3: Inspect current file sizes**

Run:

```powershell
$files = @('config.js','web/server.js','core/continuousMessagePreprocessor.js','core/router.js','utils/memoryCli.js','api/createAgentExecutor.js','api/mcpRuntime.js','utils/dailyJournal.js','utils/memory-v3/query.js','utils/personaMemoryState.js','utils/shortTermMemory.js')
foreach ($f in $files) { $lines = (Get-Content -LiteralPath $f | Measure-Object -Line).Lines; "$lines`t$f" }
```

Expected: Confirms the old files are still large enough to justify backflow. Use this as the before snapshot.

- [ ] **Step 4: Commit audit-only doc updates if inventory changes**

Run:

```powershell
git add docs/superpowers/plans/2026-05-22-large-file-backflow-sync.md README.md docs/repo-cleanup.md
git commit -m "docs: update large file backflow inventory"
```

Expected: Commit only if the inventory changed.

## Chunk 2: Config Backflow

### Task 2: Move new config groups out of `config.js`

**Files:**
- Modify: `config.js`
- Modify: `config/envRuntime.js`
- Modify: `config/promptRuntime.js`
- Create only if needed: `config/memoryRuntime.js`
- Create only if needed: `config/postReplyRuntime.js`
- Test: relevant tests that read these config keys
- Docs: `README.md`, `docs/repo-cleanup.md`

- [ ] **Step 1: Group settings by owner**

Classify every post-split config key into one owner:

- planner/main model: `PLAN_*`, `PLANNER_*`
- MemOS recall: `MEMOS_*`
- post-reply/vector watchdog: `POST_REPLY_VECTOR_*`
- session/main reply context: `SESSION_CONTEXT_*`, `MAIN_REPLY_CONTEXT_*`, short-term limits
- image visual summary: `IMAGE_MEMORY_VISUAL_SUMMARY_*`

- [ ] **Step 2: Move one group at a time**

For each group, export a small object from the owning `config/*Runtime.js` module and spread it from `config.js`.

Expected shape:

```javascript
module.exports = {
  ...buildPlannerRuntimeConfig({ pick, pickNum, pickBool }),
  ...buildMemosRuntimeConfig({ pick, pickNum, pickBool, pickList }),
};
```

- [ ] **Step 3: Verify keys remain exported**

Run:

```powershell
node -e "const c=require('./config'); for (const k of ['PLANNER_SEMANTIC_REFINE_ENABLED','MEMOS_RECALL_CACHE_TTL_MS','POST_REPLY_VECTOR_WATCHDOG_ENABLED','IMAGE_MEMORY_VISUAL_SUMMARY_ENABLED']) { if (!(k in c)) throw new Error(k + ' missing'); } console.log('config backflow keys ok')"
```

Expected: `config backflow keys ok`.

- [ ] **Step 4: Run focused tests**

Run relevant tests found by:

```powershell
rg -n "PLANNER_SEMANTIC|MEMOS_RECALL|POST_REPLY_VECTOR_WATCHDOG|IMAGE_MEMORY_VISUAL_SUMMARY|MAIN_REPLY_CONTEXT" tests config.js utils core api web
```

Then run the matching `node tests/*.test.js` files.

- [ ] **Step 5: Update docs and commit**

Update `README.md` and `docs/repo-cleanup.md` with `YYYY-MM-DD HH:mm +08:00` and mark the config group as synced.

Run:

```powershell
git add config.js config README.md docs/repo-cleanup.md
git commit -m "refactor: sync config backflow into runtime modules"
```

## Chunk 3: Web Server Backflow

### Task 3: Move admin context preview route and UI out of `web/server.js`

**Files:**
- Modify: `web/server.js`
- Modify or create: `web/mainReplyContextPreviewRoute.js`
- Modify or create: `web/adminConsoleHtml.js`
- Test: `tests/*server*.test.js` or add focused route test if none exists
- Docs: `README.md`, `docs/repo-cleanup.md`

- [ ] **Step 1: Extract route registration**

Move the `/api/main-reply-context-preview` handler into a helper that accepts `{ app }` and registers the route.

Expected interface:

```javascript
function registerMainReplyContextPreviewRoute(app) {
  app.get('/api/main-reply-context-preview', (req, res) => {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
    return res.json({ ok: true, preview: buildMainReplyContextPreview({ limit }) });
  });
}
```

- [ ] **Step 2: Extract UI rendering block if practical**

If `web/server.js` embeds the whole admin console HTML, move only the context-preview HTML and client script into a small renderer helper. Do not rewrite the whole console in this pass.

- [ ] **Step 3: Verify endpoint**

Run existing server tests, or add a focused test that loads the route helper with a fake Express app.

Expected: route path, default limit, and max limit are preserved.

- [ ] **Step 4: Update docs and commit**

Run:

```powershell
git add web README.md docs/repo-cleanup.md tests
git commit -m "refactor: sync web context preview backflow"
```

## Chunk 4: Message Preprocessor Backflow

### Task 4: Move image visual summary enqueue helper out of `core/continuousMessagePreprocessor.js`

**Files:**
- Modify: `core/continuousMessagePreprocessor.js`
- Modify or create: `core/continuousMessage/imageVisualSummary.js`
- Test: `tests/continuousMessagePreprocessor.test.js`
- Docs: `README.md`, `docs/repo-cleanup.md`

- [ ] **Step 1: Extract `enqueueImageVisualSummarySafe`**

Move the helper to `core/continuousMessage/imageVisualSummary.js`.

Expected export:

```javascript
module.exports = { enqueueImageVisualSummarySafe };
```

- [ ] **Step 2: Keep call-site behavior identical**

`buildImageRefMap` must still pass `sourceUrl`, `mediaType`, `userId`, `groupId`, `sessionKey`, `messageId`, `sourceMessageId`, `imageSource`, `label`, `userText`, `awaitSummary`, and optional `postWithRetry`.

- [ ] **Step 3: Run test**

Run:

```powershell
node tests/continuousMessagePreprocessor.test.js
```

Expected: pass.

- [ ] **Step 4: Update docs and commit**

Run:

```powershell
git add core/continuousMessagePreprocessor.js core/continuousMessage README.md docs/repo-cleanup.md tests/continuousMessagePreprocessor.test.js
git commit -m "refactor: sync image summary preprocessor backflow"
```

## Chunk 5: Router And Memory CLI Backflow

### Task 5: Move route allowlist and image memory merge helpers into split modules

**Files:**
- Modify: `core/router.js`
- Modify or create: `core/router/memoryTools.js`
- Modify: `utils/memoryCli.js`
- Modify or create: `utils/memoryCli/imageRecall.js`
- Test: `tests/memoryCliImageRecall.test.js`, router-focused tests from `rg -n "memory_cli|notebook_search" tests`
- Docs: `README.md`, `docs/repo-cleanup.md`

- [ ] **Step 1: Extract router allowed-tool helper**

Create a helper that centralizes notebook/local-read allowed tools.

Expected behavior:

```javascript
getNotebookAllowedTools({ needsMemory: true }) // ['memory_cli', 'notebook_search', 'notebook_list_docs']
getNotebookAllowedTools({ needsMemory: false }) // ['notebook_search', 'notebook_list_docs']
```

- [ ] **Step 2: Extract image recall helpers**

Move `normalizeImageSearchHit` and `mergeImageSearchIntoPayload` from `utils/memoryCli.js` into `utils/memoryCli/imageRecall.js`.

Expected export:

```javascript
module.exports = { normalizeImageSearchHit, mergeImageSearchIntoPayload };
```

- [ ] **Step 3: Preserve parsed source behavior**

`runMemoryCli` must only merge image memory search when `parsed.source === 'all'` and `isImageRecallQuery(parsed.query)` is true.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
node tests/memoryCliImageRecall.test.js
rg -n "memory_cli|notebook_search|notebook_list_docs" tests
```

Then run the router tests returned by `rg`.

- [ ] **Step 5: Update docs and commit**

Run:

```powershell
git add core/router.js core/router utils/memoryCli.js utils/memoryCli README.md docs/repo-cleanup.md tests
git commit -m "refactor: sync router memory recall backflow"
```

## Chunk 6: Create-Agent Backflow

### Task 6: Move expired temporary resource message into create-agent response helper

**Files:**
- Modify: `api/createAgentExecutor.js`
- Modify or create: `api/createAgent/failureReply.js`
- Test: `tests/createAgentExecutor.test.js`
- Docs: `README.md`, `docs/repo-cleanup.md`

- [ ] **Step 1: Locate current failure reply ownership**

Search:

```powershell
rg -n "buildUserFacingFailureReply|resource is valid for 2 hours|生图临时资源已失效" api tests
```

- [ ] **Step 2: Extract or extend helper**

Move `buildUserFacingFailureReply` or only its error-pattern table into `api/createAgent/failureReply.js`.

Preserve the exact message:

```text
生图临时资源已失效，请重试或更换提示词
```

- [ ] **Step 3: Run test**

Run:

```powershell
node tests/createAgentExecutor.test.js
```

Expected: pass.

- [ ] **Step 4: Update docs and commit**

Run:

```powershell
git add api/createAgentExecutor.js api/createAgent README.md docs/repo-cleanup.md tests/createAgentExecutor.test.js
git commit -m "refactor: sync create agent failure backflow"
```

## Chunk 7: Final Split Status Refresh

### Task 7: Reclassify every old file after backflow

**Files:**
- Modify: `README.md`
- Modify: `docs/repo-cleanup.md`
- Optionally modify: this plan with final completion notes

- [ ] **Step 1: Recount lines**

Run:

```powershell
$files = @('config.js','web/server.js','core/continuousMessagePreprocessor.js','core/router.js','utils/memoryCli.js','api/createAgentExecutor.js','api/mcpRuntime.js','utils/dailyJournal.js','utils/memory-v3/query.js','utils/personaMemoryState.js','utils/shortTermMemory.js')
foreach ($f in $files) { $lines = (Get-Content -LiteralPath $f | Measure-Object -Line).Lines; "$lines`t$f" }
```

Expected: old files are smaller or at least have fewer feature-owned blocks.

- [ ] **Step 2: Check old files for known backflow phrases**

Run:

```powershell
rg -n "PLANNER_SEMANTIC|MEMOS_RECALL_CACHE|POST_REPLY_VECTOR_WATCHDOG|main-reply-context-preview|enqueueImageVisualSummarySafe|normalizeImageSearchHit|resource is valid for 2 hours" config.js web/server.js core/continuousMessagePreprocessor.js core/router.js utils/memoryCli.js api/createAgentExecutor.js
```

Expected: Either no matches in old files, or matches only in thin facade imports/exports.

- [ ] **Step 2b: Check audit-only files for unresolved feature ownership**

Run:

```powershell
rg -n "discoverMcpServerTools|__buildSpawnConfigForTest|memorySync|summaryRunner|continuityCandidates|continuityDelta|restartRecall|createShortTermSummaryHelpers" api/mcpRuntime.js utils/dailyJournal.js utils/memory-v3/query.js utils/personaMemoryState.js utils/shortTermMemory.js
```

Expected: Matches are imports/exports/wiring only, or are documented as intentionally facade-owned. If the old file still owns implementation logic, create a new migration task before final status refresh.

- [ ] **Step 3: Update split status**

In `README.md`, move completed items out of "需回流同步". In `docs/repo-cleanup.md`, replace the pending list with the remaining unsynced files and a timestamp.

- [ ] **Step 4: Run smoke tests**

Run:

```powershell
node -c config.js
node -c web/server.js
node -c core/continuousMessagePreprocessor.js
node -c core/router.js
node -c utils/memoryCli.js
node -c api/createAgentExecutor.js
```

Expected: all syntax checks pass.

- [ ] **Step 5: Final commit**

Run:

```powershell
git add README.md docs/repo-cleanup.md docs/superpowers/plans/2026-05-22-large-file-backflow-sync.md
git commit -m "docs: refresh large file backflow status"
```

## Completion Criteria

- Every known post-split feature in the six old files is either migrated to a split module or explicitly documented as intentionally remaining in the facade.
- Every must-audit file has a recorded decision: already synced, migrated in this plan, or intentionally facade-owned.
- README has a timestamped backflow status.
- `docs/repo-cleanup.md` lists only remaining unsynced old files.
- Focused tests for touched behavior pass.
- Old entrypoints still work through existing require paths.

## Final Execution Record

更新 2026-05-22 16:35 +08:00：18 个推进目标已执行完成。六个 must-migrate 旧入口均已把已知回流逻辑迁入拆分模块：`config/*Runtime.js`、`web/mainReplyContextPreview*`、`core/continuousMessage/imageVisualSummary.js`、`core/router/memoryTools.js`、`utils/memoryCli/imageRecall.js`、`api/createAgent/failureReply.js`。`api/mcpRuntime.js` 审计项已迁移到 `api/mcp/config.js` 和 `api/mcp/discovery.js`；其余 audit-only 入口复核为拆分模块 wiring/组合层。最终关键词复核仅剩薄 facade import/export 或测试断言匹配，语法 smoke 通过。
