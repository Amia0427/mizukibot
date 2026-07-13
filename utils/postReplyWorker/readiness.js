const fs = require('fs');
const path = require('path');

function isProcessAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function writePostReplyWorkerState(filePath, state = {}) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({
    schemaVersion: 'post_reply_worker_state_v1',
    role: 'post_reply_worker',
    ...state
  }, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  return target;
}

function inspectPostReplyWorkerReadiness(filePath, options = {}) {
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) return { ready: false, reason: 'state_missing', file: target };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    return { ready: false, reason: 'state_invalid', file: target };
  }
  const pid = Math.max(0, Number(state.pid || 0) || 0);
  const stage = String(state.stage || '').trim();
  const heartbeatAt = Date.parse(state.heartbeatAt || '');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const maxAgeMs = Math.max(1000, Number(options.maxAgeMs || 60000) || 60000);
  const isProcessAlive = options.isProcessAlive || isProcessAliveDefault;
  if (stage !== 'ready') return { ready: false, reason: `stage_${stage || 'unknown'}`, stage, pid, file: target };
  if (!pid || !isProcessAlive(pid)) return { ready: false, reason: 'process_not_alive', stage, pid, file: target };
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > maxAgeMs) {
    return { ready: false, reason: 'heartbeat_stale', stage, pid, file: target };
  }
  return {
    ready: true,
    reason: 'ready',
    stage,
    pid,
    heartbeatAt: state.heartbeatAt,
    heartbeatAgeMs: Math.max(0, now - heartbeatAt),
    activeCount: Math.max(0, Number(state.activeCount || 0) || 0),
    file: target
  };
}

module.exports = {
  inspectPostReplyWorkerReadiness,
  writePostReplyWorkerState
};
