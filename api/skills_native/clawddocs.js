const fs = require('fs');
const path = require('path');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function listReferenceFiles(skillDir) {
  const roots = [
    path.join(skillDir, 'references'),
    path.join(skillDir, 'assets'),
    path.join(skillDir, 'snippets')
  ];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else {
          files.push(abs);
        }
      }
    }
  }
  return files;
}

function searchDocs(skillDir, query = '') {
  const normalizedQuery = normalizeText(query).toLowerCase();
  const files = listReferenceFiles(skillDir);
  if (!normalizedQuery) {
    return files.slice(0, 20).map((file) => path.relative(skillDir, file));
  }
  const hits = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.toLowerCase().includes(normalizedQuery) || path.basename(file).toLowerCase().includes(normalizedQuery)) {
      hits.push(path.relative(skillDir, file));
    }
  }
  return hits.slice(0, 20);
}

function fetchDoc(skillDir, docPath = '') {
  const normalizedPath = normalizeText(docPath);
  if (!normalizedPath) return 'Missing doc_path.';
  const target = listReferenceFiles(skillDir).find((file) => {
    const rel = path.relative(skillDir, file).replace(/\\/g, '/');
    return rel === normalizedPath || rel.toLowerCase() === normalizedPath.toLowerCase();
  });
  if (!target) return `Document not found: ${normalizedPath}`;
  const content = fs.readFileSync(target, 'utf8');
  return [
    `DOC: ${path.relative(skillDir, target).replace(/\\/g, '/')}`,
    content.slice(0, 4000)
  ].join('\n\n');
}

module.exports = {
  fetchDoc,
  searchDocs
};
