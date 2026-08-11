const path = require('path');
const appConfig = require('../../../config');
const { createEmailGreetingEngine } = require('./engine');
const { createSmtpMailer, isSmtpConfigured } = require('./mailer');
const { createEmailGreetingSubscriptionService } = require('./service');
const { createEmailGreetingStateStore } = require('./store');

let runtime = null;

function createEmailGreetingRuntime(options = {}) {
  const config = options.config || appConfig;
  const stateFile = config.EMAIL_GREETING_STATE_FILE || path.join(config.DATA_DIR, 'email-greeting-state.json');
  const configured = isSmtpConfigured(config);
  const mailer = options.mailer || createSmtpMailer(config, { transport: options.transport });
  const stateStore = options.stateStore || createEmailGreetingStateStore(stateFile, { now: options.now });
  const enabled = config.EMAIL_GREETING_ENABLED === true && (configured || Boolean(options.mailer));
  const service = options.service || createEmailGreetingSubscriptionService({
    stateStore,
    mailer,
    now: options.now,
    createCode: options.createCode,
    verificationTtlMinutes: config.EMAIL_GREETING_VERIFICATION_TTL_MINUTES
  });
  const engine = options.engine || createEmailGreetingEngine({
    ...options,
    config,
    enabled,
    mailer,
    stateStore
  });
  return { enabled, engine, mailer, service, stateStore };
}

function initializeEmailGreetingRuntime(options = {}) {
  if (!runtime) runtime = createEmailGreetingRuntime(options);
  return runtime;
}

function getEmailGreetingRuntime() {
  return runtime || initializeEmailGreetingRuntime();
}

function peekEmailGreetingRuntime() {
  return runtime;
}

function setEmailGreetingRuntimeForTests(nextRuntime) {
  runtime = nextRuntime || null;
}

module.exports = {
  createEmailGreetingRuntime,
  getEmailGreetingRuntime,
  initializeEmailGreetingRuntime,
  peekEmailGreetingRuntime,
  setEmailGreetingRuntimeForTests
};
