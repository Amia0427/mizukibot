const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../../config');
const {
  formatAgentPromptForRuntime,
  loadSkillAgentPrompts
} = require('../../utils/agentPrompts');

function resolveSkillsBaseDir() {
  const fromEnv = String(process.env.MIZUKI_SKILLS_DIR || '').trim();
  const candidates = [
    fromEnv,
    path.resolve(__dirname, '..', '..', 'skills'),
    path.resolve(process.cwd(), 'skills'),
    path.resolve(__dirname, '..', '..', '..', '..', 'skills'),
    path.resolve(process.cwd(), '..', '..', 'skills'),
    path.resolve(process.cwd(), '..', 'skills')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return path.resolve(__dirname, '..', '..', 'skills');
}

const SKILLS_VENV_DIR = String(process.env.MIZUKI_SKILLS_VENV || '').trim()
  || path.resolve(__dirname, '..', '..', '.venv_skills');
const SKILLS_PY_DEPS_DIR = String(process.env.MIZUKI_SKILLS_PY_DEPS || '').trim()
  || path.resolve(__dirname, '..', '..', '.skills_pydeps');
const SKILLS_BIN_DIR = String(process.env.MIZUKI_SKILLS_BIN || '').trim()
  || path.resolve(__dirname, '..', '..', '.skills_bin');

function getVenvBinDir() {
  return process.platform === 'win32'
    ? path.join(SKILLS_VENV_DIR, 'Scripts')
    : path.join(SKILLS_VENV_DIR, 'bin');
}

function getVenvPython() {
  return process.platform === 'win32'
    ? path.join(getVenvBinDir(), 'python.exe')
    : path.join(getVenvBinDir(), 'python3');
}

function buildCommandEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const venvBin = getVenvBinDir();
  const pathParts = [venvBin, SKILLS_BIN_DIR, env.PATH || ''].filter(Boolean);
  const pyPathParts = [SKILLS_PY_DEPS_DIR, env.PYTHONPATH || ''].filter(Boolean);

  env.PATH = pathParts.join(path.delimiter);
  env.PYTHONPATH = pyPathParts.join(path.delimiter);
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  return env;
}

function commandExists(commandName, env = process.env) {
  const pathEntries = String(env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '']
    : [''];
  for (const dir of pathEntries) {
    if (!dir) continue;
    for (const ext of exts) {
      const abs = path.join(dir, `${commandName}${ext}`);
      try {
        if (fs.existsSync(abs)) return true;
      } catch (_) {}
    }
  }
  return false;
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || config.TOOL_TIMEOUT_MS || 15000);
  const cwd = options.cwd || path.resolve(__dirname, '..', '..');
  const env = options.env || process.env;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    let timer = null;

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill('SIGTERM');
        reject(new Error(`命令超时(${timeoutMs}ms): ${command}`));
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      } else {
        const errMsg = stderr.trim() || stdout.trim() || `命令退出码: ${code}`;
        reject(new Error(errMsg));
      }
    });
  });
}

let cachedPythonCommand = null;

async function resolvePythonCommand(extraEnv = {}) {
  if (cachedPythonCommand) return cachedPythonCommand;

  const env = buildCommandEnv(extraEnv);
  const venvPython = getVenvPython();
  if (fs.existsSync(venvPython)) {
    try {
      await runCommand(venvPython, ['-V'], { env, timeoutMs: 5000 });
      cachedPythonCommand = { command: venvPython, baseArgs: [] };
      return cachedPythonCommand;
    } catch (_) {}
  }

  if (process.platform === 'win32') {
    const pyLauncher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
    if (fs.existsSync(pyLauncher)) {
      try {
        await runCommand(pyLauncher, ['-3', '-V'], { env, timeoutMs: 5000 });
        cachedPythonCommand = { command: pyLauncher, baseArgs: ['-3'] };
        return cachedPythonCommand;
      } catch (_) {}
    }
  }

  const fallbackCommands = process.platform === 'win32'
    ? ['python']
    : ['python3', 'python'];
  for (const command of fallbackCommands) {
    try {
      await runCommand(command, ['-V'], { env, timeoutMs: 5000 });
      cachedPythonCommand = { command, baseArgs: [] };
      return cachedPythonCommand;
    } catch (_) {}
  }

  cachedPythonCommand = { command: process.platform === 'win32' ? 'python' : 'python3', baseArgs: [] };
  return cachedPythonCommand;
}

async function runSkillPython(scriptPath, scriptArgs = [], extraEnv = {}) {
  const env = buildCommandEnv(extraEnv);
  const python = await resolvePythonCommand(extraEnv);
  return runCommand(python.command, [...python.baseArgs, scriptPath, ...scriptArgs], { env });
}

async function runSkillNode(scriptPath, scriptArgs = [], extraEnv = {}) {
  const env = buildCommandEnv(extraEnv);
  return runCommand('node', [scriptPath, ...scriptArgs], { env });
}

function ensureSkillPath(skillName, relPath = '') {
  const skillsBaseDir = resolveSkillsBaseDir();
  const abs = relPath
    ? path.join(skillsBaseDir, skillName, relPath)
    : path.join(skillsBaseDir, skillName);
  if (!fs.existsSync(abs)) {
    throw new Error(`Skill path not found: ${abs}`);
  }
  return abs;
}

