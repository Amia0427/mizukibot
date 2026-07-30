const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const docsDir = path.join(projectRoot, 'docs', 'development');
const packageScripts = require('../package.json').scripts;
const expectedDocuments = [
  'README.md',
  '01-getting-started.md',
  '02-architecture-map.md',
  '03-message-and-agent-runtime.md',
  '04-memory-and-prompts.md',
  '05-feature-development.md',
  '06-testing-and-quality.md',
  '07-debugging-and-operations.md'
];
const repositoryPathPattern = /^(?:api|config|core|deploy|docs|prompts|scripts|src|tests|utils|web)\/[A-Za-z0-9._/()-]+$|^(?:README\.md|package\.json|index\.js|Dockerfile|docker-compose\.yml|\.env\.example|\.nvmrc)$/;
const sourcePathPattern = /\b(?:api|config|core|deploy|docs|prompts|scripts|src|tests|utils|web)\/(?:[A-Za-z0-9._()-]+\/)*[A-Za-z0-9._()-]+\.(?:cmd|js|json|md|ps1|sh|txt|ya?ml)\b/g;
const optionalPrivatePaths = new Set([
  'prompts/admin.txt',
  'prompts/persona/'
]);

function listDocuments() {
  return fs.readdirSync(docsDir)
    .filter((fileName) => fileName.endsWith('.md'))
    .sort();
}

function normalizeMarkdownTarget(rawTarget) {
  const withoutTitle = String(rawTarget || '').trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
  return decodeURIComponent(withoutTitle.split('#')[0]);
}

function verifyLocalLinks(filePath, source) {
  let checked = 0;
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = String(match[1] || '').trim();
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;

    const target = normalizeMarkdownTarget(rawTarget);
    assert(target, `${path.relative(projectRoot, filePath)} contains an empty local link`);
    const resolved = path.resolve(path.dirname(filePath), target);
    assert(fs.existsSync(resolved), `${path.relative(projectRoot, filePath)} links to missing path: ${rawTarget}`);
    checked += 1;
  }
  return checked;
}

function verifyRepositoryPaths(filePath, source) {
  const candidates = new Set();
  for (const match of source.matchAll(/`([^`\r\n]+)`/g)) {
    const candidate = String(match[1] || '').trim();
    if (!repositoryPathPattern.test(candidate)) continue;
    if (/[*?{}<>]/.test(candidate)) continue;
    candidates.add(candidate);
  }
  for (const match of source.matchAll(sourcePathPattern)) {
    candidates.add(String(match[0] || '').trim());
  }

  let checked = 0;
  for (const candidate of candidates) {
    if (optionalPrivatePaths.has(candidate)) continue;
    const resolved = path.resolve(projectRoot, candidate);
    assert(fs.existsSync(resolved), `${path.relative(projectRoot, filePath)} references missing path: ${candidate}`);
    checked += 1;
  }
  return checked;
}

function verifyNpmScripts(filePath, source) {
  const scripts = new Set();
  for (const match of source.matchAll(/\bnpm run ([a-z0-9:-]+)/gi)) {
    const scriptName = String(match[1] || '').trim();
    assert(packageScripts[scriptName], `${path.relative(projectRoot, filePath)} references missing npm script: ${scriptName}`);
    scripts.add(scriptName);
  }
  return scripts.size;
}

assert(fs.existsSync(docsDir), 'docs/development must exist');
assert.deepStrictEqual(listDocuments(), [...expectedDocuments].sort(), 'developer documentation file set');

let localLinkCount = 0;
let repositoryPathCount = 0;
let npmScriptCount = 0;
for (const fileName of expectedDocuments) {
  const filePath = path.join(docsDir, fileName);
  const source = fs.readFileSync(filePath, 'utf8');
  assert(source.startsWith('# '), `${fileName} must start with one H1`);
  localLinkCount += verifyLocalLinks(filePath, source);
  repositoryPathCount += verifyRepositoryPaths(filePath, source);
  npmScriptCount += verifyNpmScripts(filePath, source);
}

console.log(`developerDocumentation.test.js passed (${expectedDocuments.length} docs, ${localLinkCount} local links, ${repositoryPathCount} repository paths, ${npmScriptCount} npm scripts)`);
