function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, '').trim();
}

function locationMatchesQuery(location = {}, query = '') {
  const target = normalizeText(query);
  if (!target) return false;
  return [
    location.locationId,
    location.name,
    location.displayName,
    `${location.adm2 || ''}${location.name || ''}`,
    `${location.adm1 || ''}${location.adm2 || ''}${location.name || ''}`
  ].some((value) => normalizeText(value) === target);
}

function resolveLocation(candidates = [], query = '') {
  const normalized = (Array.isArray(candidates) ? candidates : []).filter((item) => item?.locationId);
  if (normalized.length === 0) return { status: 'not_found', candidates: [] };
  if (normalized.length === 1) return { status: 'resolved', location: normalized[0], candidates: normalized };
  const exact = normalized.filter((item) => locationMatchesQuery(item, query));
  if (exact.length === 1) return { status: 'resolved', location: exact[0], candidates: normalized };
  return { status: 'ambiguous', candidates: normalized };
}

function createWeatherAlertSubscriptionService(options = {}) {
  const provider = options.provider;
  const stateStore = options.stateStore;
  const maxSubscriptions = Math.max(1, Number(options.maxSubscriptions) || 5);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  if (!provider || !stateStore) throw new Error('provider and stateStore are required');

  function list(principalId) {
    const principal = stateStore.getPrincipal(principalId);
    return {
      paused: principal.paused,
      subscriptions: principal.subscriptions.map((item) => ({ ...item }))
    };
  }

  async function subscribe(principalId, query) {
    const candidates = await provider.lookupLocations(query);
    const resolved = resolveLocation(candidates, query);
    if (resolved.status !== 'resolved') return resolved;
    const current = stateStore.getPrincipal(principalId);
    if (current.subscriptions.some((item) => item.locationId === resolved.location.locationId)) {
      return { status: 'duplicate', subscription: resolved.location };
    }
    if (current.subscriptions.length >= maxSubscriptions) {
      return { status: 'limit_reached', limit: maxSubscriptions };
    }
    const subscription = {
      locationId: resolved.location.locationId,
      name: resolved.location.name,
      adm1: resolved.location.adm1,
      adm2: resolved.location.adm2,
      displayName: resolved.location.displayName,
      latitude: resolved.location.latitude,
      longitude: resolved.location.longitude,
      subscribedAt: now()
    };
    stateStore.updatePrincipal(principalId, (principal) => {
      principal.subscriptions.push(subscription);
    }, { flushNow: true });
    return { status: 'subscribed', subscription };
  }

  async function unsubscribe(principalId, query) {
    const current = stateStore.getPrincipal(principalId);
    let matches = current.subscriptions.filter((item) => locationMatchesQuery(item, query));
    if (matches.length === 0) {
      const resolved = resolveLocation(await provider.lookupLocations(query), query);
      if (resolved.status === 'ambiguous') return resolved;
      if (resolved.status === 'resolved') {
        matches = current.subscriptions.filter((item) => item.locationId === resolved.location.locationId);
      }
    }
    if (matches.length !== 1) return { status: 'not_subscribed' };
    const subscription = matches[0];
    stateStore.updatePrincipal(principalId, (principal) => {
      principal.subscriptions = principal.subscriptions.filter((item) => item.locationId !== subscription.locationId);
      for (const [key, alert] of Object.entries(principal.alerts)) {
        if (alert.locationId === subscription.locationId) delete principal.alerts[key];
      }
    }, { flushNow: true });
    return { status: 'unsubscribed', subscription };
  }

  function pause(principalId) {
    stateStore.updatePrincipal(principalId, (principal) => {
      principal.paused = true;
      for (const alert of Object.values(principal.alerts)) {
        if (['pending', 'deferred', 'retry_wait'].includes(alert.delivery?.status)) {
          alert.delivery.status = 'suppressed';
          alert.delivery.nextAttemptAt = 0;
        }
      }
    }, { flushNow: true });
    return list(principalId);
  }

  function resume(principalId) {
    const timestamp = now();
    stateStore.updatePrincipal(principalId, (principal) => {
      principal.paused = false;
      for (const alert of Object.values(principal.alerts)) {
        if (alert.active && alert.delivery?.status === 'suppressed') {
          alert.delivery.status = 'pending';
          alert.delivery.nextAttemptAt = timestamp;
        }
      }
    }, { flushNow: true });
    return list(principalId);
  }

  async function execute(principalId, action, location) {
    if (action === 'subscribe') return subscribe(principalId, location);
    if (action === 'unsubscribe') return unsubscribe(principalId, location);
    if (action === 'list') return { status: 'listed', ...list(principalId) };
    if (action === 'pause') return { status: 'paused', ...pause(principalId) };
    if (action === 'resume') return { status: 'resumed', ...resume(principalId) };
    throw new Error(`Unsupported weather alert action: ${action}`);
  }

  return { execute, list, pause, resume, subscribe, unsubscribe };
}

module.exports = {
  createWeatherAlertSubscriptionService,
  locationMatchesQuery,
  resolveLocation
};
