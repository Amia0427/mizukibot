function waitForServerListening(server) {
  if (!server || server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function closeServer(server, options = {}) {
  if (!server || typeof server.close !== 'function') {
    return Promise.resolve({ closed: true, timedOut: false });
  }
  if (server.listening === false) return Promise.resolve({ closed: true, timedOut: false });
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0) || 0);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        finish({ closed: false, timedOut: true });
      }, timeoutMs);
    }
    try {
      server.close((error) => {
        if (error) {
          finish({ closed: false, timedOut: false, error: error.message });
          return;
        }
        finish({ closed: true, timedOut: false });
      });
    } catch (error) {
      finish({ closed: false, timedOut: false, error: error.message });
    }
  });
}

module.exports = {
  closeServer,
  waitForServerListening
};
