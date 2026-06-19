// scripts/console.js
// Lightweight local console diagnostics.
// This script is intentionally non-network and safe for local sanity checks.

const path = require('path');

function printHeader(title) {
  console.log('='.repeat(64));
  console.log(title);
  console.log('='.repeat(64));
}

function maskValue(value) {
  if (!value) return '(empty)';
  const v = String(value);
  if (v.length <= 8) return '****';
  return `${v.slice(0, 3)}***${v.slice(-3)}`;
}

async function main() {
  printHeader('MizukiBot Console Check');

  const config = require('../config');

  console.log('[paths] root:', path.resolve(__dirname, '..'));
  console.log('[runtime] node:', process.version);

  console.log('\n[config] key fields');
  console.log('TIMEZONE      =', config.TIMEZONE);
  console.log('NAPCAT_HTTP_API_BASE_URL =', config.NAPCAT_HTTP_API_BASE_URL);
  console.log('NAPCAT_HTTP_REVERSE_PORT =', config.NAPCAT_HTTP_REVERSE_PORT);
  console.log('BOT_QQ        =', config.BOT_QQ);
  console.log('WEB_PORT      =', config.WEB_PORT);
  console.log('WEB_BIND_HOST =', config.WEB_BIND_HOST);
  console.log('USE_LANGGRAPH =', config.USE_LANGGRAPH);

  console.log('\n[secrets] masked');
  console.log('API_KEY   =', maskValue(config.API_KEY));
  console.log('WEB_TOKEN =', maskValue(config.WEB_TOKEN));
  console.log('AMAP_KEY  =', maskValue(config.AMAP_KEY));
  console.log('[mode] unified single-key = API_BASE_URL + API_KEY');

  try {
    config.validateRequiredConfig();
    console.log('\n[ok] required env vars are all present.');
  } catch (e) {
    console.error('\n[fail]', e.message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[fatal]', err?.stack || err?.message || String(err));
  process.exit(1);
});
