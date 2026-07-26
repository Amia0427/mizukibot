function routeHasReadableCardContext(route = {}) {
  const meta = route?.meta && typeof route.meta === 'object'
    ? route.meta
    : (route?.routeMeta && typeof route.routeMeta === 'object' ? route.routeMeta : {});
  return Array.isArray(meta.cardContexts)
    && meta.cardContexts.some((card) => String(card?.primaryUrl || '').trim());
}

module.exports = {
  routeHasReadableCardContext
};
