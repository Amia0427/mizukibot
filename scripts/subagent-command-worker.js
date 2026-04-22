const { spawn } = require('child_process');
const readline = require('readline');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function send(message = {}) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (_) {}
}

function runCommand(command, args = [], workDir = process.cwd(), timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, Array.isArray(args) ? args : [], {
      cwd: workDir || process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      if (settled) return;
      killedByTimeout = true;
      try { child.kill(); } catch (_) {}
    }, Math.max(1000, Number(timeoutMs) || 120000));

    child.stdout.on('data', (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killedByTimeout) {
        const timeoutError = new Error(`subagent timeout after ${Math.max(1000, Number(timeoutMs) || 120000)}ms`);
        timeoutError.code = 'SUBAGENT_TIMEOUT';
        reject(timeoutError);
        return;
      }
      resolve({
        code,
        signal,
        stdout,
        stderr
      });
    });

    resolve.cancel = () => {
      try { child.kill(); } catch (_) {}
    };
  });
}

let activeRun = null;
let shuttingDown = false;

async function handleRun(message = {}) {
  if (activeRun) {
    send({
      id: normalizeText(message?.id),
      ok: false,
      type: 'response',
      code: 'PERSISTENT_SUBAGENT_BUSY',
      error: 'persistent worker is busy'
    });
    return;
  }

  const requestId = normalizeText(message?.id);
  const command = normalizeText(message?.command);
  const args = Array.isArray(message?.args) ? message.args.map((item) => String(item)) : [];
  const workDir = normalizeText(message?.workDir) || process.cwd();
  const timeoutMs = Math.max(1000, Number(message?.timeoutMs) || 120000);

  if (!requestId || !command) {
    send({
      id: requestId,
      ok: false,
      type: 'response',
      code: 'PERSISTENT_SUBAGENT_INVALID_REQUEST',
      error: 'missing request id or command'
    });
    return;
  }

  let cancelled = false;
  const resultPromise = new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeRun = {
      cancel(reason = 'cancelled') {
        cancelled = true;
        try { child.kill(); } catch (_) {}
        return reason;
      },
      id: requestId
    };

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        const timeoutError = new Error(`subagent timeout after ${timeoutMs}ms`);
        timeoutError.code = 'SUBAGENT_TIMEOUT';
        reject(timeoutError);
        return;
      }
      if (cancelled) {
        const cancelError = new Error('subagent cancelled');
        cancelError.code = 'SUBAGENT_CANCELLED';
        reject(cancelError);
        return;
      }
      resolve({
        code,
        signal,
        stderr,
        stdout
      });
    });
  });

  try {
    const result = await resultPromise;
    send({
      id: requestId,
      ok: true,
      type: 'response',
      result
    });
  } catch (error) {
    send({
      id: requestId,
      ok: false,
      type: 'response',
      code: normalizeText(error?.code) || 'PERSISTENT_SUBAGENT_RUN_ERROR',
      cancelled: normalizeText(error?.code) === 'SUBAGENT_CANCELLED',
      error: normalizeText(error?.message || error) || 'persistent worker run failed'
    });
  } finally {
    activeRun = null;
    if (shuttingDown) {
      process.exit(0);
    }
  }
}

function handleCancel(message = {}) {
  const targetId = normalizeText(message?.targetId);
  if (!activeRun || !targetId || activeRun.id !== targetId) {
    send({
      id: normalizeText(message?.id),
      ok: true,
      type: 'response',
      result: { cancelled: false }
    });
    return;
  }
  activeRun.cancel(normalizeText(message?.reason) || 'cancelled');
  send({
    id: normalizeText(message?.id),
    ok: true,
    type: 'response',
    result: { cancelled: true }
  });
}

function handleShutdown() {
  shuttingDown = true;
  if (activeRun) {
    activeRun.cancel('shutdown');
    return;
  }
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', async (line) => {
  const text = normalizeText(line);
  if (!text) return;
  let message = null;
  try {
    message = JSON.parse(text);
  } catch (error) {
    send({
      ok: false,
      type: 'protocol_error',
      code: 'PERSISTENT_SUBAGENT_PROTOCOL_ERROR',
      error: normalizeText(error?.message || error) || 'invalid json'
    });
    return;
  }

  const type = normalizeText(message?.type).toLowerCase();
  if (type === 'health') {
    send({
      id: normalizeText(message?.id),
      ok: true,
      type: 'health',
      result: {
        busy: Boolean(activeRun),
        pid: process.pid
      }
    });
    return;
  }

  if (type === 'run') {
    await handleRun(message);
    return;
  }

  if (type === 'cancel') {
    handleCancel(message);
    return;
  }

  if (type === 'shutdown') {
    handleShutdown();
    return;
  }

  send({
    id: normalizeText(message?.id),
    ok: false,
    type: 'response',
    code: 'PERSISTENT_SUBAGENT_UNKNOWN_MESSAGE',
    error: `unsupported message type: ${type || 'unknown'}`
  });
});

rl.on('close', () => {
  handleShutdown();
});

send({
  ok: true,
  pid: process.pid,
  type: 'ready'
});
