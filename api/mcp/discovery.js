function createMcpServerToolDiscovery({
  discoverServerTools,
  listConfiguredMcpServers,
  normalizeMcpError
}) {
  return async function discoverMcpServerTools(serverName = '', options = {}) {
    const normalizedServerName = String(serverName || '').trim();
    if (!normalizedServerName) return [];
    const configuredServers = listConfiguredMcpServers(options);
    const serverConfig = configuredServers.find((item) => item.serverName === normalizedServerName);
    if (!serverConfig) {
      throw normalizeMcpError(new Error(`mcp server not found: ${normalizedServerName}`), 'MCP_SERVER_NOT_FOUND');
    }
    return discoverServerTools(serverConfig, options);
  };
}

module.exports = {
  createMcpServerToolDiscovery
};
