function normalizeValue(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isTurnCompactionEpisode(episode = {}) {
  if (normalizeValue(episode.rollupLevel || episode.type) !== 'segment') return false;
  return normalizeValue(episode.textKind) === 'journal_turn_summary'
    || normalizeValue(episode.sourceCompleteness) === 'turn_batch'
    || normalizeValue(episode.source) === 'daily_journal_turn_compaction';
}

function shouldIndexJournalEpisode(episode = {}) {
  const rollupLevel = normalizeValue(episode.rollupLevel || episode.type || 'daily') || 'daily';
  return rollupLevel !== 'segment' || isTurnCompactionEpisode(episode);
}

module.exports = {
  isTurnCompactionEpisode,
  shouldIndexJournalEpisode
};
