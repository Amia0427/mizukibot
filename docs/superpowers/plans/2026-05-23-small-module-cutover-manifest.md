# Small Module Cutover Manifest

更新 2026-05-23 09:17 +08:00：本清单限定本轮可备份和删除的旧大文件。执行时不得删除清单外文件，不得删除 `data/**`、`api/legacy/aiHost.js`、`core/*.chunk.js`、`api/runtimeV2/context/*.chunk.js`。

## Backup

- Directory: `artifacts/backups/`
- Archive pattern: `large-facades-small-module-cutover-2026-05-23-0917+0800.zip`
- Hash file: `large-facades-small-module-cutover-2026-05-23-0917+0800.zip.sha256`

## Batch 1: Boot Chain

- `config.js` -> `config/index.js`
- `web/server.js` -> `web/server/index.js`
- `core/tickEngine.js` -> `core/tickEngine/index.js`
- `api/createAgentExecutor.js` -> `api/createAgentExecutor/index.js`
- `api/mcpRuntime.js` -> `api/mcpRuntime/index.js`

## Batch 2: Main Reply Chain

- `core/router.js` -> `core/router/index.js`
- `core/messageRouteFlow.js` -> `core/messageRouteFlow/index.js`
- `api/runtimeV2/host.js` -> `api/runtimeV2/host/index.js`
- `api/toolExecutors.js` -> `api/toolExecutors/index.js`
- `api/memoryExtraction.js` -> `api/memoryExtraction/index.js`
- `utils/memoryContext.js` -> `utils/memoryContext/index.js`
- `utils/memoryCli.js` -> `utils/memoryCli/index.js`
- `utils/shortTermMemory.js` -> `utils/shortTermMemory/index.js`
- `utils/personaMemoryState.js` -> `utils/personaMemoryState/index.js`
- `utils/dailyJournal.js` -> `utils/dailyJournal/index.js`
- `utils/memoryWritePipeline.js` -> `utils/memoryWritePipeline/index.js`

## Batch 3: Split Facades

- `api/qzoneDiaryService.js` -> `api/qzoneDiaryService/index.js`
- `core/continuousMessagePreprocessor.js` -> `core/continuousMessagePreprocessor/index.js`
- `utils/memeStore.js` -> `utils/memeStore/index.js`
- `utils/memory.js` -> `utils/memory/index.js`
- `utils/localKnowledge.js` -> `utils/localKnowledge/index.js`
- `utils/toolPolicy.js` -> `utils/toolPolicy/index.js`
- `utils/lancedbMemoryStore.js` -> `utils/lancedbMemoryStore/index.js`
- `utils/runtimeStatusDiagnostics.js` -> `utils/runtimeStatusDiagnostics/index.js`
- `utils/personaWorldbookSearch.js` -> `utils/personaWorldbookSearch/index.js`
- `utils/contextCompaction.js` -> `utils/contextCompaction/index.js`
- `utils/mainReplyDiagnostics.js` -> `utils/mainReplyDiagnostics/index.js`
- `utils/postReplyJobQueue.js` -> `utils/postReplyJobQueue/index.js`
- `utils/memoryGovernance.js` -> `utils/memoryGovernance/index.js`
- `utils/socialContextRuntime.js` -> `utils/socialContextRuntime/index.js`
- `utils/modelCallTracker.js` -> `utils/modelCallTracker/index.js`
- `utils/memoryProfileSurface.js` -> `utils/memoryProfileSurface/index.js`
- `utils/scheduledTaskStore.js` -> `utils/scheduledTaskStore/index.js`

## Verification

- Confirm archive exists and contains all 33 files.
- Confirm `.sha256` matches the archive.
- Confirm no tracked code references deleted `.js` facade paths.
- Run syntax checks for every new `index.js`.
- Run focused tests and `npm test`.
