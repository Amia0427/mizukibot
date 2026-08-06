const path = require('path');
const appConfig = require('../../../config');
const { createWeatherAlertEngine } = require('./engine');
const { createQWeatherProvider } = require('./provider');
const { createWeatherAlertSubscriptionService } = require('./service');
const { createWeatherAlertStateStore } = require('./store');

let runtime = null;

function normalizeApiHost(value = '') {
  const host = String(value || '').trim();
  if (!host || /^https?:\/\//i.test(host)) return host;
  return `https://${host}`;
}

function createWeatherAlertRuntime(options = {}) {
  const config = options.config || appConfig;
  const stateFile = config.WEATHER_ALERT_STATE_FILE || path.join(config.DATA_DIR, 'weather-alert-state.json');
  const provider = options.provider || createQWeatherProvider({
    apiHost: normalizeApiHost(config.QWEATHER_API_HOST),
    apiSecret: config.QWEATHER_API_SECRET || config.QWEATHER_API_KEY,
    httpClient: options.httpClient
  });
  const stateStore = options.stateStore || createWeatherAlertStateStore(stateFile, { now: options.now });
  const service = options.service || createWeatherAlertSubscriptionService({
    provider,
    stateStore,
    now: options.now
  });
  const engine = options.engine || createWeatherAlertEngine({
    ...options,
    config,
    provider,
    stateStore
  });
  return {
    enabled: config.WEATHER_ALERT_ENABLED === true,
    engine,
    provider,
    service,
    stateStore
  };
}

function initializeWeatherAlertRuntime(options = {}) {
  if (!runtime) runtime = createWeatherAlertRuntime(options);
  return runtime;
}

function getWeatherAlertRuntime() {
  return runtime || initializeWeatherAlertRuntime();
}

function peekWeatherAlertRuntime() {
  return runtime;
}

function setWeatherAlertRuntimeForTests(nextRuntime) {
  runtime = nextRuntime || null;
}

module.exports = {
  createWeatherAlertRuntime,
  getWeatherAlertRuntime,
  initializeWeatherAlertRuntime,
  normalizeApiHost,
  peekWeatherAlertRuntime,
  setWeatherAlertRuntimeForTests
};
