const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (async () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'restart-bot-periodic.ps1');
  const installPath = path.join(__dirname, '..', 'scripts', 'install-periodic-restart.ps1');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const installScript = fs.readFileSync(installPath, 'utf8');

  assert.ok(script.includes('function Resolve-NodeExecutable'), 'periodic restart should resolve a real node.exe');
  assert.ok(script.includes('Start-Process -FilePath $nodeExe'), 'periodic restart should start node.exe directly');
  assert.ok(script.includes('-ArgumentList @("index.js")'), 'periodic restart should run the main bot entrypoint');
  assert.ok(script.includes('Test-LockOwnedByRunningMainBot'), 'periodic restart should verify the bot reacquires the lock');
  assert.ok(!/Start-Process\s+-FilePath\s+["']npm["']/i.test(script), 'periodic restart must not Start-Process npm on Windows');
  assert.ok(!/Start-Process\s+-FilePath\s+["']npm\.ps1["']/i.test(script), 'periodic restart must not Start-Process npm.ps1 on Windows');
  assert.ok(!/Start-Process\s+-FilePath\s+["']npm\.cmd["']/i.test(script), 'periodic restart should not depend on npm shims');

  assert.ok(installScript.includes('-File "$RestartScript"'), 'scheduled task should invoke the restart PowerShell file');
  assert.ok(installScript.includes('<WorkingDirectory>$ProjectRoot</WorkingDirectory>'), 'scheduled task should run from the project root');
  assert.ok(installScript.includes("[string]$DailyTime = '04:00'"), 'scheduled task should default to 04:00 daily restart');
  assert.ok(installScript.includes('<CalendarTrigger>'), 'scheduled task should use a daily calendar trigger');
  assert.ok(installScript.includes('<ScheduleByDay>'), 'scheduled task should schedule by day');
  assert.ok(installScript.includes('<DaysInterval>1</DaysInterval>'), 'scheduled task should run every 1 day');
  assert.ok(!installScript.includes('[int]$IntervalHours = 6'), 'scheduled task should no longer default to every 6 hours');
  assert.ok(!installScript.includes('<Repetition>'), 'scheduled task should not repeat every few hours');

  console.log('periodicRestartScript.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
