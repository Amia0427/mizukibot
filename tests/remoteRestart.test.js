const assert = require('assert');
const path = require('path');

const {
  resetRemoteRestartForTest,
  resolveRestartCommand,
  triggerRemoteRestart
} = require('../utils/remoteRestart');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (async () => {
  resetRemoteRestartForTest();

  const winSpec = resolveRestartCommand('win32');
  assert.ok(String(winSpec.command).toLowerCase().endsWith('cmd.exe'));
  assert.strictEqual(path.basename(winSpec.script).toLowerCase(), 'restart-bot.cmd');
  assert.deepStrictEqual(winSpec.args.slice(0, 2), ['/d', '/c']);
  assert.ok(winSpec.args[2].includes('restart-bot.cmd'));
  assert.ok(/\brestart\b/i.test(winSpec.args[2]), 'remote restart should pass an explicit restart command');
  assert.strictEqual(winSpec.windowsVerbatimArguments, true);

  const spawned = [];
  const restartEvents = [];
  const onRestartScheduled = (event) => restartEvents.push(event);
  process.on('mizuki:restartScheduled', onRestartScheduled);
  const first = triggerRemoteRestart({
    platform: 'win32',
    delayMs: 1,
    spawn: (command, args, options) => {
      spawned.push({ command, args, options, unrefCalled: false });
      return {
        unref() {
          spawned[spawned.length - 1].unrefCalled = true;
        }
      };
    }
  });
  const second = triggerRemoteRestart({
    platform: 'win32',
    delayMs: 1,
    spawn: () => {
      throw new Error('second spawn should not run');
    }
  });

  assert.strictEqual(first.scheduled, true);
  assert.strictEqual(second.scheduled, false);
  assert.strictEqual(second.alreadyScheduled, true);
  assert.strictEqual(restartEvents.length, 1);
  assert.strictEqual(restartEvents[0].delayMs, 1);

  await wait(20);

  assert.strictEqual(spawned.length, 1);
  assert.ok(String(spawned[0].command).toLowerCase().endsWith('cmd.exe'));
  assert.deepStrictEqual(spawned[0].args, winSpec.args);
  assert.strictEqual(spawned[0].options.detached, true);
  assert.strictEqual(spawned[0].options.stdio, 'ignore');
  assert.strictEqual(spawned[0].options.windowsVerbatimArguments, true);
  assert.strictEqual(spawned[0].unrefCalled, true);

  resetRemoteRestartForTest();
  process.removeListener('mizuki:restartScheduled', onRestartScheduled);
  console.log('remoteRestart.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
