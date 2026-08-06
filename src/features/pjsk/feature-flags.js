function isPjskEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.PJSK_ENABLED || '').trim());
}

module.exports = { isPjskEnabled };