function ensureSkillCacheDir(name) {
  const dir = path.join(config.DATA_DIR, 'skill_cache', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeStringList(raw, limit = 10, itemMaxLen = 50) {
  const items = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(',');
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => item.slice(0, itemMaxLen))
    .slice(0, limit);
}

function safeReadTextFile(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (_) {
    return '';
  }
}

function listSkillReferenceFiles(skillName) {
  const refs = [];
  const skillsBaseDir = resolveSkillsBaseDir();
  const roots = [
    path.join(skillsBaseDir, skillName, 'references'),
    path.join(skillsBaseDir, skillName, 'assets'),
    path.join(skillsBaseDir, skillName, 'snippets')
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (['.md', '.txt', '.json', '.yaml', '.yml'].includes(ext)) {
          refs.push(abs);
        }
      }
    }
  }

  return refs.sort();
}

function extractRelevantBlocks(text, query = '', limit = 2) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const lines = String(text || '').split(/\r?\n/);
  if (!normalizedQuery) {
    return lines.join('\n').trim().slice(0, 2200);
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || '');
    const lower = line.toLowerCase();
    if (!tokens.some((token) => lower.includes(token))) continue;
    const start = Math.max(0, i - 3);
    const end = Math.min(lines.length, i + 4);
    hits.push(lines.slice(start, end).join('\n').trim());
    if (hits.length >= limit) break;
  }

  if (hits.length > 0) return hits.join('\n\n---\n\n').slice(0, 2600);
  return lines.join('\n').trim().slice(0, 2200);
}

async function loadSkillReference(skillName, args = {}) {
  const skillDir = ensureSkillPath(skillName);
  const skillDocPath = path.join(skillDir, 'SKILL.md');
  const skillDoc = safeReadTextFile(skillDocPath);
  const query = String(args.query ?? args.topic ?? args.keyword ?? '').trim();
  const requestedRef = String(args.reference ?? args.doc ?? '').trim().toLowerCase();
  const refFiles = listSkillReferenceFiles(skillName);
  const agentPrompts = loadSkillAgentPrompts(skillDir);

  let selectedRef = '';
  if (requestedRef) {
    selectedRef = refFiles.find((abs) => path.basename(abs).toLowerCase() === requestedRef)
      || refFiles.find((abs) => abs.toLowerCase().includes(requestedRef))
      || '';
  }
  if (!selectedRef && query) {
    selectedRef = refFiles.find((abs) => path.basename(abs).toLowerCase().includes(query.toLowerCase()))
      || '';
  }
  if (!selectedRef && refFiles.length > 0) {
    selectedRef = refFiles[0];
  }

  const parts = [
    'SKILL: ' + skillName,
    'PATH: ' + skillDir
  ];

  if (query) {
    parts.push('QUERY: ' + query);
  }

  if (skillDoc) {
    parts.push('SKILL_MD:');
    parts.push(extractRelevantBlocks(skillDoc, query, 3));
  } else {
    parts.push('SKILL_MD: missing');
  }

  if (selectedRef) {
    const rel = path.relative(skillDir, selectedRef) || path.basename(selectedRef);
    const refText = safeReadTextFile(selectedRef);
    parts.push('REFERENCE_FILE: ' + rel);
    parts.push(extractRelevantBlocks(refText, query, 3));
  } else if (refFiles.length > 0) {
    parts.push('REFERENCE_FILES: ' + refFiles.slice(0, 8).map((abs) => path.relative(skillDir, abs)).join(', '));
  } else {
    parts.push('REFERENCE_FILES: none');
  }

  if (agentPrompts.length > 0) {
    parts.push('AGENT_PROMPTS:');
    parts.push(agentPrompts.map((agentPrompt) => formatAgentPromptForRuntime(agentPrompt)).join('\n\n'));
  } else {
    parts.push('AGENT_PROMPTS: none');
  }

  return parts.join('\n\n');
}

async function runShellSkillScript(skillName, relPath, args = [], extraEnv = {}) {
  const scriptPath = ensureSkillPath(skillName, relPath);
  if (process.platform === 'win32') {
    return {
      stdout: '',
      stderr: 'Script ' + relPath + ' requires a Linux shell runtime',
      code: 1
    };
  }
  return runCommand('bash', [scriptPath, ...args], {
    env: buildCommandEnv(extraEnv),
    cwd: path.dirname(scriptPath)
  });
}

module.exports = {
  SKILLS_BASE_DIR: resolveSkillsBaseDir(),
  buildCommandEnv,
  commandExists,
  ensureSkillCacheDir,
  ensureSkillPath,
  extractRelevantBlocks,
  getVenvBinDir,
  getVenvPython,
  listSkillReferenceFiles,
  loadSkillReference,
  normalizeStringList,
  resolvePythonCommand,
  resolveSkillsBaseDir,
  runCommand,
  runShellSkillScript,
  runSkillNode,
  runSkillPython,
  safeReadTextFile
};
