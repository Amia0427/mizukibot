const END_TARGET = '__langgraph_end__';

const LANGGRAPH_V2_TOPOLOGY = Object.freeze({
  entryPoint: 'prepare',
  nodes: Object.freeze([
    'prepare',
    'route',
    'direct_reply',
    'planner',
    'dispatch',
    'validate',
    'repair_or_continue',
    'draft_reply',
    'humanize',
    'final_validate',
    'persist'
  ]),
  edges: Object.freeze([
    Object.freeze({ from: 'prepare', to: 'route' }),
    Object.freeze({ from: 'planner', to: 'dispatch' }),
    Object.freeze({ from: 'dispatch', to: 'validate' }),
    Object.freeze({ from: 'humanize', to: 'final_validate' }),
    Object.freeze({ from: 'final_validate', to: 'persist' }),
    Object.freeze({ from: 'persist', to: END_TARGET })
  ]),
  conditionalEdges: Object.freeze([
    Object.freeze({
      from: 'route',
      router: 'routeAfterRoute',
      branches: Object.freeze({
        chat: 'direct_reply',
        proactive: 'direct_reply',
        review: 'direct_reply',
        image: 'direct_reply',
        minecraft: 'direct_reply',
        tool_plan: 'planner'
      })
    }),
    Object.freeze({
      from: 'direct_reply',
      router: 'routeAfterDirectReply',
      branches: Object.freeze({
        planner: 'planner',
        persist: 'persist',
        __end__: END_TARGET
      })
    }),
    Object.freeze({
      from: 'validate',
      router: 'routeAfterValidate',
      branches: Object.freeze({
        answer: 'draft_reply',
        repair: 'repair_or_continue'
      })
    }),
    Object.freeze({
      from: 'repair_or_continue',
      router: 'routeAfterRepair',
      branches: Object.freeze({
        dispatch: 'dispatch',
        answer: 'draft_reply'
      })
    }),
    Object.freeze({
      from: 'draft_reply',
      router: 'routeAfterDraftReply',
      branches: Object.freeze({
        dispatch: 'dispatch',
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
