const { normalizeText } = require('./helpers');

function isTrueFlag(value) {
  if (value === true) return true;
  const text = normalizeText(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'on';
}

function recallStatusOf(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  return normalizeText(
    value.recallVerification?.status
    || value.meta?.recallVerification?.status
    || value.payload?.recallVerification?.status
    || value.openPayload?.recallVerification?.status
    || ''
  ).toLowerCase();
}

function isMemoryNotRecallable(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  if (
    isTrueFlag(value.notRecallable)
    || isTrueFlag(value.not_recallable)
    || isTrueFlag(value.meta?.notRecallable)
    || isTrueFlag(value.meta?.not_recallable)
    || isTrueFlag(value.payload?.notRecallable)
    || isTrueFlag(value.payload?.not_recallable)
  ) {
    return true;
  }
  return recallStatusOf(value) === 'not_recallable';
}

module.exports = {
  isMemoryNotRecallable,
  recallStatusOf
};
