const assert = require('assert');
const {
  END_TARGET,
  LANGGRAPH_V2_TOPOLOGY,
  applyLangGraphV2Topology
} = require('../api/runtimeV2/topology');

module.exports = (() => {
  assert.deepStrictEqual(LANGGRAPH_V2_TOPOLOGY.nodes, [
    'prepare',
    'enhance_live_state',
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
  ]);
  assert.strictEqual(LANGGRAPH_V2_TOPOLOGY.entryPoint, 'prepare');
  assert.deepStrictEqual(LANGGRAPH_V2_TOPOLOGY.edges, [
    { from: 'prepare', to: 'enhance_live_state' },
    { from: 'enhance_live_state', to: 'route' },
    { from: 'planner', to: 'dispatch' },
    { from: 'dispatch', to: 'validate' },
    { from: 'humanize', to: 'final_validate' },
    { from: 'final_validate', to: 'persist' },
    { from: 'persist', to: END_TARGET }
  ]);
  assert.deepStrictEqual(LANGGRAPH_V2_TOPOLOGY.conditionalEdges, [
    {
      from: 'route',
      router: 'routeAfterRoute',
      branches: {
        chat: 'direct_reply',
        proactive: 'direct_reply',
        review: 'direct_reply',
        image: 'direct_reply',
        minecraft: 'direct_reply',
        tool_plan: 'planner'
      }
    },
    {
      from: 'direct_reply',
      router: 'routeAfterDirectReply',
      branches: {
        planner: 'planner',
        persist: 'persist',
        __end__: END_TARGET
      }
    },
    {
      from: 'validate',
      router: 'routeAfterValidate',
      branches: {
        answer: 'draft_reply',
        repair: 'repair_or_continue'
      }
    },
    {
      from: 'repair_or_continue',
      router: 'routeAfterRepair',
      branches: {
        dispatch: 'dispatch',
        answer: 'draft_reply'
      }
    },
    {
      from: 'draft_reply',
      router: 'routeAfterDraftReply',
      branches: {
        dispatch: 'dispatch',
        humanize: 'humanize'
      }
    }
  ]);

  const calls = [];
  const graph = {
    addNode(name, impl) {
      calls.push(['addNode', name, impl.name]);
    },
    setEntryPoint(name) {
      calls.push(['setEntryPoint', name]);
    },
    addEdge(from, to) {
      calls.push(['addEdge', from, to]);
    },
    addConditionalEdges(from, router, branches) {
      calls.push(['addConditionalEdges', from, router.name, branches]);
    }
  };
  const nodes = Object.fromEntries(
    LANGGRAPH_V2_TOPOLOGY.nodes.map((nodeName) => [nodeName, function nodeImpl() {}])
  );
  const routers = Object.fromEntries(
    LANGGRAPH_V2_TOPOLOGY.conditionalEdges.map((edge) => [edge.router, function routerImpl() {}])
  );
  const end = Symbol('END');

  applyLangGraphV2Topology(graph, { nodes, routers, end });

  assert.strictEqual(calls.filter((call) => call[0] === 'addNode').length, LANGGRAPH_V2_TOPOLOGY.nodes.length);
  assert.deepStrictEqual(calls[LANGGRAPH_V2_TOPOLOGY.nodes.length], ['setEntryPoint', 'prepare']);
  assert.ok(calls.some((call) => call[0] === 'addEdge' && call[1] === 'persist' && call[2] === end));
  assert.ok(calls.some((call) => (
    call[0] === 'addConditionalEdges'
    && call[1] === 'direct_reply'
    && call[3].__end__ === end
  )));

  assert.throws(() => applyLangGraphV2Topology(graph, {
    nodes: { ...nodes, persist: null },
    routers,
    end
  }), /missing LangGraph V2 node implementation: persist/);
  assert.throws(() => applyLangGraphV2Topology(graph, {
    nodes,
    routers: { ...routers, routeAfterRepair: null },
    end
  }), /missing LangGraph V2 router implementation: routeAfterRepair/);

  console.log('langgraphV2.test.js passed');
})();
