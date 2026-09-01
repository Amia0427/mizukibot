function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeWeight(value) {
  const weight = Number(value);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function normalizeCandidates(candidates = []) {
  const normalized = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const apiBaseUrl = normalizeText(candidate.apiBaseUrl);
    const apiKey = normalizeText(candidate.apiKey);
    const model = normalizeText(candidate.model);
    const provider = normalizeText(candidate.provider);
    if (!apiBaseUrl || !apiKey || !model) continue;
    const identity = [apiBaseUrl, apiKey, model, provider].join('\u0000');
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({
      ...candidate,
      apiBaseUrl,
      apiKey,
      model,
      provider,
      weight: normalizeWeight(candidate.weight)
    });
  }
  return normalized;
}

function nextWeightedIndex(candidates, random) {
  const totalWeight = candidates.reduce((total, item) => total + normalizeWeight(item.weight), 0);
  const draw = Math.max(0, Math.min(0.9999999999999999, Number(random()) || 0)) * totalWeight;
  let remaining = draw;
  for (let index = 0; index < candidates.length; index += 1) {
    remaining -= normalizeWeight(candidates[index].weight);
    if (remaining < 0) return index;
  }
  return candidates.length - 1;
}

function shuffleMainModelCandidates(candidates = [], random = Math.random) {
  const pool = normalizeCandidates(candidates);
  const ordered = [];
  while (pool.length > 0) {
    const index = nextWeightedIndex(pool, random);
    ordered.push(pool.splice(index, 1)[0]);
  }
  return ordered;
}

function summarizeFailure(error, candidate, attempt) {
  return {
    slot: normalizeText(candidate?.id || candidate?.slot),
    attempt,
    model: normalizeText(candidate?.model),
    provider: normalizeText(candidate?.provider),
    weight: normalizeWeight(candidate?.weight),
    status: Number(error?.response?.status || 0) || null,
    error: normalizeText(error?.message || error).slice(0, 400)
  };
}

async function runMainModelPool(candidates, action, options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const ordered = shuffleMainModelCandidates(candidates, random);
  const failures = [];
  let lastError = null;

  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    const resolvedConfig = {
      ...candidate,
      __mainModelPoolEnabled: true,
      __mainModelPoolSlot: normalizeText(candidate.id || candidate.slot),
      __mainModelPoolAttempt: index + 1,
      __mainModelPoolSize: ordered.length,
      __mainModelPoolWeight: normalizeWeight(candidate.weight)
    };
    try {
      return await action(resolvedConfig);
    } catch (error) {
      lastError = error;
      failures.push(summarizeFailure(error, candidate, index + 1));
      if (typeof options.shouldContinue === 'function' && !options.shouldContinue(error)) {
        throw error;
      }
    }
  }

  const finalError = lastError || (failures.length > 0
    ? new Error(failures[failures.length - 1].error || '主模型候选均请求失败')
    : new Error('主模型候选配置为空'));
  finalError.mainModelPoolAttempts = failures;
  throw finalError;
}

module.exports = {
  normalizeCandidates,
  shuffleMainModelCandidates,
  runMainModelPool
};
