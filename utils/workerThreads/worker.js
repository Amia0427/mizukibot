const { parentPort } = require('worker_threads');

async function runTask(type, payload = {}) {
  if (type === 'memory_v3_materialize') {
    const { materializeMemoryViews } = require('../memory-v3/materializer');
    return materializeMemoryViews(payload && typeof payload === 'object' ? payload : {});
  }

  if (type === 'test_delay') {
    const delayMs = Math.max(0, Number(payload.delayMs || 0) || 0);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return {
      ok: true,
      value: payload.value
    };
  }

  throw new Error(`Unsupported worker task: ${String(type || '').trim() || 'unknown'}`);
}

if (!parentPort) {
  throw new Error('worker thread parentPort is required');
}

parentPort.on('message', async (message = {}) => {
  const id = message.id;
  try {
    const result = await runTask(message.type, message.payload);
    parentPort.postMessage({
      id,
      ok: true,
      result
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: error?.message || String(error || ''),
        name: error?.name || 'Error',
        stack: error?.stack || ''
      }
    });
  }
});
