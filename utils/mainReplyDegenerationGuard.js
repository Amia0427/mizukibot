const DEFAULT_MIN_TEXT_CHARS = 80;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeForRepeat(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[\s"'`“”‘’\[\]{}()（）【】<>《》,，.。!！?？:：;；、~～\-_=+|\\/]+/g, '');
}

function splitSentences(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/(?<=[。！？!?；;…])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function countMatches(text = '', pattern) {
  const matches = String(text || '').match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function topNgramRepeat(compact = '', size = 8) {
  const width = Math.max(4, Math.floor(Number(size) || 8));
  if (compact.length < width * 4) return { ngram: '', count: 0, coverage: 0 };
  const counts = new Map();
  for (let i = 0; i <= compact.length - width; i += 1) {
    const token = compact.slice(i, i + width);
    if (!token.trim()) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  let best = { ngram: '', count: 0, coverage: 0 };
  for (const [ngram, count] of counts.entries()) {
    if (count > best.count) {
      best = {
        ngram,
        count,
        coverage: (count * width) / Math.max(1, compact.length)
      };
    }
  }
  return best;
}

function summarizeRepeatedSentences(sentences = []) {
  const normalized = sentences
    .map((sentence) => normalizeForRepeat(sentence))
    .filter((sentence) => sentence.length >= 4);
  const counts = new Map();
  for (const sentence of normalized) {
    counts.set(sentence, (counts.get(sentence) || 0) + 1);
  }
  let maxRepeat = 0;
  let repeatedCount = 0;
  for (const count of counts.values()) {
    if (count > 1) repeatedCount += count;
    maxRepeat = Math.max(maxRepeat, count);
  }
  return {
    sentenceCount: normalized.length,
    uniqueSentenceCount: counts.size,
    uniqueRatio: normalized.length ? counts.size / normalized.length : 1,
    maxRepeat,
    repeatedCount
  };
}

function computeCharDiversity(compact = '') {
  if (!compact) {
    return { uniqueRatio: 1, topCharRatio: 0 };
  }
  const counts = new Map();
  for (const char of compact) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  let top = 0;
  for (const count of counts.values()) top = Math.max(top, count);
  return {
    uniqueRatio: counts.size / compact.length,
    topCharRatio: top / compact.length
  };
}

function hasAdjacentChunkLoop(sentences = []) {
  const normalized = sentences
    .map((sentence) => normalizeForRepeat(sentence))
    .filter((sentence) => sentence.length >= 4);
  if (normalized.length < 4) return false;
  let streak = 1;
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] === normalized[i - 1]) {
      streak += 1;
      if (streak >= 3) return true;
    } else {
      streak = 1;
    }
  }
  return false;
}

function analyzeMainReplyDegeneration(text = '', options = {}) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  const compact = normalizeForRepeat(raw);
  const minChars = Math.max(20, Number(options.minChars || DEFAULT_MIN_TEXT_CHARS) || DEFAULT_MIN_TEXT_CHARS);
  const reasons = [];
  const metrics = {
    chars: normalized.length,
    compactChars: compact.length,
    sentenceCount: 0,
    uniqueSentenceRatio: 1,
    maxSentenceRepeat: 0,
    repeatedSentenceCount: 0,
    topNgramLength: 0,
    topNgramCount: 0,
    topNgramCoverage: 0,
    charUniqueRatio: 1,
    topCharRatio: 0,
    fillerCueCount: 0,
    repeatedPunctuationRun: 0
  };

  if (!normalized || compact.length < Math.min(24, minChars)) {
    return {
      degenerated: false,
      score: 0,
      reasons,
      metrics
    };
  }

  const sentences = splitSentences(raw);
  const sentenceSummary = summarizeRepeatedSentences(sentences);
  metrics.sentenceCount = sentenceSummary.sentenceCount;
  metrics.uniqueSentenceRatio = Number(sentenceSummary.uniqueRatio.toFixed(3));
  metrics.maxSentenceRepeat = sentenceSummary.maxRepeat;
  metrics.repeatedSentenceCount = sentenceSummary.repeatedCount;

  const ngramSizes = [6, 8, 12].map((size) => topNgramRepeat(compact, size));
  const bestNgram = ngramSizes.reduce((best, item) => {
    if (item.coverage > best.coverage) return item;
    if (item.coverage === best.coverage && item.count > best.count) return item;
    return best;
  }, { ngram: '', count: 0, coverage: 0 });
  metrics.topNgramLength = bestNgram.ngram.length;
  metrics.topNgramCount = bestNgram.count;
  metrics.topNgramCoverage = Number(bestNgram.coverage.toFixed(3));

  const diversity = computeCharDiversity(compact);
  metrics.charUniqueRatio = Number(diversity.uniqueRatio.toFixed(3));
  metrics.topCharRatio = Number(diversity.topCharRatio.toFixed(3));

  const fillerCueCount = countMatches(normalized, /(?:我刚才|刚才|其实|或者说|怎么说呢|就是|那种|你知道|怎么讲|换句话说)/g);
  metrics.fillerCueCount = fillerCueCount;
  const punctuationRuns = normalized.match(/[。！？!?，,、~～.]{6,}/g) || [];
  metrics.repeatedPunctuationRun = punctuationRuns.reduce((max, item) => Math.max(max, item.length), 0);

  if (sentenceSummary.maxRepeat >= 3) reasons.push('repeated_sentence');
  if (sentenceSummary.sentenceCount >= 6 && sentenceSummary.uniqueRatio <= 0.45) reasons.push('low_sentence_variety');
  if (hasAdjacentChunkLoop(sentences)) reasons.push('adjacent_sentence_loop');
  if (compact.length >= minChars && bestNgram.count >= 5 && bestNgram.coverage >= 0.2) reasons.push('repeated_ngram');
  if (compact.length >= 120 && diversity.uniqueRatio <= 0.16 && diversity.topCharRatio >= 0.12) reasons.push('low_char_diversity');
  if (normalized.length >= 140 && fillerCueCount >= 8) reasons.push('filler_loop');
  if (metrics.repeatedPunctuationRun >= 8) reasons.push('punctuation_loop');

  const weights = {
    repeated_sentence: 0.35,
    low_sentence_variety: 0.25,
    adjacent_sentence_loop: 0.35,
    repeated_ngram: 0.35,
    low_char_diversity: 0.2,
    filler_loop: 0.2,
    punctuation_loop: 0.2
  };
  const score = Math.min(1, reasons.reduce((total, reason) => total + (weights[reason] || 0.1), 0));
  const severeSignal = reasons.includes('repeated_sentence')
    || reasons.includes('adjacent_sentence_loop')
    || reasons.includes('repeated_ngram');
  const degenerated = Boolean(
    reasons.length >= 2
    || (severeSignal && compact.length >= 48)
    || score >= 0.5
  );

  return {
    degenerated,
    score: Number(score.toFixed(3)),
    reasons,
    metrics
  };
}

