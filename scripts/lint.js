const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORT_JSON = process.argv.includes('--report-json');
const originalConsoleLog = console.log;
if (REPORT_JSON) console.log = () => {};
const TARGET_DIRS = ['api', 'core', 'src', 'utils', 'web'];
const CHUNK_GROUPS = [
  { entrypoint: 'src/features/daily-share', chunkDir: 'core' },
  { entrypoint: 'src/features/meme', chunkDir: 'core' },
  { entrypoint: 'src/features/passive-awareness', chunkDir: 'core' },
  { entrypoint: 'src/memory/vector', chunkDir: 'src/memory/vector' },
  { entrypoint: 'src/model/http', chunkDir: 'src/model/http' },
  {
    entrypoint: 'src/message/handler',
    chunkDir: 'core',
    legacyRetainedLabel: 'message handler chunks',
    legacyRetainedChunks: [
      'messageHandler.imports.chunk.js',
      'messageHandler.prompts.chunk.js',
      'messageHandler.direct-session.chunk.js',
      'messageHandler.route-capture.chunk.js',
      'messageHandler.runtime.chunk.js',
      'messageHandler.runtime-02.chunk.js',
      'messageHandler.runtime-03.chunk.js',
      'messageHandler.runtime-04.chunk.js',
      'messageHandler.runtime-05.chunk.js',
      'messageHandler.runtime-06.chunk.js',
      'messageHandler.exports.chunk.js'
    ]
  },
  {
    entrypoint: 'src/runtime-v2/context',
    chunkDir: 'api/runtimeV2/context',
    legacyRetainedLabel: 'context chunks',
    legacyRetainedChunks: [
      'service-core.chunk.js',
      'dynamic-plan.chunk.js',
      'cache-blocks.chunk.js',
      'prompt-inputs.chunk.js',
      'render-helpers.chunk.js',
      'base-dynamic-prompt.chunk.js',
      'base-dynamic-prompt-02.chunk.js',
      'dynamic-prompt.chunk.js',
      'dynamic-prompt-02.chunk.js',
      'vision.chunk.js'
    ]
  }
];

function collectJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'NapCat.Shell (2)') continue;
      result.push(...collectJsFiles(abs));
    } else if (e.isFile() && e.name.endsWith('.js')) {
      result.push(abs);
    }
  }
  return result;
}

const files = [
  path.join(ROOT, 'index.js'),
  ...TARGET_DIRS.flatMap((d) => collectJsFiles(path.join(ROOT, d)))
].filter((f, i, arr) => arr.indexOf(f) === i);

let hasError = false;
const errors = [];
const entrypointRecords = [];
const chunkRecords = [];
const chunkFiles = new Set();
const legacyRetainedChunkFiles = new Set();
const relativePath = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const log = (...args) => {
  if (!REPORT_JSON) originalConsoleLog(...args);
};

for (const group of CHUNK_GROUPS) {
  if (!group.legacyRetainedChunks) continue;
  const legacyRetainedLabel = group.legacyRetainedLabel || 'chunks';
  const chunkPaths = group.legacyRetainedChunks.map((chunk) => (
    path.resolve(ROOT, group.chunkDir, chunk)
  ));
  const missingChunks = chunkPaths.filter((chunkFile) => !fs.existsSync(chunkFile));
  for (const chunkFile of chunkPaths) legacyRetainedChunkFiles.add(chunkFile);

  try {
    if (missingChunks.length > 0) {
      throw new Error(`legacy retained chunks are missing: ${missingChunks.map(relativePath).join(', ')}`);
    }
    new Function(chunkPaths.map((chunkFile) => fs.readFileSync(chunkFile, 'utf8')).join('\n'));
    chunkRecords.push({
      file: `${group.chunkDir} (legacy retained ${legacyRetainedLabel})`,
      coverage: 'legacy-retained-combined',
      execution: 'not-run',
      entrypoint: null,
      chunks: chunkPaths.map(relativePath),
      validation: 'passed',
      error: null
    });
    log(`[lint] ok   ${group.chunkDir} (legacy retained combined ${legacyRetainedLabel})`);
  } catch (e) {
    hasError = true;
    const message = e && e.message ? e.message : String(e);
    chunkRecords.push({
      file: `${group.chunkDir} (legacy retained ${legacyRetainedLabel})`,
      coverage: 'legacy-retained-combined',
      execution: 'not-run',
      entrypoint: null,
      chunks: chunkPaths.map(relativePath),
      validation: 'failed',
      error: { message }
    });
    errors.push({ scope: 'legacy-retained-chunks', file: group.chunkDir, message });
    console.error(`[lint] fail ${group.chunkDir} (legacy retained combined ${legacyRetainedLabel})`);
    console.error('       ' + message);
  }
}
for (const file of files) {
  const rel = relativePath(file);
  if (/\.chunk\.js$/i.test(file)) {
    chunkFiles.add(path.resolve(file));
    continue;
  }
  try {
    // Parse only, similar to `node --check`.
    new Function(fs.readFileSync(file, 'utf8'));
    log(`[lint] ok   ${rel}`);
  } catch (e) {
    hasError = true;
    errors.push({ scope: 'file', file: rel, message: e && e.message ? e.message : String(e) });
    console.error(`[lint] fail ${rel}`);
    console.error('       ' + (e && e.message ? e.message : String(e)));
  }
}

