# External Sub-Agent Removal

2026-05-30 +08:00: OpenClaw, Claude CLI session, and HAPI external sub-agent activation paths have been removed from this project.

## Removed Surface

- Slash/admin commands: `/full`, `/claude`, `/claude-open`, `/claude-send`, `/claude-tail`, `/claude-stop`, `/hapi`
- Runtime executor: `full_subagent`
- Runtime capability: `subagent_bridge`
- External bridge configuration: `SUBAGENT_*`, `OPENCLAW_*`, and HAPI bridge-only settings
- Startup/shutdown dependency on the external sub-agent executor

## Kept In Scope

- Main Claude / Anthropic model protocol
- Local tool, MCP, memory, planner, and LangGraph runtime
- Internal `researchSubagent`, `createAgent`, and humanizer functionality

## Verification

- `npm run check:agent:static`
- `npm test`
- Local startup smoke test: `node index.js` reached NapCat connection without the removed bridge modules.
