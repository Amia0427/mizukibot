const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithDeliveryContext(context, task) {
  if (typeof task !== 'function') throw new Error('task must be a function');
  return storage.run(context || null, task);
}

function getDeliveryContext() {
  return storage.getStore() || null;
}

module.exports = {
  getDeliveryContext,
  runWithDeliveryContext
};
