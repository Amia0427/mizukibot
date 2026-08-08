'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { ensureDir, safeReadJson } = require('../memory/persistence');
const { GLOBAL_SCOPE_ID, SCOPE_TYPES, STAGE_LABELS, normalizeText } = require('./definitions');
const engine = require('./engine');
const store = require('./store');

function resolveLegacyStage(entry = {}) {
  const text = normalizeText(entry.relationship || entry.level || '', 48);
  if (/亲密|恋人|伴侣|最高/.test(text)) return 'intimate_companion';
  if (/亲近|挚友|密友/.test(text)) return 'close';
  if (/朋友|熟人/.test(text)) return 'friend';
  if (/认识|初识/.test(text)) return 'acquaintance';
  const points = Number(entry.points || 0) || 0;
  if (points > 500) return 'intimate_companion';
  if (points > 100) return 'friend';
  return 'stranger';
}

function seedForStage(stage, entry = {}) {
  const seed = {
    stranger: { affection: 0, trust: 0, familiarity: 0, boundaryMode: 'guarded' },
    acquaintance: { affection: 24, trust: 22, familiarity: 24, boundaryMode: 'cautious' },
    friend: { affection: 50, trust: 45, familiarity: 55, boundaryMode: 'comfortable' },
    close: { affection: 72, trust: 68, familiarity: 75, boundaryMode: 'comfortable' },
    intimate_companion: { affection: 90, trust: 82, familiarity: 90, boundaryMode: 'close' }
  }[stage] || { affection: 0, trust: 0, familiarity: 0, boundaryMode: 'guarded' };
  const trustScore = Number(entry.trust_score || 0) || 0;
  return {
    ...seed,
    trust: Math.max(seed.trust, Math.min(100, Math.max(0, trustScore))),
    attitude: normalizeText(entry.attitude || '中立、保持距离', 120) || '中立、保持距离',
    lastInteractionAt: Number(entry.last_affinity_update_at || 0) || 0
  };
}

function listLegacyFavorites() {
  const values = safeReadJson(config.DATA_FILE, {});
  return values && typeof values === 'object' ? values : {};
}

function backupLegacyFiles(now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(config.DATA_DIR, 'backups', `conversation-variables-${stamp}`);
  ensureDir(backupDir);
  for (const file of [config.DATA_FILE, config.MEMORY_FILE]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  }
  return backupDir;
}

function migrateLegacyFavorites({ apply = false, backup = true, now = Date.now() } = {}) {
  const favorites = listLegacyFavorites();
  const entries = Object.entries(favorites).filter(([id, value]) => normalizeText(id, 80) && value && typeof value === 'object');
  const result = { apply, total: entries.length, migrated: 0, skipped: 0, backupDir: '' };
  if (!apply) return result;
  if (backup) result.backupDir = backupLegacyFiles(now);

  for (const [userId, entry] of entries) {
    if (engine.hasState(userId)) {
      result.skipped += 1;
      continue;
    }
    const stage = resolveLegacyStage(entry);
    const values = seedForStage(stage, entry);
    const eventKey = `migration:legacy-favorites:${userId}`;
    const migration = store.transactEvent({
      eventKey,
      scopeType: SCOPE_TYPES.USER,
      scopeId: userId,
      source: 'legacy_migration',
      confidence: 1,
      reason: `从旧好感数据迁移：${STAGE_LABELS[stage]}`,
      proposal: { stage, legacy: entry },
      now,
      mutate: ({ eventId }) => ({
        status: 'migrated',
        before: {},
        applied: { stage, values },
        states: Object.entries(values).map(([key, value]) => ({
          scopeType: SCOPE_TYPES.USER,
          scopeId: userId,
          key,
          value,
          revision: 1
        }))
      })
    });
    if (!migration.duplicate) result.migrated += 1;
    else result.skipped += 1;
    if (userId && (Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : []).map(String).includes(userId)) {
      engine.getSnapshot({ userId, now });
    }
  }
  return result;
}

module.exports = {
  migrateLegacyFavorites,
  resolveLegacyStage,
  seedForStage
};
