const STATIC_MCP_REPLACEMENTS = [
  {
    serverName: 'fetch',
    toolName: 'fetch_url',
    functionName: 'mcp_fetch_fetch_url',
    description: 'Fetch and extract readable webpage content',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      },
      required: ['url']
    },
    targetTool: 'web_fetch'
  },
  {
    serverName: 'bing-search',
    toolName: 'search_web',
    functionName: 'mcp_bing_search_search_web',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query']
    },
    targetTool: 'web_search'
  },
  {
    serverName: 'amap-maps',
    toolName: 'search_places',
    functionName: 'mcp_amap_maps_search_places',
    description: 'Search nearby places',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string' },
        city: { type: 'string' }
      },
      required: ['keywords']
    },
    targetTool: 'search_nearby_places'
  },
  {
    serverName: 'howtocook-mcp',
    toolName: 'recipe_search',
    functionName: 'mcp_howtocook_mcp_recipe_search',
    description: 'Search local recipe records from the cached howtocook dataset',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    },
    targetTool: 'local_howtocook_recipe_search'
  }
];

function getStaticReplacementDescriptors(configuredServers = []) {
  const configuredNames = new Set(
    (Array.isArray(configuredServers) ? configuredServers : [])
      .map((item) => String(item?.serverName || '').trim())
      .filter(Boolean)
  );

  return STATIC_MCP_REPLACEMENTS
    .filter((item) => configuredNames.size === 0 || configuredNames.has(item.serverName))
    .map((item) => ({
      serverName: item.serverName,
      toolName: item.toolName,
      functionName: item.functionName,
      description: item.description,
      inputSchema: item.inputSchema,
      targetTool: item.targetTool
    }));
}

module.exports = {
  STATIC_MCP_REPLACEMENTS,
  getStaticReplacementDescriptors
};
