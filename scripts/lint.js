const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['api', 'core', 'src', 'utils', 'web'];
const CHUNK_GROUPS = [
  { entrypoint: 'src/features/daily-share', chunkDir: 'core' },
  { entrypoint: 'src/features/meme', chunkDir: 'core' },
  { entrypoint: 'src/features/passive-awareness', chunkDir: 'core' },
  { entrypoint: 'src/memory/vector', chunkDir: 'src/memory/vector' },
  { entrypoint: 'src/message/handler', chunkDir: 'core' },
  { entrypoint: 'src/model/http', chunkDir: 'src/model/http' },
  { entrypoint: 'src/runtime-v2/context', chunkDir: 'api/runtimeV2/context' },
  { entrypoint: 'src/runtime-v2/planning', chunkDir: 'src/runtime-v2/planning' }
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
const chunkFiles = new Set();
for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (/\.chunk\.js$/i.test(file)) {
    chunkFiles.add(path.resolve(file));
    continue;
  }
  try {
    // Parse only, similar to `node --check`.
    new Function(fs.readFileSync(file, 'utf8'));
    console.log(`[lint] ok   ${rel}`);
  } catch (e) {
    hasError = true;
    console.error(`[lint] fail ${rel}`);
    console.error('       ' + (e && e.message ? e.message : String(e)));
  }
}

const coveredChunkFiles = new Map();
for (const group of CHUNK_GROUPS) {
  try {
    const entrypointFile = require.resolve(path.join(ROOT, group.entrypoint));
    const entrypointSource = fs.readFileSync(entrypointFile, 'utf8');
    const listedChunks = Array.from(entrypointSource.matchAll(/['"]([^'"]+\.chunk(?:\.js)?)['"]/g))
      .map((match) => path.resolve(ROOT, group.chunkDir, match[1].endsWith('.js') ? match[1] : `${match[1]}.js`));
    require(entrypointFile);
    for (const chunkFile of listedChunks) {
      coveredChunkFiles.set(chunkFile, group.entrypoint);
    }
    console.log(`[lint] ok   ${group.entrypoint}`);
  } catch (e) {
    hasError = true;
    console.error(`[lint] fail ${group.entrypoint}`);
    console.error('       ' + (e && e.message ? e.message : String(e)));
  }
}

for (const chunkFile of chunkFiles) {
  const rel = path.relative(ROOT, chunkFile);
  const entrypoint = coveredChunkFiles.get(chunkFile);
  if (!entrypoint) {
    try {
      new Function(fs.readFileSync(chunkFile, 'utf8'));
      console.log(`[lint] ok   ${rel} (standalone chunk)`);
    } catch (e) {
      hasError = true;
      console.error(`[lint] fail ${rel}`);
      console.error('       chunk is neither standalone-valid nor covered by a validated entrypoint');
      console.error('       ' + (e && e.message ? e.message : String(e)));
    }
    continue;
  }
  console.log(`[lint] ok   ${rel} (via ${entrypoint})`);
}

if (hasError) {
  process.exit(1);
}

console.log(`[lint] completed. checked ${files.length} files.`);
