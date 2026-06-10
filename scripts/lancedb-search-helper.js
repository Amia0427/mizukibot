process.env.MIZUKIBOT_RUNTIME_ROLE = process.env.MIZUKIBOT_RUNTIME_ROLE || 'lancedb_helper';

const { searchMemoryVectors, searchWorldbookVectors } = require('../utils/lancedbMemoryStore');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}');
  const kind = String(payload.kind || '');
  const queryEmbedding = Array.isArray(payload.queryEmbedding) ? payload.queryEmbedding : [];
  const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const result = kind === 'worldbook'
    ? await searchWorldbookVectors(queryEmbedding, context, options)
    : await searchMemoryVectors(queryEmbedding, context, options);
  process.stdout.write(JSON.stringify(result || { ok: false, skipped: true, reason: 'empty_result', rows: [] }));
}

main().catch((error) => {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
