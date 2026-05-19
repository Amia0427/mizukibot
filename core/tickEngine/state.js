const path = require('path');

const config = require('../../config');
const { createJsonHotStore } = require('../../utils/jsonHotStore');

const TICK_STATE_FILE = path.join(config.DATA_DIR, 'tick_state.json');
const tickStateStore = createJsonHotStore(TICK_STATE_FILE, {
  fallback: () => ({}),
  debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
  maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
});

function saveTickState(state) {
  try {
    tickStateStore.replace(state);
  } catch (error) {
    console.error('[tick] failed to save state:', error?.message || error);
  }
}

function normalizeUserTickState(raw = {}, today = '') {
  const sameDay = String(raw?.day || '').trim() === String(today || '').trim();
  return {
    ...raw,
    day: String(today || raw?.day || '').trim(),
    proactive_count: sameDay ? Math.max(0, Number(raw?.proactive_count || 0) || 0) : 0,
    touched_windows: sameDay && raw?.touched_windows && typeof raw.touched_windows === 'object'
      ? { ...raw.touched_windows }
      : {},
    last_reason_at: raw?.last_reason_at && typeof raw.last_reason_at === 'object'
      ? { ...raw.last_reason_at }
      : {},
    last_touch_signature: String(raw?.last_touch_signature || '').trim(),
    last_touch_signature_at: Math.max(0, Number(raw?.last_touch_signature_at || 0) || 0),
    last_light_care_at: Math.max(0, Number(raw?.last_light_care_at || 0) || 0),
    last_morning_fallback_day: String(raw?.last_morning_fallback_day || '').trim(),
    last_night_fallback_day: String(raw?.last_night_fallback_day || '').trim(),
    last_proactive_at: Math.max(0, Number(raw?.last_proactive_at || 0) || 0),
    last_proactive_reason: String(raw?.last_proactive_reason || '').trim()
  };
}

function loadTickState() {
  const raw = tickStateStore.read({ forceReload: true });
  const next = {};
  for (const [userId, value] of Object.entries(raw || {})) {
    next[String(userId)] = normalizeUserTickState(value, String(value?.day || '').trim());
  }
  return next;
}

function getDailyState(state, userId, today) {
  const current = state[userId] || {};
  return normalizeUserTickState(current, today);
}

module.exports = {
  getDailyState,
  loadTickState,
  normalizeUserTickState,
  saveTickState,
  TICK_STATE_FILE
};
