const { queryLocalKnowledge } = require('../utils/localKnowledge');

function parseArgs(argv = []) {
  const flags = new Set(argv.slice(2));
  return {
    json: flags.has('--json')
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await queryLocalKnowledge({
    userId: 'diagnose_local_user',
    query: '继续上次部署问题',
    sessionKey: 'direct:diagnose_local_user',
    topK: 8
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('=== Local Knowledge Diagnose ===');
  console.log('[diagnostics]');
  console.log(JSON.stringify(result.diagnostics, null, 2));
  console.log('[results]');
  for (const item of result.results) {
    console.log(`- ${item.source} | priority=${item.priority} | score=${item.score}`);
    console.log(`  ${item.preview || item.text}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
