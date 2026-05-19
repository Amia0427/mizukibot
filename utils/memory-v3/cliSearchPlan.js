const {
  RECALL_FACETS,
  classifyRecallFacet
} = require('../recallHeuristics');
const { normalizeText } = require('./helpers');
const { JOURNAL_TRIGGER_RE } = require('./journalRecallPolicy');

const NOTEBOOK_TRIGGER_RE = /(?:\bnotebook\b|笔记|文档|markdown|\bmd\b)/i;
const SOURCE_SET = new Set(['recent', 'profile', 'personal', 'task', 'group', 'style', 'jargon', 'journal', 'notebook']);
const FACET_SET = new Set(RECALL_FACETS);

const FACET_SOURCE_PLAN = Object.freeze({
  recent_continuity: {
    primary: ['recent', 'task', 'journal'],
    secondary: ['personal', 'profile']
  },
  task_or_plan: {
    primary: ['recent', 'task', 'journal'],
    secondary: ['personal', 'profile']
  },
  preference: {
    primary: ['profile', 'personal'],
    secondary: ['recent']
  },
  identity: {
    primary: ['profile', 'personal'],
    secondary: ['recent']
  },
  relationship: {
    primary: ['profile', 'personal'],
    secondary: ['recent']
  },
  group_context: {
    primary: ['group', 'jargon', 'recent'],
    secondary: ['journal']
  },
  broad_recall: {
    primary: ['recent', 'personal', 'profile'],
    secondary: ['task', 'journal']
  },
  default_continuity: {
    primary: ['recent', 'personal', 'profile'],
    secondary: ['task', 'journal']
  }
});

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

function facetPlanForQuery(queryFacet = 'default_continuity') {
  return FACET_SOURCE_PLAN[queryFacet] || FACET_SOURCE_PLAN.default_continuity;
}

function queryFacetForSearch(query = '', source = 'all') {
  if (source === 'recent') return 'recent_continuity';
  if (source === 'task') return 'task_or_plan';
  if (source === 'group') return 'group_context';
  if (source === 'style' || source === 'jargon') return 'preference';
  if (source === 'journal') return 'recent_continuity';
  const facet = classifyRecallFacet(query);
  return FACET_SET.has(facet) ? facet : 'default_continuity';
}

function chooseSourcePlan(query = '', requestedSource = 'all') {
  const source = normalizeText(requestedSource).toLowerCase() || 'all';
  const queryFacet = queryFacetForSearch(query, source);
  if (source === 'notebook') {
    return { queryFacet: 'notebook', primary: ['notebook'], secondary: [] };
  }
  if (SOURCE_SET.has(source) && source !== 'all') {
    return { queryFacet, primary: [source], secondary: [] };
  }
  const plan = facetPlanForQuery(queryFacet);
  const primary = normalizeArray(plan.primary).filter((item) => {
    if (item === 'notebook') return NOTEBOOK_TRIGGER_RE.test(query);
    if (item === 'journal') return true;
    return true;
  });
  const secondary = normalizeArray(plan.secondary);
  if (NOTEBOOK_TRIGGER_RE.test(query)) primary.push('notebook');
  if (JOURNAL_TRIGGER_RE.test(query) && !primary.includes('journal')) primary.push('journal');
  return {
    queryFacet,
    primary: Array.from(new Set(primary)),
    secondary: Array.from(new Set(secondary))
  };
}

module.exports = {
  SOURCE_SET,
  chooseSourcePlan,
  queryFacetForSearch
};
