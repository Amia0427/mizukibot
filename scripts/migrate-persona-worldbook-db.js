#!/usr/bin/env node

const {
  loadPersonaModuleCatalog
} = require('../utils/personaModules');
const {
  getDiagnostics,
  importWorldbookFromCatalog
} = require('../utils/worldbookDb');

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    json: false
  };
  for (const raw of argv) {
    const arg = normalizeText(raw);
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
  }
  return options;
}

function formatText(result = {}) {
  const lines = [];
  lines.push(`worldbook db: ${result.dbFile || ''}`);
  lines.push(`mode: ${result.dryRun ? 'dry-run' : 'apply'}`);
  lines.push(`rows seen: ${result.rowsSeen || 0}`);
  lines.push(`rows changed: ${result.rowsChanged || 0}`);
  lines.push(`imported: ${Array.isArray(result.imported) ? result.imported.length : 0}`);
  if (Array.isArray(result.skipped) && result.skipped.length > 0) {
    lines.push(`skipped: ${result.skipped.length}`);
  }
  if (result.diagnostics) {
    lines.push(`active entries: ${result.diagnostics.activeEntries || 0}`);
    lines.push(`fts available: ${result.diagnostics.ftsAvailable === true}`);
  }
  return lines.join('\n');
}

function run(options = parseArgs()) {
  const catalog = loadPersonaModuleCatalog();
  const result = options.apply
    ? importWorldbookFromCatalog(catalog, { apply: true, force: true })
    : importWorldbookFromCatalog(catalog, { apply: false });
  result.diagnostics = getDiagnostics({ benchmark: false });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(formatText(result));
  return result;
}

if (require.main === module) {
  try {
    const result = run();
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error('[migrate-persona-worldbook-db] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  run
};
