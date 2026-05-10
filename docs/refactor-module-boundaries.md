# Refactor Module Boundaries

This repository is moving from broad `api/`, `core/`, and `utils/` buckets toward feature-oriented modules under `src/`.

The migration rule is conservative: old require paths stay valid while focused modules take ownership of new implementation.

## Directory Ownership

- `src/message/`: message ingestion, private chat gating, reply controls, streaming replies, rich QQ message payloads, Qzone request helpers.
- `src/runtime-v2/`: LangGraph V2 host, context assembly, planning, node helpers, runtime tool execution.
- `src/memory/`: vector memory, memory CLI, Memory V3 adapters, memory context, journal retrieval/materialization.
- `src/model/`: model HTTP transport, provider-specific request mapping, streaming protocol adapters, vision payload preparation.
- `src/features/`: user-visible capabilities that can evolve independently, such as passive awareness, memes, daily share, Qzone, scheduler.
- `src/shared/`: cross-cutting helpers with no product workflow ownership, such as config adapters, text utilities, time, network safety, diagnostics.

## Compatibility Facades

Do not break these existing import paths during the migration:

- `core/messageHandler.js`
- `core/router.js`
- `api/httpClient.js`
- `api/runtimeV2/host.js`
- `api/runtimeV2/context/service.js`
- `api/runtimeV2/planning/service.js`
- `utils/vectorMemory.js`
- `utils/memoryCli.js`

Each facade should continue exporting the same names. New code should prefer `src/*` paths once the relevant module exists.

## Parallel Development Rules

- One worker owns one `src/*` subtree or one facade at a time.
- Prefer extracting pure helpers first, then stateful orchestration.
- Keep behavior changes out of extraction commits.
- Add a compatibility test whenever a public export moves behind a facade.
- Do not delete old files until all callers and tests have migrated.
