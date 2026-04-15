const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = ['api', 'core', 'utils', 'web'];

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
for (const file of files) {
  const rel = path.relative(ROOT, file);
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

if (hasError) {
  process.exit(1);
}

console.log(`[lint] completed. checked ${files.length} files.`);
