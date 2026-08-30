function normalizeText(value) {
  return String(value || '').trim();
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
      provider
    });
  }
  return normalized;
}

function shuffleMainModelCandidates(candidates = [], random = Math.random) {
  const shuffled = normalizeCandidates(candidates);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[targetIndex]] = [shuffled[targetIndex], shuffled[index]];
  }
  return shuffled;
}

function summarizeFailure(error, candidate, attempt) {
  return {
    slot: normalizeText(candidate?.id || candidate?.slot),
    attempt,
    model: normalizeText(candidate?.model),
    provider: normalizeText(candidate?.provider),
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
      __mainModelPoolSize: ordered.length
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
