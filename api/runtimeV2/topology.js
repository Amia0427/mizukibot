const END_TARGET = '__langgraph_end__';

const LANGGRAPH_V2_TOPOLOGY = Object.freeze({
  entryPoint: 'prepare',
  nodes: Object.freeze([
    'prepare',
    'enhance_live_state',
    'route',
    'agent_decide',
    'execute_tools',
    'humanize',
    'final_validate',
    'persist'
  ]),
  edges: Object.freeze([
    Object.freeze({ from: 'prepare', to: 'enhance_live_state' }),
    Object.freeze({ from: 'enhance_live_state', to: 'route' }),
    Object.freeze({ from: 'execute_tools', to: 'agent_decide' }),
    Object.freeze({ from: 'humanize', to: 'final_validate' }),
    Object.freeze({ from: 'final_validate', to: 'persist' }),
    Object.freeze({ from: 'persist', to: END_TARGET })
  ]),
  conditionalEdges: Object.freeze([
    Object.freeze({
      from: 'route',
      router: 'routeAfterRoute',
      branches: Object.freeze({
        chat: 'agent_decide',
        proactive: 'agent_decide',
        review: 'agent_decide',
        image: 'agent_decide',
        minecraft: 'agent_decide',
        agent: 'agent_decide'
      })
    }),
    Object.freeze({
      from: 'agent_decide',
      router: 'routeAfterAgentDecide',
      branches: Object.freeze({
        execute_tools: 'execute_tools',
        humanize: 'humanize'
      })
    })
  ])
});

function resolveTarget(target, endTarget) {
  return target === END_TARGET ? endTarget : target;
}

function resolveBranches(branches = {}, endTarget) {
  return Object.fromEntries(
    Object.entries(branches).map(([key, target]) => [key, resolveTarget(target, endTarget)])
  );
}

function applyLangGraphV2Topology(graph, options = {}) {
  const nodes = options.nodes || {};
  const routers = options.routers || {};
  const endTarget = options.end;

  for (const nodeName of LANGGRAPH_V2_TOPOLOGY.nodes) {
    if (typeof nodes[nodeName] !== 'function') {
      throw new Error(`missing LangGraph V2 node implementation: ${nodeName}`);
    }
    graph.addNode(nodeName, nodes[nodeName]);
  }

  graph.setEntryPoint(LANGGRAPH_V2_TOPOLOGY.entryPoint);

  for (const edge of LANGGRAPH_V2_TOPOLOGY.edges) {
    graph.addEdge(edge.from, resolveTarget(edge.to, endTarget));
  }

  for (const edge of LANGGRAPH_V2_TOPOLOGY.conditionalEdges) {
    const router = routers[edge.router];
    if (typeof router !== 'function') {
      throw new Error(`missing LangGraph V2 router implementation: ${edge.router}`);
    }
    graph.addConditionalEdges(edge.from, router, resolveBranches(edge.branches, endTarget));
  }

  return graph;
}

module.exports = {
  END_TARGET,
  LANGGRAPH_V2_TOPOLOGY,
  applyLangGraphV2Topology
};
