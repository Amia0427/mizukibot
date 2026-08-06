let resolver = null;

function normalizeIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function setPlatformIdentityAliasResolver(nextResolver) {
  resolver = typeof nextResolver === 'function' ? nextResolver : null;
}

function resolvePlatformIdentityAliases(principalId) {
  const primary = String(principalId || '').trim();
  if (!primary) return [];
  const aliases = resolver ? resolver(primary) : [];
  return normalizeIds([primary, ...(Array.isArray(aliases) ? aliases : [])]);
}

function selectLatestAffinityState(states = []) {
  return (Array.isArray(states) ? states : [])
    .filter((state) => state && typeof state === 'object')
    .sort((left, right) => Number(right.last_affinity_update_at || 0) - Number(left.last_affinity_update_at || 0))[0]
    || null;
}

module.exports = {
  normalizeIds,
  resolvePlatformIdentityAliases,
  selectLatestAffinityState,
  setPlatformIdentityAliasResolver
};
