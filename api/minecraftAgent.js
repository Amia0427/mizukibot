const config = require('../config');

let bot = null;
let pathfinderApi = null;
let goalsApi = null;
let MovementsCtor = null;
let Vec3Ctor = null;
let defaultMovements = null;
let followState = {
  player: '',
  distance: 2
};

function normalizeAuth(auth) {
  const raw = String(auth || '').trim().toLowerCase();
  if (raw === 'mojang' || raw === 'microsoft' || raw === 'offline') return raw;
  return 'offline';
}

function pickConnectOptions(args = {}) {
  const auth = normalizeAuth(args.auth ?? config.MC_AUTH);
  const host = String((args.host ?? config.MC_HOST) || '').trim();
  const username = String((args.username ?? config.MC_USERNAME) || '').trim();
  const version = String((args.version ?? config.MC_VERSION) || '').trim();
  const password = String((args.password ?? config.MC_PASSWORD) || '').trim();
  const portRaw = Number(args.port ?? config.MC_PORT);
  const port = Number.isFinite(portRaw) ? Math.max(1, Math.min(65535, Math.floor(portRaw))) : 25565;

  return { auth, host, port, username, version, password };
}

function ensureEnabled() {
  if (!config.MC_ENABLED) {
    throw new Error('Minecraft tool is disabled. Set MC_ENABLED=true in .env first.');
  }
}

function ensureConnected() {
  if (!bot || !bot.player || !bot._client) {
    throw new Error('Minecraft bot is not connected. Please call minecraft_connect first.');
  }
}

function safeClearControls() {
  if (!bot) return;
  try {
    if (typeof bot.clearControlStates === 'function') {
      bot.clearControlStates();
      return;
    }
  } catch (_) {}

  const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
  for (const control of controls) {
    try {
      bot.setControlState(control, false);
    } catch (_) {}
  }
}

function resetRuntimeState() {
  bot = null;
  pathfinderApi = null;
  goalsApi = null;
  MovementsCtor = null;
  Vec3Ctor = null;
  defaultMovements = null;
  followState = { player: '', distance: 2 };
}

function getStatusObject() {
  if (!bot) {
    return {
      connected: false,
      username: '',
      host: '',
      port: 0,
      dimension: '',
      health: 0,
      food: 0,
      position: null,
      following: ''
    };
  }

  const pos = bot.entity?.position;
  return {
    connected: Boolean(bot.player && bot._client),
    username: String(bot.username || ''),
    host: String(bot._client?.socket?._host || ''),
    port: Number(bot._client?.socket?._port || 0),
    dimension: String(bot.game?.dimension || ''),
    health: Number(bot.health || 0),
    food: Number(bot.food || 0),
    position: pos
      ? {
          x: Number(pos.x.toFixed(2)),
          y: Number(pos.y.toFixed(2)),
          z: Number(pos.z.toFixed(2))
        }
      : null,
    following: followState.player || ''
  };
}

function formatStatusText(status) {
  if (!status.connected) return 'Minecraft bot is disconnected.';
  const p = status.position || { x: '?', y: '?', z: '?' };
  const followText = status.following ? `following=${status.following}` : 'following=none';
  return [
    `connected=true`,
    `username=${status.username}`,
    `server=${status.host}:${status.port}`,
    `dimension=${status.dimension || 'unknown'}`,
    `health=${status.health}, food=${status.food}`,
    `position=(${p.x}, ${p.y}, ${p.z})`,
    followText
  ].join('\n');
}

function loadMineflayerDeps() {
  let mineflayer = null;
  try {
    mineflayer = require('mineflayer');
  } catch (e) {
    throw new Error(`Missing dependency: mineflayer (${e.message})`);
  }

  let pathfinderModel = null;
  try {
    pathfinderModel = require('mineflayer-pathfinder');
  } catch (e) {
    throw new Error(`Missing dependency: mineflayer-pathfinder (${e.message})`);
  }

  let vec3Module = null;
  try {
    vec3Module = require('vec3');
  } catch (e) {
    throw new Error(`Missing dependency: vec3 (${e.message})`);
  }

  const pathfinderPlugin = pathfinderModel.pathfinder;
  const goals = pathfinderModel.goals;
  const Movements = pathfinderModel.Movements;
  const Vec3 = vec3Module.Vec3 || vec3Module;

  if (!pathfinderPlugin || !goals || !Movements || !Vec3) {
    throw new Error('Invalid mineflayer-related dependency exports.');
  }

  return { mineflayer, pathfinderPlugin, goals, Movements, Vec3 };
}

