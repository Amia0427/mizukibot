const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../../config');

const WORKER_SCRIPT = path.join(__dirname, 'worker.js');
const ALLOWED_TASK_TYPES = new Set([
  'memory_v3_materialize',
  'test_delay'
]);

let nextTaskId = 0;
let activeCount = 0;
let completedCount = 0;
let failedCount = 0;
let timeoutCount = 0;
let workerCount = 0;
let workerImpl = Worker;
const queue = [];
const activeTasks = new Set();

function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) return fallback;
  return num;
}

function isEnabled() {
  return config.BOT_WORKER_THREADS_ENABLED === true;
}

function getMaxWorkers() {
  return normalizePositiveInt(config.BOT_WORKER_THREADS_MAX, 2);
}

function getMaxQueueLength() {
  return Math.max(0, Math.floor(Number(config.BOT_WORKER_THREADS_QUEUE_MAX || 0) || 0));
}

function getDefaultTimeoutMs() {
  return Math.max(1000, Math.floor(Number(config.BOT_WORKER_THREADS_TASK_TIMEOUT_MS || 120000) || 120000));
}

function createTaskError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSupportedTask(type = '') {
  const normalized = String(type || '').trim();
  if (!ALLOWED_TASK_TYPES.has(normalized)) {
    throw createTaskError(`[worker_threads] unsupported task: ${normalized || 'unknown'}`, 'ERR_WORKER_TASK_UNSUPPORTED');
  }
  return normalized;
}

function buildSnapshot() {
  return {
    enabled: isEnabled(),
    maxWorkers: getMaxWorkers(),
    maxQueueLength: getMaxQueueLength(),
    active: activeCount,
    queued: queue.length,
    completed: completedCount,
    failed: failedCount,
    timeout: timeoutCount,
    workersStarted: workerCount
  };
}

function clearTaskTimer(task) {
  if (task.timer) {
    clearTimeout(task.timer);
    task.timer = null;
  }
}

function finishTask(task, patch = {}) {
  if (task.done) return;
  task.done = true;
  clearTaskTimer(task);
  activeCount = Math.max(0, activeCount - 1);
  activeTasks.delete(task);
  try {
    task.worker?.terminate?.();
  } catch (_) {}

  if (patch.ok) {
    completedCount += 1;
    task.resolve(patch.result);
  } else {
    failedCount += 1;
    task.reject(patch.error || createTaskError('[worker_threads] task failed', 'ERR_WORKER_TASK_FAILED'));
  }
  drainQueue();
}

function startTask(task) {
  activeCount += 1;
  workerCount += 1;
  activeTasks.add(task);
  const worker = new workerImpl(WORKER_SCRIPT);
  task.worker = worker;
  task.timer = setTimeout(() => {
    timeoutCount += 1;
    const error = createTaskError(`[worker_threads] task timed out after ${task.timeoutMs}ms`, 'ERR_WORKER_TASK_TIMEOUT');
    finishTask(task, { ok: false, error });
  }, task.timeoutMs);

  worker.once('message', (message = {}) => {
    if (message.id !== task.id) return;
    if (message.ok) {
      finishTask(task, { ok: true, result: message.result });
      return;
    }
    const error = createTaskError(message.error?.message || '[worker_threads] task failed', 'ERR_WORKER_TASK_FAILED');
    error.workerError = message.error || null;
    finishTask(task, { ok: false, error });
  });
  worker.once('error', (error) => {
    finishTask(task, {
      ok: false,
      error: error || createTaskError('[worker_threads] worker error', 'ERR_WORKER_THREAD_ERROR')
    });
  });
  worker.once('exit', (code) => {
    if (task.done || code === 0) return;
    finishTask(task, {
      ok: false,
      error: createTaskError(`[worker_threads] worker exited with code ${code}`, 'ERR_WORKER_THREAD_EXIT')
    });
  });
  worker.postMessage({
    id: task.id,
    type: task.type,
    payload: task.payload
  });
}

function drainQueue() {
  while (activeCount < getMaxWorkers() && queue.length > 0) {
    startTask(queue.shift());
  }
}

function runWorkerTask(type, payload = {}, options = {}) {
  const normalizedType = assertSupportedTask(type);
  if (!isEnabled()) {
    return Promise.reject(createTaskError('[worker_threads] disabled', 'ERR_WORKER_THREADS_DISABLED'));
  }

  const maxQueueLength = getMaxQueueLength();
  if (maxQueueLength > 0 && queue.length >= maxQueueLength && activeCount >= getMaxWorkers()) {
    return Promise.reject(createTaskError('[worker_threads] queue is full', 'ERR_WORKER_TASK_QUEUE_FULL'));
  }

  const timeoutMs = Math.max(1, Math.floor(Number(options.timeoutMs || getDefaultTimeoutMs()) || getDefaultTimeoutMs()));
  return new Promise((resolve, reject) => {
    queue.push({
      id: ++nextTaskId,
      type: normalizedType,
      payload,
      timeoutMs,
      resolve,
      reject,
      timer: null,
      worker: null,
      done: false
    });
    drainQueue();
  });
}

async function shutdownWorkerTaskPool() {
  const pending = queue.splice(0);
  for (const task of pending) {
    task.done = true;
    task.reject(createTaskError('[worker_threads] pool shutdown', 'ERR_WORKER_POOL_SHUTDOWN'));
  }
  const active = Array.from(activeTasks);
  for (const task of active) {
    finishTask(task, {
      ok: false,
      error: createTaskError('[worker_threads] pool shutdown', 'ERR_WORKER_POOL_SHUTDOWN')
    });
  }
  return buildSnapshot();
}

function __setWorkerImplForTests(nextWorkerImpl) {
  workerImpl = nextWorkerImpl || Worker;
}

function __resetWorkerTaskPoolForTests() {
  queue.length = 0;
  nextTaskId = 0;
  activeCount = 0;
  completedCount = 0;
  failedCount = 0;
  timeoutCount = 0;
  workerCount = 0;
  activeTasks.clear();
  workerImpl = Worker;
}

module.exports = {
  __resetWorkerTaskPoolForTests,
  __setWorkerImplForTests,
  getWorkerTaskPoolSnapshot: buildSnapshot,
  runWorkerTask,
  shutdownWorkerTaskPool
};
