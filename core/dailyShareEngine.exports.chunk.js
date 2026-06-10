let singleton = null;

function getDailyShareEngine() {
  if (!singleton) singleton = createDailyShareEngine();
  return singleton;
}

module.exports = {
  createDailyShareEngine,
  getDailyShareEngine
};


