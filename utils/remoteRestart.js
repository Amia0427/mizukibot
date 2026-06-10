const path = require('path');
const { spawn: defaultSpawn } = require('child_process');

let restartScheduled = false;

function getRepoRoot() {
  return path.join(__dirname, '..');
}

function resolveRestartCommand(platform = process.platform) {
  const repoRoot = getRepoRoot();
  if (platform === 'win32') {
    const restartScript = path.join(repoRoot, 'restart-bot.cmd');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', `call "${restartScript}"`],
      cwd: repoRoot,
      script: restartScript,
      windowsVerbatimArguments: true
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
    const spawnOptions = {
      cwd: commandSpec.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    };
    if (commandSpec.windowsVerbatimArguments) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    const onSpawnError = (error) => {
      restartScheduled = false;
      console.error('[remote-restart] failed to spawn restart command:', error?.message || error);
    };

    try {
      const child = spawn(commandSpec.command, commandSpec.args, spawnOptions);
      if (child && typeof child.once === 'function') {
        child.once('error', onSpawnError);
      }
      if (child && typeof child.unref === 'function') child.unref();
    } catch (error) {
      onSpawnError(error);
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
