const { buildCanonicalRouteContract } = require('./routeSchema');

/**
 * Route contract is the only canonical semantic truth for the routing pipeline.
 * router -> contract
 * planner -> consumes direct_chat contract only
 * routeExecution -> consumes contract + planner output only
 * routeProfiles -> guidance metadata only
 */
function getRouteContract(route = {}) {
  return buildCanonicalRouteContract(route);
}

module.exports = {
  getRouteContract
};
