const fs = require('fs');
const path = require('path');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function readJson(absPath, fallback) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(value, null, 2), 'utf8');
}

function getWatchlistStore(dataDir) {
  return path.join(dataDir, 'skill_cache', 'stocks', 'watchlist.json');
}

function ensureWatchlistState(dataDir) {
  const file = getWatchlistStore(dataDir);
  const state = readJson(file, { items: [] });
  if (!Array.isArray(state.items)) state.items = [];
  return { file, state };
}

function saveWatchlist(file, state) {
  writeJson(file, state);
}

function formatList(items = []) {
  if (!items.length) return 'No watchlist items.';
  return items.map((item, index) => {
    const parts = [
      `${index + 1}. ${normalizeText(item.ticker)}`,
      Number.isFinite(Number(item.target)) ? `target=${item.target}` : '',
      Number.isFinite(Number(item.stop)) ? `stop=${item.stop}` : '',
      item.alert_on_signal ? 'alert_on_signal=true' : '',
      item.notify ? 'notify=true' : ''
    ].filter(Boolean);
    return parts.join(' | ');
  }).join('\n');
}

function mutateWatchlist(dataDir, args = {}) {
  const action = normalizeText(args.action).toLowerCase();
  if (!action) return 'Missing action. Use add/remove/list/check.';
  const { file, state } = ensureWatchlistState(dataDir);
  const items = state.items;

  if (action === 'list') {
    return formatList(items);
  }

  if (action === 'check') {
    if (!items.length) return 'No watchlist items.';
    if (Boolean(args.notify)) {
      return ['📢 Stock Alerts', ...items.map((item) => `- ${item.ticker}: tracking`)].join('\n');
    }
    return items.map((item) => `${item.ticker}: tracking`).join('\n');
  }

  const ticker = normalizeText(args.ticker).toUpperCase();
  if (!ticker) return 'Missing ticker.';

  if (action === 'add') {
    const existing = items.find((item) => normalizeText(item.ticker).toUpperCase() === ticker);
    const next = existing || { ticker };
    if (Number.isFinite(Number(args.target))) next.target = Number(args.target);
    if (Number.isFinite(Number(args.stop))) next.stop = Number(args.stop);
    next.alert_on_signal = Boolean(args.alert_on_signal);
    next.notify = Boolean(args.notify);
    next.added_at = next.added_at || new Date().toISOString().slice(0, 10);
    if (!existing) items.push(next);
    saveWatchlist(file, state);
    return formatList(items);
  }

  if (action === 'remove') {
    state.items = items.filter((item) => normalizeText(item.ticker).toUpperCase() !== ticker);
    saveWatchlist(file, state);
    return formatList(state.items);
  }

  return 'Unsupported action. Use add/remove/list/check.';
}

module.exports = {
  mutateWatchlist
};
