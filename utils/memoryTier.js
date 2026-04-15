const config = require('../config');

// Memory importance tiers:
// - S: critical, should almost always be kept and preferred when relevant
// - A: important, stable long-term signal
// - B: useful, but less critical / may change
// - C: low importance, mostly ephemeral (often topics)
//
// We keep the underlying numeric "importance" for smooth scoring, and derive "tier"
// as a discrete label to make retrieval/governance rules easier to implement.

const TIER_RANK = Object.freeze({
  S: 3,
  A: 2,
  B: 1,
  C: 0
});

function normalizeTier(value) {
  const t = String(value || '').trim().toUpperCase();
  if (!t) return '';
  if (t === 'CRITICAL' || t === 'P0') return 'S';
  if (t === 'HIGH' || t === 'P1') return 'A';
  if (t === 'MEDIUM' || t === 'P2') return 'B';
  if (t === 'LOW' || t === 'P3') return 'C';
  return Object.prototype.hasOwnProperty.call(TIER_RANK, t) ? t : '';
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function getTierThresholds() {
  // Ensure monotonic thresholds even if env config is mis-set.
  const sMin = clamp(config.MEMORY_IMPORTANCE_TIER_S_MIN ?? 2.35, 0.2, 3);
  const aMin = clamp(config.MEMORY_IMPORTANCE_TIER_A_MIN ?? 1.7, 0.2, 3);
  const bMin = clamp(config.MEMORY_IMPORTANCE_TIER_B_MIN ?? 1.15, 0.2, 3);

  const sorted = [sMin, aMin, bMin].sort((a, b) => b - a);
  return {
    sMin: sorted[0],
    aMin: Math.min(sorted[0], sorted[1]),
    bMin: Math.min(sorted[1], sorted[2])
  };
}

function maxTier(a, b) {
  const ta = normalizeTier(a);
  const tb = normalizeTier(b);
  if (!ta) return tb;
  if (!tb) return ta;
  return TIER_RANK[ta] >= TIER_RANK[tb] ? ta : tb;
}

function minTier(a, b) {
  const ta = normalizeTier(a);
  const tb = normalizeTier(b);
  if (!ta) return tb;
  if (!tb) return ta;
  return TIER_RANK[ta] <= TIER_RANK[tb] ? ta : tb;
}

function capTier(tier, maxAllowedTier) {
  const t = normalizeTier(tier);
  const cap = normalizeTier(maxAllowedTier);
  if (!t) return '';
  if (!cap) return t;
  return TIER_RANK[t] > TIER_RANK[cap] ? cap : t;
}

function floorTier(tier, minAllowedTier) {
  const t = normalizeTier(tier);
  const floor = normalizeTier(minAllowedTier);
  if (!t) return '';
  if (!floor) return t;
  return TIER_RANK[t] < TIER_RANK[floor] ? floor : t;
}

function tierToRepresentativeImportance(tier) {
  // Used only when the caller explicitly provides a tier hint but not numeric importance.
  // Keep values in the same [0.2, 3] space as other scoring logic.
  const t = normalizeTier(tier);
  if (t === 'S') return 2.6;
  if (t === 'A') return 2.0;
  if (t === 'B') return 1.4;
  if (t === 'C') return 0.85;
  return 1.0;
}

function importanceToTier(importance, confidence = 1, type = 'fact') {
  const imp = clamp(importance ?? 1, 0.2, 3);
  const conf = clamp(confidence ?? 0.7, 0.01, 1);
  const t = String(type || 'fact').trim().toLowerCase();
  const { sMin, aMin, bMin } = getTierThresholds();

  // Step 1: derive tier purely from numeric importance.
  let tier = 'C';
  if (imp >= sMin) tier = 'S';
  else if (imp >= aMin) tier = 'A';
  else if (imp >= bMin) tier = 'B';
  else tier = 'C';

  // Step 2: cap tier by confidence to reduce "wrong but loud" memories.
  if (conf < 0.72) tier = capTier(tier, 'C');
  else if (conf < 0.78) tier = capTier(tier, 'B');

  // Step 3: type-based caps/floors.
  // Topics are meant to be ephemeral; even if important, don't let them dominate.
  if (t === 'topic') tier = capTier(tier, 'B') || tier;
  // Goals are usually useful long-term signals.
  if (t === 'goal') tier = floorTier(tier, 'B') || tier;

  return tier;
}

function tierAtLeast(tier, minAllowedTier) {
  const t = normalizeTier(tier);
  const floor = normalizeTier(minAllowedTier);
  if (!t || !floor) return false;
  return TIER_RANK[t] >= TIER_RANK[floor];
}

module.exports = {
  TIER_RANK,
  normalizeTier,
  maxTier,
  minTier,
  capTier,
  floorTier,
  tierToRepresentativeImportance,
  importanceToTier,
  tierAtLeast
};