const coveredChunkFiles = new Map();
for (const group of CHUNK_GROUPS) {
  let entrypointFile = '';
  let listedChunks = [];
  let missingChunks = [];
  let validation = 'passed';
  let error = null;
  try {
    if (group.legacyRetainedChunks) {
      entrypointRecords.push({
        name: group.entrypoint,
        file: null,
        validation: 'not-run',
        declaredChunks: [],
        missingChunks: [],
        error: null
      });
      continue;
    }
    entrypointFile = require.resolve(path.join(ROOT, group.entrypoint));
    const entrypointSource = fs.readFileSync(entrypointFile, 'utf8');
    listedChunks = Array.from(entrypointSource.matchAll(/['"]([^'"]+\.chunk(?:\.js)?)['"]/g))
      .map((match) => path.resolve(ROOT, group.chunkDir, match[1].endsWith('.js') ? match[1] : `${match[1]}.js`));
    missingChunks = listedChunks.filter((chunkFile) => !fs.existsSync(chunkFile));
    if (missingChunks.length > 0) {
      throw new Error(`entrypoint declares missing chunks: ${missingChunks.map(relativePath).join(', ')}`);
    }
    require(entrypointFile);
    for (const chunkFile of listedChunks) {
      coveredChunkFiles.set(chunkFile, group.entrypoint);
    }
    log(`[lint] ok   ${group.entrypoint}`);
  } catch (e) {
    hasError = true;
    validation = 'failed';
    error = { message: e && e.message ? e.message : String(e) };
    errors.push({ scope: 'entrypoint', file: group.entrypoint, message: error.message });
    console.error(`[lint] fail ${group.entrypoint}`);
    console.error('       ' + (e && e.message ? e.message : String(e)));
  }
  entrypointRecords.push({
    name: group.entrypoint,
    file: entrypointFile ? relativePath(entrypointFile) : null,
    validation,
    declaredChunks: listedChunks.map(relativePath).sort(),
    missingChunks: missingChunks.map(relativePath).sort(),
    error
  });
}

for (const chunkFile of chunkFiles) {
  const rel = relativePath(chunkFile);
  if (legacyRetainedChunkFiles.has(chunkFile)) continue;
  const entrypoint = coveredChunkFiles.get(chunkFile);
  if (!entrypoint) {
    try {
      new Function(fs.readFileSync(chunkFile, 'utf8'));
      chunkRecords.push({
        file: rel,
        coverage: 'standalone',
        entrypoint: null,
        validation: 'passed',
        error: null
      });
      log(`[lint] ok   ${rel} (standalone chunk)`);
    } catch (e) {
      hasError = true;
      const message = e && e.message ? e.message : String(e);
      chunkRecords.push({
        file: rel,
        coverage: 'uncovered',
        entrypoint: null,
        validation: 'failed',
        error: { message }
      });
      errors.push({ scope: 'chunk', file: rel, message });
      console.error(`[lint] fail ${rel}`);
      console.error('       chunk is neither standalone-valid nor covered by a validated entrypoint');
      console.error('       ' + (e && e.message ? e.message : String(e)));
    }
    continue;
  }
  chunkRecords.push({
    file: rel,
    coverage: 'entrypoint',
    entrypoint,
    validation: 'passed',
    error: null
  });
  log(`[lint] ok   ${rel} (via ${entrypoint})`);
}

chunkRecords.sort((left, right) => left.file.localeCompare(right.file));
entrypointRecords.sort((left, right) => left.name.localeCompare(right.name));
errors.sort((left, right) => `${left.scope}:${left.file}`.localeCompare(`${right.scope}:${right.file}`));
const summary = {
  discoveredJs: files.length,
  discoveredChunks: chunkRecords.length,
  entrypointCovered: chunkRecords.filter((item) => item.coverage === 'entrypoint').length,
  legacyRetainedCovered: chunkRecords.filter((item) => item.coverage === 'legacy-retained-combined').length,
  standaloneCovered: chunkRecords.filter((item) => item.coverage === 'standalone').length,
  uncovered: chunkRecords.filter((item) => item.coverage === 'uncovered').length,
  failed: errors.length,
  skipped: 0
};
const report = {
  version: 1,
  status: hasError ? 'fail' : 'pass',
  summary,
  chunks: chunkRecords,
  entrypoints: entrypointRecords,
  errors
};

if (REPORT_JSON) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  log(`[lint] completed. checked ${files.length} files.`);
}

if (hasError) process.exit(1);
