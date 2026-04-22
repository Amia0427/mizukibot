function normalizeText(value = '') {
  return String(value || '').trim();
}

function parseArgs(argv = []) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || '').trim();
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      parsed[key] = String(next);
      index += 1;
      continue;
    }
    parsed[key] = 'true';
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = normalizeText(args.session);
  const message = String(args.message || '');

  const delayMatch = message.match(/\[delay:(\d+)\]/i);
  const delayMs = delayMatch ? Math.max(0, Number(delayMatch[1]) || 0) : 0;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (/\[fail\]/i.test(message)) {
    console.error('stub requested failure');
    process.exit(1);
    return;
  }

  const conciseMessage = message
    .replace(/\[delay:\d+\]/ig, '')
    .replace(/\[fail\]/ig, '')
    .trim()
    .slice(0, 120);

  console.log('Assistant:');
  console.log(`session=${sessionId}`);
  console.log(`reply=${conciseMessage || 'ok'}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
