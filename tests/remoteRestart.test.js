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
  assert.strictEqual(path.basename(winSpec.command).toLowerCase(), 'restart-bot.cmd');
  assert.deepStrictEqual(winSpec.args, []);

  const spawned = [];
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

  await wait(20);

  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(path.basename(spawned[0].command).toLowerCase(), 'restart-bot.cmd');
  assert.deepStrictEqual(spawned[0].args, []);
  assert.strictEqual(spawned[0].options.detached, true);
  assert.strictEqual(spawned[0].options.stdio, 'ignore');
  assert.strictEqual(spawned[0].unrefCalled, true);

  resetRemoteRestartForTest();
  console.log('remoteRestart.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
