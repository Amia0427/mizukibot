const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TARGET_TESTS = [
  'tests/restartBotScript.test.js',
  'tests/windowsDaemonScript.test.js',
  'tests/mainModelFallback.test.js',
  'tests/mainModelFallbackRestartRecovery.test.js',
  'tests/continuousMessagePreprocessorDebounce.test.js',
  'tests/messageHandlerGroupConcurrency.test.js',
  'tests/messageHandlerInboundConcurrency.test.js'
];

function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    root: process.cwd(),
    skipRestartPayload: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = String(argv[index] || '').trim();
    if (!item) continue;
    if (item === '--root') {
      result.root = argv[index + 1] || result.root;
      index += 1;
      continue;
    }
    if (item.startsWith('--root=')) {
      result.root = item.slice('--root='.length);
      continue;
    }
    if (item === '--skip-restart-payload') {
      result.skipRestartPayload = true;
      continue;
    }
    throw new Error(`Unknown argument: ${item}`);
  }

  return {
    ...result,
    root: path.resolve(result.root)
  };
}

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function ensureFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required release file: ${relativePath}`);
  }
  return filePath;
}

function copySmokeFile(sourceRoot, targetRoot, relativePath) {
  const sourcePath = ensureFile(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function buildNodeEnv(root, extra = {}) {
  const env = {
    ...process.env,
    API_KEY: process.env.API_KEY || 'pre-release-smoke-key',
    DATA_DIR: extra.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-pre-release-smoke-data-')),
    RESOURCE_PRESSURE_ENABLED: 'false',
    ...extra
  };

  const rootNodeModules = path.join(root, 'node_modules');
  const localNodeModules = path.join(__dirname, '..', 'node_modules');
  const nodePathParts = [];
  if (!fs.existsSync(rootNodeModules) && fs.existsSync(localNodeModules)) {
    nodePathParts.push(localNodeModules);
  }
  if (env.NODE_PATH) nodePathParts.push(env.NODE_PATH);
  if (nodePathParts.length > 0) env.NODE_PATH = nodePathParts.join(path.delimiter);

  return env;
}

function runCommand(name, command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;

  console.log(`[pre-release-smoke] ${name}`);
  console.log(`  cwd: ${options.cwd || process.cwd()}`);
  console.log(`  run: ${[command, ...args].join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch (_) {}
      reject(new Error(`${name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
        return;
      }
      const tail = `${stdout}\n${stderr}`.split(/\r?\n/).slice(-40).join('\n');
      reject(new Error(`${name} failed with code ${code}${signal ? ` signal ${signal}` : ''}\n${tail}`));
    });
  });
}

async function runExpectedShutdownGuard(root) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-expected-shutdown-smoke-'));
  const restartScript = copySmokeFile(root, sandboxRoot, 'restart-bot.cmd');
  copySmokeFile(root, sandboxRoot, 'scripts/windows-daemon-common.ps1');
  copySmokeFile(root, sandboxRoot, 'scripts/run-bot-daemon.ps1');

  const markerPath = path.join(sandboxRoot, 'data', 'bot-main-expected-shutdown.json');
  const daemonLogPath = path.join(sandboxRoot, 'data', 'bot-daemon.log');
  const markerBefore = readFileOrNull(markerPath);
  const daemonLogBefore = readFileOrNull(daemonLogPath);
  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$script = Get-Content -LiteralPath $env:MIZUKI_SMOKE_RESTART_SCRIPT -Raw",
    "$marker = '# POWERSHELL_PAYLOAD'",
    '$idx = $script.LastIndexOf($marker)',
    "if ($idx -lt 0) { throw 'Missing PowerShell payload.' }",
    '$payload = $script.Substring($idx + $marker.Length).TrimStart()',
    '$block = [scriptblock]::Create($payload)',
    "& $block -TaskName 'MizukiPreReleaseSmoke' -Restart -SkipInstall"
  ].join('; ');

  const result = await runCommand(
    'expected_shutdown guard via sandboxed unconfirmed restart payload',
    powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      cwd: sandboxRoot,
      env: {
        ...process.env,
        MIZUKI_RESTART_BOT_ROOT: sandboxRoot.endsWith(path.sep) ? sandboxRoot : sandboxRoot + path.sep,
        MIZUKI_SMOKE_RESTART_SCRIPT: restartScript
      },
      timeoutMs: 60000
    }
  );

  if (!/restart skipped: explicit confirmation required/i.test(result.stdout)) {
    throw new Error('Unconfirmed restart did not report the explicit-confirmation guard.');
  }

  const markerAfter = readFileOrNull(markerPath);
  const daemonLogAfter = readFileOrNull(daemonLogPath);
  if (markerBefore !== markerAfter) {
    throw new Error('Unconfirmed restart changed bot-main-expected-shutdown.json.');
  }
  if (daemonLogBefore !== daemonLogAfter) {
    throw new Error('Unconfirmed restart changed bot-daemon.log.');
  }

  console.log('[pre-release-smoke] expected_shutdown guard ok: marker/log unchanged');
}

async function runTargetedTests(root) {
  ensureFile(root, 'scripts/run-tests.js');
  for (const testPath of TARGET_TESTS) ensureFile(root, testPath);

  await runCommand(
    'targeted release smoke tests',
    process.execPath,
    ['scripts/run-tests.js', ...TARGET_TESTS],
    {
      cwd: root,
      env: buildNodeEnv(root),
      timeoutMs: 180000
    }
  );
}

async function runConfigProbe(root) {
  const probe = [
    "process.env.API_KEY = process.env.API_KEY || 'pre-release-smoke-key'",
    "process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mizuki-pre-release-config-'))",
    "process.env.CONTINUOUS_MESSAGE_DEBOUNCE_MS = '15000'",
    "process.env.CONTINUOUS_MESSAGE_GROUP_PLAIN_TEXT_DEBOUNCE_MS = '2000'",
    "process.env.CONTINUOUS_MESSAGE_AT_BOT_DEBOUNCE_MS = '12000'",
    "process.env.CONTINUOUS_MESSAGE_PRIVATE_DEBOUNCE_MS = '12000'",
    "const config = require('./config')",
    "const { createContinuousMessagePreprocessor } = require('./core/continuousMessagePreprocessor')",
    'const preprocessor = createContinuousMessagePreprocessor({ enabled: true, debounceMs: config.CONTINUOUS_MESSAGE_DEBOUNCE_MS, groupPlainTextDebounceMs: config.CONTINUOUS_MESSAGE_GROUP_PLAIN_TEXT_DEBOUNCE_MS, atBotDebounceMs: config.CONTINUOUS_MESSAGE_AT_BOT_DEBOUNCE_MS, privateDebounceMs: config.CONTINUOUS_MESSAGE_PRIVATE_DEBOUNCE_MS, maxHoldMs: config.CONTINUOUS_MESSAGE_MAX_HOLD_MS })',
    "const result = { regular: preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: false }), anchored: preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: false, hasLongAggregationAnchor: true }), atBot: preprocessor.getSessionDebounceMs({ messageType: 'group', mentionedBot: true }), private: preprocessor.getSessionDebounceMs({ messageType: 'private', mentionedBot: false }), fallbackCooldownMs: config.AI_FALLBACK_COOLDOWN_MS }",
    "if (result.regular >= 15000) { throw new Error('regular group debounce is still 15s+') }",
    "if (result.anchored !== 15000) { throw new Error('anchored group debounce should keep the long aggregation window') }",
    "if (result.fallbackCooldownMs <= 0) { throw new Error('AI_FALLBACK_COOLDOWN_MS should not be permanent by default') }",
    'console.log(JSON.stringify(result))'
  ].join('; ');

  await runCommand(
    'config probe for group debounce and fallback cooldown',
    process.execPath,
    ['-e', probe],
    {
      cwd: root,
      env: buildNodeEnv(root),
      timeoutMs: 60000
    }
  );
}

async function main() {
  const args = parseArgs();
  ensureFile(args.root, 'package.json');

  console.log(`[pre-release-smoke] root=${args.root}`);
  if (!args.skipRestartPayload) {
    await runExpectedShutdownGuard(args.root);
  }
  await runTargetedTests(args.root);
  await runConfigProbe(args.root);
  console.log('[pre-release-smoke] PASS');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[pre-release-smoke] FAIL');
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  TARGET_TESTS,
  parseArgs
};
