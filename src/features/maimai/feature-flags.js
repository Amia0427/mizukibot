function isMaimaiEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.MAIMAI_ENABLED || '').trim());
}

module.exports = { isMaimaiEnabled };
