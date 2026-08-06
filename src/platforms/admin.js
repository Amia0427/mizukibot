let resolver = null;

function setPlatformAdminResolver(nextResolver) {
  resolver = typeof nextResolver === 'function' ? nextResolver : null;
}

function isPlatformAdminPrincipal(principalId) {
  return resolver ? resolver(String(principalId || '').trim()) === true : false;
}

module.exports = {
  isPlatformAdminPrincipal,
  setPlatformAdminResolver
};