function trimMainReplyDegeneratedTail(text = '') {
  const raw = String(text || '');
  const sentences = splitSentences(raw);
  if (sentences.length < 4) return raw.trim();

  const kept = [];
  let changed = false;
  for (const sentence of sentences) {
    const current = normalizeForRepeat(sentence);
    const previous = normalizeForRepeat(kept[kept.length - 1] || '');
    if (current && previous && current === previous) {
      changed = true;
      continue;
    }
    kept.push(sentence);
  }

  while (kept.length >= 4) {
    const last = normalizeForRepeat(kept[kept.length - 1]);
    const prev = normalizeForRepeat(kept[kept.length - 2]);
    const prev2 = normalizeForRepeat(kept[kept.length - 3]);
    if (last && last === prev && last === prev2) {
      kept.pop();
      changed = true;
      continue;
    }
    break;
  }

  if (!changed) return raw.trim();
  return kept.join('').trim();
}

function buildMainReplyDegenerationRepairInstruction(analysis = {}) {
  const reasons = Array.isArray(analysis.reasons) && analysis.reasons.length > 0
    ? analysis.reasons.join(', ')
    : 'low_quality_loop';
  return [
    `The previous candidate reply showed sampling degeneration (${reasons}).`,
    'Do not repeat or paraphrase that candidate.',
    'Reply once in plain natural language, directly addressing the user.',
    'Keep it concrete, non-looping, and concise unless the user explicitly asked for a long structured answer.',
    'Do not mention degeneration, retries, tools, or internal routing.'
  ].join(' ');
}

module.exports = {
  analyzeMainReplyDegeneration,
  buildMainReplyDegenerationRepairInstruction,
  normalizeForRepeat,
  splitSentences,
  trimMainReplyDegeneratedTail
};
