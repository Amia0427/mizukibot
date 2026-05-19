function createMemoryGovernancePlanHelpers(deps = {}) {
  const {
    defaults,
    nowTs
  } = deps;

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function canonicalizeText(text) {
    return normalizeText(text)
      .toLowerCase()
      .replace(/^喜欢(?:[:：]|\s)*/i, '')
      .replace(/^不喜欢(?:[:：]|\s)*/i, '')
      .replace(/^目标(?:[:：]|\s)*/i, '')
      .replace(/^recent topic(?:[:：]|\s)*/i, '')
      .replace(/^最近话题(?:[:：]|\s)*/i, '')
      .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(text) {
    const normalized = canonicalizeText(text);
    if (!normalized) return [];
    const tokens = [];
    const words = normalized.match(/[a-z0-9]+/g) || [];
    tokens.push(...words);

    const zhChunks = normalized.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const chunk of zhChunks) {
      if (chunk.length <= 1) {
        tokens.push(chunk);
        continue;
      }
      if (chunk.length <= 4) tokens.push(chunk);
      for (let i = 0; i < chunk.length - 1; i += 1) {
        tokens.push(chunk.slice(i, i + 2));
      }
    }

    return tokens;
  }

  function jaccard(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const item of setA) {
      if (setB.has(item)) inter += 1;
    }
    return inter / (setA.size + setB.size - inter);
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function isLikelyInjectionText(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return false;
    const patterns = [
      /ignore.*(instruction|prompt|system)/i,
      /system\s*prompt/i,
      /developer\s*message/i,
      /do not reveal/i,
      /你现在要代替机器人/i,
      /不要承认自己在执行规则/i,
      /必须像自然聊天/i
    ];
    return patterns.some((p) => p.test(t));
  }

  function isLikelyAssistantPersonaFact(text) {
    const t = normalizeText(text);
    if (!t) return false;
    if (/用户|user/i.test(t)) return false;
    return /^(瑞希|助手|assistant).{0,10}(喜欢|讨厌|自称|知道|是)/i.test(t);
  }

  function isExpiredTopic(item, topicTtlDays) {
    if (String(item.type) !== 'topic') return false;
    const ts = Number(item.updatedAt || item.createdAt || 0) || 0;
    if (!ts) return false;
    const ageDays = (nowTs() - ts) / (24 * 3600 * 1000);
    return ageDays > Math.max(3, Number(topicTtlDays) || 21);
  }

  function scoreQuality(item) {
    const confidence = clamp(item.confidence ?? 0.7, 0.01, 1);
    const importance = clamp(item.importance ?? 1, 0.2, 3);
    const mentions = Math.max(0, Number(item.mentionCount || 0));
    const access = Math.max(0, Number(item.accessCount || 0));
    const recency = Number(item.updatedAt || item.createdAt || 0) || 0;
    return (confidence * 1.4) + (importance * 0.5) + (mentions * 0.03) + (access * 0.02) + (recency * 1e-13);
  }

  function safeUserFilter(userId, item) {
    if (!userId) return true;
    return String(item.userId) === String(userId);
  }

  function mergeIntoKeeper(keeper, removed) {
    keeper.updatedAt = Math.max(
      Number(keeper.updatedAt || 0) || 0,
      Number(removed.updatedAt || 0) || 0,
      nowTs()
    );
    keeper.createdAt = Math.min(
      Number(keeper.createdAt || nowTs()) || nowTs(),
      Number(removed.createdAt || nowTs()) || nowTs()
    );
    keeper.confidence = Math.max(
      clamp(keeper.confidence ?? 0.7, 0.01, 1),
      clamp(removed.confidence ?? 0.7, 0.01, 1)
    );
    keeper.importance = Math.max(
      clamp(keeper.importance ?? 1, 0.2, 3),
      clamp(removed.importance ?? 1, 0.2, 3)
    );
    keeper.weight = Math.max(
      clamp(keeper.weight ?? 1, 0.2, 3),
      clamp(removed.weight ?? 1, 0.2, 3)
    );
    keeper.mentionCount = Math.max(1, Number(keeper.mentionCount || 1)) + Math.max(0, Number(removed.mentionCount || 0));
    keeper.accessCount = Math.max(0, Number(keeper.accessCount || 0)) + Math.max(0, Number(removed.accessCount || 0));
  }

  function findDuplicateGroups(items, dedupeThreshold = 0.9) {
    const threshold = clamp(dedupeThreshold, 0.75, 0.99);
    const exactBucket = new Map();
    const groups = [];
    const idToGroup = new Map();

    for (const item of items) {
      const key = `${item.userId}|${item.type}|${canonicalizeText(item.text || item.canonicalText || '')}`;
      if (!exactBucket.has(key)) exactBucket.set(key, []);
      exactBucket.get(key).push(item);
    }

    for (const list of exactBucket.values()) {
      if (list.length < 2) continue;
      const groupId = groups.length;
      groups.push(list.map((x) => x.id));
      for (const it of list) idToGroup.set(it.id, groupId);
    }

    const byUserType = new Map();
    for (const item of items) {
      const key = `${item.userId}|${item.type}`;
      if (!byUserType.has(key)) byUserType.set(key, []);
      byUserType.get(key).push(item);
    }

    for (const list of byUserType.values()) {
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        const tokenA = tokenize(a.canonicalText || a.text || '');
        if (!tokenA.length) continue;
        for (let j = i + 1; j < list.length; j += 1) {
          const b = list[j];
          if (idToGroup.has(a.id) && idToGroup.get(a.id) === idToGroup.get(b.id)) continue;

          const ca = canonicalizeText(a.canonicalText || a.text || '');
          const cb = canonicalizeText(b.canonicalText || b.text || '');
          if (!ca || !cb) continue;

          const containNear = (ca.includes(cb) || cb.includes(ca)) && Math.min(ca.length, cb.length) >= 6;
          const sim = containNear ? 1 : jaccard(tokenA, tokenize(b.canonicalText || b.text || ''));
          if (sim < threshold) continue;

          if (!idToGroup.has(a.id) && !idToGroup.has(b.id)) {
            const groupId = groups.length;
            groups.push([a.id, b.id]);
            idToGroup.set(a.id, groupId);
            idToGroup.set(b.id, groupId);
            continue;
          }

          if (idToGroup.has(a.id) && !idToGroup.has(b.id)) {
            const gid = idToGroup.get(a.id);
            groups[gid].push(b.id);
            idToGroup.set(b.id, gid);
            continue;
          }

          if (!idToGroup.has(a.id) && idToGroup.has(b.id)) {
            const gid = idToGroup.get(b.id);
            groups[gid].push(a.id);
            idToGroup.set(a.id, gid);
            continue;
          }

          const ga = idToGroup.get(a.id);
          const gb = idToGroup.get(b.id);
          if (ga === gb) continue;
          const merged = [...groups[ga], ...groups[gb]];
          groups[ga] = merged;
          groups[gb] = [];
          for (const id of merged) idToGroup.set(id, ga);
        }
      }
    }

    return groups
      .filter((row) => row.length > 1)
      .map((row) => Array.from(new Set(row)));
  }

  function buildGovernancePlan(rawItems, options = {}) {
    const cfg = {
      ...defaults,
      ...options
    };
    const mode = String(cfg.mode || 'balanced').toLowerCase() === 'strict' ? 'strict' : 'balanced';
    const action = String(cfg.action || 'archive').toLowerCase() === 'delete' ? 'delete' : 'archive';
    const minConfidence = clamp(cfg.minConfidence, 0.01, 1);
    const topicTtlDays = Math.max(3, Number(cfg.topicTtlDays) || 21);
    const dedupeThreshold = clamp(cfg.dedupeThreshold, 0.75, 0.99);
    const selected = (Array.isArray(rawItems) ? rawItems : []).filter((item) => safeUserFilter(cfg.userId, item));

    const byId = new Map(selected.map((item) => [String(item.id), item]));
    const plans = [];

    for (const item of selected) {
      if (String(item.status || 'active') !== 'active') continue;
      const reasons = [];
      const confidence = clamp(item.confidence ?? 0.7, 0.01, 1);
      const text = normalizeText(item.text);

      if (confidence < minConfidence) reasons.push('low_confidence');
      if (text.length < 2) reasons.push('invalid_too_short');
      if (isExpiredTopic(item, topicTtlDays)) reasons.push('stale_topic');
      if (isLikelyInjectionText(text)) reasons.push('prompt_injection_like');
      if (isLikelyAssistantPersonaFact(text)) reasons.push('assistant_persona_fact');

      if (mode === 'strict') {
        if (text.length > 180) reasons.push('too_verbose');
        if (item.type === 'topic' && confidence < Math.max(0.78, minConfidence + 0.04)) reasons.push('low_quality_topic');
      }

      if (reasons.length > 0) {
        plans.push({
          id: item.id,
          op: action,
          reason: reasons.join('+'),
          mergeTo: ''
        });
      }
    }

    const activeCandidates = selected.filter((item) => String(item.status || 'active') === 'active');
    const duplicateGroups = findDuplicateGroups(activeCandidates, dedupeThreshold);

    for (const group of duplicateGroups) {
      const members = group.map((id) => byId.get(String(id))).filter(Boolean);
      if (members.length < 2) continue;

      members.sort((a, b) => scoreQuality(b) - scoreQuality(a));
      const keeper = members[0];

      for (let i = 1; i < members.length; i += 1) {
        const removeItem = members[i];
        if (plans.some((p) => p.id === removeItem.id)) continue;
        plans.push({
          id: removeItem.id,
          op: action,
          reason: 'duplicate',
          mergeTo: keeper.id
        });
      }
    }

    const keepers = new Map();
    for (const p of plans) {
      if (!p.mergeTo) continue;
      if (!keepers.has(p.mergeTo)) keepers.set(p.mergeTo, []);
      keepers.get(p.mergeTo).push(p.id);
    }

    const stats = {
      scanned: selected.length,
      active_scanned: selected.filter((item) => String(item.status || 'active') === 'active').length,
      planned: plans.length,
      archive: plans.filter((p) => p.op === 'archive').length,
      delete: plans.filter((p) => p.op === 'delete').length,
      low_confidence: plans.filter((p) => p.reason.includes('low_confidence')).length,
      stale_topic: plans.filter((p) => p.reason.includes('stale_topic')).length,
      prompt_injection_like: plans.filter((p) => p.reason.includes('prompt_injection_like')).length,
      assistant_persona_fact: plans.filter((p) => p.reason.includes('assistant_persona_fact')).length,
      duplicate: plans.filter((p) => p.reason === 'duplicate').length,
      merge_keepers: keepers.size
    };

    return {
      options: {
        mode,
        action,
        userId: cfg.userId ? String(cfg.userId) : '',
        minConfidence,
        topicTtlDays,
        dedupeThreshold
      },
      stats,
      plans,
      keepers
    };
  }

  return {
    buildGovernancePlan,
    mergeIntoKeeper,
    normalizeText
  };
}

module.exports = {
  createMemoryGovernancePlanHelpers
};