function attachCoreBotEvents(activeBot) {
  activeBot.on('kicked', (reason) => {
    // Keep event logs concise so callers can inspect failures quickly.
    console.error('[minecraft] kicked:', reason);
  });

  activeBot.on('error', (err) => {
    console.error('[minecraft] bot error:', err?.message || err);
  });

  activeBot.on('end', (reason) => {
    console.log('[minecraft] disconnected:', reason || 'end');
    if (bot === activeBot) {
      resetRuntimeState();
    }
  });
}

function waitForSpawn(activeBot, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onSpawn = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const onEnd = (reason) => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Disconnected before spawn: ${reason || 'unknown reason'}`));
    };

    const onError = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(err?.message || 'Unknown minecraft connection error'));
    };

    function cleanup() {
      clearTimeout(timer);
      activeBot.off('spawn', onSpawn);
      activeBot.off('end', onEnd);
      activeBot.off('error', onError);
    }

    activeBot.once('spawn', onSpawn);
    activeBot.once('end', onEnd);
    activeBot.once('error', onError);
  });
}

function waitForPathResult(timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Pathfinding timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onGoalReached = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve('goal_reached');
    };

    const onPathReset = (reason) => {
      if (done) return;
      if (String(reason || '').toLowerCase() === 'goal_updated') return;
      done = true;
      cleanup();
      reject(new Error(`Path reset: ${reason || 'unknown reason'}`));
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('Bot disconnected during pathfinding'));
    };

    function cleanup() {
      clearTimeout(timer);
      if (!bot?.pathfinder) return;
      bot.pathfinder.off('goal_reached', onGoalReached);
      bot.pathfinder.off('path_reset', onPathReset);
      bot.off('end', onEnd);
    }

    if (!bot?.pathfinder) {
      clearTimeout(timer);
      reject(new Error('Pathfinder is not available.'));
      return;
    }

    bot.pathfinder.once('goal_reached', onGoalReached);
    bot.pathfinder.on('path_reset', onPathReset);
    bot.once('end', onEnd);
  });
}

async function connect(args = {}) {
  ensureEnabled();

  if (bot && bot.player && bot._client) {
    return `Minecraft bot already connected.\n${formatStatusText(getStatusObject())}`;
  }

  if (bot) {
    await disconnect({ reason: 'replace-connection' });
  }

  const opts = pickConnectOptions(args);
  if (!opts.host) throw new Error('Missing Minecraft host. Set MC_HOST or pass host.');
  if (!opts.username) throw new Error('Missing Minecraft username. Set MC_USERNAME or pass username.');

  if (!config.MC_ALLOW_DYNAMIC_TARGET) {
    const lockHost = String(config.MC_HOST || '').trim();
    const lockPort = Number(config.MC_PORT || 25565);
    if (args.host && opts.host !== lockHost) {
      throw new Error('Dynamic host override is disabled. Set MC_ALLOW_DYNAMIC_TARGET=true to allow host override.');
    }
    if (args.port && Number(opts.port) !== Number(lockPort)) {
      throw new Error('Dynamic port override is disabled. Set MC_ALLOW_DYNAMIC_TARGET=true to allow port override.');
    }
  }

  const deps = loadMineflayerDeps();
  pathfinderApi = deps.pathfinderPlugin;
  goalsApi = deps.goals;
  MovementsCtor = deps.Movements;
  Vec3Ctor = deps.Vec3;

  const createOptions = {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    auth: opts.auth
  };

  if (opts.version) createOptions.version = opts.version;
  if (opts.password) createOptions.password = opts.password;

  bot = deps.mineflayer.createBot(createOptions);
  attachCoreBotEvents(bot);
  bot.loadPlugin(pathfinderApi);

  const timeoutMs = Math.max(3000, Number(config.MC_CONNECT_TIMEOUT_MS) || 20000);
  await waitForSpawn(bot, timeoutMs);

  defaultMovements = new MovementsCtor(bot);
  bot.pathfinder.setMovements(defaultMovements);
  followState = { player: '', distance: 2 };

  return `Minecraft bot connected.\n${formatStatusText(getStatusObject())}`;
}

async function disconnect(args = {}) {
  const activeBot = bot;
  if (!activeBot) return 'Minecraft bot already disconnected.';

  const reason = String(args.reason || 'manual-disconnect');
  followState = { player: '', distance: 2 };

  try {
    activeBot.pathfinder?.stop?.();
  } catch (_) {}
  safeClearControls();

  await new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve();
    }, 3500);

    const onEnd = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };

    activeBot.once('end', onEnd);
    try {
      activeBot.quit(reason);
    } catch (_) {
      activeBot.removeListener('end', onEnd);
      clearTimeout(timer);
      resolve();
    }
  });

  if (bot === activeBot) {
    resetRuntimeState();
  }

  return `Minecraft bot disconnected (${reason}).`;
}

function status() {
  return formatStatusText(getStatusObject());
}

async function chat(args = {}) {
  ensureConnected();
  const message = String(args.message || '').trim();
  if (!message) throw new Error('minecraft_chat requires message.');
  bot.chat(message);
  return `Sent chat message: ${message.slice(0, 120)}`;
}

async function moveTo(args = {}) {
  ensureConnected();
  const x = Number(args.x);
  const y = Number(args.y);
  const z = Number(args.z);
  const range = Number.isFinite(Number(args.range)) ? Math.max(0, Number(args.range)) : 1;
  const timeoutMs = Number.isFinite(Number(args.timeout_ms))
    ? Math.max(1000, Math.floor(Number(args.timeout_ms)))
    : Math.max(5000, Number(config.MC_ACTION_TIMEOUT_MS) || 45000);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error('minecraft_move_to requires numeric x/y/z.');
  }
  if (!bot.pathfinder || !goalsApi) {
    throw new Error('Pathfinder plugin is not ready.');
  }

  followState = { player: '', distance: 2 };
  if (!defaultMovements && MovementsCtor) {
    defaultMovements = new MovementsCtor(bot);
  }
  if (defaultMovements) {
    bot.pathfinder.setMovements(defaultMovements);
  }

  bot.pathfinder.setGoal(new goalsApi.GoalNear(x, y, z, range));
  await waitForPathResult(timeoutMs);
  const p = bot.entity?.position;
  return `Move completed. Current position=(${p?.x?.toFixed(2)}, ${p?.y?.toFixed(2)}, ${p?.z?.toFixed(2)})`;
}

async function followPlayer(args = {}) {
  ensureConnected();
  const playerName = String(args.player || args.username || '').trim();
  const distance = Number.isFinite(Number(args.distance)) ? Math.max(1, Number(args.distance)) : 2;
  if (!playerName) throw new Error('minecraft_follow_player requires player.');
  if (!bot.pathfinder || !goalsApi) {
    throw new Error('Pathfinder plugin is not ready.');
  }

  const target = bot.players[playerName]?.entity;
  if (!target) {
    throw new Error(`Cannot find player entity: ${playerName}`);
  }

  followState = { player: playerName, distance };
  if (!defaultMovements && MovementsCtor) {
    defaultMovements = new MovementsCtor(bot);
  }
  if (defaultMovements) {
    bot.pathfinder.setMovements(defaultMovements);
  }
  bot.pathfinder.setGoal(new goalsApi.GoalFollow(target, distance), true);
  return `Following player ${playerName} with distance ${distance}.`;
}

async function lookAt(args = {}) {
  ensureConnected();
  if (!Vec3Ctor) {
    throw new Error('Vec3 dependency is not available.');
  }

  const x = Number(args.x);
  const y = Number(args.y);
  const z = Number(args.z);
  const force = Boolean(args.force);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error('minecraft_look_at requires numeric x/y/z.');
  }

  await bot.lookAt(new Vec3Ctor(x, y, z), force);
  return `Looked at (${x}, ${y}, ${z}).`;
}

async function stop() {
  ensureConnected();
  followState = { player: '', distance: 2 };
  try {
    bot.pathfinder?.stop?.();
  } catch (_) {}
  safeClearControls();
  return 'Stopped current movement/action.';
}

async function shutdown() {
  if (!bot) return;
  try {
    await disconnect({ reason: 'process-exit' });
  } catch (e) {
    console.error('[minecraft] shutdown error:', e?.message || e);
  }
}

module.exports = {
  connect,
  disconnect,
  status,
  chat,
  moveTo,
  followPlayer,
  lookAt,
  stop,
  shutdown
};
