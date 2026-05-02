const fs = require('fs');
const path = require('path');

const AGENT_PROMPT_EXTENSIONS = new Set(['.md', '.markdown', '.yaml', '.yml']);
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '__pycache__', 'data']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNewlines(value = '') {
  return String(value || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripInlineComment(value = '') {
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') {
      quote = quote === ch ? '' : (quote || ch);
      continue;
    }
    if (ch === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseYamlScalar(raw = '') {
  const value = stripInlineComment(String(raw || '').trim());
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    return value.startsWith('"')
      ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
      : inner.replace(/''/g, "'");
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function countIndent(line = '') {
  const match = String(line || '').match(/^ */);
  return match ? match[0].length : 0;
}

function readBlockScalar(lines, startIndex, parentIndent, folded = false) {
  const collected = [];
  let minIndent = Infinity;
  let index = startIndex + 1;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!String(line || '').trim()) {
      collected.push('');
      continue;
    }

    const indent = countIndent(line);
    if (indent <= parentIndent) break;
    minIndent = Math.min(minIndent, indent);
    collected.push(line);
  }

  const trimIndent = Number.isFinite(minIndent) ? minIndent : parentIndent + 2;
  const normalized = collected
    .map((line) => line.slice(Math.min(trimIndent, countIndent(line))))
    .join('\n')
    .trim();

  return {
    value: folded ? normalized.replace(/\n+/g, ' ') : normalized,
    nextIndex: index - 1
  };
}

function parseYamlLike(raw = '') {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = normalizeNewlines(raw).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!String(line || '').trim()) continue;
    if (/^\s*#/.test(line)) continue;

    const indent = countIndent(line);
    const body = line.slice(indent);
    const match = body.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    const key = match[1];
    const rest = match[2] === undefined ? '' : match[2];

    if (!String(rest || '').trim()) {
      const next = {};
      parent[key] = next;
      stack.push({ indent, value: next });
      continue;
    }

    const scalarMarker = String(rest || '').trim();
    if (scalarMarker === '|' || scalarMarker === '>') {
      const block = readBlockScalar(lines, i, indent, scalarMarker === '>');
      parent[key] = block.value;
      i = block.nextIndex;
      continue;
    }

    parent[key] = parseYamlScalar(rest);
  }

  return root;
}

function splitMarkdownFrontMatter(raw = '') {
  const text = normalizeNewlines(raw);
  if (!text.startsWith('---\n')) {
    return { frontMatter: null, body: text };
  }

  const endIndex = text.indexOf('\n---', 4);
  if (endIndex < 0) {
    return { frontMatter: null, body: text };
  }

  const afterMarker = text.slice(endIndex + 4);
  if (afterMarker && !afterMarker.startsWith('\n')) {
    return { frontMatter: null, body: text };
  }

  return {
    frontMatter: text.slice(4, endIndex),
    body: afterMarker.replace(/^\n/, '')
  };
}

function firstMarkdownHeading(text = '') {
  const lines = normalizeNewlines(text).split('\n');
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) return normalizeText(match[1]);
  }
  return '';
}

function firstProseLine(text = '') {
  const lines = normalizeNewlines(text).split('\n');
  for (const line of lines) {
    const trimmed = normalizeText(line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, ''));
    if (trimmed) return trimmed;
  }
  return '';
}

