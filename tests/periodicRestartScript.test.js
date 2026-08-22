const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const powershellCommand = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(command) {
  return spawnSync(powershellCommand, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')
  ], {
    cwd: root,
    encoding: 'utf8'
  });
}

function readJsonLine(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((item) => item.trim().startsWith('{'));
  assert.ok(line, stdout);
  return JSON.parse(line);
}

const restartScript = path.join(root, 'scripts', 'restart-bot-periodic.ps1');
const restartLog = path.join(os.tmpdir(), 'mizuki-periodic-restart-validation.log');
const processTraps = [
  'function global:Add-Content { param($Path, $Value, $Encoding) }',
  "function global:Stop-Process { throw 'process trap: Stop-Process' }",
  "function global:Start-Process { throw 'process trap: Start-Process' }",
  "function global:Get-CimInstance { throw 'process trap: Get-CimInstance' }"
];
const restartResult = runPowerShell([
  ...processTraps,
  `& ${quotePowerShell(restartScript)} -ValidateOnly -LogFile ${quotePowerShell(restartLog)}`
].join('; '));

if (restartResult.error?.code === 'ENOENT' && process.platform !== 'win32') {
  console.log('periodicRestartScript.test.js skipped: pwsh is unavailable');
} else {
  assert.ifError(restartResult.error);
  assert.strictEqual(restartResult.status, 0, restartResult.stderr || restartResult.stdout);
  assert.doesNotMatch(`${restartResult.stdout}\n${restartResult.stderr}`, /process trap:/);
  const restartPlan = readJsonLine(restartResult.stdout);
  assert.strictEqual(restartPlan.execute, false);
  assert.ok(fs.existsSync(restartPlan.nodeExecutable));
  assert.deepStrictEqual(restartPlan.arguments, ['index.js']);
  assert.strictEqual(path.resolve(restartPlan.workingDirectory), root);
  assert.strictEqual(path.resolve(restartPlan.lockPath), path.join(root, '.mizukibot.lock'));
  assert.strictEqual(path.resolve(restartPlan.logPath), restartLog);
  assert.strictEqual(path.resolve(restartPlan.stdoutLogPath), path.join(root, 'data', 'bot-runtime.out.log'));
  assert.strictEqual(path.resolve(restartPlan.stderrLogPath), path.join(root, 'data', 'bot-runtime.err.log'));
  assert.match(restartResult.stdout, /Validation only; restart not executed/);

  const installScript = path.join(root, 'scripts', 'install-periodic-restart.ps1');
  const installTraps = [
    "function global:Get-ScheduledTask { throw 'install trap: Get-ScheduledTask' }",
    "function global:Unregister-ScheduledTask { throw 'install trap: Unregister-ScheduledTask' }",
    "function global:schtasks { throw 'install trap: schtasks' }",
    "function global:Remove-Item { throw 'install trap: Remove-Item' }"
  ];
  const installResult = runPowerShell([
    ...installTraps,
    `& ${quotePowerShell(installScript)} -ValidateOnly`
  ].join('; '));
  assert.strictEqual(installResult.status, 0, installResult.stderr || installResult.stdout);
  assert.doesNotMatch(`${installResult.stdout}\n${installResult.stderr}`, /install trap:/);
  const installPlan = readJsonLine(installResult.stdout);
  assert.strictEqual(installPlan.execute, false);
  assert.strictEqual(installPlan.dailyTime, '04:00');
  assert.strictEqual(path.resolve(installPlan.restartScript), restartScript);
  assert.strictEqual(path.resolve(installPlan.workingDirectory), root);
  assert.match(installPlan.taskXml, /<CalendarTrigger>/);
  assert.match(installPlan.taskXml, /<ScheduleByDay>\s*<DaysInterval>1<\/DaysInterval>\s*<\/ScheduleByDay>/);
  assert.ok(installPlan.taskXml.includes(`-File "${restartScript}"`));
  assert.ok(installPlan.taskXml.includes(`<WorkingDirectory>${root}</WorkingDirectory>`));
  assert.doesNotMatch(installPlan.taskXml, /<Repetition>/);

  const invalidResult = runPowerShell([
    ...installTraps,
    `& ${quotePowerShell(installScript)} -ValidateOnly -DailyTime '24:00'`
  ].join('; '));
  assert.notStrictEqual(invalidResult.status, 0);
  assert.match(`${invalidResult.stdout}\n${invalidResult.stderr}`, /DailyTime must be a valid 24-hour time/);
  assert.doesNotMatch(`${invalidResult.stdout}\n${invalidResult.stderr}`, /install trap:/);

  console.log('periodicRestartScript.test.js passed');
}
