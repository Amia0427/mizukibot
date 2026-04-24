const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { logStartupSecurityWarnings } = require('../utils/securityDiagnostics');

const MAX_TIMEOUT_MS = 120000;
const REPO_ROOT = path.resolve(__dirname, '..');
const INLINE_CODE_ARGS = new Set(['-c', '-e', '--eval', '--print']);
const NPM_ALLOWED_COMMANDS = new Set(['run', 'test', 'start']);
const NPX_ALLOWED_COMMANDS = new Set(['--no-install']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function timingSafeEqualText(left = '', right = '') {
  const leftBuf = Buffer.from(String(left || ''), 'utf8');
  const rightBuf = Buffer.from(String(right || ''), 'utf8');
  if (leftBuf.length !== rightBuf.length) return false;
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function ensureAuthorized(req, res, next) {
  const expected = normalizeText(config.LOCAL_COMMAND_BRIDGE_TOKEN);
  if (!expected) return next();
  const auth = normalizeText(req.headers.authorization || '');
  if (timingSafeEqualText(auth, `Bearer ${expected}`)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function parseAllowedCwdRoots() {
  const raw = normalizeText(process.env.LOCAL_COMMAND_BRIDGE_ALLOWED_CWD || '');
  const roots = [REPO_ROOT];
  for (const item of raw.split(path.delimiter)) {
    const value = normalizeText(item);
    if (!value) continue;
    roots.push(path.resolve(value));
  }
  return roots;
}

function isWithinRoot(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveSafeCwd(input) {
  const raw = normalizeText(input);
  if (/^\\\\/.test(raw)) throw new Error('cwd outside allowed roots');
  const resolved = raw ? path.resolve(REPO_ROOT, raw) : REPO_ROOT;
  const roots = parseAllowedCwdRoots();
  if (!roots.some((root) => isWithinRoot(resolved, root))) {
    throw new Error('cwd outside allowed roots');
  }
  return resolved;
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((arg) => String(arg)) : [];
}

function validateRuntimeArgs(commandName, args) {
  if ((commandName === 'python' || commandName === 'py' || commandName === 'node')
    && args.some((arg) => INLINE_CODE_ARGS.has(String(arg).trim().toLowerCase()))) {
    throw new Error(`${commandName} inline execution is not allowed`);
  }
}

function validatePackageRunnerArgs(commandName, args) {
  const first = normalizeText(args[0]).toLowerCase();
  if (commandName === 'npm') {
    if (!NPM_ALLOWED_COMMANDS.has(first)) throw new Error('npm command is not allowed');
    if (args.some((arg) => normalizeText(arg) === '--')) throw new Error('npm shell passthrough is not allowed');
  }
  if (commandName === 'npx') {
    if (!NPX_ALLOWED_COMMANDS.has(first)) throw new Error('npx command is not allowed');
    if (args.length < 2) throw new Error('npx requires a local tool name');
    if (args.some((arg) => /^https?:\/\//i.test(normalizeText(arg)))) throw new Error('npx remote packages are not allowed');
  }
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30000;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, parsed));
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const cwd = options.cwd || process.cwd();
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
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch (_) {}
      reject(new Error(`command timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function buildCommandSpec(name = '', payload = {}) {
  const repoRoot = REPO_ROOT;
  const commandName = normalizeText(name).toLowerCase();
  const args = normalizeArgs(payload.args);
  validateRuntimeArgs(commandName, args);
  validatePackageRunnerArgs(commandName, args);
  const cwd = resolveSafeCwd(payload.cwd || repoRoot);
  const hapiEnv = {
    ...process.env,
    HAPI_HOME: 'D:\\waifu\\data\\hapi-home',
    HAPI_API_URL: 'http://127.0.0.1:3006'
  };
  const cliApiToken = normalizeText(process.env.CLI_API_TOKEN || process.env.HAPI_CLI_API_TOKEN || '');
  if (cliApiToken) hapiEnv.CLI_API_TOKEN = cliApiToken;
  const specs = {
    python: {
      command: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      args,
      cwd
    },
    py: {
      command: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe',
      args,
      cwd
    },
    node: {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args,
      cwd
    },
    npm: {
      command: 'C:\\Program Files\\nodejs\\npm.cmd',
      args,
      cwd
    },
    npx: {
      command: 'C:\\Program Files\\nodejs\\npx.cmd',
      args,
      cwd
    },
    hapi: {
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\hapi.cmd',
      args,
      cwd,
      env: hapiEnv
    }
  };
  return specs[commandName] || null;
}

function warnIfBridgeTokenMissing() {
  logStartupSecurityWarnings(config, (message) => {
    if (!String(message || '').includes('local-command-bridge')) return;
    console.warn(message);
  });
}

async function main() {
  warnIfBridgeTokenMissing();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(ensureAuthorized);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/run', async (req, res) => {
    try {
      const spec = buildCommandSpec(req.body?.name, req.body || {});
      if (!spec) {
        return res.status(400).json({ ok: false, error: 'unsupported_command' });
      }
      const result = await runCommand(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        timeoutMs: req.body?.timeoutMs
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  const port = 3210;
  app.listen(port, '127.0.0.1', () => {
    console.log(`[local-command-bridge] listening on 127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[local-command-bridge] fatal', error?.stack || error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  buildCommandSpec,
  ensureAuthorized,
  normalizeTimeoutMs,
  resolveSafeCwd,
  timingSafeEqualText,
  warnIfBridgeTokenMissing
};
