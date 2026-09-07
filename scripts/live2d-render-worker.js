const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.once('end', () => resolve(input));
    process.stdin.once('error', reject);
  });
}

async function main() {
  const rawInput = await readStdin();
  const input = JSON.parse(rawInput);
  const modulePath = String(process.env.LIVE2D_RENDER_WORKER_MODULE || '').trim();
  if (!modulePath) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'renderer_adapter_not_configured' }));
    return;
  }
  const adapter = require(path.resolve(modulePath));
  const render = adapter.renderLive2dAnimation || adapter.render;
  if (typeof render !== 'function') {
    process.stdout.write(JSON.stringify({ ok: false, code: 'renderer_adapter_invalid' }));
    return;
  }
  const result = await render(input);
  const buffer = Buffer.isBuffer(result) ? result : result?.buffer;
  if (Buffer.isBuffer(buffer)) {
    process.stdout.write(JSON.stringify({ ok: true, base64: buffer.toString('base64') }));
    return;
  }
  process.stdout.write(JSON.stringify(result || { ok: false, code: 'renderer_empty' }));
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error || 'renderer failed')}\n`);
  process.exitCode = 1;
});
