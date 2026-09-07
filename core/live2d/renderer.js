const path = require('path');
const { spawn } = require('child_process');

function normalizeRenderResult(result = {}) {
  if (Buffer.isBuffer(result)) return { ok: true, buffer: result };
  if (result && Buffer.isBuffer(result.buffer)) return { ok: true, buffer: result.buffer };
  if (result && typeof result.base64 === 'string' && result.base64.trim()) {
    return { ok: true, buffer: Buffer.from(result.base64.trim(), 'base64') };
  }
  return {
    ok: false,
    code: String(result?.code || 'renderer_empty').trim() || 'renderer_empty'
  };
}

function runRenderWorker(input, options = {}) {
  const workerPath = options.workerPath || path.resolve(__dirname, '../../scripts/live2d-render-worker.js');
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10000);
  const child = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      LIVE2D_RENDER_WORKER_MODULE: String(options.workerModule || '').trim()
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'renderer_timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.once('error', () => finish({ ok: false, code: 'renderer_process_error' }));
    child.once('close', (code) => {
      if (code !== 0) return finish({ ok: false, code: 'renderer_process_failed' });
      try {
        finish(normalizeRenderResult(JSON.parse(stdout)));
      } catch (_) {
        finish({ ok: false, code: 'renderer_invalid_output' });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function createLive2dRenderer(options = {}) {
  const runtimeConfig = options.config || {};
  const renderAnimation = options.renderAnimation;

  async function render(input = {}) {
    if (runtimeConfig.LIVE2D_RENDER_ENABLED !== true) return { ok: false, code: 'disabled' };
    if (typeof renderAnimation === 'function') {
      return normalizeRenderResult(await renderAnimation(input));
    }
    return runRenderWorker({
      ...input,
      modelDir: input.modelDir || runtimeConfig.LIVE2D_MODEL_DIR,
      browserExecutablePath: runtimeConfig.LIVE2D_BROWSER_EXECUTABLE_PATH
    }, {
      workerPath: options.workerPath,
      workerModule: runtimeConfig.LIVE2D_RENDER_WORKER_MODULE,
      timeoutMs: runtimeConfig.LIVE2D_RENDER_TIMEOUT_MS
    });
  }

  return { render };
}

module.exports = {
  createLive2dRenderer,
  normalizeRenderResult,
  runRenderWorker
};
