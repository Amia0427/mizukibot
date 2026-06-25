// scripts/console.js
const path = require('path');

const MEMORY_RAG_EXPLAIN_COMMANDS = new Set([
  'rag',
  'memory-rag',
  'memory-rag-explain',
  'diag:memory-rag-explain'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

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

function hasUserIdOption(argv = []) {
  return argv.some((item) => {
    const text = normalizeText(item);
    return text === '--user-id'
      || text === '--userId'
      || text === '--user'
      || text.startsWith('--user-id=')
      || text.startsWith('--userId=');
  });
}

function normalizeMemoryRagExplainArgs(argv = []) {
  const args = argv.map((item) => normalizeText(item)).filter(Boolean);
  if (args.length === 0 || args[0].startsWith('--') || hasUserIdOption(args)) {
    return args;
  }
  const [userId, ...rest] = args;
  return ['--user-id', userId, ...rest];
}

function isHelpCommand(command = '') {
  const text = normalizeText(command).toLowerCase();
  return text === 'help' || text === '-h' || text === '--help';
}

function printUsage() {
  console.log('Usage:');
  console.log('  npm run console');
  console.log('  npm run console -- rag <userId> "<query>" [diagnostic options]');
  console.log('  npm run console -- memory-rag-explain --user-id <id> --query "<query>"');
}

async function runConfigCheck() {
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

async function runMemoryRagExplain(argv = [], deps = {}) {
  if (argv.some(isHelpCommand)) {
    printUsage();
    return null;
  }
  const diagnostic = deps.memoryRagExplain || require('./diagnose-memory-rag-explain');
  const options = diagnostic.parseArgs(normalizeMemoryRagExplainArgs(argv));
  return diagnostic.run(options);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const [command, ...rest] = argv;
  if (!command) return runConfigCheck();

  const normalizedCommand = normalizeText(command).toLowerCase();
  if (MEMORY_RAG_EXPLAIN_COMMANDS.has(normalizedCommand)) {
    return runMemoryRagExplain(rest, deps);
  }
  if (normalizedCommand === 'check' || normalizedCommand === 'config') {
    return runConfigCheck();
  }
  if (isHelpCommand(normalizedCommand)) {
    printUsage();
    return null;
  }

  console.error(`[fail] unknown console command: ${command}`);
  printUsage();
  process.exitCode = 1;
  return null;
}

if (require.main === module) {
  main().then((result) => {
    if (result && result.ok === false) {
      process.exitCode = 1;
    }
  }).catch((err) => {
    console.error('[fatal]', err?.stack || err?.message || String(err));
    process.exit(1);
  });
}

module.exports = {
  main,
  maskValue,
  normalizeMemoryRagExplainArgs,
  runMemoryRagExplain
};
