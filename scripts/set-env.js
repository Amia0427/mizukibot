const fs = require('fs');
const path = require('path');

const { DEFAULT_ENV_PATH, setEnvPairs } = require('../utils/envFile');

function printUsage() {
  console.error('[ERROR] Usage: node scripts/set-env.js KEY VALUE [KEY VALUE ...]');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    printUsage();
    process.exit(1);
  }

  const pairs = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = String(args[i] || '').trim();
    const value = String(args[i + 1] || '').trim();

    if (!key) {
      console.error('[ERROR] Empty env key.');
      process.exit(1);
    }

    pairs[key] = value;
  }

  const envPath = DEFAULT_ENV_PATH;
  if (!fs.existsSync(path.dirname(envPath))) {
    console.error('[ERROR] Project path missing.');
    process.exit(1);
  }

  setEnvPairs(pairs, envPath);
  console.log(`[OK] Updated ${Object.keys(pairs).length} env key(s) in .env`);
}

main();
