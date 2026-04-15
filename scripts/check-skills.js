const { TOOL_EXECUTORS } = require('../api/toolExecutors');

async function main() {
  const results = [];

  // 1) skill_vetter_report: local static vet check should always run offline.
  try {
    const out = await TOOL_EXECUTORS.skill_vetter_report({ skill_name: 'web-search' });
    results.push({ tool: 'skill_vetter_report', ok: true, preview: String(out).slice(0, 220) });
  } catch (e) {
    results.push({ tool: 'skill_vetter_report', ok: false, error: e.message });
  }

  // 2) skill_qqbot_dep_check: validates python deps loading path.
  try {
    const out = await TOOL_EXECUTORS.skill_qqbot_dep_check({});
    results.push({ tool: 'skill_qqbot_dep_check', ok: true, preview: String(out).slice(0, 220) });
  } catch (e) {
    results.push({ tool: 'skill_qqbot_dep_check', ok: false, error: e.message });
  }

  // 3) skill_web_search: may fail if network is blocked, but should return graceful output.
  try {
    const out = await TOOL_EXECUTORS.skill_web_search({ query: 'mizuki bot', max_results: 1 });
    results.push({ tool: 'skill_web_search', ok: true, preview: String(out).slice(0, 220) });
  } catch (e) {
    results.push({ tool: 'skill_web_search', ok: false, error: e.message });
  }

  // 4) skill_weather: network-dependent, but should not crash.
  try {
    const out = await TOOL_EXECUTORS.skill_weather({ location: 'Shanghai' });
    results.push({ tool: 'skill_weather', ok: true, preview: String(out).slice(0, 220) });
  } catch (e) {
    results.push({ tool: 'skill_weather', ok: false, error: e.message });
  }

  // 5) skill_youtube_transcript: expected to depend on outbound network and subtitle availability.
  try {
    const out = await TOOL_EXECUTORS.skill_youtube_transcript({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    results.push({ tool: 'skill_youtube_transcript', ok: true, preview: String(out).slice(0, 220) });
  } catch (e) {
    results.push({ tool: 'skill_youtube_transcript', ok: false, error: e.message });
  }

  // 6) skill_summarize: if summarize CLI is missing, should return a graceful hint.
  try {
    const out = await TOOL_EXECUTORS.skill_summarize({ input: 'https://example.com', length: 'short' });
    results.push({ tool: 'skill_summarize', ok: true, preview: String(out).slice(0, 220) });
  } catch (e) {
    results.push({ tool: 'skill_summarize', ok: false, error: e.message });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('[check-skills] fatal:', e.message);
  process.exit(1);
});

