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
      args: ['/d', '/c', `call "${restartScript}" restart confirm`],
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
  const meta = options.meta && typeof options.meta === 'object' ? options.meta : {};
  try {
    process.emit('mizuki:restartScheduled', { delayMs: options.delayMs ?? 800, ...meta });
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
      windowsHide: true,
      env: {
        ...process.env,
        MIZUKI_RESTART_CONFIRM: '1',
        MIZUKI_RESTART_SOURCE: String(meta.source || 'remote_restart').trim() || 'remote_restart',
        MIZUKI_RESTART_REASON: String(meta.reason || 'remote_restart_scheduled').trim() || 'remote_restart_scheduled',
        MIZUKI_RESTART_REQUESTED_BY: String(meta.userId || '').trim(),
        MIZUKI_RESTART_REQUEST_ID: String(meta.requestId || '').trim(),
        MIZUKI_RESTART_MESSAGE_ID: String(meta.messageId || '').trim(),
        MIZUKI_RESTART_GROUP_ID: String(meta.groupId || '').trim(),
        MIZUKI_RESTART_COMMAND: String(meta.command || '').trim()
      }
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
