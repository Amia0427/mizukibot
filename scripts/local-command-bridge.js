const express = require('express');
const { spawn } = require('child_process');
const config = require('../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function ensureAuthorized(req, res, next) {
  const expected = normalizeText(config.LOCAL_COMMAND_BRIDGE_TOKEN);
  if (!expected) return next();
  const auth = normalizeText(req.headers.authorization || '');
  if (auth === `Bearer ${expected}`) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function runCommand(command, args = [], options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
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
  const repoRoot = process.cwd();
  const commandName = normalizeText(name).toLowerCase();
  const specs = {
    python: {
      command: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      args: Array.isArray(payload.args) ? payload.args : [],
      cwd: payload.cwd || repoRoot
    },
    py: {
      command: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe',
      args: Array.isArray(payload.args) ? payload.args : [],
      cwd: payload.cwd || repoRoot
    },
    node: {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: Array.isArray(payload.args) ? payload.args : [],
      cwd: payload.cwd || repoRoot
    },
    npm: {
      command: 'C:\\Program Files\\nodejs\\npm.cmd',
      args: Array.isArray(payload.args) ? payload.args : [],
      cwd: payload.cwd || repoRoot
    },
    npx: {
      command: 'C:\\Program Files\\nodejs\\npx.cmd',
      args: Array.isArray(payload.args) ? payload.args : [],
      cwd: payload.cwd || repoRoot
    },
    hapi: {
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\hapi.cmd',
      args: Array.isArray(payload.args) ? payload.args : [],
      cwd: payload.cwd || repoRoot,
      env: {
        ...process.env,
        HAPI_HOME: 'D:\\waifu\\data\\hapi-home',
        CLI_API_TOKEN: 'FUcQwzRjozCZIApUYZyd-B4zjkXj0Ief80_i618xH8Q',
        HAPI_API_URL: 'http://127.0.0.1:3006'
      }
    }
  };
  return specs[commandName] || null;
}

async function main() {
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

main().catch((error) => {
  console.error('[local-command-bridge] fatal', error?.stack || error?.message || error);
  process.exit(1);
});
