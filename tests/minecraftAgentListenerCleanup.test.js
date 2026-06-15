const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function installMineflayerMocks(createdBots) {
  class FakePathfinder extends EventEmitter {
    setMovements(movements) {
      this.movements = movements;
    }

    setGoal(goal) {
      this.goal = goal;
    }

    stop() {
      this.stopped = true;
    }
  }

  class FakeBot extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.username = options.username;
      this.player = null;
      this._client = { socket: { _host: options.host, _port: options.port } };
      this.entity = { position: { x: 1, y: 2, z: 3 } };
      this.game = { dimension: 'overworld' };
      this.health = 20;
      this.food = 20;
      this.players = {};
      this.pathfinder = new FakePathfinder();
    }

    loadPlugin(plugin) {
      if (typeof plugin === 'function') plugin(this);
      setImmediate(() => {
        this.player = { username: this.username };
        this.emit('spawn');
      });
    }

    clearControlStates() {
      this.controlsCleared = true;
    }

    quit(reason) {
      this.quitReason = reason;
      setImmediate(() => {
        this.player = null;
        this._client = null;
        this.emit('end', reason);
      });
    }
  }

  const mineflayerPath = require.resolve('mineflayer');
  const pathfinderPath = require.resolve('mineflayer-pathfinder');
  const vec3Path = require.resolve('vec3');

  require.cache[mineflayerPath] = {
    id: mineflayerPath,
    filename: mineflayerPath,
    loaded: true,
    exports: {
      createBot(options) {
        const fakeBot = new FakeBot(options);
        createdBots.push(fakeBot);
        return fakeBot;
      }
    }
  };

  require.cache[pathfinderPath] = {
    id: pathfinderPath,
    filename: pathfinderPath,
    loaded: true,
    exports: {
      pathfinder(fakeBot) {
        if (!fakeBot.pathfinder) fakeBot.pathfinder = new FakePathfinder();
      },
      goals: {
        GoalNear: class GoalNear {},
        GoalFollow: class GoalFollow {}
      },
      Movements: class Movements {
        constructor(fakeBot) {
          this.bot = fakeBot;
        }
      }
    }
  };

  require.cache[vec3Path] = {
    id: vec3Path,
    filename: vec3Path,
    loaded: true,
    exports: {
      Vec3: class Vec3 {
        constructor(x, y, z) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
      }
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const createdBots = [];

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.MC_ENABLED = 'true';
    process.env.MC_ALLOW_DYNAMIC_TARGET = 'true';
    process.env.MC_HOST = '127.0.0.1';
    process.env.MC_PORT = '25565';
    process.env.MC_USERNAME = 'mizuki-test';
    process.env.MC_CONNECT_TIMEOUT_MS = '3000';

    console.error = () => {};
    console.log = () => {};

    clearProjectCache();
    installMineflayerMocks(createdBots);

    const minecraftAgent = require('../api/minecraftAgent');
    const connectedText = await minecraftAgent.connect({
      host: '127.0.0.1',
      port: 25565,
      username: 'mizuki-test'
    });

    assert.ok(String(connectedText).includes('Minecraft bot connected.'));
    assert.strictEqual(createdBots.length, 1);

    const oldBot = createdBots[0];
    oldBot.on('chat', () => {});

    assert.strictEqual(oldBot.listenerCount('kicked'), 1);
    assert.strictEqual(oldBot.listenerCount('error'), 1);
    assert.ok(oldBot.listenerCount('end') >= 1);
    assert.strictEqual(oldBot.listenerCount('chat'), 1);

    const disconnectedText = await minecraftAgent.disconnect({ reason: 'test-reset-cleanup' });
    assert.ok(String(disconnectedText).includes('Minecraft bot disconnected'));

    for (const eventName of ['kicked', 'error', 'end', 'chat']) {
      assert.strictEqual(oldBot.listenerCount(eventName), 0, `${eventName} listeners should be removed from old bot`);
    }
    assert.ok(String(minecraftAgent.status()).includes('disconnected'));

    console.log = originalConsoleLog;
    console.log('minecraftAgentListenerCleanup.test.js passed');
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
