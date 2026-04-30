const path = require('path');

function sanitizeUserId(value, fallback = '') {
  const raw = String(value || fallback || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return cleaned || '';
}

function normalizeInsideRoot(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const rel = path.relative(rootAbs, targetAbs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { rootAbs, targetAbs, inside };
}

function mustStayInside(root, target, label) {
  const checked = normalizeInsideRoot(root, target);
  if (!checked.inside) {
    throw new Error(`${label} must stay inside ${checked.rootAbs}`);
  }
  return checked.targetAbs;
}

module.exports = {
  sanitizeUserId,
  normalizeInsideRoot,
  mustStayInside
};
