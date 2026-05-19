const { normalizeText } = require('./state');

function createControllerRegistry() {
  const controllersByTaskId = new Map();

  function clear(taskId = '') {
    controllersByTaskId.delete(normalizeText(taskId));
  }

  function clearAll() {
    controllersByTaskId.clear();
  }

  function attach(taskId = '', controller = null) {
    const key = normalizeText(taskId);
    if (!key || !controller || typeof controller.cancel !== 'function') return false;
    controllersByTaskId.set(key, controller);
    return true;
  }

  function cancel(taskId = '', reason = 'cancelled') {
    const key = normalizeText(taskId);
    if (!key) return false;
    const controller = controllersByTaskId.get(key);
    if (!controller || typeof controller.cancel !== 'function') return false;
    try {
      controller.cancel(reason);
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    attach,
    cancel,
    clear,
    clearAll
  };
}

module.exports = {
  createControllerRegistry
};