function deriveIdFromPath(filePath = '') {
  const base = path.basename(String(filePath || ''), path.extname(String(filePath || '')));
  return normalizeText(base).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function pickString(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizeAgentPrompt(parsed = {}, options = {}) {
  const filePath = String(options.filePath || '').trim();
  const ext = path.extname(filePath).toLowerCase();
  const isMarkdown = ext === '.md' || ext === '.markdown';
  const body = normalizeText(parsed.body);
  const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
  const iface = meta.interface && typeof meta.interface === 'object' ? meta.interface : meta;
  const id = pickString(iface.id, meta.id, deriveIdFromPath(filePath));
  const heading = isMarkdown ? firstMarkdownHeading(body) : '';
  const firstLine = isMarkdown ? firstProseLine(body) : '';
  const displayName = pickString(
    iface.display_name,
    iface.displayName,
    iface.name,
    iface.title,
    meta.name,
    heading,
    id
  );
  const shortDescription = pickString(
    iface.short_description,
    iface.shortDescription,
    iface.description,
    meta.description,
    firstLine
  );
  const metadataPrompt = pickString(
    iface.default_prompt,
    iface.defaultPrompt,
    iface.prompt,
    iface.instructions,
    iface.system_prompt,
    iface.systemPrompt,
    meta.default_prompt,
    meta.defaultPrompt,
    meta.prompt,
    meta.instructions,
    meta.system_prompt,
    meta.systemPrompt,
    meta.content,
    meta.body,
    meta.text
  );
  const defaultPrompt = isMarkdown ? pickString(body, metadataPrompt) : pickString(metadataPrompt, body);
  const relativePath = options.rootDir
    ? path.relative(options.rootDir, filePath).split(path.sep).join('/')
    : filePath;
  const problems = [];
  if (!defaultPrompt) problems.push('Missing default prompt text');

  return {
    id,
    sourcePath: filePath,
    relativePath,
    format: isMarkdown ? 'markdown' : 'yaml',
    interface: {
      display_name: displayName,
      short_description: shortDescription,
      default_prompt: defaultPrompt
    },
    displayName,
    shortDescription,
    defaultPrompt,
    prompt: defaultPrompt,
    content: defaultPrompt,
    ok: problems.length === 0,
    problems
  };
}

function parseAgentPromptText(raw = '', options = {}) {
  const filePath = String(options.filePath || '').trim();
  const ext = path.extname(filePath).toLowerCase();
  const text = normalizeNewlines(raw);

  if (ext === '.md' || ext === '.markdown') {
    const split = splitMarkdownFrontMatter(text);
    const meta = split.frontMatter ? parseYamlLike(split.frontMatter) : {};
    return normalizeAgentPrompt({ meta, body: split.body }, options);
  }

  const meta = parseYamlLike(text);
  return normalizeAgentPrompt({ meta, body: '' }, options);
}

function readAgentPromptFile(filePath = '', options = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseAgentPromptText(raw, { ...options, filePath });
}

function isAgentPromptFile(filePath = '') {
  return AGENT_PROMPT_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function listAgentPromptFiles(rootDir = '') {
  const root = String(rootDir || '').trim();
  const results = [];
  if (!root || !fs.existsSync(root)) return results;

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    const inAgentsDir = path.basename(current).toLowerCase() === 'agents';
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && inAgentsDir && isAgentPromptFile(abs)) {
        results.push(abs);
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function listSkillAgentPromptFiles(skillRoot = '') {
  const agentsDir = path.join(String(skillRoot || ''), 'agents');
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(agentsDir, entry.name))
    .filter(isAgentPromptFile)
    .sort((a, b) => a.localeCompare(b));
}

function loadSkillAgentPrompts(skillRoot = '') {
  return listSkillAgentPromptFiles(skillRoot).map((filePath) => readAgentPromptFile(filePath, { rootDir: skillRoot }));
}

function collectAgentPromptFilesFromRoots(roots = []) {
  const seen = new Set();
  const files = [];
  for (const root of roots) {
    for (const filePath of listAgentPromptFiles(root)) {
      const key = path.resolve(filePath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(filePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function loadAgentPromptsFromRoots(roots = [], options = {}) {
  const rootDir = String(options.rootDir || '').trim();
  return collectAgentPromptFilesFromRoots(roots)
    .map((filePath) => readAgentPromptFile(filePath, rootDir ? { rootDir } : {}));
}

function formatAgentPromptForRuntime(agentPrompt = {}) {
  const defaultPrompt = pickString(
    agentPrompt.defaultPrompt,
    agentPrompt.prompt,
    agentPrompt.content,
    agentPrompt.interface?.default_prompt,
    agentPrompt.interface?.defaultPrompt
  );
  if (!defaultPrompt) {
    const source = normalizeText(agentPrompt.relativePath || agentPrompt.sourcePath) || '(unknown)';
    const problems = Array.isArray(agentPrompt.problems)
      ? agentPrompt.problems.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    throw new Error(`Invalid agent prompt ${source}: ${problems.join('; ') || 'Missing default prompt text'}`);
  }
  const lines = [
    `- ${normalizeText(agentPrompt.displayName || agentPrompt.id) || 'agent'}`,
    `  source: ${normalizeText(agentPrompt.relativePath || agentPrompt.sourcePath) || '(unknown)'}`,
    `  format: ${normalizeText(agentPrompt.format) || 'unknown'}`
  ];
  if (agentPrompt.shortDescription) lines.push(`  description: ${agentPrompt.shortDescription}`);
  lines.push('  default_prompt:');
  lines.push(String(defaultPrompt || '').split(/\r?\n/).map((line) => `    ${line}`).join('\n'));
  return lines.join('\n');
}

module.exports = {
  AGENT_PROMPT_EXTENSIONS,
  collectAgentPromptFilesFromRoots,
  formatAgentPromptForRuntime,
  isAgentPromptFile,
  listAgentPromptFiles,
  loadAgentPromptsFromRoots,
  listSkillAgentPromptFiles,
  loadSkillAgentPrompts,
  parseAgentPromptText,
  readAgentPromptFile
};
