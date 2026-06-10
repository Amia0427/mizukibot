function createAdminTaskHandlers(deps = {}) {
  const {
    isAdminUser,
    sendGroupReply
  } = deps;

  function hasAdminAccess(route = {}, senderId = '') {
    if (typeof isAdminUser === 'function') {
      return isAdminUser(senderId);
    }
    return Boolean(route?.meta?.admin);
  }

  return {
    hasAdminAccess
  };
}

module.exports = {
  createAdminTaskHandlers
};
