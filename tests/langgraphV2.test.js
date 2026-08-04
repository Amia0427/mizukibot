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
    'agent_decide',
    'execute_tools',
    'humanize',
    'final_validate',
    'persist'
  ]);
  assert.strictEqual(LANGGRAPH_V2_TOPOLOGY.entryPoint, 'prepare');
  assert.deepStrictEqual(LANGGRAPH_V2_TOPOLOGY.edges, [
    { from: 'prepare', to: 'enhance_live_state' },
    { from: 'enhance_live_state', to: 'route' },
    { from: 'execute_tools', to: 'agent_decide' },
    { from: 'humanize', to: 'final_validate' },
    { from: 'final_validate', to: 'persist' },
    { from: 'persist', to: END_TARGET }
  ]);
  assert.deepStrictEqual(LANGGRAPH_V2_TOPOLOGY.conditionalEdges, [
    {
      from: 'route',
      router: 'routeAfterRoute',
      branches: {
        chat: 'agent_decide',
        proactive: 'agent_decide',
        review: 'agent_decide',
        image: 'agent_decide',
        minecraft: 'agent_decide',
        agent: 'agent_decide'
      }
    },
    {
      from: 'agent_decide',
      router: 'routeAfterAgentDecide',
      branches: {
        execute_tools: 'execute_tools',
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
    && call[1] === 'agent_decide'
    && call[3].execute_tools === 'execute_tools'
  )));

  assert.throws(() => applyLangGraphV2Topology(graph, {
    nodes: { ...nodes, persist: null },
    routers,
    end
  }), /missing LangGraph V2 node implementation: persist/);
  assert.throws(() => applyLangGraphV2Topology(graph, {
    nodes,
    routers: { ...routers, routeAfterAgentDecide: null },
    end
  }), /missing LangGraph V2 router implementation: routeAfterAgentDecide/);

  console.log('langgraphV2.test.js passed');
})();
