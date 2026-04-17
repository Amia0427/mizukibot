# Native Skill Migration Summary

## Summary

This repository has migrated the key execution-path skills from external process wrappers
to native JavaScript / HTTP implementations.

The goal of the migration was to eliminate runtime dependence on:

- `runSkillPython(...)`
- `runShellSkillScript(...)`
- `runSkillNode(...)`

for the main business-critical skills on Windows, where external process execution had
been failing with `spawn EPERM`.

## Migrated Skills

The following skills are now implemented without external process execution:

- `skill_arxiv_search`
- `skill_arxiv_get`
- `skill_arxiv_latest`
- `skill_weather`
- `skill_qqbot_dep_check`
- `skill_skill_validate`
- `skill_clawddocs_search`
- `skill_clawddocs_fetch`
- `skill_summarize`
- `skill_stock_price_query`
- `skill_stock_dividend`
- `skill_stock_portfolio`
- `skill_stock_hot`
- `skill_stock_rumor`
- `skill_stock_analyze`
- `skill_stock_watchlist`
- `skill_ontology_graph`
- `skill_youtube_transcript`
- `skill_ppt_generate`
- `skill_ppt_theme_list`
- `skill_image_generate_pro`

## Native Modules Added

- `api/skills_native/arxiv.js`
- `api/skills_native/weather.js`
- `api/skills_native/summarize.js`
- `api/skills_native/skillValidation.js`
- `api/skills_native/clawddocs.js`
- `api/skills_native/ontology.js`
- `api/skills_native/youtube.js`
- `api/skills_native/ppt.js`
- `api/skills_native/imageGenerate.js`
- `api/skills_native/stocks/quote.js`
- `api/skills_native/stocks/dividend.js`
- `api/skills_native/stocks/analyze.js`
- `api/skills_native/stocks/hot.js`
- `api/skills_native/stocks/rumor.js`
- `api/skills_native/stocks/portfolio.js`
- `api/skills_native/stocks/watchlist.js`

## MCP Replacement

The original dynamic MCP runtime has been replaced with a static compatibility layer.

Current replacements:

- `fetch` -> `web_fetch`
- `bing-search` -> `web_search`
- `amap-maps` -> `search_nearby_places`
- `howtocook-mcp` -> `skill_clawddocs_search`

This keeps `mcp_*` naming compatibility while removing runtime dependence on external MCP
server processes.

## Validation

Added/updated tests:

- `tests/nativeSkills.test.js`
- `tests/nativeSummarizeStock.test.js`
- `tests/nativeStocksAdvanced.test.js`
- `tests/nativeOntologyMcp.test.js`
- `tests/nativeWatchlistYoutube.test.js`
- `tests/nativePptImage.test.js`
- `tests/noExternalProcessSkillsSource.test.js`

Project test entrypoint:

- `npm test`

All tests passed at the time this summary was written.

## Online Smoke Status

Recent smoke validation confirmed:

- `skill_arxiv_search` works online
- `skill_arxiv_get` works online
- `skill_weather` is callable, but upstream weather endpoint may still return 500 in some cases
- `skill_summarize` works online
- `skill_stock_price_query` works online via native data-source fallback
- `skill_stock_hot` works and returns live data, though formatting quality can still be improved
- `skill_stock_rumor` works and returns live headlines
- `skill_youtube_transcript` now degrades cleanly when no HTTP transcript provider is configured

## Remaining Cleanup

The following files were part of a previous abandoned system-proxy experiment and appear
to be unused by the current execution path:

- `api/systemCommandProxy.js`
- `scripts/local-command-bridge.js`
- `scripts/local-command-bridge.ps1`

They were not removed automatically because filesystem deletion was denied in the current
environment. They should be manually reviewed and deleted if no longer needed.
