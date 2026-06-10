function isSystemProxyEnabled() {
  return false;
}

async function runManagedCommand(spec = {}) {
  void spec;
  throw new Error('system proxy disabled');
}

async function discoverManagedMcpTools(options = {}) {
  void options;
  throw new Error('system proxy disabled');
}

async function callManagedMcpTool(serverName = '', toolName = '', args = {}, options = {}) {
  void serverName;
  void toolName;
  void args;
  void options;
  throw new Error('system proxy disabled');
}

module.exports = {
  callManagedMcpTool,
  discoverManagedMcpTools,
  isSystemProxyEnabled,
  runManagedCommand
};
