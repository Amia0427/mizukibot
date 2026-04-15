const { setEnvPairs } = require('../utils/envFile');

function main() {
  const value = String(process.argv[2] || '').trim();
  if (!value) {
    console.error('[ERROR] Empty API key.');
    process.exit(1);
  }

  setEnvPairs({ API_KEY: value });
  console.log('[OK] API_KEY updated in .env');
}

main();
