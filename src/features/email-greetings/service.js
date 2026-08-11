const { randomInt } = require('crypto');
const { HOLIDAY_CATALOG, normalizeAnniversary } = require('./calendar');
const { renderVerificationEmail } = require('./template');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isValidEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizeText(value));
}

function maskEmail(value = '') {
  const [local, domain] = normalizeText(value).split('@');
  if (!local || !domain) return '';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function findHoliday(value = '') {
  const name = normalizeText(value);
  return HOLIDAY_CATALOG.find((item) =>
    item.id === name || item.name === name || item.aliases.includes(name)
  ) || null;
}

function createEmailGreetingSubscriptionService(options = {}) {
  const stateStore = options.stateStore;
  const mailer = options.mailer;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const createCode = typeof options.createCode === 'function'
    ? options.createCode
    : () => String(randomInt(100000, 1000000));
  const verificationTtlMs = Math.max(1, Number(options.verificationTtlMinutes || 15)) * 60 * 1000;
  if (!stateStore || !mailer) throw new Error('stateStore and mailer are required');

  async function requestSubscription(userId, email, displayName = '') {
    const normalizedEmail = normalizeText(email).toLowerCase();
    if (!isValidEmail(normalizedEmail)) return { status: 'invalid_email' };
    const code = createCode();
    const timestamp = now();
    stateStore.updateUser(userId, (user) => {
      user.status = 'pending';
      user.email = normalizedEmail;
      user.displayName = normalizeText(displayName) || user.displayName;
      user.verificationCode = code;
      user.verificationExpiresAt = timestamp + verificationTtlMs;
    }, { flushNow: true });
    const message = renderVerificationEmail(code);
    await mailer.send({ to: normalizedEmail, ...message });
    return { status: 'verification_sent', email: normalizedEmail };
  }

  function verify(userId, code) {
    const user = stateStore.getUser(userId);
    if (!user.email) return { status: 'not_pending' };
    if (user.status === 'active') return { status: 'already_active', email: user.email };
    if (!user.verificationCode || user.verificationExpiresAt < now()) return { status: 'expired' };
    if (normalizeText(code) !== user.verificationCode) return { status: 'invalid_code' };
    stateStore.updateUser(userId, (current) => {
      current.status = 'active';
      current.verificationCode = '';
      current.verificationExpiresAt = 0;
    }, { flushNow: true });
    return { status: 'verified', email: user.email };
  }

  function unsubscribe(userId) {
    const user = stateStore.getUser(userId);
    if (!user.email || user.status === 'inactive') return { status: 'not_subscribed' };
    stateStore.updateUser(userId, (current) => {
      current.status = 'inactive';
      current.verificationCode = '';
      current.verificationExpiresAt = 0;
    }, { flushNow: true });
    return { status: 'unsubscribed' };
  }

  function getStatus(userId) {
    const user = stateStore.getUser(userId);
    return {
      status: user.email ? user.status : 'not_subscribed',
      email: maskEmail(user.email),
      disabledHolidayIds: [...user.disabledHolidayIds],
      anniversaries: user.anniversaries.map((item) => ({ ...item }))
    };
  }

  function setHoliday(userId, name, enabled) {
    const holiday = findHoliday(name);
    if (!holiday) return { status: 'unknown_holiday' };
    const user = stateStore.getUser(userId);
    if (user.status !== 'active') return { status: 'not_active' };
    stateStore.updateUser(userId, (current) => {
      const disabled = new Set(current.disabledHolidayIds);
      if (enabled) disabled.delete(holiday.id);
      else disabled.add(holiday.id);
      current.disabledHolidayIds = [...disabled];
    }, { flushNow: true });
    return { status: enabled ? 'holiday_enabled' : 'holiday_disabled', holiday };
  }

  function addAnniversary(userId, name, date) {
    const user = stateStore.getUser(userId);
    if (user.status !== 'active') return { status: 'not_active' };
    const normalized = normalizeAnniversary({ name, date });
    if (!normalized) return { status: 'invalid_anniversary' };
    const duplicate = user.anniversaries.some((item) => item.name === normalized.name && item.date === normalized.date);
    if (duplicate) return { status: 'duplicate_anniversary' };
    const anniversary = {
      ...normalized,
      id: `anniversary_${now().toString(36)}_${user.anniversaries.length + 1}`
    };
    stateStore.updateUser(userId, (current) => {
      current.anniversaries.push(anniversary);
    }, { flushNow: true });
    return { status: 'anniversary_added', anniversary };
  }

  function removeAnniversary(userId, name) {
    const normalizedName = normalizeText(name);
    const user = stateStore.getUser(userId);
    const matches = user.anniversaries.filter((item) => item.name === normalizedName);
    if (matches.length === 0) return { status: 'anniversary_not_found' };
    stateStore.updateUser(userId, (current) => {
      current.anniversaries = current.anniversaries.filter((item) => item.name !== normalizedName);
    }, { flushNow: true });
    return { status: 'anniversary_removed', count: matches.length, name: normalizedName };
  }

  function listAnniversaries(userId) {
    return { status: 'anniversary_listed', anniversaries: stateStore.getUser(userId).anniversaries };
  }

  return {
    addAnniversary,
    getStatus,
    listAnniversaries,
    removeAnniversary,
    requestSubscription,
    setHoliday,
    unsubscribe,
    verify
  };
}

module.exports = {
  createEmailGreetingSubscriptionService,
  findHoliday,
  isValidEmail,
  maskEmail
};
