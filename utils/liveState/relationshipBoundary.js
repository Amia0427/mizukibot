const BOUNDARY_TEMPLATES = Object.freeze({
  stranger: '未建立明确关系；保持礼貌距离，不假设亲密度，根据当前对话逐步建立信任。',
  acquaintance: '认识但不熟；可以聊天但避免过度热情或预设对方了解自己的生活细节。',
  friend: '朋友；可以自然交流，偶尔分享心情，但不会倾诉深层痛苦或假设对方完全理解自己。',
  close: '亲近的朋友；会分享烦恼和真实感受，但仍有边界，不会无底线依赖。',
  intimate: '非常亲密的关系；可以袒露脆弱，但保持独立人格，不是对方的全部。'
});

function normalizeText(value) {
  return String(value || '').trim();
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8)
    : [];
}

function getDefaultBoundary() {
  return {
    level: 'stranger',
    closeness: 0,
    intimacy: 0,
    tags: [],
    lastInteractionAt: null,
    boundary: BOUNDARY_TEMPLATES.stranger
  };
}

function levelFromCloseness(closeness) {
  if (closeness < 10) return 'stranger';
  if (closeness < 30) return 'acquaintance';
  if (closeness < 70) return 'friend';
  if (closeness < 90) return 'close';
  return 'intimate';
}

function levelFromRelationText(value = '', closeness = 0) {
  const text = normalizeText(value);
  if (/亲密|恋人|伴侣|最高/.test(text)) return 'intimate';
  if (/亲近|挚友|密友/.test(text)) return 'close';
  if (/朋友|熟人|普通朋友/.test(text)) return 'friend';
  if (/初识|认识|点头/.test(text)) return 'acquaintance';
  if (/陌生|保持距离/.test(text)) return 'stranger';
  return levelFromCloseness(closeness);
}

function buildBoundary(relation = {}, options = {}) {
  const closeness = clampScore(relation.closeness ?? relation.points ?? relation.affinityPoints ?? 0);
  const intimacy = clampScore(relation.intimacy ?? relation.trust_score ?? relation.trustScore ?? closeness);
  const rawLevel = normalizeText(relation.level || relation.relationType || relation.relationship || relation.relation_stage);
  const level = BOUNDARY_TEMPLATES[rawLevel] ? rawLevel : levelFromRelationText(rawLevel, closeness);
  const lastInteractionAt = relation.lastInteractionAt || relation.last_interaction_at || relation.updatedAt || relation.last_affinity_update_at || null;
  const tags = normalizeTags(relation.tags || relation.relationTags || relation.labels);

  let boundary = BOUNDARY_TEMPLATES[level] || BOUNDARY_TEMPLATES.stranger;
  if (closeness < 30) {
    boundary += '；对方很多事情我都不知道，不要装熟或假设对方的喜好';
  } else if (closeness < 70) {
    boundary += '；对对方有基本了解，但不是什么都知道，不会读心';
  }

  if (lastInteractionAt) {
    const lastMs = new Date(lastInteractionAt).getTime();
    const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
    if (Number.isFinite(lastMs)) {
      const daysSince = Math.floor((nowMs - lastMs) / 86400000);
      if (daysSince > 7) {
        boundary += '；最近很久没联系，不要表现得像昨天还在聊天一样';
      }
    }
  }

  return {
    level,
    closeness,
    intimacy,
    tags,
    lastInteractionAt,
    boundary
  };
}

function timeout(ms, fallback) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(fallback), Math.max(1, Number(ms || 100) || 100));
  });
}

async function queryRelationshipProjection(userId, deps = {}) {
  const memoryV3 = deps.memoryV3 || (() => {
    try {
      return require('../memory-v3');
    } catch (_) {
      return null;
    }
  })();
  if (memoryV3 && typeof memoryV3.queryProjection === 'function') {
    const result = await memoryV3.queryProjection('relationship', {
      userId,
      targetId: 'mizuki_akiyama'
    });
    return Array.isArray(result) ? (result[0] || null) : (result || null);
  }
  return undefined;
}

function readLegacyRelationship(userId) {
  try {
    const memory = require('../memory');
    const profile = typeof memory.getUserProfile === 'function' ? memory.getUserProfile(userId) : {};
    const affinity = typeof memory.getUserAffinityState === 'function' ? memory.getUserAffinityState(userId) : {};
    const favorite = memory.favorites?.[String(userId || '').trim()] || {};
    return {
      relation_stage: profile?.relation_stage || affinity?.relationship || favorite.relationship || favorite.level,
      relationship: affinity?.relationship || favorite.relationship || favorite.level,
      closeness: favorite.points ?? affinity?.points ?? 0,
      intimacy: affinity?.trust_score ?? favorite.trust_score ?? favorite.points ?? 0,
      tags: profile?.relationship_tags || favorite.tags || [],
      lastInteractionAt: favorite.last_affinity_update_at ? new Date(Number(favorite.last_affinity_update_at)).toISOString() : null
    };
  } catch (_) {
    return null;
  }
}

async function getRelationshipBoundary(userId, options = {}) {
  const result = await getRelationshipBoundaryWithSource(userId, options);
  return result.boundary;
}

async function getRelationshipBoundaryWithSource(userId, options = {}) {
  const uid = normalizeText(userId);
  const baseSource = {
    sourceFile: 'utils/liveState/relationshipBoundary.js',
    sourcePolicy: 'getRelationshipBoundary',
    readOnly: true
  };
  if (!uid) {
    return {
      boundary: getDefaultBoundary(),
      source: {
        ...baseSource,
        dataSource: 'default_boundary_no_user_id',
        found: false
      }
    };
  }
  try {
    const queried = await Promise.race([
      queryRelationshipProjection(uid, options),
      timeout(options.timeoutMs || 100, null)
    ]);
    if (queried === null) {
      return {
        boundary: getDefaultBoundary(),
        source: {
          ...baseSource,
          dataSource: 'memory_v3_relationship_projection_empty_or_timeout',
          found: false
        }
      };
    }
    if (queried) {
      return {
        boundary: buildBoundary(queried, options),
        source: {
          ...baseSource,
          dataSource: 'memory_v3_relationship_projection',
          found: true
        }
      };
    }
    const relation = readLegacyRelationship(uid);
    if (!relation || Object.keys(relation).length === 0) {
      return {
        boundary: getDefaultBoundary(),
        source: {
          ...baseSource,
          dataSource: 'default_boundary_no_relationship_data',
          found: false
        }
      };
    }
    return {
      boundary: buildBoundary(relation, options),
      source: {
        ...baseSource,
        dataSource: 'legacy_relationship_memory',
        found: true
      }
    };
  } catch (error) {
    if (options.logger && typeof options.logger.warn === 'function') {
      options.logger.warn('Relationship query failed, using default', {
        userId: uid,
        error: error?.message || String(error)
      });
    }
    return {
      boundary: getDefaultBoundary(),
      source: {
        ...baseSource,
        dataSource: 'default_boundary_relationship_error',
        found: false,
        error: error?.message || String(error)
      }
    };
  }
}

module.exports = {
  BOUNDARY_TEMPLATES,
  buildBoundary,
  getDefaultBoundary,
  getRelationshipBoundary,
  getRelationshipBoundaryWithSource
};
