const path = require('path');
const { spawn: defaultSpawn } = require('child_process');

let restartScheduled = false;

function getRepoRoot() {
  return path.join(__dirname, '..');
}

function resolveRestartCommand(platform = process.platform) {
  const repoRoot = getRepoRoot();
  if (platform === 'win32') {
    return {
      command: path.join(repoRoot, 'restart-bot.cmd'),
      args: [],
      cwd: repoRoot
    };
  }
  return {
    command: 'bash',
    args: [path.join(repoRoot, 'scripts', 'mizukibot.sh'), 'restart'],
    cwd: repoRoot
  };
}

function triggerRemoteRestart(options = {}) {
  if (restartScheduled) {
    return { scheduled: false, alreadyScheduled: true };
  }

  restartScheduled = true;
  try {
    process.emit('mizuki:restartScheduled', { delayMs: options.delayMs ?? 800 });
  } catch (_) {}
  const spawn = options.spawn || defaultSpawn;
  const platform = options.platform || process.platform;
  const delayMs = Math.max(0, Number(options.delayMs ?? 800) || 0);
  const commandSpec = resolveRestartCommand(platform);

  const timer = setTimeout(() => {
    try {
      const child = spawn(commandSpec.command, commandSpec.args, {
        cwd: commandSpec.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (error) {
      restartScheduled = false;
      console.error('[remote-restart] failed to spawn restart command:', error?.message || error);
    }
  }, delayMs);

  if (timer && typeof timer.unref === 'function') timer.unref();
  return { scheduled: true, alreadyScheduled: false, delayMs, ...commandSpec };
}

function resetRemoteRestartForTest() {
  restartScheduled = false;
}

module.exports = {
  resolveRestartCommand,
  resetRemoteRestartForTest,
  triggerRemoteRestart
};
