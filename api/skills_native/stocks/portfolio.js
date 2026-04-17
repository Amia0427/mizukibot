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

function getPortfolioStore(dataDir) {
  return path.join(dataDir, 'skill_cache', 'stocks', 'portfolio.json');
}

function ensurePortfolioState(dataDir) {
  const file = getPortfolioStore(dataDir);
  const state = readJson(file, { portfolios: {} });
  if (!state.portfolios || typeof state.portfolios !== 'object') state.portfolios = {};
  return { file, state };
}

function savePortfolioState(file, state) {
  writeJson(file, state);
}

function formatPortfolio(name, portfolio = {}) {
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const lines = [`portfolio: ${name}`];
  if (positions.length === 0) {
    lines.push('positions: empty');
  } else {
    positions.forEach((item, index) => {
      lines.push(`${index + 1}. ${normalizeText(item.ticker)} qty=${item.quantity || 0} cost=${item.cost || 0}`);
    });
  }
  return lines.join('\n');
}

function mutatePortfolio(dataDir, args = {}) {
  const action = normalizeText(args.action).toLowerCase();
  if (!action) return 'Missing action. Use create/list/show/delete/rename/add/update/remove.';
  const { file, state } = ensurePortfolioState(dataDir);
  const portfolios = state.portfolios;

  if (action === 'list') {
    const names = Object.keys(portfolios);
    return names.length ? names.join('\n') : 'No portfolios.';
  }

  if (action === 'create') {
    const name = normalizeText(args.name);
    if (!name) return 'Missing name.';
    if (!portfolios[name]) portfolios[name] = { positions: [] };
    savePortfolioState(file, state);
    return `created: ${name}`;
  }

  if (action === 'delete') {
    const name = normalizeText(args.name);
    if (!name) return 'Missing name.';
    delete portfolios[name];
    savePortfolioState(file, state);
    return `deleted: ${name}`;
  }

  if (action === 'rename') {
    const oldName = normalizeText(args.old_name);
    const newName = normalizeText(args.new_name);
    if (!oldName || !newName) return 'Missing old_name or new_name.';
    portfolios[newName] = portfolios[oldName] || { positions: [] };
    delete portfolios[oldName];
    savePortfolioState(file, state);
    return `renamed: ${oldName} -> ${newName}`;
  }

  const portfolioName = normalizeText(args.portfolio || args.name);
  if (!portfolioName) return 'Missing portfolio.';
  if (!portfolios[portfolioName]) portfolios[portfolioName] = { positions: [] };
  const positions = portfolios[portfolioName].positions;

  if (action === 'show') {
    return formatPortfolio(portfolioName, portfolios[portfolioName]);
  }

  if (action === 'add' || action === 'update') {
    const ticker = normalizeText(args.ticker).toUpperCase();
    if (!ticker) return 'Missing ticker.';
    const quantity = Number(args.quantity || 0) || 0;
    const cost = Number(args.cost || 0) || 0;
    const existing = positions.find((item) => normalizeText(item.ticker).toUpperCase() === ticker);
    if (existing) {
      existing.quantity = quantity;
      existing.cost = cost;
    } else {
      positions.push({ ticker, quantity, cost });
    }
    savePortfolioState(file, state);
    return formatPortfolio(portfolioName, portfolios[portfolioName]);
  }

  if (action === 'remove') {
    const ticker = normalizeText(args.ticker).toUpperCase();
    if (!ticker) return 'Missing ticker.';
    portfolios[portfolioName].positions = positions.filter((item) => normalizeText(item.ticker).toUpperCase() !== ticker);
    savePortfolioState(file, state);
    return formatPortfolio(portfolioName, portfolios[portfolioName]);
  }

  return 'Unsupported action. Use create/list/show/delete/rename/add/update/remove.';
}

module.exports = {
  mutatePortfolio
};
